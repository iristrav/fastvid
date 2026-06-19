import fs from "fs";
import { PIPELINE_DISPLAY_STAGES } from "../shared/pipelineProgress.ts";

const base = "https://fastvid-production-dd68.up.railway.app";
const key = "dev-trigger-key-2026";
const allowed = new Set(PIPELINE_DISPLAY_STAGES.map((s) => s.label));
const granular = /scene \d+\/\d+|beat \d|tick \d|backfill/i;

const startRes = await fetch(`${base}/api/internal/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-key": key },
  body: fs.readFileSync("tmp-generate-1min.json", "utf8"),
});
const start = await startRes.json();
const videoId = start.videoId;
if (!videoId) {
  console.error("Failed to start:", start);
  process.exit(1);
}
console.log("Started video", videoId);

const seenSteps = new Set();
const seenLogSteps = new Set();
let lastStatus = "";

for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const res = await fetch(`${base}/api/internal/video/${videoId}`, {
    headers: { "x-internal-key": key },
  });
  const data = await res.json();
  lastStatus = data.status;
  if (data.progressStep) seenSteps.add(data.progressStep);
  for (const entry of data.progressLog ?? []) {
    if (entry?.step) seenLogSteps.add(entry.step);
  }
  console.log(
    JSON.stringify({
      i,
      status: data.status,
      progressStep: data.progressStep,
      progressPercent: data.progressPercent,
      logSteps: (data.progressLog ?? []).map((e) => e.step),
    })
  );

  if (data.status === "completed" || data.status === "failed" || data.status === "error") break;
}

let failed = false;
for (const step of [...seenSteps, ...seenLogSteps]) {
  if (granular.test(step)) {
    console.error("FAIL granular progress text:", step);
    failed = true;
  }
  if (!allowed.has(step) && step !== "Video complete!" && !/failed|retry|timeout/i.test(step)) {
    console.error("FAIL unknown progress label:", step);
    failed = true;
  }
}

console.log("\nUnique progressStep values:", [...seenSteps]);
console.log("Unique progressLog steps:", [...seenLogSteps]);
console.log("Final status:", lastStatus);

if (failed) process.exit(1);
if (lastStatus !== "completed") {
  console.warn("WARN: generation did not complete (status:", lastStatus, ")");
}
console.log("\n✅ Production progress uses coarse stages only");
