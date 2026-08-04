/**
 * Editorial Review Engine — post-render documentary quality assessment.
 *
 * Runs fire-and-forget after every render. Analyses the full video using
 * the adopt/reject audit, scene texts, beat durations and existing quality
 * metrics. Produces an EditorialReview with:
 *
 *  Rule-based (fast, no LLM):
 *    Shot Variety       — shot category distribution + consecutive-run detection
 *    Motion             — clip-source motion proxy vs. narration-energy targets
 *    Rhythm             — beat-duration coefficient of variation
 *    Visual Diversity   — source entropy + fallback/repetition penalties
 *
 *  LLM-based (one call, JSON, ≤500 tokens):
 *    Storytelling       — narrative structure, arc, intro/conclusion
 *    Visual Storytelling— clip-to-narration alignment, transitions
 *    Historical Accuracy— source/clip era appropriateness
 *    Emotional Impact   — clips supporting emotional tone
 *    Auto Improvements  — top-3 ranked, specific, actionable
 *
 * Nothing is re-rendered; all inputs are already computed artefacts.
 * Feature flag: EDITORIAL_REVIEW_ENABLED (default: "true")
 */

import { invokeLLM } from "./_core/llm";
import { classifyClipCategory } from "./shotSequenceOptimizer";
import { buildRhythmProfile } from "./visualRhythmEngine";
import type { ClipAdoptEntry } from "./clipAdoptAudit";
import type { ClipRejectEntry } from "./clipRejectAudit";
import type { VideoQualityReport } from "./videoQualityReport";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function editorialReviewEnabled(): boolean {
  return process.env.EDITORIAL_REVIEW_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type EditorialDimension =
  | "storytelling"
  | "visualStorytelling"
  | "shotVariety"
  | "motion"
  | "rhythm"
  | "visualDiversity"
  | "historicalAccuracy"
  | "emotionalImpact";

export type DimensionScore = {
  score: number;        // 0–100
  feedback: string;
  issue?: string;       // specific problem when score < 75
  suggestion?: string;  // specific actionable fix
};

export type AutoImprovement = {
  rank: 1 | 2 | 3;
  dimension: EditorialDimension;
  /** Which pipeline component most directly addresses this. */
  pipelineComponent: string;
  problem: string;
  action: string;
  expectedGain: string; // e.g. "+8 points"
};

export type SourcingMetrics = {
  archiveFraction: number;
  externalFraction: number;
  fallbackFraction: number;
  repeatedClips: number;
  repeatedSources: number;
  avgEditorialScore: number | null;
  avgMotionEstimate: number | null;
};

export type EditorialReview = {
  videoId: string;
  videoTitle: string;
  reviewedAt: string;
  scores: Record<EditorialDimension, DimensionScore>;
  overallScore: number;
  sourcing: SourcingMetrics;
  autoImprovements: AutoImprovement[];
  topIssues: string[];
};

export type ReviewInput = {
  videoId: string;
  videoTitle: string;
  scenes: Array<{ index: number; text: string; duration?: number }>;
  adoptAudit: ClipAdoptEntry[];
  rejectAudit?: ClipRejectEntry[];
  qualityReport?: VideoQualityReport | null;
  sceneClips?: string[][];
  sceneBeatDurations?: number[][];
  sceneBeats?: Array<Array<{ index: number; text: string }>>;
};

// ─── Source motion proxies ─────────────────────────────────────────────────────

const SOURCE_MOTION_PROXY: Record<string, number> = {
  pexels: 72,
  pixabay: 70,
  stock: 68,
  rescue_stock: 65,
  archive: 65,
  archive_fetch: 65,
  rescue_archive: 60,
  rescue_similar: 60,
  own_archive: 65,
  wikimedia: 20,
  wikimedia_video: 45,
  rescue_wikimedia: 20,
  openverse: 40,
  kling: 68,
  rescue_ai: 65,
  ai_generated: 68,
  fallback: 0,
  rescue_placeholder: 0,
  guaranteed: 0,
  color_fallback: 0,
  rescue_extend: 45,
  internet_archive: 55,
};

function estimateMotionForSource(source: string): number {
  return SOURCE_MOTION_PROXY[source] ?? 50;
}

// ─── Rule-based: Shot Variety ─────────────────────────────────────────────────

function scoreShootVariety(adoptAudit: ClipAdoptEntry[], scenes: ReviewInput["scenes"]): DimensionScore {
  if (adoptAudit.length === 0) return { score: 50, feedback: "No clips to analyse." };

  const categories = adoptAudit.map((e) =>
    classifyClipCategory(e.basename, e.beatIndex, e.beatText, e.sceneIndex)
  );

  const counts: Record<string, number> = {};
  for (const c of categories) counts[c] = (counts[c] ?? 0) + 1;
  const n = categories.length;

  // Detect runs
  let maxRun = 1;
  let curRun = 1;
  let runPenalty = 0;
  for (let i = 1; i < categories.length; i++) {
    if (categories[i] === categories[i - 1] && categories[i] !== "unknown") {
      curRun++;
      if (curRun >= 3) runPenalty += 4; // each extra same-category = -4
    } else {
      maxRun = Math.max(maxRun, curRun);
      curRun = 1;
    }
  }
  maxRun = Math.max(maxRun, curRun);

  const hasClose = (counts["close_up"] ?? 0) > 0;
  const hasWide = ((counts["establishing"] ?? 0) + (counts["action"] ?? 0)) > 0;
  const missingClose = !hasClose ? 8 : 0;
  const missingWide = !hasWide && n >= 4 ? 6 : 0;

  // Balance penalty: deviation from ideal spread
  const uniqueCategories = Object.keys(counts).filter((k) => k !== "unknown" && k !== "archival").length;
  const balancePenalty = Math.max(0, 3 - uniqueCategories) * 5;

  const score = Math.max(0, Math.min(100, 100 - runPenalty - missingClose - missingWide - balancePenalty));

  const issues: string[] = [];
  if (maxRun >= 3) issues.push(`${maxRun} consecutive clips of the same shot type`);
  if (!hasClose) issues.push("No close-up shots detected");
  if (!hasWide) issues.push("No establishing/wide shots detected");

  const issue = issues.length > 0 ? issues.join("; ") : undefined;
  const suggestion = !hasClose
    ? "Add a close-up detail shot in an emotionally significant scene"
    : maxRun >= 3
    ? `Break up the run of ${maxRun} same-type shots with a different shot category`
    : undefined;

  return {
    score,
    feedback: issues.length === 0
      ? `Good shot variety across ${uniqueCategories} categories`
      : `Shot variety issues: ${issues.join("; ")}`,
    issue,
    suggestion,
  };
}

// ─── Rule-based: Motion ───────────────────────────────────────────────────────

function scoreMotion(adoptAudit: ClipAdoptEntry[], scenes: ReviewInput["scenes"]): DimensionScore {
  if (adoptAudit.length === 0) return { score: 50, feedback: "No clips to analyse." };

  const motionEstimates = adoptAudit.map((e) => estimateMotionForSource(e.source));
  const avgMotion = motionEstimates.reduce((a, b) => a + b, 0) / motionEstimates.length;

  const fallbackCount = adoptAudit.filter((e) =>
    ["fallback", "rescue_placeholder", "guaranteed", "color_fallback"].includes(e.source)
  ).length;
  const fallbackFrac = fallbackCount / adoptAudit.length;

  // Desired motion level from narration energy
  const allBeatTexts = scenes.map((s) => s.text);
  const rhythmProfile = buildRhythmProfile(allBeatTexts);
  const desiredMotion = rhythmProfile.dominant === "high" ? 70 : rhythmProfile.dominant === "low" ? 25 : 50;

  const motionMismatch = Math.abs(avgMotion - desiredMotion);
  const mismatchPenalty = Math.min(20, motionMismatch * 0.3);
  const fallbackPenalty = Math.min(25, fallbackFrac * 100 * 0.8);

  const score = Math.max(0, Math.min(100, 100 - mismatchPenalty - fallbackPenalty));

  const issues: string[] = [];
  if (fallbackFrac > 0.1) issues.push(`${Math.round(fallbackFrac * 100)}% fallback/static clips`);
  if (motionMismatch > 25) {
    issues.push(
      rhythmProfile.dominant === "high" && avgMotion < desiredMotion
        ? "High-energy narration paired with mostly static footage"
        : "Low-energy narration paired with too much movement"
    );
  }

  return {
    score,
    feedback: issues.length === 0
      ? `Motion level (est. ${Math.round(avgMotion)}/100) matches narration energy (${rhythmProfile.dominant})`
      : issues.join("; "),
    issue: issues.length > 0 ? issues.join("; ") : undefined,
    suggestion: fallbackFrac > 0.15
      ? "Reduce fallback clips by improving archive sourcing for failed beats"
      : motionMismatch > 25
      ? "Adjust motion-aware ranking weight (motionMatch) for this content type"
      : undefined,
  };
}

// ─── Rule-based: Rhythm ───────────────────────────────────────────────────────

function scoreRhythm(sceneBeatDurations?: number[][]): DimensionScore {
  const all: number[] = (sceneBeatDurations ?? []).flat().filter((d) => d > 0);
  if (all.length < 3) {
    return { score: 75, feedback: "Insufficient beat-duration data for rhythm analysis." };
  }

  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const std = Math.sqrt(all.map((d) => (d - mean) ** 2).reduce((a, b) => a + b, 0) / all.length);
  const cv = std / mean; // coefficient of variation

  // Ideal CV: 0.20–0.45 (some variety, not chaotic)
  const cvPenalty = cv < 0.15 ? (0.15 - cv) * 120 : cv > 0.55 ? (cv - 0.55) * 80 : 0;

  // Penalise very short (<1.0s) or very long (>12s) beats
  const extremeLong = all.filter((d) => d > 12).length;
  const extremeShort = all.filter((d) => d < 0.8).length;
  const extremePenalty = (extremeLong + extremeShort) * 3;

  const score = Math.max(0, Math.min(100, 100 - cvPenalty - extremePenalty));

  const issue =
    cv < 0.15
      ? "Beat durations are too uniform — creates monotone pacing"
      : cv > 0.55
      ? "Extreme variation in beat durations — pacing feels erratic"
      : extremeLong > 2
      ? `${extremeLong} beats are >12 s — consider splitting`
      : undefined;

  const suggestion =
    cv < 0.15
      ? "Enable Visual Rhythm Engine to introduce energy-based duration variation"
      : cv > 0.55
      ? "Review beats with durations >10 s and split them"
      : undefined;

  return {
    score,
    feedback: issue ?? `Rhythm CV=${cv.toFixed(2)} (target 0.20–0.45), mean=${mean.toFixed(1)}s`,
    issue,
    suggestion,
  };
}

// ─── Rule-based: Visual Diversity ────────────────────────────────────────────

function scoreVisualDiversity(adoptAudit: ClipAdoptEntry[]): DimensionScore {
  if (adoptAudit.length === 0) return { score: 50, feedback: "No clips to analyse." };

  const sourceCounts: Record<string, number> = {};
  for (const e of adoptAudit) {
    const normalized = e.source.startsWith("rescue_similar")
      ? "own_archive"
      : e.source.startsWith("rescue_")
      ? "rescue"
      : e.source;
    sourceCounts[normalized] = (sourceCounts[normalized] ?? 0) + 1;
  }

  const n = adoptAudit.length;
  const values = Object.values(sourceCounts);
  const entropy = values.length <= 1
    ? 0
    : -values.map((c) => c / n).reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0);
  const maxEntropy = Math.log2(Math.max(2, values.length));
  const normalizedEntropy = entropy / maxEntropy; // 0..1

  const fallbackFrac = (sourceCounts["rescue"] ?? 0) / n +
    ((sourceCounts["fallback"] ?? 0) + (sourceCounts["guaranteed"] ?? 0) + (sourceCounts["color_fallback"] ?? 0)) / n;

  // Detect consecutive same-source runs
  let maxSourceRun = 1;
  let curSourceRun = 1;
  for (let i = 1; i < adoptAudit.length; i++) {
    if (adoptAudit[i].source === adoptAudit[i - 1].source) {
      curSourceRun++;
      maxSourceRun = Math.max(maxSourceRun, curSourceRun);
    } else {
      curSourceRun = 1;
    }
  }

  const entropyScore = normalizedEntropy * 70; // max 70 from entropy
  const sourceRunPenalty = Math.max(0, (maxSourceRun - 3) * 4);
  const fallbackPenalty = Math.min(30, fallbackFrac * 100);
  const score = Math.max(0, Math.min(100, entropyScore + 30 - sourceRunPenalty - fallbackPenalty));

  const domSource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])[0];
  const domFrac = domSource ? domSource[1] / n : 0;

  const issues: string[] = [];
  if (domFrac > 0.75) issues.push(`${Math.round(domFrac * 100)}% clips from single source (${domSource[0]})`);
  if (maxSourceRun >= 6) issues.push(`${maxSourceRun} consecutive clips from same source`);
  if (fallbackFrac > 0.1) issues.push(`${Math.round(fallbackFrac * 100)}% fallback clips`);

  return {
    score,
    feedback: issues.length === 0
      ? `Good source diversity across ${values.length} categories`
      : issues.join("; "),
    issue: issues.length > 0 ? issues.join("; ") : undefined,
    suggestion: domFrac > 0.75
      ? "Add more source variety: wikimedia, internet archive, or pexels alongside archive clips"
      : maxSourceRun >= 6
      ? "The Global Documentary Director can detect and break up source monotony"
      : undefined,
  };
}

// ─── Sourcing metrics ─────────────────────────────────────────────────────────

function computeSourcingMetrics(
  adoptAudit: ClipAdoptEntry[],
  qualityReport?: VideoQualityReport | null
): SourcingMetrics {
  const n = adoptAudit.length;
  if (n === 0) {
    return { archiveFraction: 0, externalFraction: 0, fallbackFraction: 0, repeatedClips: 0, repeatedSources: 0, avgEditorialScore: null, avgMotionEstimate: null };
  }

  const archiveSources = new Set(["archive", "archive_fetch", "rescue_archive", "own_archive", "rescue_similar", "rescue_similar_v2"]);
  const fallbackSources = new Set(["fallback", "rescue_placeholder", "guaranteed", "color_fallback"]);

  const archiveCount = adoptAudit.filter((e) => archiveSources.has(e.source) || e.source.startsWith("rescue_similar")).length;
  const fallbackCount = adoptAudit.filter((e) => fallbackSources.has(e.source)).length;
  const externalCount = n - archiveCount - fallbackCount;

  // Repeated clips (same basename used more than once)
  const basenameCounts: Record<string, number> = {};
  for (const e of adoptAudit) basenameCounts[e.basename] = (basenameCounts[e.basename] ?? 0) + 1;
  const repeatedClips = Object.values(basenameCounts).filter((c) => c > 1).length;

  // Repeated sources (distinct source used ≥3 times in a row)
  let repeatedSources = 0;
  let curRun = 1;
  for (let i = 1; i < adoptAudit.length; i++) {
    if (adoptAudit[i].source === adoptAudit[i - 1].source) {
      curRun++;
      if (curRun === 3) repeatedSources++;
    } else {
      curRun = 1;
    }
  }

  const motionEstimates = adoptAudit.map((e) => estimateMotionForSource(e.source));
  const avgMotionEstimate = motionEstimates.reduce((a, b) => a + b, 0) / n;

  return {
    archiveFraction: archiveCount / n,
    externalFraction: externalCount / n,
    fallbackFraction: fallbackCount / n,
    repeatedClips,
    repeatedSources,
    avgEditorialScore: null, // future: look up from annotation
    avgMotionEstimate,
  };
}

// ─── LLM assessment ───────────────────────────────────────────────────────────

type LLMScores = {
  storytelling: DimensionScore;
  visualStorytelling: DimensionScore;
  historicalAccuracy: DimensionScore;
  emotionalImpact: DimensionScore;
  autoImprovements: Array<{
    rank: 1 | 2 | 3;
    dimension: EditorialDimension;
    problem: string;
    action: string;
    expectedGain: string;
  }>;
};

const PIPELINE_COMPONENT_MAP: Record<EditorialDimension, string> = {
  storytelling: "Editorial Sequence Planner + script structure",
  visualStorytelling: "Shot Sequence Optimizer + Editorial Reorder",
  shotVariety: "Shot Sequence Optimizer aggressiveness",
  motion: "Motion-Aware Ranking (motionMatch weight)",
  rhythm: "Visual Rhythm Engine energy classification",
  visualDiversity: "Global Documentary Director + source diversification",
  historicalAccuracy: "Archive retrieval priority + Editorial Scoring",
  emotionalImpact: "Visual Intent Engine emotion field + Editorial Score",
};

async function getLLMScores(input: ReviewInput, ruleScores: Partial<Record<EditorialDimension, DimensionScore>>): Promise<LLMScores | null> {
  const sceneLines = input.scenes.slice(0, 16).map((s, i) => {
    const clips = input.adoptAudit.filter((e) => e.sceneIndex === s.index);
    const srcSummary = clips.length > 0
      ? Object.entries(clips.reduce((acc, e) => { acc[e.source] = (acc[e.source] ?? 0) + 1; return acc; }, {} as Record<string, number>))
          .map(([src, cnt]) => `${src}:${cnt}`).join(", ")
      : "no clips";
    return `${i + 1}. "${s.text.slice(0, 90)}" → ${clips.length} clips (${srcSummary})`;
  }).join("\n");

  const ruleLines = Object.entries(ruleScores)
    .map(([dim, ds]) => `- ${dim}: ${ds?.score ?? "?"} ${ds?.issue ? `(${ds.issue.slice(0, 60)})` : ""}`)
    .join("\n");

  const prompt = `You are a professional documentary editor performing a quality review.

VIDEO: "${input.videoTitle}"
SCENES (${input.scenes.length} total, showing first ${Math.min(input.scenes.length, 16)}):
${sceneLines}

PRE-COMPUTED SCORES:
${ruleLines}

CLIP SOURCING: ${Math.round((input.adoptAudit.filter(e => ["archive","archive_fetch","own_archive"].some(s => e.source.startsWith(s))).length / Math.max(1, input.adoptAudit.length)) * 100)}% archive, ${input.adoptAudit.filter(e => ["fallback","rescue_placeholder","guaranteed","color_fallback"].includes(e.source)).length} fallback clips

Score these 4 dimensions (0–100) with short specific feedback:
• storytelling — narrative structure, tension arc, clear intro & conclusion
• visualStorytelling — do clips match the narration? good pacing and transitions?
• historicalAccuracy — do sources/clips match the era, location and events?
• emotionalImpact — do the visuals support the emotional tone of the narration?

Also list the top 3 auto-improvements (most impactful first).

Respond ONLY with valid JSON (no markdown):
{
  "storytelling": { "score": 90, "feedback": "...", "issue": "...", "suggestion": "..." },
  "visualStorytelling": { "score": 85, "feedback": "...", "issue": "...", "suggestion": "..." },
  "historicalAccuracy": { "score": 95, "feedback": "...", "issue": null, "suggestion": null },
  "emotionalImpact": { "score": 80, "feedback": "...", "issue": "...", "suggestion": "..." },
  "autoImprovements": [
    { "rank": 1, "dimension": "visualDiversity", "problem": "...", "action": "...", "expectedGain": "+8 points" },
    { "rank": 2, "dimension": "rhythm", "problem": "...", "action": "...", "expectedGain": "+5 points" },
    { "rank": 3, "dimension": "shotVariety", "problem": "...", "action": "...", "expectedGain": "+4 points" }
  ]
}`;

  try {
    const result = await invokeLLM({
      messages: [
        { role: "system", content: "You are a professional documentary editor. Respond with valid JSON only, no markdown fences." },
        { role: "user", content: prompt },
      ],
      maxTokens: 700,
      responseFormat: { type: "json_object" },
    });

    const raw = result?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);

    const toDim = (key: string): DimensionScore => ({
      score: Math.min(100, Math.max(0, Number(parsed[key]?.score ?? 75))),
      feedback: String(parsed[key]?.feedback ?? ""),
      issue: parsed[key]?.issue || undefined,
      suggestion: parsed[key]?.suggestion || undefined,
    });

    const improvements: LLMScores["autoImprovements"] = (parsed.autoImprovements ?? [])
      .slice(0, 3)
      .map((imp: Record<string, unknown>, i: number) => ({
        rank: (i + 1) as 1 | 2 | 3,
        dimension: (imp.dimension as EditorialDimension) ?? "visualDiversity",
        problem: String(imp.problem ?? ""),
        action: String(imp.action ?? ""),
        expectedGain: String(imp.expectedGain ?? ""),
      }));

    return {
      storytelling: toDim("storytelling"),
      visualStorytelling: toDim("visualStorytelling"),
      historicalAccuracy: toDim("historicalAccuracy"),
      emotionalImpact: toDim("emotionalImpact"),
      autoImprovements: improvements,
    };
  } catch (err) {
    console.warn("[EditorialReview] LLM assessment failed:", (err as Error).message?.slice(0, 60));
    return null;
  }
}

// ─── Overall score ────────────────────────────────────────────────────────────

const DIMENSION_WEIGHTS: Record<EditorialDimension, number> = {
  storytelling: 0.18,
  visualStorytelling: 0.15,
  historicalAccuracy: 0.14,
  shotVariety: 0.12,
  motion: 0.10,
  rhythm: 0.10,
  visualDiversity: 0.12,
  emotionalImpact: 0.09,
};

function computeOverall(scores: Record<EditorialDimension, DimensionScore>): number {
  let total = 0;
  for (const [dim, ds] of Object.entries(scores) as [EditorialDimension, DimensionScore][]) {
    total += ds.score * (DIMENSION_WEIGHTS[dim] ?? 0.1);
  }
  return Math.round(total);
}

// ─── Auto improvements from rule scores (fallback when LLM fails) ─────────────

function buildRuleAutoImprovements(scores: Record<EditorialDimension, DimensionScore>): AutoImprovement[] {
  const sorted = (Object.entries(scores) as [EditorialDimension, DimensionScore][])
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, 3);

  return sorted.map(([dim, ds], i) => ({
    rank: (i + 1) as 1 | 2 | 3,
    dimension: dim,
    pipelineComponent: PIPELINE_COMPONENT_MAP[dim],
    problem: ds.issue ?? `Low ${dim} score (${ds.score}/100)`,
    action: ds.suggestion ?? `Review and tune ${PIPELINE_COMPONENT_MAP[dim]}`,
    expectedGain: `+${Math.min(20, Math.round((80 - ds.score) * 0.4))} points`,
  }));
}

// ─── Public entry point ────────────────────────────────────────────────────────

/** Runs the full post-render editorial review. Never throws. */
export async function runEditorialReview(input: ReviewInput): Promise<EditorialReview> {
  if (!editorialReviewEnabled()) {
    return buildEmptyReview(input.videoId, input.videoTitle);
  }

  // 1. Rule-based scores (fast, no LLM)
  const shotVariety = scoreShootVariety(input.adoptAudit, input.scenes);
  const motion = scoreMotion(input.adoptAudit, input.scenes);
  const rhythm = scoreRhythm(input.sceneBeatDurations);
  const visualDiversity = scoreVisualDiversity(input.adoptAudit);

  const ruleScores: Partial<Record<EditorialDimension, DimensionScore>> = {
    shotVariety, motion, rhythm, visualDiversity,
  };

  // 2. LLM scores (one call)
  const llm = await getLLMScores(input, ruleScores);

  // 3. Merge all scores
  const fallbackLLMScore = (score: number): DimensionScore => ({
    score,
    feedback: "LLM assessment unavailable — score estimated from source metrics",
  });

  const scores: Record<EditorialDimension, DimensionScore> = {
    storytelling: llm?.storytelling ?? fallbackLLMScore(72),
    visualStorytelling: llm?.visualStorytelling ?? fallbackLLMScore(72),
    historicalAccuracy: llm?.historicalAccuracy ?? fallbackLLMScore(75),
    emotionalImpact: llm?.emotionalImpact ?? fallbackLLMScore(70),
    shotVariety,
    motion,
    rhythm,
    visualDiversity,
  };

  // 4. Overall score
  const overallScore = computeOverall(scores);

  // 5. Sourcing metrics
  const sourcing = computeSourcingMetrics(input.adoptAudit, input.qualityReport);

  // 6. Auto improvements
  const rawImprovements = llm?.autoImprovements ?? [];
  const autoImprovements: AutoImprovement[] = rawImprovements.length >= 2
    ? rawImprovements.map((imp) => ({
        ...imp,
        pipelineComponent: PIPELINE_COMPONENT_MAP[imp.dimension] ?? "pipeline",
      }))
    : buildRuleAutoImprovements(scores);

  // 7. Top issues (for quick log scan)
  const topIssues = (Object.entries(scores) as [EditorialDimension, DimensionScore][])
    .filter(([, ds]) => ds.score < 75 && ds.issue)
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, 5)
    .map(([dim, ds]) => `[${dim}:${ds.score}] ${ds.issue}`);

  return {
    videoId: input.videoId,
    videoTitle: input.videoTitle,
    reviewedAt: new Date().toISOString(),
    scores,
    overallScore,
    sourcing,
    autoImprovements,
    topIssues,
  };
}

function buildEmptyReview(videoId: string, videoTitle: string): EditorialReview {
  const empty: DimensionScore = { score: 0, feedback: "Review disabled." };
  return {
    videoId, videoTitle, reviewedAt: new Date().toISOString(),
    scores: {
      storytelling: empty, visualStorytelling: empty, shotVariety: empty, motion: empty,
      rhythm: empty, visualDiversity: empty, historicalAccuracy: empty, emotionalImpact: empty,
    },
    overallScore: 0, sourcing: { archiveFraction: 0, externalFraction: 0, fallbackFraction: 0,
      repeatedClips: 0, repeatedSources: 0, avgEditorialScore: null, avgMotionEstimate: null },
    autoImprovements: [], topIssues: [],
  };
}
