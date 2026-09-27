/**
 * Geo stock queries, script expansion, and the pre-render refusal of an indefensible render.
 */
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import {
  buildGeoStockSearchQueries,
  resolveRequiredGeoTagsForBeat,
} from "./curatedMediaSourcing";
import { extractTitleGeoPlaceTags, isComparisonGeoTitle } from "./worldGeoSlugs";
import { hasContentAnchor } from "./searchQueryContract";
import type { BeatGeoRegion } from "./vidrushQuality";
import {
  checkScriptMeetsBudget,
  stripVisualTagsFromScript,
  buildScriptLengthRefinePrompt,
  scriptStillOnTopic,
  countNarrationWords,
  type ScriptLengthBudget,
} from "./scriptWriter";
import type { VideoQualityReport } from "./videoQualityReport";
import { indefensibleExportConditions } from "./videoQualityReport";

/** Pexels/Pixabay queries anchored to beat + title geography (wrong-country stock avoided). */
export function buildDocumentaryShotQueries(baseQuery: string, beatIndex: number): string[] {
  const q = baseQuery.trim();
  if (q.length < 4) return [];
  /**
   * RONDE 88A P4 — a camera instruction needs something to point at.
   *
   * Every variant below is `<subject> <shot vocabulary>`, so the whole query is only as much of a
   * question as its subject. When the subject has already collapsed to a genre word upstream —
   * `stubPowerWordFromSceneText` ends in `|| "documentary"`, and so do two of the archive pool's
   * own fallbacks — this produced "documentary wide establishing aerial", which asks for aerial
   * footage of the world in general.
   *
   * Render 568 built 128 such queries and the gate refused all 128: documentary x68,
   * establishing x40, historical x20. The gate was right every time; being right 128 times after
   * the work is done is not the same as the work not being done. `hasContentAnchor` is that same
   * check, asked here first — the length test above was the only thing this ever asked, and
   * "documentary" is ten characters long.
   *
   * Returning nothing is the honest answer, and the one RONDE 100B already established for the
   * same situation: "nothing left, so ask for nothing". Every caller of this function spreads the
   * result into a list, so an empty answer asks one fewer provider rather than asking wrongly.
   */
  if (!hasContentAnchor(q)) return [];
  const variants = [
    `${q} wide establishing aerial`,
    `${q} medium street level documentary`,
    `${q} detail close up architecture`,
  ];
  const start = beatIndex % variants.length;
  return [variants[start]!, variants[(start + 1) % variants.length]!];
}

/** Pexels/Pixabay queries anchored to beat + title geography (wrong-country stock avoided). */
export function buildEmergencyGeoStockQueries(
  beatText: string,
  videoTitle?: string,
  segmentLock?: BeatGeoRegion | null
): string[] {
  const required = resolveRequiredGeoTagsForBeat(beatText, videoTitle, segmentLock);
  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  const beatGeo = buildGeoStockSearchQueries(beatText, videoTitle);

  const anchored = [
    ...required.map((t) => `${t} city aerial`),
    ...required.map((t) => `${t} skyline timelapse`),
    ...titleGeo.map((t) => `${t} urban planning aerial`),
    ...titleGeo.map((t) => `${t} city street`),
    ...beatGeo,
  ];

  if (!isComparisonGeoTitle(videoTitle) && titleGeo.length > 0) {
    const beatSeed = beatText.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    for (const t of titleGeo.slice(0, 3)) {
      anchored.push(`${t} documentary b-roll`);
      anchored.push(`${t} infrastructure aerial`);
      anchored.push(...buildDocumentaryShotQueries(`${t} city`, beatSeed + t.length));
    }
  }

  /**
   * RONDE 88A P4 — same rule on the way out, because this list has two sources.
   *
   * The templates above anchor on a geo tag and are safe by construction, but `beatGeo` comes from
   * `buildGeoStockSearchQueries` and the `${t} ...` templates take whatever `titleGeo` returned. A
   * title of "documentary" produced the literal queries "documentary documentary footage" and
   * "documentary" — the second is exactly the 68-times-refused line in render 568's audit.
   */
  return [
    ...new Set(anchored.filter((q) => q.trim().length >= 4 && hasContentAnchor(q))),
  ].slice(0, 10);
}

export type ScriptExpandFn = (userPrompt: string) => Promise<string>;

/** Retry script expansion until budget met or attempts exhausted. */
export async function ensureScriptMeetsBudgetWithRetry(
  script: string,
  budget: ScriptLengthBudget,
  topicPrompt: string,
  expandFn: ScriptExpandFn,
  maxAttempts = 3
): Promise<{ script: string; ok: boolean; words: number }> {
  let current = script;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const check = checkScriptMeetsBudget(current, budget);
    if (check.ok) {
      return { script: current, ok: true, words: countNarrationWords(current) };
    }
    if (attempt >= maxAttempts) {
      return { script: current, ok: false, words: check.words };
    }
    console.warn(
      `[Script] Budget short (${check.words}/${budget.minWords} words) — expand attempt ${attempt + 1}/${maxAttempts}`
    );
    try {
      const refined = await expandFn(
        buildScriptLengthRefinePrompt(current, budget, check.words, topicPrompt)
      );
      if (typeof refined === "string" && refined.trim().length > 150 && scriptStillOnTopic(topicPrompt, refined)) {
        current = stripVisualTagsFromScript(refined.trim());
      }
    } catch (err) {
      console.warn(`[Script] Expand attempt ${attempt + 1} failed:`, (err as Error).message?.slice(0, 120));
    }
  }
  const finalCheck = checkScriptMeetsBudget(current, budget);
  if (finalCheck.ok) {
    return { script: current, ok: true, words: countNarrationWords(current) };
  }
  const lenientFloor = Math.round(budget.minWords * 0.85);
  const words = finalCheck.words;
  if (words >= lenientFloor) {
    console.warn(
      `[Script] Accepting lenient budget ${words}/${budget.minWords} words (≥${lenientFloor})`
    );
    return { script: current, ok: true, words };
  }
  return { script: current, ok: false, words };
}

/** Refuses a render whose pictures cannot be traced or were never approved — see `indefensibleExportConditions`. */
export function enforceQualityExportGate(videoId: number, report: VideoQualityReport): void {
  const indefensible = indefensibleExportConditions(report);
  if (indefensible.length === 0) return;
  for (const c of indefensible) {
    console.error(`[Quality] Video ${videoId}: EXPORT BLOCKED ${c.code} — ${c.detail}`);
  }
  throw pipelineError(
    PIPELINE_ERROR.QUALITY_GATE,
    `Export blocked — this render cannot say what it is showing: ` +
      indefensible.map((c) => `${c.code}: ${c.detail}`).join(" | ")
  );
}
