/**
 * Wait for deploy, trigger English 1-min NL-vs-US test, poll until done.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";
const TARGET = process.env.DEPLOY_COMMIT || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payload = JSON.parse(
  fs.readFileSync(path.join(__dirname, "trigger-en-1min-test.json"), "utf8")
);

async function waitDeploy() {
  if (!TARGET) {
    console.log("[deploy] skip wait (no DEPLOY_COMMIT)");
    return true;
  }
  for (let i = 0; i < 48; i++) {
    try {
      const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(20_000) });
      const j = await h.json();
      const c = j.deploy?.gitCommit?.slice(0, 7);
      console.log(`[deploy] ${c ?? "unknown"}`);
      if (j.deploy?.gitCommit?.startsWith(TARGET) || c === TARGET.slice(0, 7)) return true;
    } catch (e) {
      console.log(`[deploy] health error: ${e.message?.slice(0, 60)}`);
    }
    await sleep(15_000);
  }
  return false;
}

async function trigger() {
  const res = await fetch(`${BASE}/api/internal/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": KEY },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(j));
  console.log(`[trigger] English 1-min video #${j.videoId}`);
  return j.videoId;
}

async function poll(id) {
  const deadline = Date.now() + 35 * 60_000;
  let last = "";
  const started = Date.now();
  while (Date.now() < deadline) {
    const v = await fetch(`${BASE}/api/internal/video/${id}`, {
      headers: { "x-internal-key": KEY },
      signal: AbortSignal.timeout(20_000),
    }).then((r) => r.json());
    const step = `${v.status} ${v.progressStep ?? ""} ${v.progressPercent ?? 0}%`;
    if (step !== last) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`[#${id}] ${elapsed}s — ${step}`);
      last = step;
    }
    if (v.status === "completed" || v.status === "failed") return v;
    await sleep(15_000);
  }
  throw new Error(`timeout #${id}`);
}

function grade(v) {
  const qr = v.qualityReport;
  console.log(`\n=== #${v.id} ${v.title?.slice(0, 70)} ===`);
  console.log(`status: ${v.status}`);
  if (v.errorMessage) console.log(`error: ${v.errorMessage}`);
  if (v.fileProbe?.durationSec) console.log(`duration: ${v.fileProbe.durationSec}s`);
  if (v.videoUrl) console.log(`url: ${v.videoUrl}`);
  if (qr) {
    console.log(
      `quality: ${qr.score}/100 archive=${qr.archiveCount} stock=${qr.stockCount}`
    );
    console.log(`sources: ${JSON.stringify(qr.bySource)}`);
  }
  const ok =
    v.status === "completed" &&
    (v.fileProbe?.durationSec ?? 0) >= 50 &&
    (qr?.archiveCount ?? 0) + (qr?.stockCount ?? 0) > 0;
  console.log(`grade: ${ok ? "PASS" : "NEEDS WORK"}`);
  return ok;
}

const deployed = await waitDeploy();
if (!deployed) {
  console.error("Deploy not ready");
  process.exit(2);
}

const id = await trigger();
const result = await poll(id);
const pass = grade(result);
process.exit(pass ? 0 : 1);
