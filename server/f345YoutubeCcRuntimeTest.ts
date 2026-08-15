/**
 * F3-45 — TEMPORARY diagnostic runtime test. NOT part of the production pipeline
 * and not imported by anything else — proves, against the real Railway runtime:
 * YouTube CC search -> real candidate -> existing downloader -> real video file
 * -> ffprobe -> trim -> valid clip, using only existing pipeline functions.
 *
 * Run from the repo root (e.g. in the Railway Console):
 *   npx tsx server/f345YoutubeCcRuntimeTest.ts
 *
 * This script imports four functions from ./videoPipeline that were
 * temporarily marked `export` (visibility only, zero logic changed) solely so
 * this script could reach them: searchYoutubeVideoCandidates,
 * trimRemoteVideoToClip, isValidVideoFile, probeVideoStreamMeta.
 * downloadYouTubeCCClip was already exported.
 *
 * DELETE THIS FILE after use, and revert those four `export` keywords back to
 * module-private in videoPipeline.ts (each one is marked with an "F3-45:"
 * comment directly above it for easy searching) — see the accompanying F3-45
 * runtime-test report.
 *
 * Note on step order: downloadYouTubeCCClip() already performs its own
 * internal trim via trimRemoteVideoToClip() on the RapidAPI route (see
 * videoPipeline.ts, RapidAPI branch of downloadYouTubeCCClip) — so its output
 * here (SOURCE_FILE) is already a valid ~SOURCE_DURATION_SEC clip, not a raw
 * untrimmed source. This script's TRIM step deliberately runs
 * trimRemoteVideoToClip() a SECOND, separate time on that output, to
 * independently prove the trim function against real YouTube-sourced content
 * exactly as requested — this is NOT how the production YouTube path chains
 * these two calls today.
 *
 * Makes no permanent changes: no database writes, no archive/storage records,
 * no Railway variable changes. All temporary files are removed in a finally
 * block regardless of outcome.
 */

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";

import {
  searchYoutubeVideoCandidates,
  downloadYouTubeCCClip,
  trimRemoteVideoToClip,
  isValidVideoFile,
  probeVideoStreamMeta,
} from "./videoPipeline";

const SEARCH_QUERY = "World War II archival footage";
const SOURCE_DURATION_SEC = 20;
const CLIP_DURATION_SEC = 10;
const CLIP_START_SEC = 0;
const MIN_FILE_BYTES = 10_000;

function presence(name: string): "present" | "missing" {
  return process.env[name]?.trim() ? "present" : "missing";
}

function fmtBytes(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

async function main(): Promise<void> {
  console.log("=== F3-45 YOUTUBE CC RUNTIME TEST ===");

  const sourcingEnabled = process.env.ENABLE_YOUTUBE_SOURCING === "true";
  console.log(`ENABLE_YOUTUBE_SOURCING: ${sourcingEnabled ? "true" : "NOT true"}`);
  console.log(`YOUTUBE_API_KEY: ${presence("YOUTUBE_API_KEY")}`);
  console.log(`RAPIDAPI_KEY: ${presence("RAPIDAPI_KEY")}`);
  console.log(`YOUTUBE_CC_DL_SERVICE: ${presence("YOUTUBE_CC_DL_SERVICE")}`);

  if (!sourcingEnabled || presence("YOUTUBE_API_KEY") === "missing") {
    console.log("SEARCH: FAIL");
    console.log("FINAL: FAIL");
    console.log("FAILURE_POINT: preflight");
    console.log(
      'ERROR: ENABLE_YOUTUBE_SOURCING must be "true" and YOUTUBE_API_KEY must be set before this test can run.'
    );
    process.exitCode = 1;
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f345-runtime-test-"));
  const sourcePath = path.join(workDir, "source.mp4");
  const clipPath = path.join(workDir, "clip.mp4");

  try {
    // --- 1. SEARCH ---
    let candidates: Awaited<ReturnType<typeof searchYoutubeVideoCandidates>>;
    try {
      candidates = await searchYoutubeVideoCandidates(
        SEARCH_QUERY,
        0,
        "creative_common",
        [],
        1,
        "",
        5
      );
    } catch (err) {
      console.log("SEARCH: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: search");
      console.log(`ERROR: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const first = candidates[0];
    const videoId = first?.item.id?.videoId;
    if (!first || !videoId) {
      console.log("SEARCH: FAIL");
      console.log("VIDEO_ID: (none)");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: search");
      console.log(
        `ERROR: 0 usable candidates returned for query "${SEARCH_QUERY}" with videoLicense=creativeCommon.`
      );
      process.exitCode = 1;
      return;
    }

    const title = first.title || "(no title)";
    console.log("SEARCH: PASS");
    console.log(`VIDEO_ID: ${videoId}`);
    console.log(`TITLE: ${title}`);

    // --- 2. DOWNLOAD ROUTE (informational — mirrors downloadYouTubeCCClip's own priority) ---
    const route =
      presence("YOUTUBE_CC_DL_SERVICE") === "present"
        ? "YOUTUBE_CC_DL_SERVICE (cloud/yt-dlp)"
        : presence("RAPIDAPI_KEY") === "present"
          ? "RAPIDAPI"
          : "NONE (no downloader configured)";
    console.log(`DOWNLOAD_ROUTE: ${route}`);

    // --- 3. DOWNLOAD ---
    let downloadOk = false;
    try {
      downloadOk = await downloadYouTubeCCClip(videoId, SOURCE_DURATION_SEC, 0, sourcePath, 0, title);
    } catch (err) {
      console.log("DOWNLOAD: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: download");
      console.log(`ERROR: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (!downloadOk || !fs.existsSync(sourcePath)) {
      console.log("DOWNLOAD: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: download");
      console.log(
        `ERROR: downloadYouTubeCCClip() returned ${downloadOk}, file exists=${fs.existsSync(sourcePath)}. Route attempted: ${route}.`
      );
      process.exitCode = 1;
      return;
    }
    console.log("DOWNLOAD: PASS");

    const sourceSize = fs.statSync(sourcePath).size;
    console.log(`SOURCE_FILE_SIZE: ${fmtBytes(sourceSize)}`);
    if (sourceSize <= MIN_FILE_BYTES) {
      console.log("SOURCE_FFPROBE: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: download (file too small)");
      console.log(`ERROR: source file is ${sourceSize} bytes, at or below the ${MIN_FILE_BYTES}-byte floor.`);
      process.exitCode = 1;
      return;
    }

    // --- 4. SOURCE FFPROBE ---
    const sourceValid = await isValidVideoFile(sourcePath);
    const sourceMeta = await probeVideoStreamMeta(sourcePath);
    if (!sourceValid || !sourceMeta) {
      console.log("SOURCE_FFPROBE: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: source ffprobe");
      console.log(`ERROR: isValidVideoFile=${sourceValid}, probeVideoStreamMeta=${sourceMeta ? "ok" : "null"}`);
      process.exitCode = 1;
      return;
    }
    console.log("SOURCE_FFPROBE: PASS");
    console.log(`SOURCE_DURATION: ${sourceMeta.durationSec.toFixed(1)}s`);

    // --- 5. TRIM (separate, deliberate second pass — see header comment) ---
    let trimOk = false;
    try {
      trimOk = await trimRemoteVideoToClip(
        sourcePath,
        clipPath,
        CLIP_DURATION_SEC,
        CLIP_START_SEC,
        "F3-45 runtime test"
      );
    } catch (err) {
      console.log("TRIM: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: trim");
      console.log(`ERROR: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (!trimOk || !fs.existsSync(clipPath)) {
      console.log("TRIM: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: trim");
      console.log(`ERROR: trimRemoteVideoToClip() returned ${trimOk}, file exists=${fs.existsSync(clipPath)}.`);
      process.exitCode = 1;
      return;
    }
    console.log("TRIM: PASS");

    const clipSize = fs.statSync(clipPath).size;
    console.log(`CLIP_FILE_SIZE: ${fmtBytes(clipSize)}`);
    if (clipSize <= MIN_FILE_BYTES) {
      console.log("CLIP_FFPROBE: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: trim (output file too small)");
      console.log(`ERROR: clip file is ${clipSize} bytes, at or below the ${MIN_FILE_BYTES}-byte floor.`);
      process.exitCode = 1;
      return;
    }

    // --- 6. CLIP FFPROBE ---
    const clipValid = await isValidVideoFile(clipPath);
    const clipMeta = await probeVideoStreamMeta(clipPath);
    if (!clipValid || !clipMeta) {
      console.log("CLIP_FFPROBE: FAIL");
      console.log("FINAL: FAIL");
      console.log("FAILURE_POINT: clip ffprobe");
      console.log(`ERROR: isValidVideoFile=${clipValid}, probeVideoStreamMeta=${clipMeta ? "ok" : "null"}`);
      process.exitCode = 1;
      return;
    }
    console.log("CLIP_FFPROBE: PASS");
    console.log(`CLIP_DURATION: ${clipMeta.durationSec.toFixed(1)}s`);

    console.log("FINAL: PASS");
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

main().catch((err) => {
  console.error("=== F3-45 YOUTUBE CC RUNTIME TEST — UNCAUGHT ERROR ===");
  console.error((err as Error).stack || String(err));
  process.exitCode = 1;
});
