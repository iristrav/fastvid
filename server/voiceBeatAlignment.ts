/**
 * Voice beat alignment — Whisper transcription maps narration beats to real TTS timing.
 */
import fs from "fs";
import path from "path";
import { ENV } from "./_core/env";
import type { WhisperSegment } from "./_core/voiceTranscription";
import { syncBeatHoldSecToVoiceTimeline, type BeatHoldInput } from "./voiceMomentSync";
import { archiveVisualMaxClipSec, archiveVisualMinClipSec } from "./sourcingPolicy";
import {
  extractFrameAtFraction,
  resolveBeatVisionQueryEmbedding,
  beatVisionContextFromProfile,
  scoreFramePathsAgainstBeat,
  localVisionEnabled,
} from "./localClipVision";
import { minClipQualityScore } from "./visualQualityGate";
import { voiceVisualAuditMinScore } from "./voiceVisualMatch";
import { probeVideoDurationSec } from "./archiveVideoSplitter";

export type BeatVoiceAlignment = {
  beatIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
};

const alignCache = new Map<string, WhisperSegment[]>();

export function voiceBeatAlignmentEnabled(): boolean {
  if (process.env.ENABLE_VOICE_BEAT_ALIGNMENT === "false") return false;
  return Boolean(ENV.forgeApiKey);
}

export function voiceAlignmentSpotCheckEnabled(): boolean {
  if (process.env.ENABLE_VOICE_ALIGNMENT_SPOT_CHECK === "false") return false;
  return localVisionEnabled() && voiceBeatAlignmentEnabled();
}

function normalizeAlignText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[visual:[^\]]+\]/gi, " ")
    .replace(/[^a-zà-ÿ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function alignTokens(text: string): string[] {
  return normalizeAlignText(text).split(" ").filter((w) => w.length > 1);
}

function tokenOverlapScore(expected: string[], haystack: string[]): number {
  if (!expected.length) return 0;
  const set = new Set(haystack);
  let hits = 0;
  for (const t of expected) {
    if (set.has(t)) hits++;
  }
  return hits / expected.length;
}

function whisperApiUrl(): string {
  const base = ENV.forgeApiUrl?.trim();
  if (base) {
    return new URL("v1/audio/transcriptions", base.endsWith("/") ? base : `${base}/`).toString();
  }
  return "https://api.openai.com/v1/audio/transcriptions";
}

async function transcribeSceneAudio(audioPath: string): Promise<WhisperSegment[] | null> {
  if (!ENV.forgeApiKey || !fs.existsSync(audioPath)) return null;

  const stat = fs.statSync(audioPath);
  const cacheKey = `${audioPath}:${stat.size}:${stat.mtimeMs}`;
  const cached = alignCache.get(cacheKey);
  if (cached) return cached;

  const buf = fs.readFileSync(audioPath);
  const formData = new FormData();
  formData.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(audioPath));
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  try {
    const resp = await fetch(whisperApiUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "Accept-Encoding": "identity",
      },
      body: formData,
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) {
      console.warn(
        `[VoiceAlign] Whisper HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`
      );
      return null;
    }
    const data = (await resp.json()) as { segments?: WhisperSegment[] };
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if (segments.length === 0) return null;
    alignCache.set(cacheKey, segments);
    return segments;
  } catch (err) {
    console.warn(`[VoiceAlign] transcription failed:`, (err as Error).message?.slice(0, 100));
    return null;
  }
}

/** Map beat texts onto Whisper segment windows in narration order. */
export function alignBeatTextsToSegments(
  beatTexts: string[],
  segments: WhisperSegment[],
  voiceDurationSec: number
): BeatVoiceAlignment[] {
  if (!beatTexts.length) return [];

  const results: BeatVoiceAlignment[] = [];
  let segCursor = 0;

  for (let bi = 0; bi < beatTexts.length; bi++) {
    const beatTokens = alignTokens(beatTexts[bi]!);
    if (segCursor >= segments.length) {
      const prevEnd = results[results.length - 1]?.endSec ?? 0;
      results.push({
        beatIndex: bi,
        startSec: prevEnd,
        endSec: voiceDurationSec,
        durationSec: Math.max(0.5, voiceDurationSec - prevEnd),
      });
      continue;
    }

    if (beatTokens.length === 0) {
      const seg = segments[segCursor]!;
      results.push({
        beatIndex: bi,
        startSec: seg.start,
        endSec: seg.end,
        durationSec: Math.max(0.5, seg.end - seg.start),
      });
      segCursor++;
      continue;
    }

    let bestEnd = segCursor;
    let bestScore = 0;
    let accumulated: string[] = [];

    for (let si = segCursor; si < segments.length; si++) {
      accumulated.push(...alignTokens(segments[si]!.text));
      const score = tokenOverlapScore(beatTokens, accumulated);
      if (score >= bestScore) {
        bestScore = score;
        bestEnd = si;
      }
      if (si > segCursor && score < bestScore * 0.55 && bestScore >= 0.35) break;
    }

    const startSec = segments[segCursor]!.start;
    let endSec = segments[bestEnd]!.end;
    if (bi === beatTexts.length - 1) {
      endSec = Math.max(endSec, voiceDurationSec);
    }
    results.push({
      beatIndex: bi,
      startSec,
      endSec,
      durationSec: Math.max(0.5, endSec - startSec),
    });
    segCursor = Math.min(segments.length, bestEnd + 1);
  }

  if (results.length > 0) {
    const last = results[results.length - 1]!;
    last.endSec = Math.max(last.endSec, voiceDurationSec);
    last.durationSec = Math.max(0.5, last.endSec - last.startSec);
  }

  return results;
}

export function applyBeatVoiceAlignments(
  beats: BeatHoldInput[],
  alignments: BeatVoiceAlignment[],
  voiceSec: number,
  xfadeSec = 0.35
): void {
  if (!beats.length || !alignments.length) return;

  const minHold = archiveVisualMinClipSec();
  const maxHold = archiveVisualMaxClipSec();
  const weights: number[] = [];

  for (let i = 0; i < beats.length; i++) {
    const a = alignments.find((x) => x.beatIndex === i) ?? alignments[i];
    const dur = a?.durationSec ?? beats[i]!.holdSec;
    beats[i]!.holdSec = Math.max(minHold, Math.min(maxHold, dur));
    weights.push(Math.max(0.35, dur));
  }

  syncBeatHoldSecToVoiceTimeline(beats, voiceSec, xfadeSec, weights);
}

/** Align scene beats to per-scene voiceover MP3 via Whisper. Returns false when skipped/failed. */
export async function alignSceneBeatsToVoiceAudio(
  beats: BeatHoldInput[],
  sceneAudioPath: string,
  voiceSec: number,
  xfadeSec = 0.35
): Promise<boolean> {
  if (!voiceBeatAlignmentEnabled() || !beats.length || voiceSec <= 0) return false;

  const segments = await transcribeSceneAudio(sceneAudioPath);
  if (!segments?.length) return false;

  const alignments = alignBeatTextsToSegments(
    beats.map((b) => b.text),
    segments,
    voiceSec
  );
  if (alignments.length !== beats.length) return false;

  applyBeatVoiceAlignments(beats, alignments, voiceSec, xfadeSec);
  console.log(
    `[VoiceAlign] ${beats.length} beats aligned to ${voiceSec.toFixed(1)}s VO ` +
      `(windows: ${alignments.map((a) => a.durationSec.toFixed(1)).join("s, ")}s)`
  );
  return true;
}

/** Validate montage clip durations cover the aligned voice window. */
export function validateMontageVoiceCoverage(
  beatDurations: number[],
  voiceSec: number,
  xfadeSec = 0.35
): { ok: boolean; coverageSec: number; warnings: string[] } {
  const warnings: string[] = [];
  const n = beatDurations.length;
  const gross = beatDurations.reduce((s, d) => s + d, 0);
  const coverageSec = n > 1 ? gross - (n - 1) * xfadeSec : gross;
  const delta = Math.abs(coverageSec - voiceSec);
  if (delta > Math.max(1.2, voiceSec * 0.12)) {
    warnings.push(
      `montage coverage ${coverageSec.toFixed(1)}s vs voice ${voiceSec.toFixed(1)}s (Δ${delta.toFixed(1)}s)`
    );
  }
  return { ok: warnings.length === 0, coverageSec, warnings };
}

/** Sample composed scene at each beat midpoint — quick CLIP sanity check. */
export async function spotCheckComposedSceneBeatSync(
  composedPath: string,
  beats: BeatHoldInput[],
  beatDurations: number[],
  clipBeatIndices: number[],
  workDir: string,
  sceneIndex: number,
  videoTitle?: string,
  xfadeSec = 0.35,
  options?: { skipClipScoring?: boolean }
): Promise<{ ok: boolean; warnings: string[] }> {
  if (!voiceAlignmentSpotCheckEnabled() || !fs.existsSync(composedPath)) {
    return { ok: true, warnings: [] };
  }

  const skipClip = options?.skipClipScoring === true;
  const warnings: string[] = [];
  const minScore = voiceVisualAuditMinScore();
  const totalDur = await probeVideoDurationSec(composedPath);
  if (totalDur <= 0.5) return { ok: true, warnings: [] };

  let timeline = 0;
  const checkCap = Math.min(beatDurations.length, 4);

  for (let ci = 0; ci < beatDurations.length; ci++) {
    if (ci >= checkCap && ci !== beatDurations.length - 1) {
      timeline += beatDurations[ci]! - (ci > 0 ? xfadeSec : 0);
      continue;
    }

    const beatIdx = clipBeatIndices[ci] ?? ci;
    const beat = beats[beatIdx];
    if (!beat) {
      timeline += beatDurations[ci]! - (ci > 0 ? xfadeSec : 0);
      continue;
    }

    const sampleSec = Math.min(totalDur - 0.05, timeline + beatDurations[ci]! * 0.45);
    const sampleFrac = Math.max(0.02, Math.min(0.98, sampleSec / totalDur));
    const framePath = path.join(
      workDir,
      `scene_${sceneIndex}_align_spot_${ci}_${path.basename(composedPath).replace(/\.[^.]+$/, "")}.jpg`
    );
    const ok = await extractFrameAtFraction(composedPath, framePath, sampleFrac, 8_000);
    if (!ok) {
      timeline += beatDurations[ci]! - (ci > 0 ? xfadeSec : 0);
      continue;
    }

    if (!skipClip) {
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
      if (scored && scored.score < minScore) {
        warnings.push(
          `beat ${beatIdx} timeline ${sampleSec.toFixed(1)}s CLIP ${scored.score}/10 < ${minScore}`
        );
      }
    }
    try {
      fs.unlinkSync(framePath);
    } catch {
      /* ignore */
    }

    timeline += beatDurations[ci]! - (ci > 0 ? xfadeSec : 0);
  }

  if (warnings.length) {
    console.warn(
      `[VoiceAlign] Scene ${sceneIndex} composed spot-check: ${warnings.join("; ")}`
    );
  }
  return { ok: warnings.length === 0, warnings };
}
