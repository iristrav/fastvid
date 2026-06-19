const ALLOWED = new Set([
  "Script schrijven",
  "Voiceover genereren",
  "Beelden zoeken",
  "Montage editten",
  "Effecten toevoegen",
  "Video afronden",
]);
const GRANULAR = /scene \d+\/\d+|beat \d|tick \d|backfill/i;
const base = "https://fastvid-production-dd68.up.railway.app";
const key = "dev-trigger-key-2026";
const videoId = parseInt(process.argv[2] || "201", 10);

const seenSteps = new Set();
const seenLog = new Set();
let lastStatus = "";

for (let i = 0; i < 40; i++) {
  const res = await fetch(`${base}/api/internal/video/${videoId}`, {
    headers: { "x-internal-key": key },
  });
  const data = await res.json();
  lastStatus = data.status;
  if (data.progressStep) seenSteps.add(data.progressStep);
  for (const e of data.progressLog ?? []) {
    if (e?.step) seenLog.add(e.step);
  }
  console.log(
    JSON.stringify({
      poll: i,
      status: data.status,
      progressStep: data.progressStep,
      percent: data.progressPercent,
      log: (data.progressLog ?? []).map((e) => e.step),
    })
  );
  if (data.status === "completed" || data.status === "failed") break;
  await new Promise((r) => setTimeout(r, 15000));
}

let failed = false;
for (const step of [...seenSteps, ...seenLog]) {
  if (GRANULAR.test(step)) {
    console.error("FAIL granular:", step);
    failed = true;
  }
  if (!ALLOWED.has(step) && !/complete|failed|retry|timeout|starting|approved/i.test(step)) {
    console.error("FAIL unknown label:", step);
    failed = true;
  }
}

console.log("\nSeen progressStep:", [...seenSteps]);
console.log("Seen progressLog:", [...seenLog]);
console.log("Final:", lastStatus);
process.exit(failed ? 1 : 0);
