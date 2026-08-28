/**
 * FASTVID — does the finished film show the same picture twice? (RONDE 156)
 *
 * ── Why this exists as a separate layer ──────────────────────────────────────────────────────
 *
 * The pipeline has a lot of dedup, and it is good: `usedContentKeys` blocks the same file,
 * `usedCuratedAssetIds` and `usedCuratedStorageUrls` block the same archive row and storage
 * object, and `usedFingerprints` blocks near-duplicate footage that all three of those miss —
 * the same event from a different archive or a different encode.
 *
 * All of it runs BEFORE adoption, and two routes deliberately step around it. Both fire only when
 * a scene is starved of footage:
 *
 *   ensureArchiveMontageVoiceCoverage round B  re-uses dedup.lastRealClip, comment and all
 *   montageTailPadFilterChain                  loop=loop=N replays the whole scene montage
 *
 * Those choices are defensible on their own terms — RONDE 130 measured that looping beats freezing
 * — but they mean the pre-adoption checks cannot answer "does the finished video repeat itself".
 * Nothing did. This does, by measuring the exported MP4 rather than trusting the intentions that
 * produced it, exactly as the stillness audit does.
 *
 * ── What it measures ─────────────────────────────────────────────────────────────────────────
 *
 * One frame per second, dHashed with the same helpers the sourcing dedup uses, grouped by
 * perceptual near-equality. Frames adjacent in time are expected to look alike — that is a shot,
 * not a repeat — so only groups whose members are separated by a real gap count.
 *
 * It changes no behaviour. It reports.
 */
import { exec as execCb } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import { dHashFromGray8x8, isNearDuplicateHash } from "./archiveClipDedup";

const exec = promisify(execCb);

// Resolved the same way videoStillnessAudit does, so both audits obey the same overrides.
function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}
function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

/** Seconds two sightings must be apart before they count as a repeat rather than one shot. */
export const REPEAT_MIN_GAP_SEC = 3;

/** How much repeated screen time a finished film may carry before the audit fails it. */
export const REPEAT_MAX_SHARE = 0.15;

export type RepeatedPicture = {
  /** Every second at which this picture was on screen. */
  atSec: number[];
  /** How many separate times it appeared, counting a run of adjacent seconds as one. */
  appearances: number;
  /** Screen time beyond its first appearance — the seconds a viewer saw it again. */
  repeatedSec: number;
};

export type RepeatReport = {
  durationSec: number;
  /** Frames actually sampled and hashed. */
  sampled: number;
  /** How many visually distinct pictures the film contains. */
  distinctPictures: number;
  /** Pictures seen more than once, worst first. */
  repeats: RepeatedPicture[];
  /** Total seconds the viewer spent looking at something they had already seen. */
  repeatedSec: number;
  /** repeatedSec as a share of the whole film. */
  repeatedShare: number;
};

export type RepeatVerdict = {
  ok: boolean;
  repeatedShare: number;
  limitShare: number;
  violations: string[];
};

async function probeDurationSec(videoPath: string): Promise<number> {
  const { stdout } = await exec(
    `${ffprobeBin()} -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${videoPath}"`
  );
  const d = parseFloat(String(stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Sample one frame per second as 8x8 grayscale and hash each.
 *
 * `scale=8:8` after `fps=1` is what dHashFromGray8x8 expects, and `gray` keeps the pipe to 64
 * bytes per frame — the whole point of sampling this way rather than writing JPEGs to disk.
 */
async function sampleFrameHashes(videoPath: string, timeoutMs: number): Promise<bigint[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-repeat-"));
  const raw = path.join(dir, "frames.gray");
  try {
    await exec(
      `${ffmpegBin()} -v error -i "${videoPath}" -vf "fps=1,scale=8:8" -pix_fmt gray -f rawvideo "${raw}"`,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
    );
    const buf = fs.readFileSync(raw);
    const hashes: bigint[] = [];
    for (let off = 0; off + 64 <= buf.length; off += 64) {
      hashes.push(dHashFromGray8x8(buf.subarray(off, off + 64)));
    }
    return hashes;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Group the sampled seconds into visually distinct pictures.
 *
 * Greedy against group representatives rather than all-pairs: a film is at most a few hundred
 * samples, and a picture that matches any member of a group belongs to that group.
 */
function groupByPicture(hashes: bigint[]): number[][] {
  const groups: { hash: bigint; atSec: number[] }[] = [];
  hashes.forEach((h, sec) => {
    const hit = groups.find((g) => isNearDuplicateHash(g.hash, h));
    if (hit) hit.atSec.push(sec);
    else groups.push({ hash: h, atSec: [sec] });
  });
  return groups.map((g) => g.atSec);
}

/**
 * Split one picture's sightings into appearances.
 *
 * Consecutive seconds are one appearance — that is a shot being on screen, which is not a repeat.
 * A gap of at least REPEAT_MIN_GAP_SEC starts a new one, which is the viewer seeing it come back.
 */
function splitIntoAppearances(atSec: number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const sec of atSec) {
    if (current.length === 0 || sec - current[current.length - 1]! < REPEAT_MIN_GAP_SEC) {
      current.push(sec);
    } else {
      runs.push(current);
      current = [sec];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

export async function auditVideoRepeats(params: {
  videoPath: string;
  timeoutMs?: number;
}): Promise<RepeatReport> {
  const timeout = params.timeoutMs ?? 180_000;
  const durationSec = await probeDurationSec(params.videoPath);
  const hashes = await sampleFrameHashes(params.videoPath, timeout);

  const groups = groupByPicture(hashes);
  const repeats: RepeatedPicture[] = [];
  let repeatedSec = 0;

  for (const atSec of groups) {
    const appearances = splitIntoAppearances(atSec);
    if (appearances.length < 2) continue;
    // Everything after the first appearance is time the viewer spent on a picture they had seen.
    const secondsAfterFirst = atSec.length - appearances[0]!.length;
    repeatedSec += secondsAfterFirst;
    repeats.push({ atSec, appearances: appearances.length, repeatedSec: secondsAfterFirst });
  }

  repeats.sort((a, b) => b.repeatedSec - a.repeatedSec);
  return {
    durationSec,
    sampled: hashes.length,
    distinctPictures: groups.length,
    repeats,
    repeatedSec,
    repeatedShare: durationSec > 0 ? repeatedSec / durationSec : 0,
  };
}

/**
 * Is this an acceptable amount of repetition?
 *
 * A share rather than a count, because a returning shot is an ordinary documentary device and
 * banning it outright would be wrong. What is not ordinary is a film that is mostly its own
 * reruns, which is what a starved scene produces.
 */
export function checkRepeatLimit(
  report: RepeatReport,
  limitShare: number = REPEAT_MAX_SHARE
): RepeatVerdict {
  const violations = report.repeats
    .filter((r) => r.repeatedSec >= REPEAT_MIN_GAP_SEC)
    .map(
      (r) =>
        `one picture returns ${r.appearances}× — ${r.repeatedSec}s of repeated screen time ` +
        `(seen at ${r.atSec.slice(0, 8).join("s, ")}s${r.atSec.length > 8 ? ", …" : ""})`
    );
  return {
    ok: report.repeatedShare <= limitShare,
    repeatedShare: report.repeatedShare,
    limitShare,
    violations,
  };
}

export function formatRepeatReport(
  label: string,
  report: RepeatReport,
  verdict: RepeatVerdict
): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `[RepeatAudit] ${label}`,
    `  duration            ${report.durationSec.toFixed(2)}s`,
    `  sampled             ${report.sampled} frame(s), 1/s`,
    `  distinct pictures   ${report.distinctPictures}`,
    `  repeated pictures   ${report.repeats.length}`,
    `  repeated screen     ${report.repeatedSec}s (${pct(report.repeatedShare)})`,
    `  limit               ${pct(verdict.limitShare)}`,
    `  passed              ${verdict.ok ? "YES" : "NO"}`,
  ];
  for (const v of verdict.violations.slice(0, 6)) lines.push(`  REPEAT              ${v}`);
  return lines.join("\n");
}
