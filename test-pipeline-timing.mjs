import { createConnection } from 'mysql2/promise';

const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Get the voice ID from DB
const conn = await createConnection(DATABASE_URL);
const [voices] = await conn.execute('SELECT fishAudioReferenceId FROM voices WHERE isActive = 1 LIMIT 1');
await conn.end();
const voiceId = voices[0]?.fishAudioReferenceId;
console.log('Voice ID:', voiceId);

// Simulate 8 scenes with 400-char texts (like the pipeline does)
const sceneTexts = [
  "Ancient DNA has completely rewritten everything we thought we knew about the Vikings. For centuries, historians painted them as blonde Scandinavian warriors who raided coastal villages.",
  "The genetic study analyzed over 442 ancient genomes from Viking Age burial sites across Scandinavia, the British Isles, and Eastern Europe.",
  "Researchers discovered that many individuals buried with Viking weapons and artifacts were actually of Southern European or Asian genetic origin.",
  "This challenges the popular image of the blonde, blue-eyed Norse warrior that has dominated popular culture for centuries.",
  "The Vikings were not a homogeneous ethnic group but rather a diverse collection of peoples united by culture, language, and seafaring tradition.",
  "Trade routes extended from the Arctic Circle to Constantinople, bringing genetic material from dozens of different populations into Scandinavia.",
  "Modern Scandinavians actually share less DNA with ancient Vikings than previously assumed, suggesting significant population replacement over the centuries.",
  "This research fundamentally changes our understanding of early medieval Europe and the complex movements of peoples across the continent.",
];

async function generateOne(text, index, voiceId) {
  const start = Date.now();
  const body = { text, format: 'mp3', model: 's2-pro', mp3_bitrate: 128 };
  if (voiceId) body.reference_id = voiceId;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  
  try {
    const r = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${FISH_AUDIO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const buf = Buffer.from(await r.arrayBuffer());
    const elapsed = Date.now() - start;
    console.log(`  Scene ${index}: ${r.status} | ${buf.length} bytes | ${elapsed}ms`);
    return elapsed;
  } catch (e) {
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    console.log(`  Scene ${index}: ERROR ${e.message} | ${elapsed}ms`);
    return elapsed;
  }
}

// Test 1: All 8 in parallel (no p-limit)
console.log('\n=== Test 1: All 8 scenes in parallel (no concurrency limit) ===');
const t1start = Date.now();
await Promise.all(sceneTexts.map((text, i) => generateOne(text, i, voiceId)));
console.log(`Total time (parallel): ${Date.now() - t1start}ms`);

// Test 2: Batches of 3 (current approach with p-limit)
console.log('\n=== Test 2: Batches of 3 (current p-limit approach) ===');
const t2start = Date.now();
let queue = [...sceneTexts.entries()];
while (queue.length > 0) {
  const batch = queue.splice(0, 3);
  await Promise.all(batch.map(([i, text]) => generateOne(text, i, voiceId)));
}
console.log(`Total time (batches of 3): ${Date.now() - t2start}ms`);
