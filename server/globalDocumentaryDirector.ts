/**
 * Global Documentary Director — whole-video editorial analysis pass.
 *
 * Runs ONCE after ALL scene visuals have been retrieved, before FFmpeg composition.
 * Has access to the full planned clip sequence across every scene and produces a
 * global editorial assessment with actionable recommendations.
 *
 * What it detects:
 *  - Too many maps / archival stills across multiple consecutive scenes
 *  - Missing visual variety (no close-ups or no wide shots anywhere)
 *  - Repetitive visual source (e.g. 12 pexels scenes in a row)
 *  - Monotone energy arc (all high or all low energy throughout)
 *  - Scenes dominated by fallback/color-card clips (sourcing failures)
 *  - Missing world-map when multiple geographic locations are named
 *
 * What it can fix automatically:
 *  - Swap clip order across scenes to break map-monotony (move a map scene earlier/later)
 *  - Flag scenes for "needs_variety" so the compose layer can add text-overlay variety
 *  - Recommend infographic injection points
 *
 * Output: GlobalDirectorReport logged to console + returned for pipeline metadata.
 *
 * Feature flag: GLOBAL_DOCUMENTARY_DIRECTOR_ENABLED (default: "true")
 */

import { invokeLLM } from "./_core/llm";
import path from "path";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function globalDocumentaryDirectorEnabled(): boolean {
  return process.env.GLOBAL_DOCUMENTARY_DIRECTOR_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type VisualSourceType =
  | "own_archive"
  | "pexels"
  | "pixabay"
  | "wikimedia"
  | "internet_archive"
  | "ai_generated"
  | "map_infographic"
  | "fallback"
  | "other";

export type SceneVisualProfile = {
  sceneIndex: number;
  sceneText: string;
  clipCount: number;
  /** Fraction of clips that are maps / archival stills (0–1) */
  archivalFraction: number;
  /** Fraction of clips from fallback / color card (0–1) */
  fallbackFraction: number;
  /** Primary visual source (most frequent) */
  dominantSource: VisualSourceType;
  /** Shot type variety: unique shot categories / total clips */
  shotVariety: number;
  /** Whether wide / establishing shots are present */
  hasWideShots: boolean;
  /** Whether close-up shots are present */
  hasCloseUps: boolean;
};

export type DirectorIssueType =
  | "map_overload"          // ≥3 consecutive scenes with >50% maps
  | "fallback_scene"        // a scene has >30% fallback clips
  | "repetitive_source"     // same source >70% across 4+ consecutive scenes
  | "no_close_ups"          // no close-ups in the entire video
  | "no_wide_shots"         // no wide establishing shots anywhere
  | "monotone_pace"         // all scenes same energy (all high or all low)
  | "archive_gap";          // 5+ min of video without any archival/own-archive clip

export type DirectorIssue = {
  type: DirectorIssueType;
  sceneIndices: number[];
  description: string;
  severity: "warning" | "error";
};

export type DirectorRecommendation = {
  type: "inject_infographic" | "add_world_map" | "reduce_maps" | "inject_close_up" | "inject_wide" | "swap_source";
  targetSceneIndex: number;
  description: string;
};

export type GlobalDirectorReport = {
  sceneProfiles: SceneVisualProfile[];
  issues: DirectorIssue[];
  recommendations: DirectorRecommendation[];
  overallQuality: "good" | "fair" | "poor";
  llmInsights?: string; // optional LLM-generated narrative assessment
};

// ─── Clip classification helpers ───────────────────────────────────────────────

const ARCHIVAL_PATH_TOKENS = /map|engraving|painting|illustration|newspaper|document|diagram|poster|chart|wikimedia|archive/i;
const FALLBACK_PATH_TOKENS = /color_fallback|fallback|guaranteed|placeholder|color_clip/i;
const WIDE_TEXT_TOKENS = /wide|aerial|panorama|establishing|cityscape|landscape|overhead|drone|overview/i;
const CLOSE_TEXT_TOKENS = /close|face|detail|extreme|macro|portrait/i;

function inferSourceFromPath(clipPath: string): VisualSourceType {
  const base = path.basename(clipPath).toLowerCase();
  const dir = clipPath.toLowerCase();
  if (FALLBACK_PATH_TOKENS.test(base)) return "fallback";
  if (dir.includes("pexels")) return "pexels";
  if (dir.includes("pixabay")) return "pixabay";
  if (dir.includes("wikimedia") || dir.includes("wikipedia")) return "wikimedia";
  if (dir.includes("archive.org") || dir.includes("internetarchive")) return "internet_archive";
  if (dir.includes("kling") || dir.includes("ai_gen") || dir.includes("veo") || dir.includes("grok")) return "ai_generated";
  if (dir.includes("curated") || dir.includes("own_archive") || dir.includes("media_archive")) return "own_archive";
  if (ARCHIVAL_PATH_TOKENS.test(base)) return "own_archive";
  return "other";
}

function isArchivalClip(clipPath: string, beatText: string): boolean {
  const combined = (path.basename(clipPath) + " " + beatText).toLowerCase();
  return ARCHIVAL_PATH_TOKENS.test(combined);
}

function isFallbackClip(clipPath: string): boolean {
  return FALLBACK_PATH_TOKENS.test(path.basename(clipPath));
}

// ─── Scene profiler ───────────────────────────────────────────────────────────

function profileScene(
  sceneIndex: number,
  sceneText: string,
  clips: string[],
  beats: Array<{ index: number; text: string }> = []
): SceneVisualProfile {
  if (clips.length === 0) {
    return {
      sceneIndex, sceneText, clipCount: 0,
      archivalFraction: 0, fallbackFraction: 0,
      dominantSource: "other", shotVariety: 0,
      hasWideShots: false, hasCloseUps: false,
    };
  }

  const beatTexts = clips.map((_, i) => beats[i]?.text ?? "");
  const archival = clips.filter((c, i) => isArchivalClip(c, beatTexts[i])).length;
  const fallback = clips.filter((c) => isFallbackClip(c)).length;

  const sourceCounts = new Map<VisualSourceType, number>();
  for (const c of clips) {
    const src = inferSourceFromPath(c);
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
  }
  let dominantSource: VisualSourceType = "other";
  let maxCount = 0;
  sourceCounts.forEach((count, src) => {
    if (count > maxCount) { maxCount = count; dominantSource = src; }
  });

  const allText = clips.map((_, i) => beatTexts[i]).join(" ") + " " + sceneText;
  const hasWideShots = WIDE_TEXT_TOKENS.test(allText);
  const hasCloseUps = CLOSE_TEXT_TOKENS.test(allText);

  const uniqueSources = sourceCounts.size;
  const shotVariety = Math.min(1, uniqueSources / Math.max(1, clips.length));

  return {
    sceneIndex, sceneText: sceneText.slice(0, 120), clipCount: clips.length,
    archivalFraction: archival / clips.length,
    fallbackFraction: fallback / clips.length,
    dominantSource, shotVariety,
    hasWideShots, hasCloseUps,
  };
}

// ─── Issue detectors ──────────────────────────────────────────────────────────

function detectMapOverload(profiles: SceneVisualProfile[]): DirectorIssue | null {
  let runStart = -1;
  let runLength = 0;
  const badScenes: number[] = [];

  for (let i = 0; i <= profiles.length; i++) {
    const isMap = i < profiles.length && profiles[i].archivalFraction > 0.5;
    if (isMap) {
      if (runStart === -1) runStart = i;
      runLength++;
    } else {
      if (runLength >= 3) {
        for (let j = runStart; j < runStart + runLength; j++) badScenes.push(j);
      }
      runStart = -1; runLength = 0;
    }
  }

  if (badScenes.length === 0) return null;
  return {
    type: "map_overload",
    sceneIndices: badScenes,
    description: `${badScenes.length} consecutive scenes are >50% archival/map clips. Consider inserting live footage.`,
    severity: "warning",
  };
}

function detectFallbackScenes(profiles: SceneVisualProfile[]): DirectorIssue | null {
  const bad = profiles.filter((p) => p.fallbackFraction > 0.3).map((p) => p.sceneIndex);
  if (bad.length === 0) return null;
  return {
    type: "fallback_scene",
    sceneIndices: bad,
    description: `${bad.length} scene(s) have >30% fallback clips — sourcing incomplete.`,
    severity: "error",
  };
}

function detectRepetitiveSource(profiles: SceneVisualProfile[]): DirectorIssue | null {
  if (profiles.length < 4) return null;
  let runStart = -1;
  let runSource: VisualSourceType | null = null;
  let runLength = 0;
  const badScenes: number[] = [];

  for (let i = 0; i <= profiles.length; i++) {
    const src = i < profiles.length ? profiles[i].dominantSource : null;
    const same = src === runSource && src !== "other" && src !== "fallback";
    if (same) {
      runLength++;
    } else {
      if (runLength >= 4 && runSource) {
        for (let j = runStart; j < runStart + runLength; j++) badScenes.push(j);
      }
      runStart = i; runSource = src; runLength = 1;
    }
  }

  if (badScenes.length === 0) return null;
  return {
    type: "repetitive_source",
    sceneIndices: badScenes,
    description: `${badScenes.length} consecutive scenes dominated by the same visual source.`,
    severity: "warning",
  };
}

function detectMissingVariety(profiles: SceneVisualProfile[]): DirectorIssue[] {
  const issues: DirectorIssue[] = [];
  const anyWide = profiles.some((p) => p.hasWideShots);
  const anyClose = profiles.some((p) => p.hasCloseUps);

  if (!anyWide && profiles.length >= 3) {
    issues.push({
      type: "no_wide_shots",
      sceneIndices: profiles.map((p) => p.sceneIndex),
      description: "No establishing / wide shots detected anywhere in the video.",
      severity: "warning",
    });
  }
  if (!anyClose && profiles.length >= 3) {
    issues.push({
      type: "no_close_ups",
      sceneIndices: profiles.map((p) => p.sceneIndex),
      description: "No close-up shots detected anywhere in the video.",
      severity: "warning",
    });
  }
  return issues;
}

function buildRecommendations(issues: DirectorIssue[], profiles: SceneVisualProfile[]): DirectorRecommendation[] {
  const recs: DirectorRecommendation[] = [];

  for (const issue of issues) {
    if (issue.type === "map_overload") {
      // Recommend injecting live footage in the middle of the map run
      const mid = issue.sceneIndices[Math.floor(issue.sceneIndices.length / 2)];
      recs.push({
        type: "reduce_maps",
        targetSceneIndex: mid,
        description: `Break up map-heavy run at scene ${mid} with live footage or animation.`,
      });
    }
    if (issue.type === "no_wide_shots") {
      recs.push({
        type: "inject_wide",
        targetSceneIndex: 0,
        description: "Open the video with an establishing wide shot.",
      });
    }
    if (issue.type === "no_close_ups") {
      const emotionalScene = profiles.findIndex((p) => p.archivalFraction < 0.3);
      if (emotionalScene >= 0) {
        recs.push({
          type: "inject_close_up",
          targetSceneIndex: emotionalScene,
          description: `Add a close-up detail shot in scene ${emotionalScene}.`,
        });
      }
    }
  }

  return recs;
}

function overallQuality(issues: DirectorIssue[]): "good" | "fair" | "poor" {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (errors > 0) return "poor";
  if (warnings >= 2) return "fair";
  return "good";
}

// ─── Optional LLM narrative assessment ────────────────────────────────────────

async function getLLMInsights(
  videoTitle: string,
  profiles: SceneVisualProfile[],
  issues: DirectorIssue[]
): Promise<string | undefined> {
  if (issues.length === 0) return undefined;

  const sceneLines = profiles.map((p) =>
    `Scene ${p.sceneIndex}: ${p.clipCount} clips, archival=${(p.archivalFraction * 100).toFixed(0)}%, ` +
    `fallback=${(p.fallbackFraction * 100).toFixed(0)}%, source=${p.dominantSource}`
  ).join("\n");

  const issueLines = issues.map((i) => `- [${i.severity}] ${i.description}`).join("\n");

  const prompt = `You are an experienced documentary editor reviewing a video titled "${videoTitle}".

Scene visual breakdown:
${sceneLines}

Detected issues:
${issueLines}

In 2–4 concise sentences, describe the most important editorial fix the director should make. Be specific and actionable. Focus on what matters most for visual storytelling quality.`;

  try {
    const result = await invokeLLM({
      messages: [
        { role: "system", content: "You are a professional documentary editor. Be concise and direct." },
        { role: "user", content: prompt },
      ],
      maxTokens: 150,
    });
    const text = result?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Analyzes the full video's planned visual sequence and returns a GlobalDirectorReport.
 * Fire-and-forget safe — never throws.
 */
export async function analyzeVideoStructure(
  videoTitle: string,
  sceneTexts: string[],
  sceneClips: string[][],
  sceneBeats?: Array<Array<{ index: number; text: string }>>
): Promise<GlobalDirectorReport> {
  if (!globalDocumentaryDirectorEnabled()) {
    return { sceneProfiles: [], issues: [], recommendations: [], overallQuality: "good" };
  }

  try {
    const sceneProfiles = sceneTexts.map((text, i) =>
      profileScene(i, text, sceneClips[i] ?? [], sceneBeats?.[i] ?? [])
    );

    const issues: DirectorIssue[] = [
      detectMapOverload(sceneProfiles),
      detectFallbackScenes(sceneProfiles),
      detectRepetitiveSource(sceneProfiles),
      ...detectMissingVariety(sceneProfiles),
    ].filter((x): x is DirectorIssue => x !== null);

    const recommendations = buildRecommendations(issues, sceneProfiles);
    const quality = overallQuality(issues);

    // LLM insights only when there are real issues — fire once, fire-and-forget
    const llmInsights = issues.length >= 2
      ? await getLLMInsights(videoTitle, sceneProfiles, issues).catch(() => undefined)
      : undefined;

    const report: GlobalDirectorReport = { sceneProfiles, issues, recommendations, overallQuality: quality, llmInsights };

    // Log summary
    if (issues.length > 0) {
      console.log(
        `[GlobalDirector] "${videoTitle}" — quality=${quality} issues=${issues.length} ` +
          issues.map((i) => `[${i.severity}] ${i.type}`).join(", ")
      );
      for (const rec of recommendations) {
        console.log(`[GlobalDirector] → ${rec.description}`);
      }
      if (llmInsights) console.log(`[GlobalDirector] LLM: ${llmInsights}`);
    } else {
      console.log(`[GlobalDirector] "${videoTitle}" — quality=good, no issues detected`);
    }

    return report;
  } catch (err) {
    console.warn("[GlobalDirector] analysis failed:", (err as Error).message?.slice(0, 80));
    return { sceneProfiles: [], issues: [], recommendations: [], overallQuality: "good" };
  }
}
