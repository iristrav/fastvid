/** Modular pipeline — stage-boundary adapters (Phase 8).
 *
 *  "Avoid duplicate conversions between stages" — every conversion between a legacy shape and
 *  a Phase 3-7 engine shape lives here, exactly once, instead of being re-derived inline at
 *  each call site that needs it.
 *
 *  Two of these adapters exist specifically so `cinematicEditingEngineStageEnabled()` can be
 *  turned on independently of `visualIntelligenceEngineStageEnabled()` (see newEngineFlags.ts):
 *  `generateEDL()` needs one `CandidateAsset` + one `VisualIntent` per beat regardless of which
 *  stage produced them.
 *
 *  - `archiveAssetRowToCandidateAsset()` converts the legacy Media Search stage's
 *    `CuratedCandidatePick` (a DB row + score, curatedMediaSourcing.ts) into visualMatchingV2's
 *    `CandidateAsset` shape, so the Cinematic Editing Engine's `bestCandidate` field always
 *    receives the same type whether Visual Intelligence Engine ran or not. Modeled on
 *    sourceAdapters.ts's own (module-private) `normalizeCandidate()` — same field defaults,
 *    reimplemented here rather than imported since that helper isn't exported and is tied to
 *    that file's own SourceAdapter search-logging conventions.
 *  - `minimalVisualIntentFromScene()` is an honestly-labeled DEGRADED stand-in for a real
 *    `VisualIntent` — used only when Cinematic Editing Engine is on but Visual Intelligence
 *    Engine (the thing that normally extracts a rich VisualIntent via an LLM call) is off. It
 *    fills the handful of fields the legacy `Scene` already carries (visualCue, pexelsQuery,
 *    personNames) and leaves every entity-extraction field Phase 3 added (objects, brands,
 *    companies, countries, events) empty — never fabricated. This is intentionally worse than
 *    a real VisualIntent; enabling Visual Intelligence Engine alongside Cinematic Editing
 *    Engine is what removes the degradation, not a smarter fallback here.
 *
 *  `sceneToBeatInput()` is the one-line Scene -> visualMatchingV2 BeatInput conversion, kept
 *  here rather than inlined at the one call site so a second call site never re-derives it
 *  slightly differently.
 */
import type { BeatInput } from "../visualMatchingV2/visualIntentExtractor";
import type { CandidateAsset, VisualIntent } from "../visualMatchingV2/types";
import type { CuratedCandidatePick, Scene } from "./types";

/** Every legacy-adapted candidate/beat this phase produces uses this beat-id convention:
 *  scene index N -> "sN-b0" — this modular orchestrator (Phase 2) treats one Scene as one
 *  beat (it does not sub-split into multiple beats per scene), so there is always exactly one
 *  beat per scene, and it is always beat 0. Documented once here rather than duplicated at
 *  every call site that needs to construct or parse this id. */
export function sceneBeatId(sceneIndex: number): string {
  return `s${sceneIndex}-b0`;
}

export function sceneToBeatInput(scene: Scene): BeatInput {
  return { beatId: sceneBeatId(scene.index), spokenText: scene.text };
}

/** Converts the legacy Media Search stage's winning candidate into visualMatchingV2's
 *  CandidateAsset shape. `localPath` stays null — legacy archive rows reference a remote
 *  storageUrl (R2/CDN), not a pre-downloaded local file; this is the same nullable-either-way
 *  contract clipRenderer.ts (Phase 7) already handles for both localPath and remoteUrl. */
export function archiveAssetRowToCandidateAsset(pick: CuratedCandidatePick): CandidateAsset {
  const asset = pick.asset;
  const nowIso = new Date().toISOString();

  return {
    candidateId: `legacy_archive:${asset.id}`,
    source: "own_archive",
    assetType: asset.mediaType,
    title: asset.title ?? null,
    description: null,
    tags: asset.tags ?? [],
    thumbnail: null,
    localPath: null,
    remoteUrl: asset.storageUrl,
    metadata: { archiveName: pick.archiveName, archiveAssetId: asset.id },
    searchQuery: (pick.archiveNicheTags ?? []).join(" "),
    retrievalMethod: "search",
    fetchedAt: nowIso,
    language: null,
    license: asset.licenseNote ?? null,
    attribution: asset.sourceNote ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    duration: asset.durationSec ?? null,
    mimeType: asset.mimeType ?? null,
    originalSource: pick.archiveName,
    downloadTimeMs: null,
    embeddingSimilarity: pick.semantic?.embeddingSimilarity ?? null,
    keywordScore: pick.score,
    retrievalReasons: ["keyword"],
    retrievalSources: [{ source: "own_archive_legacy", score: pick.score }],
    clipSimilarity: pick.clipVisionScore10 != null ? pick.clipVisionScore10 / 10 : null,
    clipModel: null,
    clipEmbeddingVersion: null,
    clipLatencyMs: null,
    editorialScore: null,
    motionLevel: null,
    rankingScore: pick.score,
    rankingBreakdown: null,
  };
}

/** DEGRADED stand-in VisualIntent (see file-level doc comment) — only ever used when Cinematic
 *  Editing Engine is on and Visual Intelligence Engine is off. */
export function minimalVisualIntentFromScene(scene: Scene): VisualIntent {
  const beatId = sceneBeatId(scene.index);
  return {
    beatId,
    spokenText: scene.text,
    visualSubject: scene.visualCue || scene.literalVisualCue || scene.text.slice(0, 80),
    visualAction: "",
    visualLocation: "",
    visualTime: "",
    historicalContext: "",
    emotion: "",
    visualDescription: scene.visualCue ?? "",
    primaryKeyword: scene.pexelsQuery || scene.pexelsQueries?.[0] || scene.text.slice(0, 40),
    secondaryKeyword: scene.pexelsQueries?.[1] ?? "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    people: scene.personNames ?? [],
    countries: [],
    events: [],
    intentHash: `legacy_adapter:${beatId}`,
    cacheHit: false,
  };
}
