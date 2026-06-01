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
console.log('Keys:', Object.keys(data));
console.log('status:', data.status);
console.log('title:', data.title);
console.log('lengthSeconds:', data.lengthSeconds);
console.log('formats count:', data.formats?.length);
console.log('adaptiveFormats count:', data.adaptiveFormats?.length);
if (data.formats?.length) {
  console.log('\n=== formats (combined audio+video) ===');
  for (const f of data.formats.slice(0, 8)) {
    console.log(`  itag=${f.itag} mimeType="${f.mimeType?.slice(0, 40)}" qualityLabel=${f.qualityLabel} contentLength=${f.contentLength} url=${(f.url || '').slice(0, 80)}...`);
  }
}
if (data.adaptiveFormats?.length) {
  console.log('\n=== adaptiveFormats (video-only or audio-only) ===');
  for (const f of data.adaptiveFormats.slice(0, 10)) {
    console.log(`  itag=${f.itag} mimeType="${f.mimeType?.slice(0, 40)}" qualityLabel=${f.qualityLabel} contentLength=${f.contentLength}`);
  }
}

// Try downloading the smallest combined format
if (data.formats?.length) {
  const smallest = [...data.formats].filter(f => f.url && f.mimeType?.includes('mp4'))
    .sort((a, b) => (parseInt(a.contentLength || '0')) - (parseInt(b.contentLength || '0')))[0];
  if (smallest) {
    console.log(`\nDownloading smallest mp4: itag=${smallest.itag} size=${smallest.contentLength}`);
    const t0 = Date.now();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 30000);
    try {
      const dl = await fetch(smallest.url, { signal: ctrl.signal });
      console.log('Download HTTP:', dl.status, 'in', Date.now() - t0, 'ms');
      if (dl.ok) {
        const buf = Buffer.from(await dl.arrayBuffer());
        console.log('Downloaded', buf.length, 'bytes');
        const fs = await import('fs');
        fs.writeFileSync('/tmp/rapidapi_test.mp4', buf);
        console.log('Saved to /tmp/rapidapi_test.mp4');
      }
    } catch (err) {
      console.log('Download error:', err.message);
    } finally {
      clearTimeout(tid);
    }
  }
}
