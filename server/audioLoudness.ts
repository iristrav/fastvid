/**
 * RONDE 222 — THE DELIVERED FILM IS MEASURED FOR LENGTH AND NEVER FOR LEVEL.
 *
 * `avSyncCheck` asks whether the picture and the sound line up. Nothing asks how LOUD the sound is,
 * and nothing ever set it. Measured on the file a customer actually received — render 574,
 * "Why Adolf Hitler Took His Own Life in 1945":
 *
 *     integrated   -41.2 LUFS
 *     target       -14   LUFS      (YouTube, Spotify, and every other streaming platform)
 *     true peak    -20.3 dBFS
 *     LRA            2.2 LU
 *
 * Twenty-seven decibels under target. A viewer at normal volume hears effectively nothing. This is
 * not a regression: a search of the whole server tree for `loudnorm`, `LUFS`, `targetLufs` and
 * `normalizeAudio` returned nothing at all. The level was never anybody's job.
 *
 * ── Why this belongs here and not in the mix ────────────────────────────────────────────────
 *
 * The two delivery routes build their audio in different places and in different shapes: the
 * cinematic route ends its graph at `[aout]` in `timelineFilters`, and the compose route writes
 * `outputPath` from any of five ffmpeg invocations. Putting a filter in each is the defect this
 * codebase keeps removing — a rule that N routes must follow, registered by a few of them, so the
 * sixth branch added later ships unnormalised and nobody notices.
 *
 * Loudness is a property of the FINISHED FILM, so it is measured and corrected on the finished
 * film, at the one point per route that already holds it: the same place `checkFileAvSync` runs.
 * One rule, two call sites, and a branch added tomorrow inherits it for free.
 *
 * ── The discipline ─────────────────────────────────────────────────────────────────────────
 *
 * Nothing here is allowed to make a file worse. The correction is measured, applied, and then
 * measured again; the new file replaces the old one only when it is genuinely closer to target.
 * Every other outcome keeps the file exactly as it was and says why. A render never fails because
 * of this pass — a film that is too quiet is still a film, and refusing to deliver it would be a
 * worse answer than delivering it with the fault reported.
 */
import { promisify } from "util";
import { exec as execCb } from "child_process";
import fs from "fs";

const exec = promisify(execCb);

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/**
 * EBU R128 integrated target, in LUFS.
 *
 * -14 is what YouTube, Spotify and Apple Music normalise to. Delivering at target means the
 * platform leaves the film alone; delivering under it means the platform turns everything else UP
 * relative to this film, which is the audible version of the render 574 fault.
 */
export const TARGET_LUFS = -14;

/** True-peak ceiling in dBTP. -1.5 leaves headroom for the lossy encoder's overshoot. */
export const TRUE_PEAK_DBTP = -1.5;

/** Loudness range target in LU. 11 is the R128 broadcast default and suits narration. */
export const TARGET_LRA = 11;

/**
 * How far off target a film may sit before it is worth re-encoding its audio.
 *
 * Re-encoding is not free and AAC→AAC is not lossless, so a film already within a listener's
 * just-noticeable range is left alone rather than churned. 1.0 LU is below the threshold at which
 * a level difference reads as a level difference.
 */
export const LOUDNESS_TOLERANCE_LU = 1.0;

export type LoudnessStats = {
  integratedLufs: number | null;
  truePeakDb: number | null;
  lra: number | null;
  thresholdLufs: number | null;
};

export type LoudnessOutcome =
  /** Measured, and already within tolerance. Nothing was re-encoded. */
  | "already_on_target"
  /** Measured, corrected, and the corrected file measured closer to target. It was replaced. */
  | "normalised"
  /** The file has no audio stream to measure. */
  | "no_audio"
  /** The measurement itself could not be read. The file is untouched. */
  | "not_measurable"
  /** A correction was attempted and did not improve the file. The original was kept. */
  | "not_improved"
  /** The correction pass failed outright. The original was kept. */
  | "failed";

export type LoudnessResult = {
  outcome: LoudnessOutcome;
  /** Integrated loudness before the pass, when it could be measured. */
  beforeLufs: number | null;
  /** Integrated loudness after the pass, when one ran and could be measured. */
  afterLufs: number | null;
  targetLufs: number;
  /** Present whenever the outcome is not a plain success — never a silent failure. */
  reason?: string;
};

/**
 * RONDE 235 — WHAT RENDER 576 WAS ALLOWED TO SAY ABOUT ITS OWN FAILURE.
 *
 * The delivered film measured -41.4 LUFS against a -14 target and the correction pass failed. This
 * is the entire diagnosis it printed:
 *
 *     [Loudness] ... outcome=failed — the correction pass failed: Command failed:
 *     "/usr/bin/ffmpeg" -nostdin -hide_banner -y -i "/var/tmp/fastvid_576_.../covered_the_
 *     assembled_film_....mp4" -map 0:v:0 -map
 *
 * — and it stops there, mid-flag. Node's `exec` builds its message as `Command failed: <the whole
 * command>\n<stderr>`, and the command alone is well past the 160 characters the reason kept. So
 * the slice could never reach ffmpeg's own words: for EVERY exec failure, on every file, the
 * reason is the head of a command line the reader already knows and nothing else.
 *
 * The answer was never missing. `err.stderr` carries it, and ffmpeg puts the actual complaint —
 * "No space left on device", "Invalid argument", "Conversion failed" — in the LAST lines it
 * prints. So the tail is what survives, with the exit status in front of it.
 *
 * This is the same defect this codebase keeps removing, in its quietest form: not a refusal
 * nobody logged, but a refusal that logged the question instead of the answer.
 */
export function describeFfmpegFailure(err: unknown, maxChars = 400): string {
  const e = (err ?? {}) as { stderr?: unknown; message?: unknown; code?: unknown; signal?: unknown };
  const status =
    typeof e.signal === "string" && e.signal
      ? `killed by ${e.signal}`
      : typeof e.code === "number"
        ? `exit ${e.code}`
        : "no exit status";

  /**
   * `err.stderr` when the child produced any, otherwise whatever the message holds after the
   * `Command failed: …` echo. Both are searched for the last non-empty lines rather than the
   * first: ffmpeg's banner, its input analysis and its progress counters all come before the
   * error, and only the error matters here.
   */
  const raw =
    (typeof e.stderr === "string" && e.stderr.trim() ? e.stderr : String(e.message ?? "")).replace(
      /^Command failed:.*$/m,
      ""
    );
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(frame|size)=/.test(l));
  const tail = lines.slice(-6).join(" | ");
  const said = tail ? tail.slice(-maxChars) : "ffmpeg printed nothing";
  return `${status}: ${said}`;
}

/**
 * Read a file's loudness with `loudnorm` itself, in analysis mode.
 *
 * `ebur128` would give the integrated figure too, but `loudnorm`'s own JSON carries the four
 * numbers its second pass needs (`input_i`, `input_tp`, `input_lra`, `input_thresh`), so measuring
 * with the filter that will do the correcting means the correction is LINEAR — a single computed
 * gain rather than a dynamic compressor riding the programme. For narration with a 2.2 LU range
 * that difference is the difference between "louder" and "pumping".
 */
export async function measureLoudness(filePath: string): Promise<LoudnessStats> {
  const empty: LoudnessStats = {
    integratedLufs: null,
    truePeakDb: null,
    lra: null,
    thresholdLufs: null,
  };
  try {
    const { stderr } = await exec(
      `"${ffmpegBin()}" -nostdin -hide_banner -i "${filePath}" ` +
        `-af loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${TARGET_LRA}:print_format=json ` +
        `-f null -`,
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return parseLoudnormJson(String(stderr)) ?? empty;
  } catch {
    /**
     * A file with no audio stream makes this invocation fail, and so does an unreadable file. The
     * caller separates the two with its own probe; here both are simply "no measurement".
     */
    return empty;
  }
}

/**
 * Pull the loudnorm JSON block out of ffmpeg's stderr.
 *
 * Exported because it is the part worth testing without an ffmpeg on the machine: the parser is
 * where a format change would break this quietly.
 */
export function parseLoudnormJson(stderr: string): LoudnessStats | null {
  /** The block is the LAST JSON object printed, and ffmpeg prints plenty of other lines around it. */
  const open = stderr.lastIndexOf("{");
  const close = stderr.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stderr.slice(open, close + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (key: string): number | null => {
    const raw = parsed[key];
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const n = parseFloat(String(raw));
    /**
     * loudnorm reports `-inf` for a silent file. That is a real measurement of a real problem, but
     * it is not a number a gain can be computed from, so it is reported as unmeasurable rather
     * than turned into an infinite correction.
     */
    return Number.isFinite(n) ? n : null;
  };
  return {
    integratedLufs: num("input_i"),
    truePeakDb: num("input_tp"),
    lra: num("input_lra"),
    thresholdLufs: num("input_thresh"),
  };
}

/**
 * The second-pass filter chain, given what the first pass measured.
 *
 * `linear=true` asks loudnorm for a single static gain instead of dynamic compression; it honours
 * that request whenever the gain does not push the true peak past `TP`, and falls back to dynamic
 * on its own when it would. `aresample=48000` is not optional: loudnorm outputs at 192 kHz, and
 * without this the muxed file carries a sample rate no player expects.
 */
export function loudnormChain(stats: LoudnessStats): string | null {
  const { integratedLufs, truePeakDb, lra, thresholdLufs } = stats;
  if (integratedLufs == null || truePeakDb == null || lra == null || thresholdLufs == null) {
    return null;
  }
  return (
    `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${TARGET_LRA}:` +
    `measured_I=${integratedLufs}:measured_TP=${truePeakDb}:` +
    `measured_LRA=${lra}:measured_thresh=${thresholdLufs}:` +
    `linear=true:print_format=summary,aresample=48000`
  );
}

/** True when a measured film is close enough to target that re-encoding buys nothing. */
export function isOnTarget(integratedLufs: number | null): boolean {
  if (integratedLufs == null) return false;
  return Math.abs(integratedLufs - TARGET_LUFS) <= LOUDNESS_TOLERANCE_LU;
}

/**
 * Bring one delivered file to the streaming loudness target, in place.
 *
 * The picture is stream-copied, so this costs an audio decode and encode and nothing else. The
 * original is replaced only after the corrected file has been measured and found closer to target
 * — a correction that made things worse, or a pass that produced an unreadable file, leaves the
 * delivered film exactly as it was.
 */
export async function normaliseDeliveredLoudness(
  filePath: string,
  opts: { hasAudio?: boolean; timeoutMs?: number } = {}
): Promise<LoudnessResult> {
  const base: Omit<LoudnessResult, "outcome"> = {
    beforeLufs: null,
    afterLufs: null,
    targetLufs: TARGET_LUFS,
  };
  if (opts.hasAudio === false) {
    return { ...base, outcome: "no_audio", reason: "the file carries no audio stream" };
  }
  if (!fs.existsSync(filePath)) {
    return { ...base, outcome: "failed", reason: "the file does not exist" };
  }

  const before = await measureLoudness(filePath);
  if (before.integratedLufs == null) {
    return {
      ...base,
      outcome: "not_measurable",
      reason: "loudnorm printed no readable measurement for this file",
    };
  }
  if (isOnTarget(before.integratedLufs)) {
    return { ...base, outcome: "already_on_target", beforeLufs: before.integratedLufs };
  }

  const chain = loudnormChain(before);
  if (!chain) {
    return {
      ...base,
      outcome: "not_measurable",
      beforeLufs: before.integratedLufs,
      reason: "the measurement was incomplete, so no linear correction could be computed",
    };
  }

  const tmpPath = `${filePath}.loudnorm.mp4`;
  /**
   * RONDE 235 — the correction is attempted twice, and the second attempt asks for less.
   *
   * `-movflags +faststart` is a convenience, not part of the correction: it makes ffmpeg write the
   * whole file and then REWRITE it to move the moov atom to the front. At the moment this pass
   * runs, the render's work directory still holds everything the render fetched — 311 downloads in
   * render 576 — so the one step that needs a second full-size write is also the one most likely
   * to be refused by the environment.
   *
   * So a failure is not the last word. The second attempt drops that flag and nothing else: same
   * measurement, same linear chain, same target, same codec. What it CANNOT do is lower the bar —
   * both attempts hand their output to the same measure-and-compare below, and a file that is not
   * measurably closer to target is still discarded. A retry that could ship a worse file would be
   * a worse defect than the one it fixes.
   */
  const runCorrection = async (faststart: boolean): Promise<string | null> => {
    try {
      await exec(
        `"${ffmpegBin()}" -nostdin -hide_banner -y -i "${filePath}" ` +
          `-map 0:v:0 -map 0:a:0 -c:v copy -af "${chain}" ` +
          `-c:a aac -b:a 320k ${faststart ? "-movflags +faststart " : ""}"${tmpPath}"`,
        { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 8 * 1024 * 1024 }
      );
      return null;
    } catch (err) {
      safeUnlink(tmpPath);
      return describeFfmpegFailure(err);
    }
  };

  const firstFailure = await runCorrection(true);
  if (firstFailure) {
    const secondFailure = await runCorrection(false);
    if (secondFailure) {
      return {
        ...base,
        outcome: "failed",
        beforeLufs: before.integratedLufs,
        reason:
          `the correction pass failed twice — with faststart: ${firstFailure} — ` +
          `without faststart: ${secondFailure}`,
      };
    }
    console.warn(
      `[Loudness] the first correction attempt failed (${firstFailure}) — ` +
        `the retry without +faststart produced a file`
    );
  }

  if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 0) {
    safeUnlink(tmpPath);
    return {
      ...base,
      outcome: "failed",
      beforeLufs: before.integratedLufs,
      reason: "the correction pass produced no file",
    };
  }

  const after = await measureLoudness(tmpPath);
  /**
   * THE ONE THING THIS PASS MUST NEVER DO IS SHIP A WORSE FILE.
   *
   * A corrected file is accepted only when it is measurably closer to target than the original. An
   * unreadable measurement counts as "not closer": the delivered film keeps the level it had, and
   * the log says the correction was discarded rather than claiming a success nobody verified.
   */
  const improved =
    after.integratedLufs != null &&
    Math.abs(after.integratedLufs - TARGET_LUFS) < Math.abs(before.integratedLufs - TARGET_LUFS);
  if (!improved) {
    safeUnlink(tmpPath);
    return {
      ...base,
      outcome: "not_improved",
      beforeLufs: before.integratedLufs,
      afterLufs: after.integratedLufs,
      reason:
        after.integratedLufs == null
          ? "the corrected file could not be measured, so the original was kept"
          : "the corrected file was no closer to target, so the original was kept",
    };
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    safeUnlink(tmpPath);
    return {
      ...base,
      outcome: "failed",
      beforeLufs: before.integratedLufs,
      afterLufs: after.integratedLufs,
      reason: `the corrected file could not replace the original: ${(err as Error).message?.slice(0, 160)}`,
    };
  }

  return {
    ...base,
    outcome: "normalised",
    beforeLufs: before.integratedLufs,
    afterLufs: after.integratedLufs,
  };
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* a leftover temp file is not worth failing a render over */
  }
}

/**
 * One line for the render log, in the shape the other delivery checks use.
 *
 * Every outcome prints, including the successful ones: a reader asking "was this film levelled?"
 * must get an answer from the log rather than from the absence of a warning.
 */
export function formatLoudness(result: LoudnessResult): string {
  const lufs = (n: number | null) => (n == null ? "unknown" : `${n.toFixed(1)} LUFS`);
  const head = `[Loudness] target=${result.targetLufs} LUFS measured=${lufs(result.beforeLufs)}`;
  switch (result.outcome) {
    case "already_on_target":
      return `${head} — within ${LOUDNESS_TOLERANCE_LU} LU of target, left as it is`;
    case "normalised":
      return `${head} → ${lufs(result.afterLufs)} — corrected`;
    case "no_audio":
      return `${head} — ${result.reason}`;
    default:
      return `${head} after=${lufs(result.afterLufs)} outcome=${result.outcome} — ${result.reason ?? "no reason recorded"}`;
  }
}

/** True when the outcome left the film off target — the caller warns rather than logs. */
export function loudnessNeedsAttention(result: LoudnessResult): boolean {
  return result.outcome !== "already_on_target" && result.outcome !== "normalised";
}
