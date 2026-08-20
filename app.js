'use strict';

/* =====================================================================
 * Agnes Video Studio — Long-format video maker using Agnes AI API
 * Pure static (deployable on GitHub Pages). API key stays in browser.
 * ===================================================================== */

const API_BASE = 'https://apihub.agnes-ai.com';
const VIDEO_MODEL = 'agnes-video-v2.0';
const CHAT_MODEL = 'agnes-2.5-flash';
const STORE_KEY = 'agnesVideoStudio_v1';
const APP_VERSION = '20260816k';

/* Global error guard: never let an uncaught error kill the page silently.
 * Shows a dismissible overlay with the exact message so cache issues are visible. */
window.addEventListener('error', (e) => {
  try { toast('Error: ' + (e.message || 'unknown') + ' — if old error persists, hard refresh (Ctrl+Shift+R)', true); } catch (_) {}
});

const RATIO_SIZES = {
  '16:9': { width: 1152, height: 768 },
  '9:16': { width: 768, height: 1152 },
  '1:1':  { width: 768, height: 768 },
};

/* Duration presets — frames @24fps (frame = seconds*24+1), aligned to the reference
 * implementation. All fit within the 720p tier cap (409 frames ≈ 17s) after clamping. */
const DURATION_FRAMES = { 3: 81, 5: 121, 8: 193, 10: 241, 12: 289, 18: 441 };
const FRAME_RATE = 24;

/* Agnes normalizes resolution into tiers. Frame budget depends on the tier:
 *   > 1280×720 (1080p tier) → max 169 frames
 *   > 854×480  (720p tier)  → max 409 frames
 *   else                    → max 961 frames
 * Clamp num_frames to the tier cap so long clips don't get rejected.
 */
function clampFrames(width, height, numFrames) {
  const pixels = (width || 1152) * (height || 768);
  const max = pixels > 1280 * 720 ? 169 : pixels > 854 * 480 ? 409 : 961;
  return Math.max(1, Math.min(numFrames || 121, max));
}

/* The status API can return the finished video URL under several shapes;
 * try them all (reference implementation parity) instead of only metadata.url. */
function extractVideoUrl(d) {
  if (!d || typeof d !== 'object') return null;
  const candidates = [
    d.video_url, d.url, d.videoUrl,
    d.data && d.data.video_url, d.data && d.data.url, d.data && d.data.videoUrl,
    d.result && d.result.video_url, d.result && d.result.url, d.result && d.result.videoUrl,
    d.metadata && d.metadata.video_url, d.metadata && d.metadata.url, d.metadata && d.metadata.videoUrl,
    d.output && d.output.url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('http')) return c;
  }
  return null;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- rate limiting ----------
 * Agnes enforces RPM per account. Video on the free tier is 1 req/min.
 * Polling is deliberately slow (60s) to stay within the status-query quota.
 * A callback lets the pipeline show a live countdown to the user.
 */
const VIDEO_RPM_OPTIONS = { 1: 62000, 2: 32000, 5: 15000, 10: 9000 };
const POLL_INTERVAL = 60000;          // status query interval (reference: 60s)
const MAX_POLL_TIME = 1800000;        // 30 min max per scene
const MAX_CONSECUTIVE_FAILURES = 10;  // give up after N consecutive poll failures
const MAX_SUBMIT_RETRIES = 8;         // submit retries with linear backoff (capped)
const RETRY_BASE_DELAY = 30000;       // delay = min(30s * (attempt+1), 150s)
const MIN_INTERVALS = {
  video: () => VIDEO_RPM_OPTIONS[state.settings.videoRpm || 1] || 62000,
  image: () => 3200,   // image ~20 rpm → 3.2s spacing
  chat:  () => 3200,   // chat ~20 rpm
  poll:  () => 0,
};
const lastCallAt = {};
let onRateWait = null; // (remainingSeconds, kind) => void

function videoRpmInterval() { return MIN_INTERVALS.video(); }

async function throttle(kind) {
  const interval = MIN_INTERVALS[kind] ? MIN_INTERVALS[kind]() : 0;
  if (!interval) return;
  const since = lastCallAt[kind] || 0;
  const wait = since + interval - Date.now();
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    if (onRateWait) onRateWait(secs, kind);
    else toast(`Rate limit: waiting ${secs}s before next ${kind} request…`, true);
    await sleep(secs * 1000);
  }
  lastCallAt[kind] = Date.now();
}

/* Try to parse a rate-limit error message like:
 * "video generation rate limit exceeded: allows 1 requests per 1 minute(s) (request id: ...)"
 * Returns { perMinutes } on success, null otherwise.
 */
function parseRateLimit(err) {
  if (!err) return null;
  const msg = String(err.message || '');
  const m = msg.match(/allows\s+\d+\s+requests?\s+per\s+(\d+)\s+minute/i);
  if (m) return { perMinutes: parseInt(m[1], 10) || 1 };
  if (err.status === 429) return { perMinutes: 1 };
  if (/rate limit/i.test(msg)) return { perMinutes: 1 };
  return null;
}

async function retryOnRateLimit(fn, kind) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const rl = parseRateLimit(err);
      if (!rl) throw err;
      if (attempt >= 3) throw err;
      attempt++;
      const waitMs = rl.perMinutes * 60000;
      const secs = Math.ceil(waitMs / 1000);
      if (onRateWait) onRateWait(secs, kind, true);
      await sleep(secs * 1000);
    }
  }
}

/* ---------- state ---------- */
let state = {
  apiKey: '',
  projectTitle: '',
  scenes: [],
  settings: { sceneCount: 5, sceneDuration: 5, aspectRatio: '16:9', videoStyle: '', videoRpm: 1 },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const s = JSON.parse(raw); state = Object.assign(state, s); }
  } catch (e) { /* ignore */ }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------- logger ----------
 * In-memory ring buffer of run logs, shown in the Log panel.
 * Each entry: time, level (info/warn/error/success), scope (scene:N / system),
 * message, and optional raw error text for diagnosis.
 */
const MAX_LOGS = 500;
const logEntries = [];
let logSeq = 1;

function loggerAdd(level, scope, message, raw) {
  logEntries.push({ id: logSeq++, ts: Date.now(), level, scope, message, raw });
  if (logEntries.length > MAX_LOGS) logEntries.shift();
  renderLogs();
}
const log = {
  info:  (scope, message) => loggerAdd('info', scope, message),
  warn:  (scope, message, raw) => loggerAdd('warn', scope, message, raw),
  error: (scope, message, raw) => loggerAdd('error', scope, message, raw),
  success: (scope, message) => loggerAdd('success', scope, message),
};
function fmtLogTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function sceneScope(scene) {
  const idx = state.scenes.findIndex(s => s && s.id === scene.id);
  return idx >= 0 ? 'scene:' + (idx + 1) : 'system';
}
let logExpanded = false;
function renderLogs() {
  const list = $('#logList');
  if (!list) return;
  list.innerHTML = '';
  if (logEntries.length === 0) {
    list.innerHTML = '<p class="log-empty">No logs yet — generate a video to see progress here.</p>';
    return;
  }
  logEntries.forEach(entry => {
    const el = document.createElement('div');
    el.className = 'log-row log-' + entry.level;
    el.innerHTML = `
      <span class="log-time">${fmtLogTime(entry.ts)}</span>
      <span class="log-lvl">${entry.level.toUpperCase().slice(0, 4)}</span>
      ${entry.scope !== 'system' ? `<span class="log-scope">${escapeHtml(entry.scope)}</span>` : ''}
      <span class="log-msg">${escapeHtml(entry.message)}${entry.raw ? `<span class="log-raw"> — ${escapeHtml(entry.raw)}</span>` : ''}</span>
    `;
    list.appendChild(el);
  });
  if (logExpanded) {
    list.scrollTop = list.scrollHeight;
  }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

/* ---------- API helpers ---------- */
function authHeaders() {
  return { 'Authorization': 'Bearer ' + state.apiKey, 'Content-Type': 'application/json' };
}

async function apiFetch(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code))
      || ('HTTP ' + res.status);
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function chat(messages) {
  return retryOnRateLimit(() => throttle('chat')
    .then(() => apiFetch('/v1/chat/completions', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.6, max_tokens: 4000 }),
    })), 'chat');
}

/* Determine whether a submit/poll error is retryable (reference parity):
 * 401 (invalid key) and other 4xx are fatal; 429/5xx/network/timeout are retryable. */
function isRetryableError(err) {
  if (!err) return false;
  if (err.status >= 500) return true;
  if (err.status === 429) return true;
  if (/rate limit/i.test(err.message || '')) return true;
  if (!err.status && /network|failed to fetch|timeout|invalid response/i.test(err.message || '')) return true;
  return false;
}

/* Submit one video task with capped linear-backoff retries.
 * delay = min(30s * (attempt+1), 150s): 30s, 60s, 90s, 120s, 150s, 150s… (max 8 attempts).
 */
async function createVideoTask(params, scope) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_SUBMIT_RETRIES; attempt++) {
    try {
      await throttle('video');
      const data = await apiFetch('/v1/videos', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify(Object.assign({ model: VIDEO_MODEL }, params)),
      });
      const videoId = data.video_id || data.task_id || data.id;
      if (!videoId) throw new Error('Video task creation failed: no id returned');
      return { videoId, taskId: data.task_id || data.id, data };
    } catch (err) {
      lastErr = err;
      if (scope) log.warn(scope, 'Submit attempt ' + (attempt + 1) + ' failed', err.message);
      if (!isRetryableError(err) || attempt === MAX_SUBMIT_RETRIES - 1) throw err;
      const delay = Math.min(RETRY_BASE_DELAY * (attempt + 1), 150000);
      const secs = Math.round(delay / 1000);
      if (scope) log.info(scope, 'Retrying submit in ' + secs + 's (backoff)');
      if (onRateWait) onRateWait(secs, 'video', true);
      else toast(`Rate limit: retrying video submission in ${secs}s…`, true);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function pollVideo(videoId) {
  const res = await fetch(`${API_BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
    headers: { 'Authorization': 'Bearer ' + state.apiKey },
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error && (data.error.message || data.error.code)) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  if (data && typeof data === 'object') return data;
  throw new Error('Video status query returned an invalid response');
}

/* =====================================================================
 * SCENES RENDERING
 * ===================================================================== */
function sceneById(id) { return state.scenes.find(s => s.id === id); }

function renderScenes() {
  const list = $('#sceneList');
  list.innerHTML = '';
  state.scenes.forEach((scene, i) => {
    const el = document.createElement('div');
    el.className = 'scene' + (scene.videoUrl ? ' has-video' : '');
    el.dataset.id = scene.id;
    el.innerHTML = `
      <div class="scene-num">${i + 1}</div>
      <div class="scene-main">
        <textarea class="scene-prompt" rows="2" placeholder="Video prompt (English recommended)">${escapeHtml(scene.videoPrompt)}</textarea>
        <div class="scene-meta">
          <span class="scene-status st-${scene.status}">${statusLabel(scene.status)}</span>
          ${scene.videoUrl ? `<span class="scene-status st-completed">${scene.seconds ? '~' + scene.seconds + 's' : 'done'}</span>` : ''}
        </div>
        <div class="progress-track"><div class="progress-bar" style="width:${scene.progress || 0}%"></div></div>
        <div class="scene-img-row">
          <video class="scene-video" src="${escapeAttr(scene.videoUrl || '')}" controls preload="metadata"></video>
        </div>
        ${scene.error ? `<div class="error-box">${escapeHtml(scene.error)}</div>` : ''}
      </div>
      <div class="scene-actions">
        <button class="btn btn-sm btn-primary act-generate">▶ Generate</button>
        <button class="btn btn-sm btn-danger act-delete">✕</button>
      </div>
    `;

    el.querySelector('.scene-prompt').addEventListener('change', (e) => {
      scene.videoPrompt = e.target.value; saveState();
    });

    el.querySelector('.act-generate').addEventListener('click', async () => {
      scene.videoPrompt = el.querySelector('.scene-prompt').value;
      await generateOneScene(scene, el, true);
    });

    el.querySelector('.act-delete').addEventListener('click', () => {
      state.scenes = state.scenes.filter(s => s.id !== scene.id);
      saveState(); renderScenes(); renderVoiceover();
    });

    list.appendChild(el);
  });
}

function statusLabel(st) {
  return { pending: 'pending', queued: 'queued', progress: 'generating…', completed: 'completed', failed: 'failed', extending: 'extending…' }[st] || st;
}

function setSceneStatus(scene, el, status, progress) {
  scene.status = status;
  if (typeof progress === 'number') scene.progress = progress;
  saveState();
  if (el) {
    const st = el.querySelector('.scene-status');
    if (st) {
      st.className = 'scene-status st-' + status;
      st.textContent = statusLabel(status);
    }
    el.classList.toggle('show-progress', status === 'progress' || status === 'queued' || status === 'extending');
    const bar = el.querySelector('.progress-bar');
    if (bar) bar.style.width = (scene.progress || 0) + '%';
    if (scene.error) {
      let eb = el.querySelector('.error-box');
      if (!eb) {
        const box = document.createElement('div');
        box.className = 'error-box';
        el.querySelector('.scene-main').appendChild(box);
        eb = box;
      }
      eb.textContent = scene.error;
    }
  }
}

/* =====================================================================
 * STORYBOARD GENERATION (AI)
 * ===================================================================== */
$('#btnGenStoryboard').addEventListener('click', async () => {
  const story = $('#storyInput').value.trim();
  const count = Math.min(12, Math.max(2, parseInt($('#sceneCount').value, 10) || 5));
  const dur = parseInt($('#sceneDuration').value, 10) || 5;
  const ratio = $('#aspectRatio').value;
  const style = $('#videoStyle').value.trim();
  const err = $('#storyError');
  err.classList.add('hidden');

  if (!state.apiKey) { toast('Please set your API key first', true); return; }
  if (!story) { toast('Please write a story first', true); return; }

  const btn = $('#btnGenStoryboard');
  btn.disabled = true;
  btn.textContent = '⏳ Generating storyboard…';
  log.info('system', 'Storyboard generation started (' + count + ' scenes)');
  try {
    const sys = `You are a film storyboard director. Split the user's story into exactly ${count} sequential scenes. Each scene must have:
- "video_prompt": a detailed ENGLISH text-to-video prompt describing subject, action, scene, camera movement, lighting and style${style ? ', style: ' + style : ''}. Write it as one continuous sentence for an AI video model.
- "narration_bn": a short BANGLA (Bengali) voiceover narration line for this scene (1-2 sentences).
Ensure scenes flow as one continuous story (each continues where the previous ended).
Respond ONLY with valid JSON: {"title":"...","scenes":[{"video_prompt":"...","narration_bn":"..."}]}`;
    const res = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: story },
    ]);
    const text = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (!text) throw new Error('No response from model');

    const json = extractJson(text);
    if (!json || !Array.isArray(json.scenes) || json.scenes.length === 0) {
      throw new Error('Model did not return a valid storyboard. Try again.');
    }

    state.projectTitle = json.title || $('#projectTitle').value.trim() || 'My video';
    if (json.title) $('#projectTitle').value = json.title;
    state.scenes = json.scenes.map(sc => ({
      id: uid(),
      videoPrompt: (sc.video_prompt || '').trim(),
      narrationBn: (sc.narration_bn || '').trim(),
      status: 'pending', progress: 0, videoUrl: '', error: '',
      seconds: dur, width: RATIO_SIZES[ratio].width, height: RATIO_SIZES[ratio].height,
      numFrames: DURATION_FRAMES[dur], frameRate: FRAME_RATE, ratio,
    }));
    saveState();
    renderScenes();
    renderVoiceover();
    log.success('system', 'Storyboard ready: ' + state.scenes.length + ' scenes — "' + (json.title || '') + '"');
    toast(`Storyboard ready: ${state.scenes.length} scenes`);
  } catch (e) {
    err.textContent = 'Error: ' + e.message;
    err.classList.remove('hidden');
    log.error('system', 'Storyboard generation failed', e.message);
    toast('Storyboard failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI দিয়ে Storyboard বানান';
  }
});

function extractJson(text) {
  // strip markdown fences
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { return null; }
}

$('#btnAddScene').addEventListener('click', () => {
  const dur = parseInt($('#sceneDuration').value, 10) || 5;
  const ratio = $('#aspectRatio').value;
  state.scenes.push({
    id: uid(), videoPrompt: '', narrationBn: '',
    status: 'pending', progress: 0, videoUrl: '', error: '',
    seconds: dur, width: RATIO_SIZES[ratio].width, height: RATIO_SIZES[ratio].height,
    numFrames: DURATION_FRAMES[dur], frameRate: FRAME_RATE, ratio,
  });
  saveState(); renderScenes(); renderVoiceover();
});

/* =====================================================================
 * VIDEO GENERATION
 * ===================================================================== */
async function generateOneScene(scene, el, fresh) {
  if (!state.apiKey) { toast('Set API key first', true); return; }
  if (!scene.videoPrompt.trim()) { toast('Scene prompt is empty', true); return; }

  const sc = sceneScope(scene);

  // scene 1 (no previous completed scene) → text-to-video;
  // later scenes → start from the previous scene's last frame (ti2vid continuity)
  let imageUrl = null;
  const prev = prevCompletedScene(scene);
  if (prev && prev.videoUrl) {
    setSceneStatus(scene, el, 'extending', 2);
    log.info(sc, 'Extending from previous scene last frame...');
    try {
      imageUrl = await extractLastFrame(prev.videoUrl, sc);
      log.success(sc, 'Last frame extracted (used as ti2vid start frame)');
    } catch (e) {
      log.warn(sc, 'Extend failed — falling back to text-to-video', e.message);
      toast('Extend from last frame failed, using text-to-video instead: ' + e.message, true);
      imageUrl = null;
    }
  } else {
    log.info(sc, 'No previous scene — generating from text prompt (text-to-video)');
  }

  const params = {
    prompt: scene.videoPrompt,
    height: scene.height || 768,
    width: scene.width || 1152,
    num_frames: clampFrames(scene.width || 1152, scene.height || 768, scene.numFrames || 121),
    frame_rate: scene.frameRate || 24,
  };
  if (imageUrl) {
    params.image = imageUrl;
    params.mode = 'ti2vid';
  }

  setSceneStatus(scene, el, 'queued', 3);
  log.info(sc, 'Submitting video task (image=' + (imageUrl ? 'yes, ti2vid' : 'none, t2v') + ')');
  try {
    const { videoId } = await createVideoTask(params, sc);
    scene.videoId = videoId;
    log.success(sc, 'Video task submitted, videoId=' + videoId);
    await pollUntilDone(scene, el);
    log.success(sc, 'Scene completed: ' + (scene.videoUrl || ''));
    renderScenes();
    renderVoiceover();
    updatePlayer();
    toast(`Scene generated ✓ (${scene.seconds || '?'}s)`);
  } catch (e) {
    scene.error = e.message;
    log.error(sc, 'Scene failed', e.message);
    setSceneStatus(scene, el, 'failed', scene.progress);
    toast('Scene failed: ' + e.message, true);
  }
}

function prevCompletedScene(scene) {
  const idx = state.scenes.findIndex(s => s.id === scene.id);
  for (let i = idx - 1; i >= 0; i--) {
    const s = state.scenes[i];
    if (s.status === 'completed' && s.videoUrl) return s;
  }
  return null;
}

function pollUntilDone(scene, el) {
  return new Promise((resolve, reject) => {
    let consecutiveFails = 0;
    let pollCount = 0;
    const sc = sceneScope(scene);
    const startedAt = Date.now();
    const tick = async () => {
      if (Date.now() - startedAt > MAX_POLL_TIME) {
        log.error(sc, 'Poll timeout (>30 min)');
        return reject(new Error('Timeout waiting for video (>30 min)'));
      }
      try {
        const d = await pollVideo(scene.videoId);
        const status = d.status || '';
        const progress = d.progress != null ? d.progress : 0;
        pollCount++;

        if (status === 'completed') {
          const url = extractVideoUrl(d);
          if (url) {
            scene.videoUrl = url;
            scene.seconds = d.seconds ? String(parseFloat(d.seconds).toFixed(1)) : scene.seconds;
            setSceneStatus(scene, el, 'completed', 100);
            log.success(sc, 'Polling finished — video ready after ' + pollCount + ' check(s)');
            return resolve(d);
          }
          // completed but no URL yet — treat as still processing, keep waiting
          const p = Math.min(99, Math.max(0, progress));
          setSceneStatus(scene, el, 'progress', p);
          log.info(sc, 'Status completed but no URL yet, still waiting (check #' + pollCount + ')');
          await sleep(POLL_INTERVAL);
          tick();
          return;
        }
        if (status === 'failed') {
          const em = (d.error && (d.error.message || d.error.code)) || 'Generation failed';
          log.error(sc, 'Video generation reported failed', em);
          return reject(new Error(em));
        }

        const p = Math.min(99, Math.max(0, progress));
        setSceneStatus(scene, el, 'progress', p);
        if (pollCount === 1 || pollCount % 5 === 0) {
          log.info(sc, 'Polling... status=' + (status || 'processing') + ' progress=' + progress + '% (check #' + pollCount + ')');
        }
        await sleep(POLL_INTERVAL);
        tick();
      } catch (e) {
        const rl = parseRateLimit(e);
        if (rl) {
          // poll got rate-limited; wait out the window and resume polling
          if (consecutiveFails < MAX_CONSECUTIVE_FAILURES) {
            const waitMs = rl.perMinutes * 60000;
            consecutiveFails++;
            log.warn(sc, 'Poll rate-limited, waiting ' + Math.ceil(waitMs / 1000) + 's (fail #' + consecutiveFails + ')', e.message);
            if (onRateWait) onRateWait(Math.ceil(waitMs / 1000), 'poll', true);
            await sleep(waitMs);
            tick();
          } else return reject(e);
        } else if (consecutiveFails < MAX_CONSECUTIVE_FAILURES) {
          // transient network errors: count it, keep trying (interval between polls)
          consecutiveFails++;
          log.warn(sc, 'Poll error (consecutive fail #' + consecutiveFails + ')', e.message);
          await sleep(POLL_INTERVAL);
          tick();
        } else {
          log.error(sc, 'Too many consecutive polling failures', e.message);
          return reject(new Error('Too many consecutive polling failures: ' + (e.message || 'network error')));
        }
      }
    };
    tick();
  });
}

/* =====================================================================
 * GENERATE ALL
 * ===================================================================== */
let pipelineRunning = false;
$('#btnGenerateAll').addEventListener('click', async () => {
  if (pipelineRunning) { toast('Already running', true); return; }
  if (!state.apiKey) { toast('Set API key first', true); return; }
  const pending = state.scenes.filter(s => s.status !== 'completed');
  if (pending.length === 0) { toast('Nothing to generate', true); return; }

  pipelineRunning = true;
  const scenesToRun = state.scenes.filter(s => s.status !== 'completed');
  log.info('system', 'Pipeline started — ' + scenesToRun.length + ' scene(s) to generate');
  $('#btnGenerateAll').disabled = true;
  $('#btnGenerateAll').textContent = '⏳ Generating…';
  const status = $('#pipelineStatus');
  onRateWait = (secs, kind, retried) => {
    const what = kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'API';
    log.warn('system', 'Rate limit (' + what + '): waiting ' + secs + 's', retried ? 'retry after wait' : '');
    status.textContent = retried
      ? `Rate limit hit — waiting ${secs}s before retrying ${what}…`
      : `Waiting ${secs}s (${what} rate limit)…`;
  };

  for (let i = 0; i < scenesToRun.length; i++) {
    const scene = scenesToRun[i];
    const el = $(`.scene[data-id="${scene.id}"]`);
    const num = sceneIndex(scene) + 1;
    status.textContent = `Scene ${num}/${state.scenes.length}: generating… (একটি করে, ধীরে ধীরে)`;
    log.info('system', 'Pipeline: starting scene ' + num + '/' + state.scenes.length);
    // refresh prompt from textarea
    if (el) scene.videoPrompt = el.querySelector('.scene-prompt').value;
    try {
      await generateOneScene(scene, el, true);
    } catch (e) {
      // per-scene errors are already surfaced; continue with next scene
      log.error('system', 'Pipeline: scene ' + num + ' threw an uncaught error', e.message);
    }
    // 5s pause between scenes — as per the requested pacing
    if (i < scenesToRun.length - 1) {
      status.textContent = `Scene ${num}/${state.scenes.length} done — pausing 5s before next scene…`;
      log.info('system', 'Pipeline: pausing 5s before next scene');
      await sleep(5000);
    }
  }

  status.textContent = '✓ Done';
  log.success('system', 'Pipeline finished');
  pipelineRunning = false;
  $('#btnGenerateAll').disabled = false;
  $('#btnGenerateAll').textContent = '▶ Generate full video (sequentially)';
  onRateWait = null;
  updatePlayer();
  toast('Pipeline finished');

  // all scenes done → automatically build the concatenated single MP4
  const done = state.scenes.filter(s => s.status === 'completed' && s.videoUrl);
  if (done.length >= 2 && done.length === state.scenes.length) {
    log.info('system', 'All scenes complete — auto-concatenating...');
    await concatAllScenes();
  }
});

function sceneIndex(scene) { return state.scenes.findIndex(s => s.id === scene.id); }

$('#btnClearAll').addEventListener('click', () => {
  state.scenes = state.scenes.map(s => ({ ...s, status: 'pending', progress: 0, videoUrl: '', videoId: '', error: '' }));
  saveState(); renderScenes(); renderVoiceover(); updatePlayer();
  $('#fullPlayer').pause();
  $('#fullPlayer').removeAttribute('src');
  $('#playerOverlay').classList.remove('hidden');
});

/* =====================================================================
 * FULL PLAYER (sequential playback)
 * ===================================================================== */
let playerQueue = [];

function updatePlayer() {
  const completed = state.scenes.filter(s => s.status === 'completed' && s.videoUrl);
  const total = completed.reduce((acc, s) => acc + (parseFloat(s.seconds) || 0), 0);
  const mins = Math.floor(total / 60);
  const secs = Math.round(total % 60);
  $('#totalLength').textContent = completed.length
    ? `${completed.length} clips · ~${mins}m ${secs}s total`
    : '';

  if (completed.length === 0) {
    $('#playerOverlay').classList.remove('hidden');
  } else {
    $('#playerOverlay').classList.add('hidden');
  }
  const first = completed[0];
  if (first && !$('#fullPlayer').getAttribute('src')) {
    $('#fullPlayer').src = first.videoUrl;
  }
}

function playFull() {
  const completed = state.scenes.filter(s => s.status === 'completed' && s.videoUrl);
  if (completed.length === 0) { toast('No completed scenes yet', true); return; }
  playerQueue = completed.slice(1).map(s => s.videoUrl);
  const v = $('#fullPlayer');
  v.src = completed[0].videoUrl;
  v.play();
}

$('#btnPlayFull').addEventListener('click', playFull);
$('#btnStopFull').addEventListener('click', () => {
  const v = $('#fullPlayer');
  v.pause();
  v.currentTime = 0;
});

$('#fullPlayer').addEventListener('ended', () => {
  if (playerQueue.length > 0) {
    $('#fullPlayer').src = playerQueue.shift();
    $('#fullPlayer').play();
  }
});

/* =====================================================================
 * FFMPEG.WASM (shared singleton for frame extraction + concatenation)
 * Uses @ffmpeg/ffmpeg 0.12 single-threaded core (reference parity) which
 * does NOT require SharedArrayBuffer/COOP-COEP headers, so it works on
 * GitHub Pages. Loaded lazily (~30MB, cached by the browser afterwards).
 * ===================================================================== */
let ffmpegModule = null;
let ffmpegSingleton = null;
let ffmpegLoadPromise = null;
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
/* @ffmpeg/util.toBlobURL equivalent: fetch a URL and expose it as a same-origin blob URL
 * (needed so the ffmpeg worker can importScripts the core without CORS restrictions) */
async function toBlobURL(url, mimeType) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}
/* @ffmpeg/util.fetchFile equivalent: Blob -> Uint8Array for the ffmpeg FS */
async function fetchFile(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
/* load the ffmpeg.wasm UMD module once (30MB, cached by browser after first) */
async function ensureFFmpegModule() {
  if (ffmpegModule) return ffmpegModule;
  const status = $('#concatStatus');
  status.textContent = 'Loading ffmpeg.wasm (~30MB, first time only)…';
  log.info('system', 'Loading ffmpeg.wasm (single-threaded core)...');
  try {
    /* ffmpeg.js is self-hosted (with its sibling 814.ffmpeg.js worker chunk) so the
     * browser can construct the Worker same-origin (cross-origin workers are blocked) */
    await loadScript('vendor/ffmpeg.js');
    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) throw new Error('ffmpeg failed to initialize');
    ffmpegModule = window.FFmpegWASM.FFmpeg;
    status.textContent = '';
    return ffmpegModule;
  } catch (e) {
    log.error('system', 'Could not load ffmpeg.wasm', e.message);
    status.textContent = '';
    throw e;
  }
}
/* get a single loaded FFmpeg instance (reused by extract + concat) */
async function getFFmpeg() {
  if (ffmpegSingleton && ffmpegSingleton.loaded) return ffmpegSingleton;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  const status = $('#concatStatus');
  status.textContent = 'Booting ffmpeg core…';
  ffmpegLoadPromise = (async () => {
    const FFmpeg = await ensureFFmpegModule();
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegSingleton = ffmpeg;
    status.textContent = '';
    return ffmpeg;
  })();
  try {
    return await ffmpegLoadPromise;
  } catch (e) {
    ffmpegLoadPromise = null;
    status.textContent = '';
    throw e;
  }
}

/* download a scene video into a Blob, bypassing the missing CORS headers */
async function downloadVideoBlob(url) {
  const res = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
  return res.blob();
}

/* extract the last frame of a video as a base64 PNG data URL (reference parity:
 * uses ffmpeg.wasm `-sseof -0.1` so the next scene starts from the previous last frame) */
async function extractLastFrame(videoUrl, scope) {
  const ffmpeg = await getFFmpeg();
  const inputName = `frame_input_${Date.now()}.mp4`;
  const outputName = `frame_${Date.now()}.png`;
  try {
    const blob = await downloadVideoBlob(videoUrl);
    await ffmpeg.writeFile(inputName, await fetchFile(blob));
    await ffmpeg.exec(['-sseof', '-0.1', '-i', inputName, '-frames:v', '1', '-y', outputName]);
    const data = await ffmpeg.readFile(outputName);
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    if (scope) log.success(scope, 'Last frame extracted via ffmpeg (ti2vid start frame)');
    return `data:image/png;base64,${b64}`;
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch (e) { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch (e) { /* ignore */ }
  }
}

async function concatAllScenes() {
  const completed = state.scenes.filter(s => s.status === 'completed' && s.videoUrl);
  if (completed.length === 0) { toast('No completed scenes to concatenate', true); return; }
  if (completed.length < 2) { toast('Need at least 2 completed scenes to concatenate', true); return; }

  const btn = $('#btnConcat');
  const status = $('#concatStatus');
  const dl = $('#concatDownload');
  dl.classList.add('hidden');
  btn.disabled = true;

  try {
    const ffmpeg = await getFFmpeg();

    // 1. write every clip into ffmpeg's FS as clip_i.mp4
    status.textContent = `Downloading ${completed.length} clips…`;
    log.info('system', 'Concat: downloading ' + completed.length + ' clips');
    const lines = [];
    for (let i = 0; i < completed.length; i++) {
      status.textContent = `Downloading clip ${i + 1}/${completed.length}…`;
      const blob = await downloadVideoBlob(completed[i].videoUrl);
      await ffmpeg.writeFile(`clip_${i}.mp4`, await fetchFile(blob));
      lines.push(`file 'clip_${i}.mp4'`);
      log.info('system', `Concat: clip ${i + 1} loaded (${(blob.size / 1048576).toFixed(1)} MB)`);
    }
    await ffmpeg.writeFile('list.txt', new TextEncoder().encode(lines.join('\n')));

    // 2. concat with stream copy (fast, no quality loss — clips share codec/res)
    status.textContent = 'Concatenating… (stream copy, no re-encode)';
    log.info('system', 'Concat: running ffmpeg concat demuxer with -c copy');
    await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'output.mp4']);

    // 3. read result and expose download + preview
    const data = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([data], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    dl.href = url;
    dl.download = `${(state.projectTitle || 'full-video').replace(/[^\w\-]+/g, '_')}.mp4`;
    dl.classList.remove('hidden');
    $('#fullPlayer').src = url;
    $('#playerOverlay').classList.add('hidden');
    const sizeMb = (blob.size / 1048576).toFixed(1);
    status.textContent = `✓ ${completed.length} clips → ${sizeMb} MB`;
    log.success('system', `Concat complete: ${completed.length} clips, ${sizeMb} MB (stream-copied, no re-encode)`);
    toast('Concatenated! Download or press ▶ to preview');
    renderScenes();
  } catch (e) {
    status.textContent = '';
    log.error('system', 'Concat failed', e.message);
    toast('Concat failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('#btnConcat').addEventListener('click', concatAllScenes);

/* =====================================================================
 * VOICEOVER (Bangla)
 * ===================================================================== */
function renderVoiceover() {
  const list = $('#voiceList');
  list.innerHTML = '';
  if (state.scenes.length === 0) {
    list.innerHTML = '<p class="hint">Storyboard বানানোর পর প্রতি scene-এর জন্য বাংলা narration দেখাবে।</p>';
    return;
  }
  state.scenes.forEach((scene, i) => {
    const el = document.createElement('div');
    el.className = 'voice-item';
    el.innerHTML = `
      <div class="voice-num">${i + 1}</div>
      <div class="voice-body">
        <div class="voice-text">${escapeHtml(scene.narrationBn || '(no narration yet)')}</div>
        <div class="voice-meta">Google TTS (bn) · Browser voice</div>
      </div>
      <div class="voice-actions">
        <button class="btn btn-sm btn-ghost act-gtts-play">▶ Google TTS</button>
        <a class="btn btn-sm btn-ghost act-gtts-dl" download="scene${i + 1}.mp3" target="_blank" rel="noopener">⬇ MP3</a>
        <button class="btn btn-sm btn-ghost act-bv-play">🗣 Browser voice</button>
        <button class="btn btn-sm btn-ghost act-bv-stop">⏹</button>
        <button class="btn btn-sm btn-ghost act-narr-edit">✎ Edit</button>
      </div>
    `;

    const ttsUrl = gttsUrl(scene.narrationBn || '');

    el.querySelector('.act-gtts-play').addEventListener('click', () => {
      if (!scene.narrationBn) { toast('No narration text', true); return; }
      new Audio(ttsUrl).play().catch(() => toast('Playback blocked — click MP3 to open', true));
    });
    el.querySelector('.act-gtts-dl').href = ttsUrl;
    el.querySelector('.act-bv-play').addEventListener('click', () => speakBrowser(scene.narrationBn));
    el.querySelector('.act-bv-stop').addEventListener('click', () => { if (window.speechSynthesis) speechSynthesis.cancel(); });
    el.querySelector('.act-narr-edit').addEventListener('click', () => {
      const txt = prompt('Edit Bangla narration:', scene.narrationBn || '');
      if (txt !== null) { scene.narrationBn = txt; saveState(); renderVoiceover(); }
    });

    list.appendChild(el);
  });
}

function gttsUrl(text) {
  return 'https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=bn&client=gtx&q=' + encodeURIComponent(text);
}

function speakBrowser(text) {
  if (!window.speechSynthesis) { toast('Browser does not support speech synthesis', true); return; }
  if (!text) { toast('No narration text', true); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'bn-BD';
  u.rate = 0.95;
  const voices = speechSynthesis.getVoices();
  const bn = voices.find(v => /^bn/i.test(v.lang)) || voices.find(v => /hin/i.test(v.lang));
  if (bn) u.voice = bn;
  speechSynthesis.speak(u);
}

/* =====================================================================
 * SETTINGS
 * ===================================================================== */
$('#btnTestKey').addEventListener('click', async () => {
  const key = $('#apiKey').value.trim();
  if (!key) { toast('Enter an API key', true); return; }
  state.apiKey = key; saveState();
  const btn = $('#btnTestKey');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    await chat([{ role: 'user', content: 'ping' }]);
    updateKeyBadge(true);
    toast('✓ API key is valid');
  } catch (e) {
    updateKeyBadge(false);
    toast('Invalid API key: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Test key';
  }
});

$('#apiKey').addEventListener('change', () => {
  state.apiKey = $('#apiKey').value.trim();
  saveState();
  if (state.apiKey) updateKeyBadge(true);
});
$('#projectTitle').addEventListener('change', () => { state.projectTitle = $('#projectTitle').value.trim(); saveState(); });
$('#sceneCount').addEventListener('change', () => { state.settings.sceneCount = parseInt($('#sceneCount').value, 10); saveState(); });
$('#sceneDuration').addEventListener('change', () => { state.settings.sceneDuration = parseInt($('#sceneDuration').value, 10); saveState(); });
$('#aspectRatio').addEventListener('change', () => { state.settings.aspectRatio = $('#aspectRatio').value; saveState(); });
$('#videoStyle').addEventListener('change', () => { state.settings.videoStyle = $('#videoStyle').value.trim(); saveState(); });
$('#videoRpm').addEventListener('change', () => { state.settings.videoRpm = parseInt($('#videoRpm').value, 10) || 1; saveState(); });

/* ---------- log panel controls ---------- */
$('#btnToggleLog').addEventListener('click', () => {
  logExpanded = !logExpanded;
  const list = $('#logList');
  list.classList.toggle('log-collapsed', !logExpanded);
  $('#btnToggleLog').textContent = logExpanded ? 'Collapse' : 'Expand';
  if (logExpanded) list.scrollTop = list.scrollHeight;
});
$('#btnClearLog').addEventListener('click', () => {
  logEntries.length = 0;
  renderLogs();
  log.info('system', 'Log cleared');
});

function updateKeyBadge(valid) {
  const b = $('#keyBadge');
  if (valid) { b.textContent = 'API key OK'; b.className = 'badge badge-on'; }
  else { b.textContent = 'No API key'; b.className = 'badge badge-off'; }
}

function updateVersionBadge() {
  const b = $('#verBadge');
  if (b) { b.textContent = 'v' + APP_VERSION; b.title = 'app build ' + APP_VERSION; }
}

/* ---------- utils ---------- */
function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

/* ---------- init ---------- */
updateVersionBadge();
loadState();
if (state.apiKey) { $('#apiKey').value = state.apiKey; updateKeyBadge(true); }
if (state.projectTitle) $('#projectTitle').value = state.projectTitle;
if (state.settings) {
  $('#sceneCount').value = state.settings.sceneCount || 5;
  $('#sceneDuration').value = state.settings.sceneDuration || 5;
  $('#aspectRatio').value = state.settings.aspectRatio || '16:9';
  $('#videoStyle').value = state.settings.videoStyle || '';
  $('#videoRpm').value = state.settings.videoRpm || 1;
}
if (state.scenes.length === 0) {
  // seed one empty scene to get started
  const dur = 5;
  state.scenes.push({
    id: uid(), videoPrompt: '', narrationBn: '',
    status: 'pending', progress: 0, videoUrl: '', error: '',
    seconds: dur, width: 1152, height: 768, numFrames: 121, frameRate: 24, ratio: '16:9',
  });
  saveState();
}
renderScenes();
renderVoiceover();
updatePlayer();
log.info('system', 'App loaded (build ' + APP_VERSION + '). Set your API key and generate a storyboard to start.');
renderLogs();
