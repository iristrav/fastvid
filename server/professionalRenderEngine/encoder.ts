/** Professional Render Engine — Encoder (Phase 7).
 *
 *  Turns a validated RenderPlan into the final FFmpeg encode command and runs it through an
 *  injected `CommandExecutor` — never `child_process.exec` directly, exactly like every other
 *  test in this codebase's own convention of mocking the sibling exec call rather than
 *  spawning a real ffmpeg process.
 *
 *  `isForkPressureError()`/the jittered-backoff formula are reused as a PATTERN, not imported:
 *  videoPipeline.ts's real `exec()` (confirmed by this phase's research) is deeply coupled to
 *  module-level singletons this dormant directory must never touch (`ffmpegSemaphore`,
 *  `sceneFetchScopeStorage`, the watchdog/heartbeat machinery) — reimplementing the same
 *  proven EAGAIN/fork-pressure classification and `1500ms * attempt` jittered backoff here,
 *  standalone, satisfies "automatic retry of failed render tasks" without dragging this
 *  module's tests into that production file's state machine.
 *
 *  GPU encoding stays off unless BOTH the caller requests it (`EncodeOptions.useGpu`) AND
 *  `gpuEncodingEnabled()` (featureFlags.ts) is set — no GPU backend exists anywhere in this
 *  codebase today (confirmed by research) and none is available to validate here, so a caller
 *  asking for GPU encoding alone is not enough; the environment-level flag is the final word.
 */
import { gpuEncodingEnabled } from "./featureFlags";
import type { CommandExecutor, EncodeAttempt, EncodeOptions, EncodeResult, RenderPlan } from "./types";

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

/** Same transient-failure classification videoPipeline.ts's exec() uses: EAGAIN, "resource
 *  temporarily unavailable" / "cannot fork" text (Node's exec .message often omits the real
 *  ffmpeg stderr, so both message and stderr are checked), and libx264's threaded-encoder
 *  pthread-init failure under the same resource pressure. */
export function isForkPressureError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EAGAIN") return true;
  const msg = `${(err as Error)?.message || ""} ${(err as { stderr?: string })?.stderr || ""}`;
  if (/resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg)) return true;
  if (/error initializing output stream/i.test(msg) && /error while opening encoder/i.test(msg)) return true;
  return false;
}

/** +/-30% jitter around a base delay — spreads out retries from many concurrent callers
 *  hitting the same resource-pressure wall at once, instead of all retrying in sync. */
export function jitteredDelay(ms: number): number {
  return Math.round(ms * (0.7 + Math.random() * 0.6));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FullFilterComplex = { filterComplex: string; videoLabel: string; audioLabel: string | null };

/** Concatenates every scene's already-labeled filter_complex into one graph, then joins the
 *  scenes' own output labels together (`concat=n=N:v=1:a=0` for video, `acrossfade`-free plain
 *  `concat` for audio too — scene-to-scene joins are hard cuts at the top level; any
 *  scene-INTERNAL transition already happened inside that scene's own filterComplex via
 *  timelineRenderer.ts). A single-scene plan needs no concat at all. */
function buildFullFilterComplex(plan: RenderPlan): FullFilterComplex {
  const sceneVideoFilters = plan.scenes.map((s) => s.filterComplex).filter((f) => f.length > 0);
  const sceneAudioFilters = plan.scenes.map((s) => s.audioFilterComplex).filter((f) => f.length > 0);

  let videoLabel = plan.scenes[0]?.outputLabel ?? "";
  let videoConcat = "";
  if (plan.scenes.length > 1) {
    const inputs = plan.scenes.map((s) => `[${s.outputLabel}]`).join("");
    videoLabel = "vfinal";
    videoConcat = `${inputs}concat=n=${plan.scenes.length}:v=1:a=0[vfinal]`;
  }

  const scenesWithAudio = plan.scenes.filter((s) => s.audioOutputLabel.length > 0);
  let audioLabel: string | null = scenesWithAudio[0]?.audioOutputLabel ?? null;
  let audioConcat = "";
  if (scenesWithAudio.length > 1) {
    const inputs = scenesWithAudio.map((s) => `[${s.audioOutputLabel}]`).join("");
    audioLabel = "afinal";
    audioConcat = `${inputs}concat=n=${scenesWithAudio.length}:v=0:a=1[afinal]`;
  }

  const parts = [...sceneVideoFilters, ...sceneAudioFilters, videoConcat, audioConcat].filter((p) => p.length > 0);

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}

function videoCodecArgs(useGpu: boolean): string {
  return useGpu ? "-c:v h264_nvenc" : "-c:v libx264";
}

/** Builds the final FFmpeg command. `inputFiles` must be in the same order the render plan's
 *  filter_complex references them by index (e.g. "0:v", "1:v") — resolving that order from
 *  candidateIds to real local file paths is renderPlanner.ts's `ClipAssetResolver`'s job, not
 *  this function's; this function only assembles the command from already-resolved paths. */
export function buildEncodeCommand(plan: RenderPlan, inputFiles: string[], options: EncodeOptions): string {
  const effectiveGpu = options.useGpu && gpuEncodingEnabled();
  const inputArgs = inputFiles.map((f) => `-i "${f}"`).join(" ");
  const { filterComplex, videoLabel, audioLabel } = buildFullFilterComplex(plan);
  const mapArgs = audioLabel ? `-map "[${videoLabel}]" -map "[${audioLabel}]"` : `-map "[${videoLabel}]"`;

  return (
    `${FFMPEG_BIN} -y ${inputArgs} -filter_complex "${filterComplex}" ${mapArgs} ` +
    `${videoCodecArgs(effectiveGpu)} -crf ${options.crf} -preset ${options.preset} -pix_fmt yuv420p ` +
    `"${options.outputPath}"`
  );
}

/** Runs the encode, retrying on classified transient fork/resource-pressure failures up to
 *  `options.maxRetries` times with a jittered backoff, and giving up immediately on anything
 *  else (a real parameter/filter error retrying won't fix). `sleepFn` is an injected seam so
 *  tests never actually wait out the backoff. */
export async function encode(
  plan: RenderPlan,
  inputFiles: string[],
  options: EncodeOptions,
  executor: CommandExecutor,
  sleepFn: (ms: number) => Promise<void> = defaultSleep
): Promise<EncodeResult> {
  const usedGpu = options.useGpu && gpuEncodingEnabled();
  const command = buildEncodeCommand(plan, inputFiles, options);
  const attempts: EncodeAttempt[] = [];

  for (let attempt = 1; attempt <= Math.max(1, options.maxRetries + 1); attempt++) {
    const startedAt = Date.now();
    try {
      await executor(command);
      attempts.push({ attempt, succeeded: true, durationMs: Date.now() - startedAt });
      return { outputPath: options.outputPath, succeeded: true, attempts, usedGpu };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = (err as Error)?.message ?? String(err);
      attempts.push({ attempt, succeeded: false, error, durationMs });

      const retriesLeft = options.maxRetries + 1 - attempt;
      if (!isForkPressureError(err) || retriesLeft <= 0) {
        return { outputPath: options.outputPath, succeeded: false, attempts, usedGpu };
      }
      await sleepFn(jitteredDelay(1500 * attempt));
    }
  }

  return { outputPath: options.outputPath, succeeded: false, attempts, usedGpu };
}
