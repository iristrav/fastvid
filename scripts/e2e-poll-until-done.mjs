#!/usr/bin/env node
/** Poll internal video until completed/failed or timeout. */
const base = process.env.FASTVID_API_BASE || "https://fastvid-production-dd68.up.railway.app";
const key = process.env.FASTVID_TRIGGER_KEY || "dev-trigger-key-2026";
const id = process.argv[2];
const maxMin = Number(process.env.FASTVID_POLL_MAX_MIN || 25);
if (!id) {
  console.error("Usage: node scripts/e2e-poll-until-done.mjs <videoId>");
  process.exit(1);
}
const deadline = Date.now() + maxMin * 60_000;
let lastStep = "";
while (Date.now() < deadline) {
  const res = await fetch(`${base}/api/internal/video/${id}`, { headers: { "x-internal-key": key } });
  const v = await res.json();
  const step = v.progressStep ?? v.status ?? "?";
  const pct = v.progressPercent ?? 0;
  if (step !== lastStep) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${v.status} ${pct}% — ${step}`);
    lastStep = step;
  }
  if (v.status === "completed") {
    console.log("\n✅ DONE", v.videoUrl ?? "(no url)");
    process.exit(0);
  }
  if (v.status === "failed") {
    console.error("\n❌ FAILED", v.errorMessage ?? v.progressStep);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 12_000));
}
console.error(`\n⏰ Timeout after ${maxMin} min`);
process.exit(2);
