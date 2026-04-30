import { createConnection } from 'mysql2/promise';

const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!FISH_AUDIO_API_KEY) {
  console.error('FISH_AUDIO_API_KEY not set in environment');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set in environment');
  process.exit(1);
}

// Get voices from DB
const conn = await createConnection(DATABASE_URL);
const [voices] = await conn.execute('SELECT name, fishAudioReferenceId FROM voices WHERE isActive = 1 LIMIT 3');
await conn.end();

console.log('Voices in DB:');
voices.forEach(v => console.log(`  ${v.name}: ${v.fishAudioReferenceId}`));

// Test Fish Audio with first voice
const voice = voices[0];
const text = 'Ancient DNA has completely rewritten everything we thought we knew about the Vikings. For centuries, historians painted them as blonde Scandinavian warriors.';

console.log(`\nTesting Fish Audio with voice: ${voice?.name} (${voice?.fishAudioReferenceId})`);
console.log(`Text: ${text.length} chars, ${text.split(' ').length} words`);

const start = Date.now();
const body = { text, format: 'mp3', model: 's2-pro', mp3_bitrate: 128 };
if (voice?.fishAudioReferenceId) body.reference_id = voice.fishAudioReferenceId;

const response = await fetch('https://api.fish.audio/v1/tts', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${FISH_AUDIO_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const buf = Buffer.from(await response.arrayBuffer());
const elapsed = Date.now() - start;
console.log(`Status: ${response.status} | Size: ${buf.length} bytes | Time: ${elapsed}ms`);
if (!response.ok) console.log('Error:', buf.toString().slice(0, 300));
else console.log(`SUCCESS! ${Math.round(buf.length/1024)}KB audio in ${elapsed}ms`);

// Test WITHOUT reference_id (default voice)
console.log('\nTesting Fish Audio WITHOUT reference_id (default voice)...');
const start2 = Date.now();
const response2 = await fetch('https://api.fish.audio/v1/tts', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${FISH_AUDIO_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ text, format: 'mp3', model: 's2-pro', mp3_bitrate: 128 }),
});
const buf2 = Buffer.from(await response2.arrayBuffer());
const elapsed2 = Date.now() - start2;
console.log(`Status: ${response2.status} | Size: ${buf2.length} bytes | Time: ${elapsed2}ms`);
if (!response2.ok) console.log('Error:', buf2.toString().slice(0, 300));
else console.log(`SUCCESS! ${Math.round(buf2.length/1024)}KB audio in ${elapsed2}ms`);
