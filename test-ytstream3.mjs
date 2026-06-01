// Re-test: maybe the URL is only IP-locked for *cross-origin* requests, but works
// if we set the right headers. Try multiple header combos.
import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/nexiasafe-video/.env' });

const KEY = process.env.RAPIDAPI_KEY;
const VIDEO_ID = 'Kc6ZJw3r9wc';

const resp = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${VIDEO_ID}`, {
  headers: {
    'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com',
    'x-rapidapi-key': KEY,
  },
});
const data = await resp.json();

// Try the smallest combined format
const fmt = data.formats[0];
console.log('Testing itag', fmt.itag, 'size', fmt.contentLength);
console.log('URL host:', new URL(fmt.url).hostname);

const headerCombos = [
  { label: 'no headers', headers: {} },
  { label: 'YouTube UA', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } },
  { label: 'Range bytes=0-1000000', headers: { 'Range': 'bytes=0-1000000', 'User-Agent': 'Mozilla/5.0' } },
  { label: 'with Referer', headers: { 'Referer': 'https://www.youtube.com/', 'User-Agent': 'Mozilla/5.0' } },
];

for (const { label, headers } of headerCombos) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    const t0 = Date.now();
    const dl = await fetch(fmt.url, { signal: ctrl.signal, headers });
    console.log(`${label}: HTTP ${dl.status} in ${Date.now() - t0}ms`);
    if (dl.ok) {
      // Read first 100KB
      const reader = dl.body.getReader();
      let total = 0;
      while (total < 200000) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
      }
      console.log(`  -> read ${total} bytes successfully`);
      try { reader.cancel(); } catch {}
    }
    clearTimeout(tid);
  } catch (err) {
    console.log(`${label}: ERROR ${err.message}`);
  }
}
