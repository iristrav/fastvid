import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mysql from 'mysql2/promise';

dotenv.config();

const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-test-'));

// 6 scenes (MAX_SCENES = 6, same as pipeline)
const scenes = [
  "Ancient DNA has revolutionized our understanding of Viking history. Scientists can now extract genetic material from 1000-year-old bones and sequence entire genomes.",
  "The Vikings were not a single unified people but a diverse collection of Scandinavian tribes with different genetic backgrounds and cultural traditions.",
  "New research shows that many Vikings had dark hair, contradicting the popular image of blond warriors from the north that has dominated popular culture.",
  "Viking women played a more active role in society than previously thought, with some even serving as warriors, traders, and community leaders.",
  "The genetic evidence reveals extensive Viking trade networks stretching from North America all the way to Central Asia and the Middle East.",
  "DNA analysis of burial sites shows that Vikings frequently intermarried with local populations wherever they settled, creating diverse communities."
];

async function generateVoiceover(text, outputPath, voiceId) {
  const truncated = text.slice(0, 400);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25_000);
      const response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: truncated, reference_id: voiceId, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        continue;
      }
      if (!response.ok) { console.warn(`  Scene failed: HTTP ${response.status}`); return 5; }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outputPath, buffer);
      return buffer.length;
    } catch (err) {
      if (attempt === 1) { console.warn(`  Scene error: ${err.message}`); return 0; }
    }
  }
  return 0;
}

// Get real voice ID
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute('SELECT fishAudioReferenceId FROM voices WHERE name = "Michael" LIMIT 1');
await conn.end();
const voiceId = rows[0]?.fishAudioReferenceId;
console.log(`Voice ID: ${voiceId}`);
console.log(`Testing ${scenes.length} scenes fully parallel...`);

const start = Date.now();
const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}.mp3`));
const sizes = await Promise.all(scenes.map((text, i) => generateVoiceover(text, audioPaths[i], voiceId)));
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

const successCount = sizes.filter(s => s > 0).length;
const totalKB = sizes.reduce((a, b) => a + b, 0) / 1024;

console.log(`\n✅ RESULT: ${elapsed}s for ${scenes.length} scenes`);
console.log(`   Success: ${successCount}/${scenes.length}`);
console.log(`   Total audio data: ${totalKB.toFixed(0)} KB`);
console.log(`   Under 2 min: ${parseFloat(elapsed) < 120 ? 'YES ✅' : 'NO ❌'}`);

fs.rmSync(workDir, { recursive: true });
