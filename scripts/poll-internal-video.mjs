#!/usr/bin/env node
/** Poll Railway internal video status. Usage: node scripts/poll-internal-video.mjs [id] */
const base = process.env.FASTVID_API_BASE || "https://fastvid-production-dd68.up.railway.app";
const key = process.env.FASTVID_TRIGGER_KEY || "dev-trigger-key-2026";
const id = process.argv[2] || process.env.FASTVID_VIDEO_ID;
if (!id) {
  console.error("Usage: node scripts/poll-internal-video.mjs <videoId>");
  process.exit(1);
}
const res = await fetch(`${base}/api/internal/video/${id}`, {
  headers: { "x-internal-key": key },
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
