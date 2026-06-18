#!/usr/bin/env node
/**
 * Production health + optional latest video quality check.
 * Usage: node scripts/check-production-health.mjs [videoId]
 */
const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const INTERNAL_KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";

async function main() {
  const videoId = process.argv[2];

  console.log(`\n── Health: ${BASE}/api/health`);
  const healthRes = await fetch(`${BASE}/api/health`);
  const health = await healthRes.json();
  console.log(JSON.stringify(health, null, 2));

  const ok =
    health.status === "ok" &&
    health.llm?.provider &&
    health.llm.provider !== "none" &&
    health.worker?.ok !== false;
  console.log(ok ? "\n✓ Health looks good" : "\n✗ Health degraded — check worker + LLM keys");

  if (!videoId) {
    console.log("\nTip: pass a video ID to inspect qualityReport:");
    console.log("  node scripts/check-production-health.mjs 291");
    return;
  }

  console.log(`\n── Video #${videoId}`);
  const vidRes = await fetch(`${BASE}/api/internal/video/${videoId}`, {
    headers: { "x-internal-key": INTERNAL_KEY },
  });
  if (!vidRes.ok) {
    console.error("Video fetch failed:", vidRes.status, await vidRes.text());
    process.exit(1);
  }
  const video = await vidRes.json();
  console.log("status:", video.status);
  console.log("title:", video.title);
  if (video.qualityReport) {
    console.log("\nqualityReport:");
    console.log(JSON.stringify(video.qualityReport, null, 2));
  } else {
    console.log("\n(no qualityReport — video generated before bf8191a or metadata missing)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
