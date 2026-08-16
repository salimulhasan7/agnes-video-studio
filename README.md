# 🎬 Agnes Video Studio

দীর্ঘ ফরম্যাট ভিডিও বানানোর ওয়েব টুল — Agnes AI API (agnes-video-v2.0) দিয়ে। Long-format AI video maker with a Grok-style **Extend** feature and **Bangla voiceover**.

## Features

- **Text-to-video / image-to-video / keyframe animation** using Agnes Video V2.0 (free API)
- **AI Storyboard**: বাংলা বা ইংরেজি গল্প লিখুন, AI সেটিকে scene-এ ভাগ করবে (প্রতি scene-এর জন্য video prompt + বাংলা narration)
- **Grok-style Extend**: প্রতিটি নতুন clip আগের clip-এর *শেষ ফ্রেম* থেকে শুরু হয় — একটানা লম্বা ভিডিও তৈরি হয়
- **Keyframe image**: `agnes-image-2.1-flash` দিয়ে প্রতি scene-এর জন্য স্টার্টিং ইমেজ বানান
- **Sequential player**: সব clip একসাথে চালিয়ে পুরো ভিডিও প্রিভিউ
- **Bangla voiceover**: গুগল TTS (bn) + ব্রাউজারের বাংলা ভয়েস দিয়ে প্রতি scene-এর narration শোনা/ডাউনলোড

## How it works

Agnes Video V2.0 একটি asynchronous API — আগে task তৈরি হয়, পরে `video_id` দিয়ে ফলাফল আনা হয়। প্রতিটি video clip সর্বোচ্চ ~18 সেকেন্ড (`num_frames ≤ 441`, `8n+1` নিয়ম)। তাই "লম্বা ভিডিও" বানাতে:

1. Scene-গুলো **sequence** অনুযায়ী generate হয়
2. পরের scene-এর শুরুতে আগের video-এর **শেষ ফ্রেম** extract করে সেটাকে input image হিসেবে পাঠানো হয় (`mode: ti2vid`)
3. ফলে clip-গুলো একটানা দেখায় — পুরোটাই একটি লম্বা ভিডিওর মতো

## Local run

Static site — যেকোনো static server দিয়ে চালান:

```bash
python3 -m http.server 8080
# অথবা
npx serve .
```

## Deploy to git (GitHub Pages)

যেহেতু এটি সম্পূর্ণ static, GitHub Pages-এ ফ্রি হোস্ট করা যায় — কোনো backend লাগে না।

```bash
git add -A
git commit -m "Add Agnes Video Studio"
git push origin main
```

তারপর GitHub repo-র **Settings → Pages** এ গিয়ে source হিসেবে `main` branch (root folder) বেছে দিন। কয়েক মিনিটে লাইভ লিংক পাবেন:

```
https://<your-username>.github.io/<repo-name>/
```

**ব্যপারটা জানা ভালো:** GitHub Pages-এর `*.github.io` ডোমেইন থেকে Agnes API-তে সরাসরি request যাবে (CORS খোলা আছে)। API key শুধু আপনার ব্রাউজারের `localStorage`-এ থাকবে — কোডে হার্ডকোড করা নেই, তাই repository-তে key প্রকাশ হবে না।

## API Key

- Agnes AI-এর [কনসোল](https://agnes-ai.com) থেকে ফ্রি API key নিন
- সাইটে গিয়ে উপরে API key বসান → **Test key** চাপুন
- key ব্রাউজারে সেভ থাকে

## Tech notes

- Models: `agnes-video-v2.0`, `agnes-image-2.1-flash`, `agnes-2.5-flash`
- API Base: `https://apihub.agnes-ai.com`
- Video create: `POST /v1/videos`
- Video result: `GET /agnesapi?video_id=...`
- Frame upload: `tmpfiles.org` (public URL-এ last frame আপলোড করে extend-এ ব্যবহার)
- Voiceover: Google Translate TTS (`translate.googleapis.com/translate_tts?tl=bn`) + Web Speech API

## Note

Agnes API বর্তমানে **$0/second** ভিডিও প্রাইসে আছে (বিনামূল্যে)। Free account-এ RPM limit থাকতে পারে — অনেক scene generate করলে কিছুক্ষণ অপেক্ষা করুন।
