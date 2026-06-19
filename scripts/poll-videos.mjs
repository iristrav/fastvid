const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";
const ids = process.argv.slice(2).map((x) => parseInt(x, 10)).filter(Boolean);
if (!ids.length) {
  console.error("Usage: node scripts/poll-videos.mjs <id> [id...]");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxMin = Number(process.env.FASTVID_POLL_MAX_MIN || 25);
const deadline = Date.now() + maxMin * 60_000;
const last = {};

async function fetchV(id) {
  const r = await fetch(`${BASE}/api/internal/video/${id}`, { headers: { "x-internal-key": KEY } });
  return r.json();
}

function summarize(v) {
  const qr = v.qualityReport;
  console.log(`\n#${v.id} ${v.title ?? "(no title)"}`);
  console.log(`status: ${v.status} | ${v.progressStep ?? ""} | ${v.progressPercent ?? 0}%`);
  if (v.errorMessage) console.log(`error: ${v.errorMessage}`);
  if (v.fileProbe?.durationSec) console.log(`duration: ${v.fileProbe.durationSec}s`);
  if (v.videoUrl) console.log(`url: ${v.videoUrl}`);
  if (qr) {
    console.log(`quality: ${qr.score}/100 | wiki ${qr.wikimediaCount} arch ${qr.archiveCount} stock ${qr.stockCount}`);
    console.log(`sources: ${JSON.stringify(qr.bySource)}`);
    if (qr.criticalGeoViolations?.length) console.log(`CRITICAL GEO: ${JSON.stringify(qr.criticalGeoViolations)}`);
    if (qr.warnings?.length) console.log(`warnings: ${qr.warnings.join(" | ")}`);
  } else console.log("qualityReport: null");
  const archives = [];
  for (const s of v.videoScenes ?? []) {
    for (const c of s.clips ?? []) {
      if (c.source === "archive") archives.push(c.title);
    }
  }
  if (archives.length) console.log(`archive: ${archives.join(" | ")}`);
}

while (Date.now() < deadline) {
  let allDone = true;
  for (const id of ids) {
    const v = await fetchV(id);
    const step = `${v.progressStep ?? v.status} ${v.progressPercent ?? 0}%`;
    if (step !== last[id]) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] #${id} ${v.status} — ${step}`);
      last[id] = step;
    }
    if (v.status !== "completed" && v.status !== "failed") allDone = false;
    last[`data_${id}`] = v;
  }
  if (allDone) break;
  await sleep(15000);
}

console.log("\n=== FINAL ===");
for (const id of ids) summarize(last[`data_${id}`] ?? {});
