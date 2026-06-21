/**
 * Post-compose voice↔montage sync audit — timeline + CLIP at TTS cut points.
 */
import fs from "fs";
import path from "path";
import { beatVisionContextFromProfile } from "./archiveClipEmbedding";
import {
  computeMontageBeatStarts,
  fillPartialTtsVoiceStarts,
  beatsHavePartialTtsWindows,
  type BeatYearInput,
  type TtsMontagePlan,
} from "./cinematicEffectsEngine";
import {
  extractFrameAtFraction,
  resolveBeatVisionQueryEmbedding,
  scoreFramePathsAgainstBeat,
} from "./localClipVision";
import { minClipQualityScore } from "./visualQualityGate";

export type VoiceMontageSyncCheck = {
  clipIndex: number;
  beatIndex: number;
  expectedStartSec: number;
  actualStartSec: number;
  deltaSec: number;
  clipScore10: number | null;
};

export type VoiceMontageSyncAuditResult = {
  ok: boolean;
  blocking: boolean;
  warnings: string[];
  checks: VoiceMontageSyncCheck[];
};

export function voiceMontageSyncAuditEnabled(): boolean {
  if (process.env.ENABLE_VOICE_MONTAGE_SYNC_AUDIT === "false") return false;
  return true;
}

/** When true, failed sync audit blocks export (STRICT_VOICE_MONTAGE_SYNC=true). */
export function strictVoiceMontageSyncExport(): boolean {
  return process.env.STRICT_VOICE_MONTAGE_SYNC === "true";
}

const MAX_TIMELINE_DRIFT_SEC = 0.45;
const MAX_CLIP_CHECKS = 6;

function beatsHaveTtsWindows(beats: BeatYearInput[]): boolean {
  return (
    beats.length > 0 &&
    beats.every((b) => b.voiceStartSec != null && b.voiceEndSec != null)
  );
}

/** Expected cut start per clip from TTS voiceStartSec (matches hard-cut planner). */
export function expectedMontageCutStarts(
  beats: BeatYearInput[],
  voiceDur: number,
  clipBeatIndices: number[]
): number[] {
  const planCutStarts = computeTtsCutStarts(beats, voiceDur, clipBeatIndices);
  if (planCutStarts) return planCutStarts;
  return computeMontageBeatStarts(
    clipBeatIndices.map((bi) => beats[bi]?.holdSec ?? voiceDur / clipBeatIndices.length),
    0
  );
}

function computeTtsCutStarts(
  beats: BeatYearInput[],
  voiceDur: number,
  clipBeatIndices: number[]
): number[] | null {
  const full = beatsHaveTtsWindows(beats);
  const partial = !full && beatsHavePartialTtsWindows(beats);
  if ((!full && !partial) || clipBeatIndices.length === 0) return null;
  const timed = full ? beats : fillPartialTtsVoiceStarts(beats, voiceDur);
  const n = clipBeatIndices.length;
  const cutStartsSec = new Array<number>(n).fill(0);
  let ci = 0;
  while (ci < n) {
    const beatIdx = clipBeatIndices[ci] ?? 0;
    let runEnd = ci;
    while (runEnd < n && (clipBeatIndices[runEnd] ?? 0) === beatIdx) runEnd++;
    const runLen = runEnd - ci;
    const beat = timed[beatIdx]!;
    const beatStart = beat.voiceStartSec!;
    const beatEnd =
      beatIdx + 1 < timed.length && timed[beatIdx + 1]!.voiceStartSec != null
        ? timed[beatIdx + 1]!.voiceStartSec!
        : Math.max(beat.voiceEndSec ?? beatStart, voiceDur);
    const window = Math.max(0.35 * runLen, beatEnd - beatStart);
    const slot = window / runLen;
    for (let j = 0; j < runLen; j++) {
      cutStartsSec[ci + j] = beatStart + j * slot;
    }
    ci = runEnd;
  }
  return cutStartsSec;
}

async function probeVideoDurationSec(filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);
    const ffprobe = process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
    const { stdout } = await exec(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const n = parseFloat(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Audit composed scene: cut timeline vs TTS + CLIP at each cut point. */
export async function auditSceneVoiceMontageSync(
  composedPath: string,
  beats: BeatYearInput[],
  montageDurations: number[],
  clipBeatIndices: number[],
  voiceDur: number,
  workDir: string,
  sceneIndex: number,
  videoTitle?: string,
  plan?: Pick<TtsMontagePlan, "cutStartsSec" | "xfadeSec" | "ttsHardCut">
): Promise<VoiceMontageSyncAuditResult> {
  if (!voiceMontageSyncAuditEnabled() || !fs.existsSync(composedPath)) {
    return { ok: true, blocking: false, warnings: [], checks: [] };
  }
  if (montageDurations.length === 0 || clipBeatIndices.length !== montageDurations.length) {
    return { ok: true, blocking: false, warnings: [], checks: [] };
  }

  const xfadeSec = plan?.xfadeSec ?? 0;
  const actualStarts =
    plan?.cutStartsSec?.length === montageDurations.length
      ? plan.cutStartsSec
      : computeMontageBeatStarts(montageDurations, xfadeSec);
  const expectedStarts = expectedMontageCutStarts(beats, voiceDur, clipBeatIndices);

  const warnings: string[] = [];
  const checks: VoiceMontageSyncCheck[] = [];
  const totalDur = await probeVideoDurationSec(composedPath);
  const minScore = Math.max(6, minClipQualityScore() - 1);
  const checkIndices = selectCheckClipIndices(montageDurations.length);

  for (const ci of checkIndices) {
    const beatIdx = clipBeatIndices[ci] ?? ci;
    const beat = beats[beatIdx];
    if (!beat) continue;

    const expectedStartSec = expectedStarts[ci] ?? 0;
    const actualStartSec = actualStarts[ci] ?? 0;
    const deltaSec = Math.abs(actualStartSec - expectedStartSec);

    if (plan?.ttsHardCut && deltaSec > MAX_TIMELINE_DRIFT_SEC) {
      warnings.push(
        `clip ${ci} beat ${beatIdx}: cut drift ${deltaSec.toFixed(2)}s ` +
          `(expected ${expectedStartSec.toFixed(2)}s, plan ${actualStartSec.toFixed(2)}s)`
      );
    } else if (!plan?.ttsHardCut && beatsHavePartialTtsWindows(beats) && deltaSec > MAX_TIMELINE_DRIFT_SEC) {
      warnings.push(
        `clip ${ci} beat ${beatIdx}: montage drift ${deltaSec.toFixed(2)}s (partial TTS — consider hard-cut remontage)`
      );
    }

    let clipScore10: number | null = null;
    if (totalDur > 0.5) {
      const sampleSec = Math.min(totalDur - 0.04, actualStartSec + 0.1);
      const sampleFrac = Math.max(0.01, Math.min(0.99, sampleSec / totalDur));
      const framePath = path.join(
        workDir,
        `scene_${sceneIndex}_sync_audit_${ci}_${path.basename(composedPath).replace(/\.[^.]+$/, "")}.jpg`
      );
      const ok = await extractFrameAtFraction(composedPath, framePath, sampleFrac, 8_000);
      if (ok) {
        const ctx = beatVisionContextFromProfile({ text: beat.text }, videoTitle);
        const queryEmb = await resolveBeatVisionQueryEmbedding(ctx);
        const scored = await scoreFramePathsAgainstBeat(
          [framePath],
          beat.text,
          undefined,
          videoTitle,
          composedPath,
          minScore,
          undefined,
          queryEmb
        );
        clipScore10 = scored?.score ?? null;
        if (scored && scored.score < minScore) {
          warnings.push(
            `clip ${ci} beat ${beatIdx} @ ${sampleSec.toFixed(1)}s: CLIP ${scored.score}/10 < ${minScore}`
          );
        }
        try {
          fs.unlinkSync(framePath);
        } catch {
          /* ignore */
        }
      }
    }

    checks.push({
      clipIndex: ci,
      beatIndex: beatIdx,
      expectedStartSec,
      actualStartSec,
      deltaSec,
      clipScore10,
    });
  }

  const ok = warnings.length === 0;
  if (!ok) {
    console.warn(
      `[VoiceSyncAudit] Scene ${sceneIndex}: ${warnings.length} issue(s) — ${warnings.slice(0, 3).join("; ")}`
    );
  }

  return {
    ok,
    blocking: !ok && strictVoiceMontageSyncExport(),
    warnings,
    checks,
  };
}

function selectCheckClipIndices(clipCount: number): number[] {
  if (clipCount <= MAX_CLIP_CHECKS) {
    return Array.from({ length: clipCount }, (_, i) => i);
  }
  const picks = new Set<number>([0, clipCount - 1]);
  const step = Math.max(1, Math.floor(clipCount / (MAX_CLIP_CHECKS - 2)));
  for (let i = step; i < clipCount - 1 && picks.size < MAX_CLIP_CHECKS; i += step) {
    picks.add(i);
  }
  return [...picks].sort((a, b) => a - b);
}

export type VideoVoiceMontageSyncSummary = {
  ok: boolean;
  sceneCount: number;
  failedScenes: number[];
  warnings: string[];
};

export function summarizeVoiceMontageSyncAudits(
  results: Array<{ sceneIndex: number; audit: VoiceMontageSyncAuditResult }>
): VideoVoiceMontageSyncSummary {
  const failedScenes: number[] = [];
  const warnings: string[] = [];
  for (const { sceneIndex, audit } of results) {
    if (!audit.ok) {
      failedScenes.push(sceneIndex);
      warnings.push(...audit.warnings.map((w) => `Scene ${sceneIndex}: ${w}`));
    }
  }
  return {
    ok: failedScenes.length === 0,
    sceneCount: results.length,
    failedScenes,
    warnings,
  };
}
