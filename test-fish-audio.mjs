import "dotenv/config";

const key = process.env.FISH_AUDIO_API_KEY;
console.log("Key present:", !!key, key ? key.substring(0, 8) + "..." : "MISSING");

const referenceId = "802e3bc2b27e49c2995d23ef70e6ac89";

try {
  const r = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "Hello, this is a test.",
      reference_id: referenceId,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
    }),
    signal: AbortSignal.timeout(30000),
  });

  console.log("Status:", r.status, r.statusText);
  const contentType = r.headers.get("content-type");
  console.log("Content-Type:", contentType);

  if (!r.ok) {
    const txt = await r.text();
    console.log("Error body:", txt);
  } else {
    const buf = await r.arrayBuffer();
    console.log("Success! Audio bytes:", buf.byteLength);
  }
} catch (e) {
  console.error("Fetch error:", e.message);
}
