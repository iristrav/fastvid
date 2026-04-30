import "dotenv/config";

const API_KEY = process.env.FISH_AUDIO_API_KEY;
const VOICE_ID = "54a5170264694bfc8e9ad98df7bd89c3"; // Michael (real ID from DB)

console.log("Fish Audio API Key:", !!API_KEY, API_KEY ? API_KEY.substring(0, 8) + "..." : "MISSING");

const scenes = [
  "Ancient DNA has revolutionized our understanding of Viking history.",
  "New genetic studies reveal Vikings were far more diverse than thought.",
  "Archaeological evidence combined with DNA paints a complex picture.",
  "Viking trade routes stretched from North America to the Middle East.",
  "The truth about Viking appearance challenges popular media portrayals.",
  "DNA from burial sites reveals surprising connections to other cultures.",
  "Modern Scandinavians share only a fraction of DNA with ancient Norse.",
  "Viking genetic influence can still be traced in populations across Europe."
];

async function generateOne(text, index) {
  const start = Date.now();
  const body = {
    text,
    format: "mp3",
    model: "s2-pro",
    mp3_bitrate: 128,
    reference_id: VOICE_ID,
    latency: "normal",
  };
  try {
    const resp = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - start;
    const buf = await resp.arrayBuffer();
    const total = Date.now() - start;
    console.log(`  Scene ${index}: HTTP ${resp.status}, ${buf.byteLength} bytes, response=${elapsed}ms, total=${total}ms`);
    return total;
  } catch (e) {
    const elapsed = Date.now() - start;
    console.log(`  Scene ${index}: ERROR after ${elapsed}ms: ${e.message}`);
    return elapsed;
  }
}

// Test 1: Single scene
console.log("\n=== TEST 1: Single scene ===");
let t = Date.now();
await generateOne(scenes[0], 0);
console.log(`Single: ${Date.now() - t}ms`);

// Test 2: All 8 parallel
console.log("\n=== TEST 2: All 8 PARALLEL ===");
t = Date.now();
await Promise.all(scenes.map((s, i) => generateOne(s, i)));
console.log(`All 8 parallel TOTAL: ${Date.now() - t}ms`);

// Test 3: Try with latency: "balanced" (faster mode)
console.log("\n=== TEST 3: Single scene with latency=balanced ===");
t = Date.now();
const resp3 = await fetch("https://api.fish.audio/v1/tts", {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text: scenes[0], format: "mp3", model: "s2-pro", mp3_bitrate: 128, reference_id: VOICE_ID, latency: "balanced" }),
});
const buf3 = await resp3.arrayBuffer();
console.log(`  HTTP ${resp3.status}, ${buf3.byteLength} bytes, ${Date.now() - t}ms`);

// Test 4: Streaming response (read as stream instead of arrayBuffer)
console.log("\n=== TEST 4: Single scene with streaming read ===");
t = Date.now();
const resp4 = await fetch("https://api.fish.audio/v1/tts", {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text: scenes[0], format: "mp3", model: "s2-pro", mp3_bitrate: 128, reference_id: VOICE_ID }),
});
const firstByteTime = Date.now() - t;
const buf4 = await resp4.arrayBuffer();
console.log(`  HTTP ${resp4.status}, first byte: ${firstByteTime}ms, total: ${Date.now() - t}ms, ${buf4.byteLength} bytes`);
