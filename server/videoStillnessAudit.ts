/**
 * RONDE 130 — measure the finished file, not the plan that made it.
 *
 * Every round so far has proved its rule against the code that implements it: planStillSegments
 * caps a segment at five seconds, montageTailPadFilterChain writes a duration into a filter
 * string. None of that is evidence about the MP4 a viewer actually watches, and the two can
 * disagree for reasons no unit test would see — a filter that silently does nothing, a stream
 * that ends before its audio and leaves a player showing one frame, a concat that repeats a
 * segment.
 *
 * This measures the file. It samples decoded frames, compares them, and reports the longest run
 * of unchanging picture in seconds. It answers the only question that matters at the end:
 *
 *     how long is the viewer looking at exactly the same thing?
 *
 * ── How ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ffmpeg's `mpdecimate` drops frames that are near-duplicates of the one before them and reports
 * each drop, so the gaps between surviving frames ARE the still runs. It is the same tool the
 * pipeline already uses for source analysis, it decodes once, and it works on any file whatever
 * produced it — which is the point: an auditor that trusted the pipeline's own metadata would be
 * asking the suspect for its alibi.
 *
 * `freezedetect` is deliberately NOT used as the primary measure. RONDE 111 established why: it
 * needs a configured minimum duration before it reports anything, so it is blind to exactly the
 * runs that sit just under whatever that minimum is. This counts every frame instead.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}
function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

export type StillnessReport = {
  /** Video stream duration, in seconds. */
  durationSec: number;
  /** Longest stretch of unchanging picture, in seconds. THE number this module exists for. */
  longestStillSec: number;
  /** Where that stretch begins. */
  longestStillStartSec: number;
  /** Every still run at or above the reporting floor, in order. */
  stillRuns: Array<{ startSec: number; durationSec: number }>;
  /** How many times the picture genuinely changed. */
  visualChanges: number;
};

/** Runs shorter than this are ordinary held frames inside real footage, not stillness. */
const REPORTABLE_STILL_SEC = 0.6;

/**
 * Measure how long the picture stands still, anywhere in the file.
 *
 * @param maxSampleFps decode at this rate rather than the file's own. A still run is measured in
 *   seconds, so 8 samples a second locates its edges to within an eighth of a second while
 *   decoding a fraction of the frames — the difference between an audit that can run on every
 *   render and one that cannot.
 */
export async function auditVideoStillness(params: {
  videoPath: string;
  maxSampleFps?: number;
  timeoutMs?: number;
}): Promise<StillnessReport> {
  const fps = params.maxSampleFps ?? 8;
  const timeout = params.timeoutMs ?? 180_000;

  const { stdout: durOut } = await exec(
    `${ffprobeBin()} -v error -select_streams v:0 -show_entries stream=duration ` +
      `-of default=nw=1:nk=1 "${params.videoPath}"`,
    { timeout: 30_000 }
  );
  let durationSec = Number(String(durOut).trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    const { stdout: fmtOut } = await exec(
      `${ffprobeBin()} -v error -show_entries format=duration -of default=nw=1:nk=1 "${params.videoPath}"`,
      { timeout: 30_000 }
    );
    durationSec = Number(String(fmtOut).trim()) || 0;
  }

  /**
   * `mpdecimate` prints one line per frame saying whether it was dropped as a duplicate. The
   * timestamps of the frames it KEEPS are the moments the picture changed; the gaps between them
   * are how long it did not.
   */
  /**
   * showinfo writes to STDERR, and deliberately not redirected into stdout here: an earlier
   * version appended `2>&1`, which moved every line out of the stream this reads and left the
   * parser with no timestamps at all — so a perfectly normal file measured as one 34-second
   * still. Caught by measuring a file whose first six seconds are known to be moving.
   */
  const { stderr } = await exec(
    `${ffmpegBin()} -v info -i "${params.videoPath}" ` +
      `-vf "fps=${fps},mpdecimate=hi=64*12:lo=64*5:frac=0.33,showinfo" -an -f null -`,
    { timeout, maxBuffer: 256 * 1024 * 1024 }
  ).catch((e: { stdout?: string; stderr?: string }) => ({
    stderr: String(e?.stderr ?? e?.stdout ?? ""),
  }));

  const times = [...String(stderr).matchAll(/pts_time:([\d.]+)/g)]
    .map((m) => Number.parseFloat(m[1]!))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const stillRuns: Array<{ startSec: number; durationSec: number }> = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i]!;
    const next = i + 1 < times.length ? times[i + 1]! : durationSec;
    const run = next - start;
    if (run >= REPORTABLE_STILL_SEC) stillRuns.push({ startSec: start, durationSec: run });
  }

  /**
   * A file whose picture never changes produces ONE kept frame, so there is no "next" to measure
   * against — the whole file is one still run and the loop above would report it from the single
   * timestamp. Guarded explicitly rather than left to arithmetic.
   */
  if (times.length <= 1 && durationSec > 0) {
    return {
      durationSec,
      longestStillSec: durationSec,
      longestStillStartSec: times[0] ?? 0,
      stillRuns: [{ startSec: times[0] ?? 0, durationSec }],
      visualChanges: Math.max(0, times.length - 1),
    };
  }

  let longest = { startSec: 0, durationSec: 0 };
  for (const r of stillRuns) if (r.durationSec > longest.durationSec) longest = r;

  return {
    durationSec,
    longestStillSec: longest.durationSec,
    longestStillStartSec: longest.startSec,
    stillRuns,
    visualChanges: Math.max(0, times.length - 1),
  };
}

export type StillnessVerdict = {
  ok: boolean;
  longestStillSec: number;
  limitSec: number;
  /** Runs that break the rule, so a report can name them rather than only count them. */
  violations: Array<{ startSec: number; durationSec: number }>;
};

/**
 * Does this file obey the rule?
 *
 * The tolerance is a frame or two, not a grace period: a run measured at 5.04s on an 8Hz sample
 * of a five-second segment is that segment, and failing it would make the check report its own
 * sampling error as a defect.
 */
export function checkStillnessLimit(report: StillnessReport, limitSec: number): StillnessVerdict {
  const tolerance = 0.25;
  const violations = report.stillRuns.filter((r) => r.durationSec > limitSec + tolerance);
  return {
    ok: violations.length === 0,
    longestStillSec: report.longestStillSec,
    limitSec,
    violations,
  };
}

/** The block the render report prints — the numbers the audit asks for, from the file itself. */
export function formatStillnessReport(label: string, report: StillnessReport, verdict: StillnessVerdict): string {
  const lines = [
    `[VisualIntegrity] ${label}`,
    `  duration            ${report.durationSec.toFixed(2)}s`,
    `  visual changes      ${report.visualChanges}`,
    `  still segments      ${report.stillRuns.length}`,
    `  longest still       ${report.longestStillSec.toFixed(2)}s at ${report.longestStillStartSec.toFixed(2)}s`,
    `  limit               ${verdict.limitSec.toFixed(2)}s`,
    `  passed              ${verdict.ok ? "yes" : "NO"}`,
  ];
  for (const v of verdict.violations.slice(0, 5)) {
    lines.push(`  VIOLATION           ${v.durationSec.toFixed(2)}s of unchanging picture at ${v.startSec.toFixed(2)}s`);
  }
  return lines.join("\n");
}
