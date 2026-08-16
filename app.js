'use strict';

/* =====================================================================
 * Agnes Video Studio — Long-format video maker using Agnes AI API
 * Pure static (deployable on GitHub Pages). API key stays in browser.
 * ===================================================================== */

const API_BASE = 'https://apihub.agnes-ai.com';
const VIDEO_MODEL = 'agnes-video-v2.0';
const IMAGE_MODEL = 'agnes-image-2.1-flash';
const CHAT_MODEL = 'agnes-2.5-flash';
const STORE_KEY = 'agnesVideoStudio_v1';
const APP_VERSION = '20260816c';

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

const DURATION_FRAMES = { 3: 81, 5: 121, 10: 241, 18: 441 };
const FRAME_RATE = 24;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- rate limiting ----------
 * Agnes enforces RPM per account. Video on the free tier is 1 req/min.
 * We throttle creation client-side AND auto-retry after a 429.
 * A callback lets the pipeline show a live countdown to the user.
 */
const VIDEO_RPM_OPTIONS = { 1: 62000, 2: 32000, 5: 15000, 10: 9000 };
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

async function generateImage(prompt, ratio) {
  return retryOnRateLimit(() => throttle('image')
    .then(() => apiFetch('/v1/images/generations', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        model: IMAGE_MODEL, prompt, size: '1K', ratio,
        extra_body: { response_format: 'url' },
      }),
    })), 'image')
    .then(data => {
      const url = data && data.data && data.data[0] && data.data[0].url;
      if (!url) throw new Error('Image API returned no URL');
      return url;
    });
}

async function createVideoTask(params) {
  const data = await retryOnRateLimit(() => throttle('video')
    .then(() => apiFetch('/v1/videos', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(Object.assign({ model: VIDEO_MODEL }, params)),
    })), 'video');
  const videoId = data.video_id || data.task_id || data.id;
  if (!videoId) throw new Error('Video task creation failed: no id returned');
  return { videoId, taskId: data.task_id || data.id, data };
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

/* upload a dataURL (last frame) to a public, CORS-friendly host */
async function uploadFrame(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('file', blob, 'frame.png');
  const res = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd });
  const j = await res.json();
  const url = j && j.data && j.data.url;
  if (j && j.status !== 'success' || !url) throw new Error('Frame upload failed');
  // convert to raw file URL for direct fetching
  return url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

/* extract the last frame of a video as a PNG dataURL (Grok-style extend) */
function extractLastFrame(videoUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    const done = { t: false };
    const fail = (msg) => { if (!done.t) { done.t = true; reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('Timeout extracting frame'), 30000);

    video.addEventListener('error', () => fail('Could not load video for frame extraction (may be blocked by CORS)'));
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.max(0, video.duration - 0.12); }
      catch (e) { fail('Cannot seek video'); }
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 768;
        canvas.height = video.videoHeight || 768;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        const url = canvas.toDataURL('image/png');
        clearTimeout(timer);
        if (!done.t) { done.t = true; resolve(url); }
      } catch (e) {
        clearTimeout(timer);
        fail('Frame extraction blocked (video CORS). ' + e.message);
      }
    });
    video.src = videoUrl;
    video.load();
  });
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
    el.className = 'scene';
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
        <button class="btn btn-sm btn-ghost act-image">🖼 Keyframe image</button>
        <button class="btn btn-sm btn-primary act-generate">▶ Generate</button>
        ${i > 0 || scene.videoUrl ? `<button class="btn btn-sm btn-accent act-extend">➕ Extend</button>` : ''}
        <button class="btn btn-sm btn-danger act-delete">✕</button>
      </div>
    `;

    el.querySelector('.scene-prompt').addEventListener('change', (e) => {
      scene.videoPrompt = e.target.value; saveState();
    });

    el.querySelector('.act-image').addEventListener('click', async () => {
      await generateSceneImage(scene, el);
    });

    el.querySelector('.act-generate').addEventListener('click', async () => {
      scene.videoPrompt = el.querySelector('.scene-prompt').value;
      await generateOneScene(scene, el, true);
    });

    const extBtn = el.querySelector('.act-extend');
    if (extBtn) extBtn.addEventListener('click', async () => {
      await extendFromScene(scene, el);
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
    toast(`Storyboard ready: ${state.scenes.length} scenes`);
  } catch (e) {
    err.textContent = 'Error: ' + e.message;
    err.classList.remove('hidden');
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
 * IMAGE KEYFRAME
 * ===================================================================== */
async function generateSceneImage(scene, el) {
  if (!state.apiKey) { toast('Set API key first', true); return; }
  const prompt = scene.videoPrompt || $('#videoStyle').value.trim();
  if (!prompt) { toast('Write a video prompt first', true); return; }
  const btn = el.querySelector('.act-image');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const url = await generateImage(prompt + (state.settings.videoStyle ? ', style: ' + state.settings.videoStyle : ''), scene.ratio || '16:9');
    scene.keyframeImage = url;
    saveState();
    toast('Keyframe image generated ✓ (used as image-to-video base)');
  } catch (e) {
    toast('Keyframe failed: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '🖼 Keyframe image';
  }
}

/* =====================================================================
 * VIDEO GENERATION
 * ===================================================================== */
async function generateOneScene(scene, el, fresh) {
  if (!state.apiKey) { toast('Set API key first', true); return; }
  if (!scene.videoPrompt.trim()) { toast('Scene prompt is empty', true); return; }

  // if a previous completed scene exists and this is not fresh, try extending from its last frame
  let imageUrl = scene.keyframeImage || null;

  if (!imageUrl) {
    const prev = prevCompletedScene(scene);
    if (prev && prev.videoUrl) {
      setSceneStatus(scene, el, 'extending', 2);
      try {
        const frame = await extractLastFrame(prev.videoUrl);
        const pub = await uploadFrame(frame);
        imageUrl = pub;
        scene.extendFrom = prev.videoUrl;
      } catch (e) {
        toast('Extend from last frame failed, using text-to-video instead: ' + e.message, true);
        imageUrl = null;
      }
    }
  }

  const params = {
    prompt: scene.videoPrompt,
    height: scene.height || 768,
    width: scene.width || 1152,
    num_frames: scene.numFrames || 121,
    frame_rate: scene.frameRate || 24,
  };
  if (imageUrl) {
    params.image = imageUrl;
    params.mode = 'ti2vid';
  }

  setSceneStatus(scene, el, 'queued', 3);
  try {
    const { videoId } = await createVideoTask(params);
    scene.videoId = videoId;
    await pollUntilDone(scene, el);
    renderScenes();
    renderVoiceover();
    updatePlayer();
    toast(`Scene generated ✓ (${scene.seconds || '?'}s)`);
  } catch (e) {
    scene.error = e.message;
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
    let attempts = 0;
    const tick = async () => {
      attempts++;
      if (attempts > 600) return reject(new Error('Timeout waiting for video'));
      try {
        const d = await pollVideo(scene.videoId);
        const status = d.status || '';
        const progress = d.progress != null ? d.progress : (attempts * 5);

        if (status === 'completed') {
          // safety: completed must carry a usable download URL; otherwise keep polling (not done yet)
          if (d.metadata && d.metadata.url) {
            scene.videoUrl = d.metadata.url;
            scene.seconds = d.seconds ? String(parseFloat(d.seconds).toFixed(1)) : scene.seconds;
            setSceneStatus(scene, el, 'completed', 100);
            return resolve(d);
          }
          // completed but no URL yet — treat as still processing, keep waiting
          const p = Math.min(99, Math.max(0, progress));
          setSceneStatus(scene, el, 'progress', p);
          await sleep(10000);
          tick();
          return;
        }
        if (status === 'failed') {
          const em = (d.error && (d.error.message || d.error.code)) || 'Generation failed';
          return reject(new Error(em));
        }

        const p = Math.min(99, Math.max(0, progress));
        setSceneStatus(scene, el, 'progress', p);
        await sleep(10000);
        tick();
      } catch (e) {
        const rl = parseRateLimit(e);
        if (rl) {
          // poll got rate-limited; wait out the window and resume polling
          if (attempts < 20) {
            const waitMs = rl.perMinutes * 60000;
            if (onRateWait) onRateWait(Math.ceil(waitMs / 1000), 'poll', true);
            await sleep(waitMs);
            tick();
          } else return reject(e);
        } else if (attempts < 5) {
          // transient network errors: retry a few times
          await sleep(10000); tick();
        } else return reject(e);
      }
    };
    tick();
  });
}

async function extendFromScene(scene, el) {
  if (!scene.videoUrl) { toast('This scene has no video yet', true); return; }
  if (!state.apiKey) { toast('Set API key first', true); return; }
  const dur = parseInt($('#sceneDuration').value, 10) || 5;
  const ratio = $('#aspectRatio').value;
  const newScene = {
    id: uid(), videoPrompt: 'Continue the previous scene seamlessly: ' + (scene.videoPrompt || ''),
    narrationBn: '', status: 'pending', progress: 0, videoUrl: '', error: '',
    seconds: dur, width: RATIO_SIZES[ratio].width, height: RATIO_SIZES[ratio].height,
    numFrames: DURATION_FRAMES[dur], frameRate: FRAME_RATE, ratio,
  };
  const idx = state.scenes.findIndex(s => s.id === scene.id);
  state.scenes.splice(idx + 1, 0, newScene);
  saveState(); renderScenes(); renderVoiceover();

  // auto-generate the new scene (extends from the previous video's last frame)
  const newEl = $(`.scene[data-id="${newScene.id}"]`);
  await generateOneScene(newScene, newEl, false);
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
  $('#btnGenerateAll').disabled = true;
  $('#btnGenerateAll').textContent = '⏳ Generating…';
  const status = $('#pipelineStatus');
  onRateWait = (secs, kind, retried) => {
    const what = kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'API';
    status.textContent = retried
      ? `Rate limit hit — waiting ${secs}s before retrying ${what}…`
      : `Waiting ${secs}s (${what} rate limit)…`;
  };

  const scenesToRun = state.scenes.filter(s => s.status !== 'completed');
  for (let i = 0; i < scenesToRun.length; i++) {
    const scene = scenesToRun[i];
    const el = $(`.scene[data-id="${scene.id}"]`);
    const num = sceneIndex(scene) + 1;
    status.textContent = `Scene ${num}/${state.scenes.length}: generating… (একটি করে, ধীরে ধীরে)`;
    // refresh prompt from textarea
    if (el) scene.videoPrompt = el.querySelector('.scene-prompt').value;
    try {
      await generateOneScene(scene, el, true);
    } catch (e) {
      // per-scene errors are already surfaced; continue with next scene
    }
    // 5s pause between scenes — as per the requested pacing
    if (i < scenesToRun.length - 1) {
      status.textContent = `Scene ${num}/${state.scenes.length} done — pausing 5s before next scene…`;
      await sleep(5000);
    }
  }

  status.textContent = '✓ Done';
  pipelineRunning = false;
  $('#btnGenerateAll').disabled = false;
  $('#btnGenerateAll').textContent = '▶ Generate full video (sequentially)';
  onRateWait = null;
  updatePlayer();
  toast('Pipeline finished');
});

function sceneIndex(scene) { return state.scenes.findIndex(s => s.id === scene.id); }

$('#btnClearAll').addEventListener('click', () => {
  state.scenes = state.scenes.map(s => ({ ...s, status: 'pending', progress: 0, videoUrl: '', videoId: '', error: '', keyframeImage: undefined, extendFrom: undefined }));
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
