#!/usr/bin/env node
/** Trigger 2-min Kylie documentary test on Railway. */
import fs from "fs";
const base = process.env.FASTVID_API_BASE || "https://fastvid-production-dd68.up.railway.app";
const key = process.env.FASTVID_TRIGGER_KEY || "dev-trigger-key-2026";
const body = JSON.parse(
  fs.readFileSync(new URL("./trigger-body-kylie.json", import.meta.url), "utf8")
);
const res = await fetch(`${base}/api/internal/generate`, {
  method: "POST",
  headers: { "x-internal-key": key, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
if (json.videoId) {
  fs.writeFileSync("tmp-last-video-id.txt", String(json.videoId));
}
