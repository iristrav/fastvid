import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// RONDE 32 — the three proven rescue defects from the forensic audit of render 529.
//
// L1  the compose rescue handed composeSceneVideo ONLY its own clips, and composeSceneVideo
//     treats that argument as the complete set — so every winner the scene had already selected
//     silently disappeared. Worse, withSceneFetchTimeout rejects the caller without cancelling
//     the work, so the compose that "failed" had in fact finished writing a complete file six
//     seconds later, which the rescue then overwrote (scene 1: five real clips → one).
// L2  every rescue slot passed a FRESH exclusion set to fetchCuratedArchiveBeatClip and nothing
//     ever called markCuratedAssetUsed, so all twelve of scene 1's slots got curated asset
//     #55988 and the compose-time content dedup threw eleven of them away.
// L3  the rescue loop never passed beatText, so generateGuaranteedBeatClip's escalation ladder
//     collapsed to the single video-wide topic query ("Adolf Hitler") for every slot.
//
// A note on scope: the rescue blocks themselves live inside _runVideoPipelineInner, which needs
// a database, an LLM and a TTS provider to reach. These tests therefore cover the extracted
// decision helpers and generateGuaranteedBeatClip behaviourally, and add one structural guard
// (TEST A/F) over the two rescue call sites — deliberately, because the audit's central finding
// was that the same defect existed in two places and fixing one would leave the other.

const REPO_PIPELINE = path.join(__dirname, "videoPipeline.ts");

/** Real, decodable mp4 of an exact duration — ffprobe must be able to measure it. */
function writeTestVideo(filePath: string, durationSec: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", `color=c=black:s=320x240:r=25`,
      "-t", durationSec.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
      filePath,
    ],
    { stdio: "ignore" }
  );
}

describe("RONDE 32 — FIX A/F: both rescue paths top up the winners instead of replacing them", () => {
  const src = () => fs.readFileSync(REPO_PIPELINE, "utf8");

  it("neither rescue path passes a bare rescueClips array as the complete clip set", () => {
    // composeSceneVideo(scene, clips, ...) treats `clips` as the COMPLETE set — it opens with
    // clips.filter(...). Passing only the rescue clips is what erased scene 1's five winners.
    expect(src()).not.toMatch(/composeSceneVideo\(\s*\n?\s*scene,\s*rescueClips,/);
  });
});
