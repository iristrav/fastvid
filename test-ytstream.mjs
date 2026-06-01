// Test multiple RapidAPI YouTube downloaders to find one that works
import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/nexiasafe-video/.env' });

const KEY = process.env.RAPIDAPI_KEY;
console.log('RAPIDAPI_KEY set:', !!KEY, 'len:', (KEY || '').length);

const VIDEO_ID = 'Kc6ZJw3r9wc'; // known short Elon Musk Fox News interview

const apis = [
  {
    name: 'ytstream-download-youtube-videos',
    host: 'ytstream-download-youtube-videos.p.rapidapi.com',
    url: `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${VIDEO_ID}`,
  },
  {
    name: 'youtube-video-fast-downloader-24-7',
    host: 'youtube-video-fast-downloader-24-7.p.rapidapi.com',
    url: `https://youtube-video-fast-downloader-24-7.p.rapidapi.com/download_video/${VIDEO_ID}`,
  },
  {
    name: 'youtube-media-downloader',
    host: 'youtube-media-downloader.p.rapidapi.com',
    url: `https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${VIDEO_ID}`,
  },
  {
    name: 'youtube-to-mp4',
    host: 'youtube-to-mp4.p.rapidapi.com',
    url: `https://youtube-to-mp4.p.rapidapi.com/url?id=${VIDEO_ID}`,
  },
  {
    name: 'cloud-api-hub-youtube-downloader',
    host: 'cloud-api-hub-youtube-downloader.p.rapidapi.com',
    url: `https://cloud-api-hub-youtube-downloader.p.rapidapi.com/dl?id=${VIDEO_ID}`,
  },
];

for (const api of apis) {
  try {
    const t0 = Date.now();
    const resp = await fetch(api.url, {
      headers: {
        'x-rapidapi-host': api.host,
        'x-rapidapi-key': KEY,
      },
    });
    const text = await resp.text();
    console.log(`\n=== ${api.name} ===`);
    console.log(`HTTP ${resp.status} (${Date.now() - t0}ms)`);
    console.log(text.slice(0, 800));
  } catch (err) {
    console.log(`\n=== ${api.name} ===`);
    console.log('ERROR:', err.message);
  }
}
