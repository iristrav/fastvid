/**
 * Video Renderer stage — single responsibility: runs FFmpeg, nothing else.
 *
 * Adapter around the existing shared `exec()` helper (server/videoPipeline.ts) — already
 * almost exactly this contract: takes a raw shell command string, gates the spawn behind the
 * global ffmpeg concurrency semaphore, retries transient fork-pressure failures, and returns
 * stdout/stderr. It reads two pieces of ambient state (the active scene-fetch cancellation
 * scope and the active render's cancel flag) but both degrade gracefully to a no-op when
 * called outside any tracked render context — exactly the case for a standalone call from this
 * stage — so no extra parameter plumbing is needed to use it safely in isolation.
 */
import { exec } from "../../videoPipeline";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type FfmpegExecResult, type StageResult } from "../types";

export async function runFfmpeg(cmd: string): Promise<StageResult<FfmpegExecResult>> {
  return runStage(PIPELINE_ERROR.FFMPEG, true, async () => exec(cmd));
}
