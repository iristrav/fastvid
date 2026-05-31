import 'dotenv/config';
import https from 'https';

const key = process.env.YOUTUBE_API_KEY;
console.log('Key available:', !!key);

const test = (q) => new Promise((res) => {
  const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key + '&q=' + encodeURIComponent(q) + '&type=video&videoLicense=creativeCommon&maxResults=5&part=id';
  https.get(url, (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      try { const j = JSON.parse(d); res(j.pageInfo?.totalResults || 0); }
      catch { res(0); }
    });
  }).on('error', () => res(0));
});

const queries = [
  // Scene-specific queries (current approach — too specific)
  'Elon Musk Architect animated map Pretoria',
  'Elon Musk Zip2 website PayPal',
  // Simpler queries (2-3 words)
  'Elon Musk Pretoria',
  'Elon Musk childhood',
  'Elon Musk South Africa',
  'Elon Musk',
  'Tesla SpaceX',
  'Elon Musk Tesla',
  'Elon Musk SpaceX',
  'Elon Musk interview',
  'Elon Musk speech',
  // Topic-only (no person name)
  'Tesla electric car',
  'SpaceX rocket launch',
  'PayPal payment',
  'Silicon Valley startup',
];

for (const q of queries) {
  const n = await test(q);
  console.log(`Query: "${q}" → ${n} results`);
}
