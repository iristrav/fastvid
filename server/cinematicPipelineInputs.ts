/**
 * RONDE 151 §1/§2 — the translation between the production pipeline and the cinematic engine.
 *
 * ── What the audit actually found ────────────────────────────────────────────────────────────
 *
 * RONDE 150 ended with "the cinematic pipeline exists but the main pipeline does not call it", and
 * the obvious reading of that is that a function call is missing. It is not. The two halves speak
 * different vocabularies, and nothing could have called across that gap:
 *
 *   the production pipeline has   SceneBeat          index, text, searchQuery, powerWord,
 *                                                    keywords, holdSec, visualDescription,
 *                                                    voiceStartSec, voiceEndSec
 *                                a clip PATH        plus a VisualLineageRecord that proves where
 *                                                    the bytes came from
 *
 *   the cinematic engine wants   VisualIntent       from server/visualMatchingV2/
 *                                CandidateAsset     from server/visualMatchingV2/
 *
 * And `visualMatchingV2` is a parallel retrieval system that is feature-flagged off — its own
 * `sourcingPolicy` comment says "off until proven" — and is not imported by videoPipeline.ts at
 * all. So the engine's input contract was written against a system that does not run in
 * production. That is the real reason nothing called it.
 *
 * ── Why an adapter is the right answer, and not a change to either side ──────────────────────
 *
 * Changing the engine's types would mean rewriting 1736 lines of planners that are correct and
 * tested. Turning on visualMatchingV2 to satisfy a type would be switching on an entire unproven
 * retrieval system as a side effect of a montage change.
 *
 * So this file does what `edlToTimeline.ts` does one step later in the chain: it translates
 * vocabulary and DECIDES NOTHING. Every value below is copied from something the pipeline already
 * established, or measured by a probe this render already took, or left empty because the pipeline
 * genuinely does not know it.
 *
 * ── The rule that matters most here ──────────────────────────────────────────────────────────
 *
 * An empty field is an honest answer; a plausible-looking invented one is not.
 *
 * `visualMatchingV2` derives `visualLocation`, `visualTime`, `historicalContext` and the rest from
 * an LLM pass the production pipeline never runs. Filling them here with a guess would make the
 * shot planner and the caption planner act on evidence nobody gathered — a name caption for a
 * person the extractor merely thought it saw is worse than no caption. Where production has a real
 * extractor for a field, the caller injects it; where it does not, the field is "".
 */
import type { CandidateAsset, CandidateSource, VisualIntent } from "./visualMatchingV2/types";
import { docGradeSourceKindForProvider } from "./documentaryStyle";
import type { Scene } from "./pipeline/types";
import type { AssetSourceIdentity } from "./projectTimeline";
import type { CinematicBeatInput, CinematicSceneInput } from "./cinematicPipeline";

/* ═══════════════════════ what the production pipeline supplies ═══════════════════════ */

/**
 * One beat, in the production pipeline's own words.
 *
 * Declared structurally rather than imported from videoPipeline.ts, which is 39k lines and would
 * make this module and that one mutually dependent. The shape is `SceneBeat`'s; a test asserts the
 * two stay compatible.
 */
export type ProductionBeat = {
  index: number;
  text: string;
  searchQuery?: string;
  powerWord?: string;
  keywords?: string[];
  holdSec?: number;
  visualDescription?: string;
  /**
   * SCENE-LOCAL seconds, which is exactly what the engine's `beatVoiceStartSec` means.
   *
   * Not a coincidence and not luck: `buildTtsSceneBeatMap` runs every planned beat through
   * `normalizeTtsBeatsToSceneLocal` before handing it to the pipeline. The two contracts already
   * agreed; nobody had put them next to each other. See the note on `sceneOffsetSec` in
   * edlToTimeline.ts for what happens when this is misread.
   */
  voiceStartSec?: number;
  voiceEndSec?: number;
};

/**
 * What this render proved about one adopted clip.
 *
 * `localPath` is the file the pipeline is actually using. Everything else is optional because
 * everything else may genuinely be unknown, and §7 is explicit that an unknown value is absent
 * rather than zero.
 */
export type AdoptedClipFacts = {
  localPath: string;
  /** From an ffprobe this render already took. Absent when it was never measured. */
  widthPx?: number;
  heightPx?: number;
  durationSec?: number;
  /** Where inside the source file the used portion starts and ends, when the render trimmed it. */
  sourceInSec?: number;
  sourceOutSec?: number;
  kind?: "video" | "image";
};

/**
 * The subset of `VisualLineageRecord` this adapter reads.
 *
 * Narrow on purpose: it names exactly what an asset identity is made of, so a reader can see that
 * nothing here is derived from a filename. §6 — the identity comes from the adoption record.
 */
export type AdoptionFacts = {
  provider: string | null;
  providerAssetId?: string;
  archiveAssetId?: number;
  sourceUrl?: string;
  originalUrl?: string;
  assetTitle?: string;
  query?: string;
  candidateId?: string;
};

/**
 * The entity extractors the production pipeline already owns.
 *
 * Injected rather than re-implemented. §28 forbids a second copy of anything, and an entity
 * extractor that disagreed with the one the retrieval stage used would make the captions describe
 * a different video from the one that was sourced.
 */
export type EntityExtractors = {
  people?: (text: string) => string[];
  place?: (text: string) => string;
  action?: (text: string) => string;
};

export type SceneFacts = {
  scene: Scene;
  beats: ProductionBeat[];
  /** Index-aligned with `beats`. A beat with no adopted clip is simply absent from the plan. */
  clips: Array<{ facts: AdoptedClipFacts; adoption: AdoptionFacts | null } | null>;
};

/* ═══════════════════════ what comes out ═══════════════════════ */

export type CinematicInputsResult = {
  scenes: CinematicSceneInput[];
  /**
   * Every beat that could not be planned, and why. §2/§6 — a beat that drops out of the edit must
   * say so; it must never be quietly filled with another beat's clip.
   */
  dropped: string[];
  /** Counts for the render log. */
  stats: { scenes: number; beats: number; planned: number; withTrim: number; withProbe: number };
};

/* ═══════════════════════ the translation ═══════════════════════ */

/** A beat's stable identifier, from its position. Deterministic — §32 depends on it. */
export function beatIdFor(sceneIndex: number, beatIndex: number): string {
  return `s${sceneIndex}b${beatIndex}`;
}

/**
 * The candidate's identity, from the adoption record and never from the filename.
 *
 * Falls back to the lineage's own `candidateId` and then to a positional id, because the engine
 * uses this only to tell one beat's clip from another's — it is not, and must not be mistaken for,
 * the provenance identity. That is `AssetSourceIdentity`, built separately below from the same
 * record.
 */
function candidateIdFor(adoption: AdoptionFacts | null, sceneIndex: number, beatIndex: number): string {
  if (adoption?.provider && adoption.providerAssetId) {
    return `${adoption.provider}:${adoption.providerAssetId}`;
  }
  if (adoption?.archiveAssetId != null) return `archive:${adoption.archiveAssetId}`;
  if (adoption?.candidateId) return adoption.candidateId;
  return beatIdFor(sceneIndex, beatIndex);
}

/**
 * The provenance identity — the thing the rehydrator will use to fetch this file again.
 *
 * Returns null when the adoption record proves nothing, and the caller then DROPS the beat rather
 * than planning around a shot it cannot fetch back. §6: never substitute another clip.
 */
export function identityFrom(adoption: AdoptionFacts | null): AssetSourceIdentity | null {
  if (!adoption) return null;
  const hasHandle =
    Boolean(adoption.providerAssetId) || adoption.archiveAssetId != null || Boolean(adoption.sourceUrl);
  if (!adoption.provider || !hasHandle) return null;
  return {
    provider: adoption.provider,
    ...(adoption.providerAssetId ? { providerAssetId: adoption.providerAssetId } : {}),
    ...(adoption.archiveAssetId != null ? { archiveAssetId: adoption.archiveAssetId } : {}),
    ...(adoption.sourceUrl ? { mediaUrl: adoption.sourceUrl } : {}),
    ...(adoption.originalUrl ? { sourcePageUrl: adoption.originalUrl } : {}),
    ...(adoption.assetTitle ? { title: adoption.assetTitle } : {}),
  };
}

/**
 * A production beat, in the engine's vocabulary.
 *
 * The empty strings below are the honest part of this function. `visualTime`,
 * `historicalContext` and `emotion` come from an LLM intent pass in visualMatchingV2 that the
 * production pipeline does not run; every planner that reads them already handles "" (their own
 * test fixtures pass ""), and each one degrades to a plainer, correct decision rather than a wrong
 * confident one.
 */
export function intentFrom(
  beat: ProductionBeat,
  sceneIndex: number,
  beatIndex: number,
  adoption: AdoptionFacts | null,
  extractors: EntityExtractors
): VisualIntent {
  const people = extractors.people?.(beat.text) ?? [];
  return {
    beatId: beatIdFor(sceneIndex, beatIndex),
    spokenText: beat.text,
    /** The pipeline's own chosen search anchor — the closest thing it has to a visual subject. */
    visualSubject: beat.powerWord ?? beat.searchQuery ?? "",
    visualAction: extractors.action?.(beat.text) ?? "",
    visualLocation: extractors.place?.(beat.text) ?? "",
    visualTime: "",
    historicalContext: "",
    emotion: "",
    visualDescription: beat.visualDescription ?? "",
    primaryKeyword: beat.searchQuery ?? beat.powerWord ?? "",
    secondaryKeyword: beat.keywords?.[0] ?? "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    countries: [],
    events: [],
    people,
    /**
     * The QUERY THAT ACTUALLY RAN, from the lineage record, rather than a hash recomputed here.
     * A recomputed hash would claim a cache identity this render never had.
     */
    intentHash: adoption?.query ?? beat.searchQuery ?? beatIdFor(sceneIndex, beatIndex),
    cacheHit: false,
  };
}

/**
 * The production provider, as one of the eight tokens the engine's type allows.
 *
 * ── Why this is a mapping and not a rename ───────────────────────────────────────────────────
 *
 * `CandidateSource` is a closed union of eight visualMatchingV2 sources, and production sources
 * from far more than eight places — NARA, NASA, Flickr, SepiaSearch, Vimeo, media.ccc, GDELT,
 * Openverse and a dozen generative providers. Widening the union is not free: `SourcePriority` is
 * `Record<CandidateSource, number>`, so every literal that builds one would have to grow a member,
 * across a subsystem this round has no business disturbing.
 *
 * So the token is a CLASSIFICATION, and the classification is made by
 * `docGradeSourceKindForProvider` — the one function in this codebase that already answers "is this
 * archival, stock, or generated", and the same one the colour grade uses. Two planners read this
 * field and both ask a yes/no question of it: is the source archival (shotPlanner's
 * `ARCHIVE_SOURCES`), and is it generated.
 *
 * The TRUE provider is never lost. It goes into `AssetSourceIdentity.provider`, which is what
 * provenance, the grade and the rehydrator all read, and a test asserts that a NARA clip still
 * says "nara" there even though the engine sees "internet_archive".
 */
export function engineSourceFor(
  provider: string | null | undefined,
  archiveAssetId?: number | null
): CandidateSource {
  const p = (provider ?? "").trim().toLowerCase();
  // An exact member of the union is used as itself — no classification needed.
  const exact: readonly CandidateSource[] = [
    "own_archive", "wikimedia", "pexels", "pixabay",
    "internet_archive", "youtube_cc", "europeana", "ai_generated",
  ];
  if ((exact as readonly string[]).includes(p)) return p as CandidateSource;

  switch (docGradeSourceKindForProvider(provider, { archiveAssetId })) {
    /** Our own archive row is the most accurate of the archival tokens for a curated asset. */
    case "archive":
      return archiveAssetId != null ? "own_archive" : "internet_archive";
    case "ai_generated":
      return "ai_generated";
    case "stock":
      return "pexels";
    /**
     * An unclassified provider is NOT called archival. `own_archive` and `internet_archive` both
     * put the shot planner into its archival branch, and claiming that for a source nobody has
     * classified would apply an editorial rule on no evidence. `pexels` is the neutral token here:
     * it is in neither special list, so the planner treats the clip on its own merits.
     */
    default:
      return "pexels";
  }
}

/**
 * An adopted clip, in the engine's vocabulary.
 *
 * §7 in one function: `duration`, `width` and `height` are null unless this render MEASURED them.
 * The timeline planner reads `duration` to decide how much of a clip it may use, and a fabricated
 * 10 would let it plan a cut past the end of a file that is four seconds long.
 */
export function candidateFrom(
  facts: AdoptedClipFacts,
  adoption: AdoptionFacts | null,
  beat: ProductionBeat,
  sceneIndex: number,
  beatIndex: number
): CandidateAsset {
  return {
    candidateId: candidateIdFor(adoption, sceneIndex, beatIndex),
    source: engineSourceFor(adoption?.provider, adoption?.archiveAssetId),
    assetType: facts.kind ?? "video",
    title: adoption?.assetTitle ?? null,
    description: null,
    tags: [],
    thumbnail: null,
    localPath: facts.localPath,
    remoteUrl: adoption?.sourceUrl ?? null,
    metadata: null,
    searchQuery: adoption?.query ?? beat.searchQuery ?? "",
    retrievalMethod: "search",
    fetchedAt: new Date(0).toISOString(),
    language: null,
    license: null,
    attribution: null,
    width: facts.widthPx ?? null,
    height: facts.heightPx ?? null,
    duration: facts.durationSec ?? null,
    mimeType: null,
    originalSource: adoption?.originalUrl ?? null,
    downloadTimeMs: null,
    embeddingSimilarity: null,
    keywordScore: null,
    retrievalReasons: [],
    retrievalSources: [],
    clipSimilarity: null,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    editorialScore: null,
    motionLevel: null,
    rankingScore: null,
    rankingBreakdown: null,
  };
}

/**
 * Turn one render's scenes, beats and adopted clips into the cinematic engine's inputs.
 *
 * ── Scene offsets ────────────────────────────────────────────────────────────────────────────
 *
 * Each scene starts where the previous one ended, from the pipeline's own `scene.duration`. That
 * is arithmetic on numbers the pipeline established, not a decision about them — and it is ONE
 * offset per scene, added to beat times that are already scene-relative. The RONDE 150 double-count
 * cannot recur here because a per-beat offset is not expressible in this shape.
 */
export function buildCinematicSceneInputs(params: {
  scenes: SceneFacts[];
  extractors?: EntityExtractors;
  /** The scene's start on the whole video's clock, when the render measured it from the TTS. */
  sceneOffsetsSec?: number[];
}): CinematicInputsResult {
  const extractors = params.extractors ?? {};
  const dropped: string[] = [];
  const out: CinematicSceneInput[] = [];
  const stats = { scenes: 0, beats: 0, planned: 0, withTrim: 0, withProbe: 0 };

  let cursorSec = 0;
  params.scenes.forEach((sceneFacts, sceneOrder) => {
    const { scene } = sceneFacts;
    /**
     * Measured beats where the render has them, the script's own duration otherwise. Both are the
     * pipeline's numbers; neither is invented here.
     */
    const sceneOffsetSec = params.sceneOffsetsSec?.[sceneOrder] ?? cursorSec;
    cursorSec = sceneOffsetSec + Math.max(0, scene.duration);

    const beats: CinematicBeatInput[] = [];
    sceneFacts.beats.forEach((beat, beatIndex) => {
      stats.beats++;
      const adopted = sceneFacts.clips[beatIndex] ?? null;
      const beatId = beatIdFor(scene.index, beatIndex);

      if (!adopted) {
        dropped.push(`${beatId}: no clip was adopted for this beat`);
        return;
      }
      const identity = identityFrom(adopted.adoption);
      if (!identity) {
        /**
         * §6/§28 — a clip whose source cannot be proven is DROPPED, with its provider named.
         *
         * The alternative is planning a shot around a file that exists only in this render's temp
         * directory: the edit would look right today and be unrenderable tomorrow, which is the
         * exact failure the lineage ledger was built to end.
         */
        dropped.push(
          `${beatId}: adopted clip has no rehydratable identity ` +
            `(provider=${adopted.adoption?.provider ?? "unknown"})`
        );
        return;
      }

      const start = beat.voiceStartSec ?? 0;
      const end = beat.voiceEndSec ?? start + (beat.holdSec ?? 0);
      const durationSec = Math.max(0, end - start);
      if (durationSec <= 0) {
        dropped.push(`${beatId}: the beat has no voice window and no hold length`);
        return;
      }

      if (adopted.facts.durationSec != null) stats.withProbe++;
      if (adopted.facts.sourceInSec != null || adopted.facts.sourceOutSec != null) stats.withTrim++;

      beats.push({
        input: {
          scene,
          intent: intentFrom(beat, scene.index, beatIndex, adopted.adoption, extractors),
          bestCandidate: candidateFrom(adopted.facts, adopted.adoption, beat, scene.index, beatIndex),
          beatVoiceStartSec: start,
          beatVoiceDurationSec: durationSec,
        },
        identity,
      });
      stats.planned++;
    });

    if (beats.length === 0) {
      dropped.push(`scene ${scene.index}: no beat could be planned, the scene is not in the edit`);
      return;
    }

    out.push({
      director: {
        scene,
        beatIntents: beats.map((b) => b.input.intent),
        durationSec: Math.max(0, scene.duration),
      },
      beats,
      sceneOffsetSec,
    });
    stats.scenes++;
  });

  return { scenes: out, dropped, stats };
}

/** One line for the render log. Counts and ids only — never a URL, never a payload. */
export function formatCinematicInputs(result: CinematicInputsResult): string {
  return (
    `[CinematicPipeline] inputs scenes=${result.stats.scenes} beats=${result.stats.beats} ` +
    `planned=${result.stats.planned} probed=${result.stats.withProbe} ` +
    `trimmed=${result.stats.withTrim} dropped=${result.dropped.length}`
  );
}
