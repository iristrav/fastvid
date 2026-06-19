import fs from "fs";

const base = "https://fastvid-production-dd68.up.railway.app";
const key = "dev-trigger-key-2026";
const videoId = parseInt(process.argv[2] || "198", 10);
const outPath = process.argv[3] || "tmp-video-198.json";

const res = await fetch(`${base}/api/internal/video/${videoId}`, {
  headers: { "x-internal-key": key },
});
const data = await res.json();
fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(JSON.stringify({
  id: data.id,
  status: data.status,
  progressStep: data.progressStep,
  progressPercent: data.progressPercent,
  errorMessage: data.errorMessage,
  durationSec: data.fileProbe?.durationSec,
  sizeBytes: data.fileProbe?.sizeBytes,
  clipCount: (data.videoScenes ?? []).reduce((n, s) => n + (s.clips?.length ?? 0), 0),
}, null, 2));
