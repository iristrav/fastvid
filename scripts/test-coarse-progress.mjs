import fs from "fs";
import { PIPELINE_DISPLAY_STAGES, resolvePipelineDisplayStage } from "../shared/pipelineProgress.ts";

const allowedLabels = new Set(PIPELINE_DISPLAY_STAGES.map((s) => s.label));
const granular = /scene \d+\/\d+|beat \d|tick \d|backfill/i;

const samples = [
  "Scene 2/15: beat 1/4...",
  "Fetching visuals (scene 4/15, 2 done, tick 3)...",
  "Clips achter elkaar plakken (ruwe montage)... (6/15)",
  "Effecten, overgangen en tekst toevoegen... (11/15)",
  "🔍 Researching topic...",
  "Volledige voiceover in ElevenLabs (één script)...",
  "Alle scenes samenvoegen + muziek...",
];

let failed = false;
for (const raw of samples) {
  const { label } = resolvePipelineDisplayStage(raw, 50);
  if (!allowedLabels.has(label)) {
    console.error(`FAIL: "${raw}" -> "${label}" (not in allowed set)`);
    failed = true;
  }
  if (granular.test(label)) {
    console.error(`FAIL: label still granular: "${label}"`);
    failed = true;
  }
  console.log(`OK: "${raw.slice(0, 40)}..." -> "${label}"`);
}

if (failed) process.exit(1);
console.log("\n✅ All coarse stage mappings valid");
