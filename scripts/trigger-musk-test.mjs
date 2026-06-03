#!/usr/bin/env node
/** Trigger 2-min Musk documentary test on Railway. */
const base = process.env.FASTVID_API_BASE || "https://fastvid-production-dd68.up.railway.app";
const key = process.env.FASTVID_TRIGGER_KEY || "dev-trigger-key-2026";
const body = {
  prompt: "Elon Musk: Tesla, SpaceX and the future of humanity",
  videoLength: "2",
  videoType: "documentary",
};
const res = await fetch(`${base}/api/internal/generate`, {
  method: "POST",
  headers: { "x-internal-key": key, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
if (json.videoId) {
  const fs = await import("fs");
  fs.writeFileSync("tmp-last-video-id.txt", String(json.videoId));
}
