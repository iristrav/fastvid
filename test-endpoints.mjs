import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/nexiasafe-video/.env' });

const KEY = process.env.RAPIDAPI_KEY;
const VIDEO_ID = 'Kc6ZJw3r9wc';
const HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';

const endpoints = [
  `/stream?id=${VIDEO_ID}`,
  `/download?id=${VIDEO_ID}`,
  `/mp4?id=${VIDEO_ID}`,
  `/proxy?id=${VIDEO_ID}`,
  `/video?id=${VIDEO_ID}`,
  `/dl?id=${VIDEO_ID}&format=18`,
  `/dl?id=${VIDEO_ID}&download=true`,
  `/dl/${VIDEO_ID}`,
  `/${VIDEO_ID}`,
];

for (const ep of endpoints) {
  try {
    const resp = await fetch(`https://${HOST}${ep}`, {
      headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY },
    });
    const ct = resp.headers.get('content-type') || '';
    const cl = resp.headers.get('content-length') || '?';
    console.log(`${ep} -> ${resp.status} ct=${ct} cl=${cl}`);
    if (resp.ok && ct.startsWith('video/')) {
      console.log('  -> VIDEO BYTES!');
    } else if (resp.status === 404) {
      // skip
    } else {
      const text = await resp.text();
      console.log(`  body: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`${ep} -> ERROR ${err.message}`);
  }
}
