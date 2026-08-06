/**
 * Editorial Reorder — post-retrieval montage quality pass.
 *
 * After all clips are fetched and before FFmpeg composition, an AI "final editor"
 * reviews the full scene clip list and produces an optimal documentary montage order.
 *
 * What it checks:
 *  - Opening with an establishing shot
 *  - wide → medium → close-up shot progression
 *  - No identical consecutive shots
 *  - No runs of 3+ same shot type in a row
 *  - Card placement (not adjacent to other cards)
 *  - Emotional arc and tension build
 *  - Visual storytelling coherence
 *
 * What it can do:
 *  - Reorder clips (swap positions)
 *  - Skip a clip (drop it from the sequence)
 *  - Duplicate a clip once as a transition
 *  - Move cards to better positions
 *
 * What it cannot do:
 *  - Start new retrieval
 *  - Fetch new assets
 *
 * Feature flag: EDITORIAL_REORDER_ENABLED (default: "true")
 */

import { invokeLLM } from "./_core/llm";
import { getShotForBeat } from "./editorialSequencePlanner";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClipMeta = {
  /** Position in the original clip array */
  originalIndex: number;
  /** Beat index this clip was fetched for */
  beatIndex: number;
  /** Beat narration text */
  beatText: string;
  /** Shot type from the storyboard (or inferred from filename/beat) */
  shotType: string;
  /** Visual description */
  visualDescription: string;
  /** Duration in seconds */
  duration: number;
  /** True if this is a fallback/placeholder clip */
  isFallback: boolean;
  /** True if this is a chapter card or title card */
  isCard: boolean;
};

export type ReorderResult = {
  /** New ordered clip paths */
  clips: string[];
  /** Parallel beat durations */
  beatDurations: number[];
  /** Parallel clip-to-beat index mapping */
  clipBeatIndices: number[];
  /** Human-readable summary of changes made */
  changesSummary: string;
};

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function editorialReorderEnabled(): boolean {
  return process.env.EDITORIAL_REORDER_ENABLED !== "false";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FALLBACK_PATTERNS = [
  /guaranteed/i,
  /placeholder/i,
  /color_fallback/i,
  /black_fill/i,
  /fallback/i,
];

function isFallbackClip(clipPath: string): boolean {
  const base = path.basename(clipPath);
  return FALLBACK_PATTERNS.some((re) => re.test(base));
}

function isCardClip(clipPath: string): boolean {
  const base = path.basename(clipPath);
  return /chapter_card|title_card|section_card/i.test(base);
}

function inferShotType(meta: ClipMeta): string {
  if (meta.shotType && meta.shotType !== "medium shot") return meta.shotType;
  // Infer from visual description keywords
  const desc = (meta.visualDescription + " " + meta.beatText).toLowerCase();
  if (/wide|establishing|panorama|aerial|overview|cityscape|landscape/.test(desc)) return "wide shot";
  if (/close.?up|face|eye|hand|detail|extreme/.test(desc)) return "close-up";
  if (/medium|waist|portrait|person standing/.test(desc)) return "medium shot";
  if (/map|document|engraving|painting|illustration|newspaper/.test(desc)) return "archival";
  return "medium shot";
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildPrompt(
  clips: ClipMeta[],
  sceneText: string,
  videoTitle: string,
  sceneDuration: number,
  isOpeningScene: boolean
): string {
  const clipLines = clips
    .map(
      (c, i) =>
        `Clip ${i}: [${c.shotType}] "${c.visualDescription.slice(0, 80)}" ` +
        `(${c.duration.toFixed(1)}s, beat ${c.beatIndex}` +
        (c.isCard ? ", CARD" : "") +
        (c.isFallback ? ", FALLBACK" : "") +
        `)`
    )
    .join("\n");

  // Phase 9: real documentary hooks (Vox, Search Party, Johnny Harris) very often cold-open on
  // the single most striking or emotionally charged image rather than a slow establishing pan
  // — the wide shot lands a beat or two later, once the hook has earned the viewer's attention.
  // Rule 1 stays the default for every other scene; only the video's opening scene gets this
  // override, and only when a stronger option actually exists.
  const openingRule = isOpeningScene
    ? "1. This is the VIDEO'S OPENING SCENE — lead with the single most visually striking or emotionally charged clip available, even if it's a close-up or action shot, NOT necessarily a wide/establishing shot. Earn attention first; a wide shot can follow a beat later."
    : "1. Open with a wide/establishing shot if one exists";

  return `You are the final editor of a professional documentary. Review this clip sequence and produce the optimal montage order.

Video: "${videoTitle}"
Scene: "${sceneText.slice(0, 200)}"
Total duration: ${sceneDuration.toFixed(1)}s
Clips available:
${clipLines}

Editorial rules:
${openingRule}
2. Prefer wide → medium → close-up progression within a sequence
3. Never place two CARD clips adjacent to each other
4. Avoid 3+ consecutive clips of the same shot type
5. No consecutive near-identical clips (same beatIndex = likely same visual)
6. FALLBACK clips should be minimized — place them last or skip if enough other clips
7. Cards should introduce sections (place before the relevant content, not at end)
8. Build emotional arc: start grounded, develop tension/drama, resolve
9. A clip may appear twice if it serves as a connecting shot (transition)
10. Skip a clip (omit its index) if it breaks visual flow or is redundant

Return ONLY this JSON:
{
  "order": [0, 2, 1, 3, ...],   // indices from the clip list above, in new order
  "reasoning": "brief one-sentence explanation",
  "changes": "what you changed and why (max 80 chars)"
}

If the current order is already good, return the same order unchanged.`;
}

// ─── Main reorder function ────────────────────────────────────────────────────

/**
 * Reorder a scene's clip list for optimal documentary montage flow.
 * Returns the reordered SceneVisualsResult-like structure.
 * Never throws — falls back to original order on any error.
 */
export async function editorialReorderScene(
  sceneIndex: number,
  sceneText: string,
  videoTitle: string,
  sceneDuration: number,
  clips: string[],
  beatDurations: number[],
  clipBeatIndices: number[] | undefined,
  beats: Array<{ index: number; text: string; holdSec: number }> | undefined
): Promise<ReorderResult> {
  const original: ReorderResult = {
    clips: [...clips],
    beatDurations: [...beatDurations],
    clipBeatIndices: clipBeatIndices ? [...clipBeatIndices] : clips.map((_, i) => i),
    changesSummary: "no change",
  };

  if (!editorialReorderEnabled() || clips.length < 2) return original;

  try {
    // Build clip metadata for the LLM
    const clipMeta: ClipMeta[] = clips.map((clipPath, i) => {
      const beatIdx = clipBeatIndices?.[i] ?? i;
      const beat = beats?.find((b) => b.index === beatIdx);
      const shot = getShotForBeat(sceneIndex, beatIdx);
      const dur = beatDurations[i] ?? beat?.holdSec ?? 4;
      return {
        originalIndex: i,
        beatIndex: beatIdx,
        beatText: beat?.text ?? "",
        shotType: shot ? shot.shotType : "medium shot",
        visualDescription: shot ? shot.searchQuery : (beat?.text ?? "").slice(0, 80),
        duration: dur,
        isFallback: isFallbackClip(clipPath),
        isCard: isCardClip(clipPath),
      };
    });

    // Enrich shot type from meta
    for (const m of clipMeta) {
      m.shotType = inferShotType(m);
    }

    // Skip if all clips are fallbacks or there's nothing meaningful to reorder
    const realClips = clipMeta.filter((c) => !c.isFallback);
    if (realClips.length < 2) return original;

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a professional documentary film editor. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: buildPrompt(clipMeta, sceneText, videoTitle, sceneDuration, sceneIndex === 0),
        },
      ],
      preferProvider: "groq",
      maxTokens: 300,
      responseFormat: { type: "json_object" },
    });

    const raw =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "{}";

    const parsed = JSON.parse(raw) as {
      order?: unknown;
      reasoning?: string;
      changes?: string;
    };

    if (!Array.isArray(parsed.order)) return original;

    // Validate and apply the new order
    const newOrder = (parsed.order as unknown[])
      .filter((v): v is number => typeof v === "number" && v >= 0 && v < clips.length)
      .filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate (duplicates allowed below)

    // Allow one duplicate per clip for transition use (but limit total length)
    const maxClips = Math.ceil(clips.length * 1.3);
    const allowedOrder = (parsed.order as unknown[])
      .filter((v): v is number => typeof v === "number" && v >= 0 && v < clips.length)
      .slice(0, maxClips);

    if (allowedOrder.length < 1) return original;

    const reorderedClips = allowedOrder.map((idx) => clips[idx]!);
    const reorderedDurations = allowedOrder.map((idx) => beatDurations[idx] ?? 4);
    const reorderedBeatIndices = allowedOrder.map((idx) => clipBeatIndices?.[idx] ?? idx);

    const changesSummary = typeof parsed.changes === "string"
      ? parsed.changes.slice(0, 100)
      : `reordered ${allowedOrder.length} clips`;

    // Only apply if something actually changed
    const orderChanged =
      allowedOrder.length !== clips.length ||
      allowedOrder.some((idx, i) => idx !== i);

    if (!orderChanged) {
      return { ...original, changesSummary: "order unchanged — already optimal" };
    }

    console.log(
      `[Editorial] s${sceneIndex} reorder: ${clips.length}→${reorderedClips.length} clips — ${changesSummary}\n` +
        `  Original: [${clips.map((_, i) => i).join(",")}]\n` +
        `  New:      [${allowedOrder.join(",")}]`
    );

    return {
      clips: reorderedClips,
      beatDurations: reorderedDurations,
      clipBeatIndices: reorderedBeatIndices,
      changesSummary,
    };
  } catch (err) {
    console.warn(
      `[Editorial] s${sceneIndex} reorder skipped:`,
      (err as Error).message?.slice(0, 80)
    );
    return original;
  }
}
