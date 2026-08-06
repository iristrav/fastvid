/** Editorial Review Engine V2 — Visual Reviewer (Phase 6).
 *
 *  Scores Visual Accuracy and Visual Diversity. ClipInstruction (Phase 4's output) doesn't
 *  carry the original CandidateAsset's search metadata, so this reviewer works from the two
 *  signals actually available at this pipeline stage: ShotPlanner's own `shot.reason` text
 *  (which already says, in plain words, when a beat matched only via the generic-category
 *  fallback tier or had no strong local signal at all — reused verbatim rather than
 *  re-deriving a confidence score) and each clip's candidateId source prefix (every
 *  SourceAdapter prefixes candidateId with its source, e.g. "own_archive:...").
 *
 *  Visual Diversity's entropy calculation mirrors the legacy engine's scoreVisualDiversity()
 *  algorithm shape (source entropy + consecutive-same-source run penalty + repeated-clip
 *  detection), reused as a pattern, not a literal import — the legacy version reads
 *  ClipAdoptEntry.source directly; this one derives an equivalent signal from candidateId.
 */
import type { DimensionScore, FlatBeat, Problem } from "./types";

export type VisualReviewResult = {
  scores: { visualAccuracy: DimensionScore; visualDiversity: DimensionScore };
  problems: Problem[];
};

const FALLBACK_SIGNAL = "generic-category fallback";
const NO_LOCAL_SIGNAL = "No stronger signal";

function sourcePrefix(candidateId: string): string {
  const idx = candidateId.indexOf(":");
  return idx === -1 ? candidateId : candidateId.slice(0, idx);
}

function scoreVisualAccuracy(beats: FlatBeat[]): { score: DimensionScore; problems: Problem[] } {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const problems: Problem[] = [];
  const fallbackBeats = beats.filter((b) => b.decision.shot.reason.includes(FALLBACK_SIGNAL));
  const noSignalBeats = beats.filter((b) => b.decision.shot.reason.includes(NO_LOCAL_SIGNAL));

  for (const b of fallbackBeats) {
    problems.push({
      type: "off_topic_visual",
      severity: "medium",
      sceneIndex: b.sceneIndex,
      beatId: b.decision.beatId,
      description: `Beat ${b.decision.beatId} matched only via the generic-category fallback — its visual may not directly support the narration.`,
      evidence: b.decision.shot.reason,
    });
  }

  const fallbackFraction = fallbackBeats.length / beats.length;
  const noSignalFraction = noSignalBeats.length / beats.length;
  const penalty = fallbackFraction * 60 + noSignalFraction * 20;
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    score: {
      score,
      feedback:
        fallbackBeats.length === 0
          ? "Visuals appear well-matched to the narration — no generic-fallback matches found."
          : `${fallbackBeats.length}/${beats.length} beats matched only via generic-category fallback.`,
      issue: fallbackBeats.length > 0 ? `${fallbackBeats.length} beat(s) with weak visual-to-narration match` : undefined,
      suggestion: fallbackBeats.length > 0 ? "Search for more specific footage for the flagged beats instead of relying on the generic fallback." : undefined,
    },
    problems,
  };
}

function scoreVisualDiversity(beats: FlatBeat[]): { score: DimensionScore; problems: Problem[] } {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const problems: Problem[] = [];
  const prefixes = beats.map((b) => sourcePrefix(b.decision.clip.candidateId));
  const counts: Record<string, number> = {};
  for (const p of prefixes) counts[p] = (counts[p] ?? 0) + 1;

  const n = prefixes.length;
  const values = Object.values(counts);
  const entropy = values.length <= 1 ? 0 : -values.map((c) => c / n).reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0);
  const maxEntropy = Math.log2(Math.max(2, values.length));
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  let maxSourceRun = 1;
  let curSourceRun = 1;
  for (let i = 1; i < prefixes.length; i++) {
    if (prefixes[i] === prefixes[i - 1]) {
      curSourceRun++;
      maxSourceRun = Math.max(maxSourceRun, curSourceRun);
    } else {
      curSourceRun = 1;
    }
  }

  const idCounts: Record<string, FlatBeat[]> = {};
  for (const b of beats) {
    const id = b.decision.clip.candidateId;
    (idCounts[id] ??= []).push(b);
  }
  const repeated = Object.entries(idCounts).filter(([, occurrences]) => occurrences.length > 1);
  for (const [candidateId, occurrences] of repeated) {
    problems.push({
      type: "repeated_footage",
      severity: occurrences.length >= 3 ? "high" : "medium",
      sceneIndex: occurrences[0]!.sceneIndex,
      beatId: occurrences[0]!.decision.beatId,
      description: `The same clip ("${candidateId}") is used ${occurrences.length} times across the video.`,
      evidence: `Beats: ${occurrences.map((o) => o.decision.beatId).join(", ")}.`,
    });
  }

  const entropyScore = normalizedEntropy * 70;
  const sourceRunPenalty = Math.max(0, (maxSourceRun - 3) * 4);
  const repeatedPenalty = Math.min(30, repeated.length * 10);
  const score = Math.max(0, Math.min(100, entropyScore + 30 - sourceRunPenalty - repeatedPenalty));

  const issues: string[] = [];
  if (repeated.length > 0) issues.push(`${repeated.length} clip(s) reused more than once`);
  if (maxSourceRun >= 6) issues.push(`${maxSourceRun} consecutive clips from the same source`);

  return {
    score: {
      score,
      feedback: issues.length === 0 ? `Good source diversity across ${values.length} sources.` : issues.join("; "),
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion: repeated.length > 0 ? "Replace the duplicate visuals with alternate footage." : maxSourceRun >= 6 ? "Vary the source mix — avoid long runs from a single provider." : undefined,
    },
    problems,
  };
}

export function reviewVisuals(beats: FlatBeat[]): VisualReviewResult {
  const accuracy = scoreVisualAccuracy(beats);
  const diversity = scoreVisualDiversity(beats);
  return {
    scores: { visualAccuracy: accuracy.score, visualDiversity: diversity.score },
    problems: [...accuracy.problems, ...diversity.problems],
  };
}
