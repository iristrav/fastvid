const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";
const TARGET = process.env.DEPLOY_COMMIT || "ea641ef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDeploy() {
  for (let i = 0; i < 40; i++) {
    const h = await fetch(`${BASE}/api/health`).then((r) => r.json());
    const c = h.deploy?.gitCommit;
    console.log(`[deploy] ${c}`);
    if (c === TARGET) return true;
    await sleep(15000);
  }
  return false;
}

async function trigger(prompt, label) {
  const res = await fetch(`${BASE}/api/internal/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": KEY },
    body: JSON.stringify({ prompt, videoLength: "1", videoType: "documentary" }),
  });
  const j = await res.json();
  console.log(`${label}: #${j.videoId}`);
  return j.videoId;
}

async function poll(id) {
  const deadline = Date.now() + 25 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const v = await fetch(`${BASE}/api/internal/video/${id}`, {
      headers: { "x-internal-key": KEY },
    }).then((r) => r.json());
    const step = `${v.progressStep ?? v.status} ${v.progressPercent ?? 0}%`;
    if (step !== last) {
      console.log(`[#${id}] ${v.status} — ${step}`);
      last = step;
    }
    if (v.status === "completed" || v.status === "failed") return v;
    await sleep(15000);
  }
  throw new Error(`timeout #${id}`);
}

function summarize(v) {
  console.log(`\n=== #${v.id} ${v.title} ===`);
  console.log(`status: ${v.status}`);
  if (v.errorMessage) console.log(`error: ${v.errorMessage}`);
  if (v.fileProbe?.durationSec) console.log(`duration: ${v.fileProbe.durationSec}s`);
  if (v.videoUrl) console.log(`url: ${v.videoUrl}`);
  const qr = v.qualityReport;
  if (qr) {
    console.log(`quality: ${qr.score}/100 wiki=${qr.wikimediaCount} arch=${qr.archiveCount} stock=${qr.stockCount}`);
    console.log(`sources: ${JSON.stringify(qr.bySource)}`);
    if (qr.criticalGeoViolations?.length) {
      console.log(`geo warnings: ${JSON.stringify(qr.criticalGeoViolations.slice(0, 3))}`);
    }
  } else console.log("qualityReport: null");
  const archives = [];
  for (const s of v.videoScenes ?? []) {
    for (const c of s.clips ?? []) {
      if (c.source === "archive") archives.push(c.title);
    }
  }
  if (archives.length) console.log(`archive clips: ${archives.join(" | ")}`);
}

const ok = await waitDeploy();
if (!ok) {
  console.error(`Deploy ${TARGET} not ready`);
  process.exit(2);
}

const nl = await trigger(
  "Why the Netherlands Is the Opposite of the U.S. — compare Dutch cycling infrastructure, compact cities and public transit with American suburban sprawl and car dependency. Documentary tone.",
  "NL-vs-US"
);
const sg = await trigger(
  "Why Singapore Is a Model for Urban Living. Explain HDB public housing, MRT metro, urban planning, Marina Bay, hawker centers, and walkable neighborhoods. Documentary tone with specific place names.",
  "Singapore"
);

const [r1, r2] = await Promise.all([poll(nl), poll(sg)]);
summarize(r1);
summarize(r2);
process.exit(r1.status === "completed" && r2.status === "completed" ? 0 : 1);
