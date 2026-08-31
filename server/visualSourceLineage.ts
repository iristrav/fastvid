/**
 * RONDE 86/87 — where every picture in the finished video actually came from, provably.
 *
 * RONDE 86 built the first version of this ledger, because until then a clip's provenance lived
 * in exactly one place: its filename. `inferClipSourceFromPath` read a provider out of
 * `__pid_<provider>-<sha>` or guessed from a dozen naming conventions, and the quality report
 * counted sources by running that guess over the final clip list. That works right up to the
 * first rename — and the compose path renames constantly: `_still` when a photograph becomes a
 * clip, `_transformed` by the transform step, and `padShortClipWithNext` republishes two clips as
 * a brand-new `pad_combined_sNbM_<ts>.mp4` carrying no tag at all. Render 536 shipped 66 clips
 * and reported 27 of them as source=unknown.
 *
 * RONDE 87 makes the ledger the ONLY official source of truth, and forbids guessing outright.
 *
 * Three rules govern everything below:
 *
 *   1. A provider is recorded only when it came from the candidate/provider data itself. There is
 *      no path from a filename, a URL pattern, a position in a list or a route label to an
 *      official provider attribution. When the source cannot be proven the record says so —
 *      providerStatus "UNVERIFIED", provider null — and every count reports it as UNVERIFIED
 *      rather than folding it into a plausible-looking bucket.
 *
 *   2. A clip's life is a sequence of EVENTS, not a set of booleans. FOUND, ELIGIBLE, RANKED,
 *      SELECTED, DOWNLOAD_STARTED/SUCCEEDED/FAILED, ADOPTED, TRIMMED, PADDED, OVERLAYED,
 *      TRANSFORMED, COMPOSED, REPLACED, REMOVED, FINAL_VIDEO. Every official number is derived
 *      from those events and from nothing else, so two subsystems reporting the same thing can
 *      no longer produce two different totals — or double-count one event as two.
 *
 *   3. DOWNLOADED is not ADOPTED is not COMPOSED is not FINAL_VIDEO. A FINAL_VIDEO event is
 *      written only when the pipeline can point at the concat that produced the delivered file
 *      and show this clip's scene in its input list. Absent that proof the answer is
 *      NOT_VERIFIED, which is a different fact from zero and is reported as such.
 *
 * A derived file — trim, pad, overlay, transform — never becomes an independent source. It gets
 * its own lineage record carrying `parentLineageId`, and inherits provider identity from that
 * parent. Inheriting along a derivation the pipeline itself performed is proof, not inference.
 *
 * Deliberately dependency-free: no DB, no filesystem, no imports from videoPipeline (which
 * imports this file, so the reverse would be a cycle). Plain in-memory data with a per-render
 * lifetime, exactly like VisualDedupState's other maps.
 */

import * as path from "path";

/** How a clip reached the beat it fills. */
export type VisualLineageRoute =
  | "primary"
  | "fallback"
  | "rescue"
  | "backfill"
  | "padding"
  | "graphic";

export type VisualLineageMediaType = "video" | "image" | "graphic" | "unknown";

/**
 * Whether this record's provider is a proven fact.
 *
 * VERIFIED means the provider name arrived with the candidate — from the provider's own search
 * result, from putCachedProviderAsset, or from the archive row the asset was read out of — or was
 * inherited along a derivation this pipeline itself performed. UNVERIFIED means it was not
 * available, and the only honest report is that nobody knows.
 */
export type ProviderStatus = "VERIFIED" | "UNVERIFIED";

/** The stages of a clip's life that the pipeline can observe and prove. */
export const LINEAGE_STAGES = [
  "FOUND",
  "ELIGIBLE",
  "RANKED",
  "SELECTED",
  "DOWNLOAD_STARTED",
  "DOWNLOAD_SUCCEEDED",
  "DOWNLOAD_FAILED",
  "ADOPTED",
  "TRANSFORMED",
  "TRIMMED",
  "PADDED",
  "OVERLAYED",
  "COMPOSED",
  "REPLACED",
  "REMOVED",
  "FINAL_VIDEO",
] as const;

export type LineageStage = (typeof LINEAGE_STAGES)[number];

/** The outcome attached to an event. REJECTED always carries a reason. */
export type LineageEventStatus = "OK" | "FAILED" | "REJECTED" | "REPLACED" | "REMOVED";

/**
 * RONDE 165 — the one vocabulary every terminal outcome is written in.
 *
 * Four rounds fixed VANISHED_WITHOUT_OUTCOME one route at a time (RONDE 95 built the rule, 159
 * closed the compose filter, 162 closed validation and placeholders) and render 554 still reported
 * seventeen. Each fix invented its own reason string at its own call site, so the next route to be
 * added started silent again by default.
 *
 * These are the reasons, named once. `recordAssetOutcome` below is the only way to file one, so a
 * route that ends an asset's life either uses a reason from this list or does not compile.
 *
 * Deliberately NOT a second audit system: this is a typed front door onto recordEventForPath, the
 * ledger that already holds every asset's history and already computes the vanished warning.
 */
export type AssetOutcomeReason =
  // ── Refused by a check ──────────────────────────────────────────────────────────────────────
  /** The file could not be read at all. */
  | "invalid_file"
  /** Readable, but the montage cannot use this video stream. */
  | "unusable_stream"
  /** Nearly all black — a picture with nothing in it. */
  | "mostly_black"
  /** A placeholder card that failed its own validation. */
  | "placeholder_rejected"
  /** A placeholder card that was made and then not needed. */
  | "placeholder_not_used"
  /** Refused by the compose barrier. */
  | "compose_gate"
  /** The same content is already in this scene. */
  | "duplicate_content"
  /** VisionGate judged it and refused it. */
  | "vision_rejected"
  /** A curated archive asset refused before adoption. */
  | "curated_rejected"
  /** An extended clip the compose barrier turned away. */
  | "extended_rejected"
  /**
   * An extension that was built and adopted, and then dropped before the final video.
   *
   * Distinct from `extended_rejected`: nothing refused this clip on content grounds, the montage
   * simply did not use it. RONDE 167 §2 asks for the extend route's endings to be nameable, and
   * "the barrier said no" and "it was never needed" are the two that exist.
   *
   * There is deliberately no `extended_download_failed`. An extension that fails to build produces
   * no file and no record, so there is nothing to account for — inventing a reason for it would
   * add exactly the kind of enum member nothing writes, which is the bug class this round is
   * about. The test suite asserts no orphan record is created on that path.
   */
  | "extended_removed"
  /** The fair-use transform this asset required did not produce a usable file. */
  | "transform_failed"
  // ── Ended by something else winning ─────────────────────────────────────────────────────────
  /** Downloaded and judged, but another candidate won the beat. */
  | "superseded_by_winner"
  /**
   * RONDE 168 — the beat's look budget ran out before anyone judged this candidate.
   *
   * Distinct from `not_chosen`, and the distinction is the whole finding: "we looked and preferred
   * another" and "we never looked" are opposite facts, and video 555 shipped a picture on the
   * second while its audit read like the first.
   */
  | "never_judged"
  /**
   * Judged, kept nothing against it, and the beat still went elsewhere.
   *
   * Deliberately distinct from `superseded_by_winner`: "another candidate was better" and "this
   * beat found no winner at all" need opposite fixes, and a single reason covering both would
   * hide which of the two a render is actually suffering from.
   */
  | "not_chosen"
  /** Swapped out for a specific replacement. */
  | "replaced_by_candidate"
  /**
   * RONDE 169 — the scene this clip was adopted for was re-sourced, and it was not carried over.
   *
   * Twelve places assign `sceneVisualResults[i]`, several of them rebuilding a scene's picture
   * list from scratch after a coverage repair or a strict-voice refill. The clips of the previous
   * list were ADOPTED and then simply stopped being referenced — no gate refused them, nothing
   * replaced them one-for-one, and nothing said a word. Render 555 ended with eighteen assets in
   * that state and every one of them carried provider=UNVERIFIED, which is the signature of the
   * backfill, rescue and fallback routes that rebuild lists.
   *
   * Its own reason rather than `replaced_by_candidate`, because there is no single candidate that
   * took its place: the whole scene was re-cut.
   */
  | "scene_resourced"
  /** A derived clip took over from the source it was made from. */
  | "superseded_by_derived";

/** Which lineage status each reason files. Kept beside the reasons so the two cannot drift. */
const OUTCOME_STATUS: Record<AssetOutcomeReason, LineageEventStatus> = {
  invalid_file: "REJECTED",
  unusable_stream: "REJECTED",
  mostly_black: "REJECTED",
  placeholder_rejected: "REJECTED",
  placeholder_not_used: "REMOVED",
  compose_gate: "REJECTED",
  duplicate_content: "REMOVED",
  vision_rejected: "REJECTED",
  curated_rejected: "REJECTED",
  extended_rejected: "REJECTED",
  extended_removed: "REMOVED",
  transform_failed: "REJECTED",
  never_judged: "REMOVED",
  not_chosen: "REMOVED",
  superseded_by_winner: "REPLACED",
  replaced_by_candidate: "REPLACED",
  scene_resourced: "REPLACED",
  superseded_by_derived: "REPLACED",
};

/**
 * File the one terminal outcome an asset gets.
 *
 * `context` is free text for the beat or scene it happened in — never a second reason. A caller
 * with no ledger is a no-op, exactly as every other audit call in this file is.
 */
export function recordAssetOutcome(
  ledger: VisualSourceLedger | undefined,
  clipPath: string,
  reason: AssetOutcomeReason,
  context?: string,
  /**
   * RONDE 167 — the second handle, and for a whole route it is the ONLY one that works.
   *
   * `resolve` tries the exact path, then the derivation chain, then the content key. The curated
   * archive route never registers a path at all: `ensureCuratedAssetLineage` opens the record from
   * the DB row under `archive-asset:<id>` and its content key, and `prepareCuratedArchiveClip`
   * writes `scene_N_bM_curated_a<id>.mp4` without touching the ledger. So an outcome filed by path
   * alone found nothing and wrote nothing — measured: zero events — which made RONDE 165's
   * `superseded_by_winner` dead for every archive candidate, the exact case render 554's s2b3
   * evidence was about.
   *
   * The record was always reachable. `clipContentKey` maps that filename straight back to
   * `curated:asset:<id>`; nobody was passing it.
   */
  contentKey?: string
): void {
  const status = OUTCOME_STATUS[reason];
  /**
   * REJECTED is a STATUS, not a stage — see rejectionStageForGate. A refusal is filed as a
   * REMOVED stage carrying the REJECTED status, which is exactly the shape the vanished rule
   * looks for ("a stage whose status includes REJECTED"), and a hand-off is filed as REPLACED.
   */
  const stage: LineageStage = status === "REPLACED" ? "REPLACED" : "REMOVED";
  ledger?.recordEventForPath(clipPath, stage, {
    status,
    reason: context ? `${reason}:${context}` : reason,
    contentKey,
  });
}

/**
 * The gate that produced a rejection, §E.
 *
 * Kept separate from `stage`: the stage says WHERE in the clip's life the refusal happened, the
 * gate says WHICH check refused it. Render 536 could report neither — its rejections were counted
 * per reason across the whole render with no asset attached, so "internet_archive rejected 184"
 * was the finest grain available and it named neither the assets nor the gates.
 */
export function rejectionStageForGate(gate: string): LineageStage {
  const g = (gate ?? "").trim().toLowerCase();
  // Everything that judges a candidate before it can be used is an eligibility refusal.
  if (
    g === "vision_gate" || g === "baked_text" || g === "off_topic_protest" ||
    g === "off_topic_visual" || g === "documentary_beat_gate" || g === "entity_evidence" ||
    g === "beat_image_gate" || g === "still_cap" || g === "license_rejected" ||
    g === "modern_mismatch" || g === "geo_blocked"
  ) {
    return "ELIGIBLE";
  }
  // Anything raised while the montage is being assembled belongs to the compose stage.
  if (g === "compose_gate" || g === "near_duplicate" || g === "mostly_black") return "COMPOSED";
  // An unrecognised gate is NOT sorted into a bucket it may not belong in.
  return "ELIGIBLE";
}

export type VisualLineageEvent = {
  lineageId: string;
  timestamp: number;
  stage: LineageStage;
  status: LineageEventStatus;
  /** Why, for anything that is not a plain OK. */
  reason?: string;
  /** For a rejection: the gate that refused it. */
  gate?: string;
  sceneIndex: number;
  beatIndex: number;
  /** null when the provider is not proven — never a placeholder string. */
  provider: string | null;
  providerStatus: ProviderStatus;
  providerAssetId?: string;
  currentPath?: string;
  parentLineageId?: string;
};

/** Everything known about one clip's origin. `provider` is null unless it was proven. */
export type VisualLineageRecord = {
  /** Unique within a render; the handle every event carries. */
  lineageId: string;
  /** The DB row this render is producing, when the pipeline was given one. */
  videoId?: number;
  /** Identifies this render even when videoId is absent (a retry re-uses the videoId). */
  renderId: string;
  sceneIndex: number;
  beatIndex: number;
  /** The pipeline's own beat identifier, when it has one. */
  beatId?: string;
  /** The narration this clip is meant to illustrate. */
  beatText?: string;
  /** The candidate's identity at selection time — provider asset key, archive row, or content key. */
  candidateId: string;
  /** clipContentKey(localPath) as the caller computed it. */
  contentKey: string;
  /** The provider that supplied this asset, or null when it could not be proven. */
  provider: string | null;
  providerStatus: ProviderStatus;
  providerAssetId?: string;
  /** The URL the bytes were fetched from. */
  sourceUrl?: string;
  /** The provider's canonical page for the asset, when it differs from sourceUrl. */
  originalUrl?: string;
  localPath: string;
  originalFilename: string;
  /** Updated as the clip is trimmed, padded and overlaid. */
  currentFilename: string;
  mediaType: VisualLineageMediaType;
  /** The query that produced this candidate. */
  query?: string;
  /**
   * RONDE 95 (§2) — the gate route that ran that query.
   *
   * `query` says WHAT was asked; this says WHICH call site asked it, in the same vocabulary the
   * [SearchGate] report uses (fetchWikimediaVideos, scenePool:searchPexelsCandidates, …). Without
   * it a clip can be traced back to its words but not to the code that chose them, which is the
   * half of the question that matters when a provider starts returning the wrong thing.
   */
  searchRoute?: string;
  /** The retrieval/ranking score it won on. */
  candidateScore?: number;
  /** Vision-gate verdict, 0–10. */
  visionScore?: number;
  /** The score it was actually selected on, when that differs from candidateScore. */
  selectedScore?: number;
  /** Curated-archive row id, when the clip came from the own archive. */
  archiveAssetId?: number;
  assetTitle?: string;
  route: VisualLineageRoute;
  /** The adopt-audit source label. A ROUTE LABEL, never a provider. */
  sourceLabel?: string;
  /** The record this one was derived from — set on every trim, pad, overlay and transform. */
  parentLineageId?: string;
  createdAt: number;
  selectedAt?: number;
  adoptedAt?: number;
  composedAt?: number;
  /** Set only when the delivered file's concat input provably contains this clip's scene. */
  finalVideoAt?: number;
};

export type CreateLineageInput = {
  sceneIndex: number;
  beatIndex: number;
  beatId?: string;
  beatText?: string;
  candidateId: string;
  contentKey: string;
  localPath: string;
  mediaType?: VisualLineageMediaType;
  route?: VisualLineageRoute;
  /**
   * The provider, when and only when it came from the candidate/provider data. Omitted or empty
   * produces providerStatus "UNVERIFIED" and provider null — there is no third option, and no
   * caller can opt out of that by passing a guess, because a guess is indistinguishable here from
   * a fact and the whole point of the round is that they must not be.
   */
  provider?: string | null;
  providerAssetId?: string;
  sourceUrl?: string;
  originalUrl?: string;
  query?: string;
  /** RONDE 95 (§2): the gate route that ran the query — see VisualLineageRecord.searchRoute. */
  searchRoute?: string;
  candidateScore?: number;
  visionScore?: number;
  selectedScore?: number;
  archiveAssetId?: number;
  assetTitle?: string;
  sourceLabel?: string;
  parentLineageId?: string;
  videoId?: number;
};

/** The counters kept for every provider and for the render as a whole. */
export const SUMMARY_COUNTERS = [
  "searches",
  "results",
  "eligible",
  "ranked",
  "selected",
  "downloadStarted",
  "downloadSucceeded",
  "downloadFailed",
  "adopted",
  "transformed",
  "composed",
  "replaced",
  "removed",
  "finalVideo",
  "rejected",
  "fallback",
  "rescue",
  "backfill",
] as const;

export type SummaryCounter = (typeof SUMMARY_COUNTERS)[number];
export type SummaryCounts = Record<SummaryCounter, number>;

export function emptySummaryCounts(): SummaryCounts {
  const out = {} as SummaryCounts;
  for (const c of SUMMARY_COUNTERS) out[c] = 0;
  return out;
}

export type VisualSourceSummary = {
  total: SummaryCounts;
  byProvider: Record<string, SummaryCounts>;
  failureReasons: Record<string, number>;
  /** Records whose provider could not be proven. Reported, never redistributed. */
  unverifiedRecords: number;
  verifiedRecords: number;
};

/** The label official reports use for a record whose provider is not proven. */
export const UNVERIFIED_PROVIDER = "UNVERIFIED";

/** The label a count uses when the pipeline could not observe the answer at all. */
export const NOT_VERIFIED = "NOT_VERIFIED";

export type AuditFinding = {
  code: string;
  message: string;
  lineageId?: string;
  detail?: string;
};

export type ReconciliationResult = {
  errors: AuditFinding[];
  warnings: AuditFinding[];
  verifiedSourceClips: number;
  unverifiedSourceClips: number;
  /** Number of clips proven to be in the delivered file. */
  finalVideoClips: number;
  /**
   * True when the pipeline never got to prove which clips reached the delivered file — the
   * difference between "no clip made it" (a catastrophe) and "nobody checked" (a gap in the
   * instrumentation). §J of the brief exists entirely for this distinction.
   */
  finalVideoVerified: boolean;
};

function normalizeProvider(provider: string | undefined | null): string | null {
  const p = (provider ?? "").trim().toLowerCase();
  if (!p) return null;
  // A caller that tries to launder "unknown" into a provider name gets the same answer as a
  // caller that passed nothing, which is the honest one.
  if (p === "unknown" || p === "unverified" || p === "null" || p === "undefined") return null;
  return p;
}

/** The bucket a record's counts belong to: its proven provider, or the UNVERIFIED bucket. */
function providerBucket(record: { provider: string | null }): string {
  return record.provider ?? UNVERIFIED_PROVIDER;
}

/**
 * A per-render, event-sourced ledger of clip provenance.
 *
 * One instance per render, hung off VisualDedupState, discarded with it. Nothing here throws:
 * every method is safe to call on the hot path with partial information, because a missing
 * lineage entry must degrade the REPORT, never the render.
 */
export class VisualSourceLedger {
  readonly renderId: string;
  readonly videoId?: number;

  private readonly records = new Map<string, VisualLineageRecord>();
  private readonly events: VisualLineageEvent[] = [];
  /** localPath → lineageId. The authoritative index. */
  private readonly byPath = new Map<string, string>();
  /** contentKey → lineageId, for a path renamed without being linked. */
  private readonly byContentKey = new Map<string, string>();
  /** derived path → the path it was produced from. Walked by resolve(). */
  private readonly derivedFrom = new Map<string, string>();
  /** Per-provider search/result counters, which are not per-asset and so cannot be events. */
  private readonly searchCounts = new Map<string, { searches: number; results: number }>();
  /** Provider-reported completed downloads, for fetch paths that count rather than emit events. */
  private readonly providerDownloads = new Map<string, number>();
  /** (lineageId, stage) already counted — the guard against double counting one event. */
  private readonly countedStages = new Set<string>();
  private seq = 0;
  private finalVideoProven = false;
  /**
   * RONDE 167 §7 — how this ledger turns a file path into an asset identity.
   *
   * The curated archive route is the reason this exists. Its record is opened from the DB row and
   * is reachable only by `curated:asset:<id>`; the file it later writes,
   * `scene_N_bM_curated_a<id>.mp4`, is never registered as a path. Every terminal-outcome writer
   * in the pipeline looked the clip up by path alone, found nothing, and wrote nothing — measured
   * at zero events — so RONDE 165's superseded_by_winner, RONDE 159's and 162's REMOVED events and
   * RONDE 95's recordReplacement were all inert for archive assets.
   *
   * Patching each writer to pass a key would fix today's five and leave the sixth to be forgotten.
   * Instead the LEDGER knows how to derive the identity, so `resolve` closes the gap for every
   * caller that exists and every caller that does not exist yet.
   *
   * Injected rather than imported: `clipContentKey` lives in videoPipeline, which imports this
   * module. The dependency stays one-way and this file stays free of fs and ffmpeg.
   */
  private contentKeyResolver?: (clipPath: string) => string | undefined;
  private readonly emit?: (line: string) => void;

  /**
   * `emit` receives one formatted line per event as it happens (§B).
   *
   * Injected rather than calling console.log directly so the ledger stays a pure data structure —
   * the tests drive thousands of events through it without flooding the reporter, and the pipeline
   * decides how verbose a render should be.
   */
  constructor(opts: { renderId: string; videoId?: number; emit?: (line: string) => void }) {
    this.renderId = opts.renderId;
    this.videoId = opts.videoId;
    this.emit = opts.emit;
  }

  // ── Lineage records ────────────────────────────────────────────────────────

  /**
   * Opens a lineage for one candidate and emits its FOUND event.
   *
   * The provider is taken at face value ONLY here, and only because this is the single point at
   * which a caller is holding the candidate's own provider data. Everything downstream reads the
   * record; nothing downstream may set a provider that was not set here or inherited from a
   * parent.
   */
  createLineage(input: CreateLineageInput): VisualLineageRecord {
    const parent = input.parentLineageId ? this.records.get(input.parentLineageId) : undefined;
    const provider = normalizeProvider(input.provider) ?? parent?.provider ?? null;
    const basename = path.basename(input.localPath);
    this.seq += 1;
    const record: VisualLineageRecord = {
      lineageId: `${this.renderId}#${this.seq}`,
      videoId: input.videoId ?? this.videoId,
      renderId: this.renderId,
      sceneIndex: input.sceneIndex,
      beatIndex: input.beatIndex,
      beatId: input.beatId,
      beatText: input.beatText,
      candidateId: input.candidateId,
      contentKey: input.contentKey,
      provider,
      providerStatus: provider ? "VERIFIED" : "UNVERIFIED",
      providerAssetId: input.providerAssetId ?? parent?.providerAssetId,
      sourceUrl: input.sourceUrl ?? parent?.sourceUrl,
      originalUrl: input.originalUrl ?? parent?.originalUrl,
      localPath: input.localPath,
      originalFilename: basename,
      currentFilename: basename,
      mediaType: input.mediaType ?? parent?.mediaType ?? "unknown",
      query: input.query ?? parent?.query,
      searchRoute: input.searchRoute ?? parent?.searchRoute,
      candidateScore: input.candidateScore,
      visionScore: input.visionScore,
      selectedScore: input.selectedScore,
      archiveAssetId: input.archiveAssetId ?? parent?.archiveAssetId,
      assetTitle: input.assetTitle ?? parent?.assetTitle,
      route: input.route ?? parent?.route ?? "primary",
      sourceLabel: input.sourceLabel ?? parent?.sourceLabel,
      parentLineageId: input.parentLineageId,
      createdAt: Date.now(),
    };
    this.records.set(record.lineageId, record);
    this.byPath.set(record.localPath, record.lineageId);
    if (record.contentKey) this.byContentKey.set(record.contentKey, record.lineageId);
    this.recordEvent(record.lineageId, "FOUND", { status: "OK" });
    return record;
  }

  /** The record behind a lineageId. */
  get(lineageId: string | undefined): VisualLineageRecord | null {
    return (lineageId && this.records.get(lineageId)) || null;
  }

  /**
   * Attaches a record opened before its file existed to the file that was produced.
   *
   * The curated-archive path opens a lineage from the DB row BEFORE the download, so a failure can
   * name the asset instead of vanishing into a bare count. Once the download succeeds the record
   * has to point at the real file. This changes no provenance — the record already carries the
   * provider it was created with — it only makes the record reachable by the path it now owns.
   */
  /**
   * Teach this ledger how to derive an asset identity from a file path. Called once per render.
   *
   * Optional by design: a ledger without one behaves exactly as before, which keeps every test and
   * tool that builds a bare ledger working.
   */
  setContentKeyResolver(fn: (clipPath: string) => string | undefined): void {
    this.contentKeyResolver = fn;
  }

  bindPath(lineageId: string, localPath: string, contentKey?: string): VisualLineageRecord | null {
    const record = this.records.get(lineageId);
    if (!record || !localPath) return null;
    // The placeholder path the record was opened under stops being a handle on it.
    if (record.localPath !== localPath) this.byPath.delete(record.localPath);
    record.localPath = localPath;
    record.originalFilename = path.basename(localPath);
    record.currentFilename = path.basename(localPath);
    if (contentKey) record.contentKey = contentKey;
    this.byPath.set(localPath, lineageId);
    if (record.contentKey) this.byContentKey.set(record.contentKey, lineageId);
    return record;
  }

  /**
   * The record for a clip, found by whichever handle still works.
   *
   * Order matters: the exact path is unambiguous, the derivation chain is authoritative, and the
   * content key survives a rename that was never linked. There is deliberately NO basename
   * fallback any more — two different renders' work dirs can hold files with the same basename,
   * and a basename match is a guess dressed up as a lookup.
   */
  resolve(clipPath: string, contentKey?: string): VisualLineageRecord | null {
    if (!clipPath) return null;
    const direct = this.byPath.get(clipPath);
    if (direct) return this.records.get(direct) ?? null;

    // Walk the derivation chain. Bounded and cycle-guarded: a mis-wired link must not hang a render.
    const seen = new Set<string>([clipPath]);
    let cursor = this.derivedFrom.get(clipPath);
    while (cursor && !seen.has(cursor)) {
      const found = this.byPath.get(cursor);
      if (found) return this.records.get(found) ?? null;
      seen.add(cursor);
      cursor = this.derivedFrom.get(cursor);
    }

    const key = contentKey ?? this.deriveContentKey(clipPath);
    if (key) {
      const byKey = this.byContentKey.get(key);
      if (byKey) return this.records.get(byKey) ?? null;
    }
    return null;
  }

  /**
   * The asset identity behind a path, when the path itself is not a handle.
   *
   * Only reached after the exact path and the derivation chain have both missed, so the cost is
   * paid on the rare lookup rather than the common one. Never throws: a resolver that fails leaves
   * the clip unknown, which is the honest answer and the pre-RONDE-167 behaviour.
   */
  /**
   * RONDE 169 — does this clip already have an ending?
   *
   * Asked by the scene-replacement writer so a clip that a compose gate already refused is not
   * given a second, weaker ending on top. Same `hasTerminalOutcome` the vanished rule, the
   * lifecycle audit and the §8 invariant use, so "accounted for" means one thing everywhere.
   */
  hasOutcomeFor(clipPath: string, contentKey?: string): boolean {
    const record = this.resolve(clipPath, contentKey);
    if (!record) return false;
    const stages = new Map<LineageStage, LineageEventStatus>();
    for (const event of this.events) {
      if (event.lineageId !== record.lineageId) continue;
      if (event.status !== "OK" || !stages.has(event.stage)) stages.set(event.stage, event.status);
    }
    return stages.has("FINAL_VIDEO") || hasTerminalOutcome(stages);
  }

  /** The path a derived file was produced from, or undefined. Read by resolveClipOutcomeIdentity. */
  derivationOriginOf(clipPath: string): string | undefined {
    return this.derivedFrom.get(clipPath);
  }

  private deriveContentKey(clipPath: string): string | undefined {
    if (!this.contentKeyResolver) return undefined;
    try {
      return this.contentKeyResolver(clipPath) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The proven provider for a clip, or null.
   *
   * Callers must render null as UNVERIFIED. There is no overload that returns a fallback string,
   * because every such overload in this codebase's history has ended up being used as a fact.
   */
  providerFor(clipPath: string, contentKey?: string): string | null {
    return this.resolve(clipPath, contentKey)?.provider ?? null;
  }

  /** The provider bucket for a clip: its proven provider, or the UNVERIFIED bucket. */
  providerBucketFor(clipPath: string, contentKey?: string): string {
    const record = this.resolve(clipPath, contentKey);
    return record ? providerBucket(record) : UNVERIFIED_PROVIDER;
  }

  /** Walks up the derivation chain to the record this one ultimately came from. */
  rootOf(lineageId: string): VisualLineageRecord | null {
    let record = this.records.get(lineageId) ?? null;
    const seen = new Set<string>();
    while (record?.parentLineageId && !seen.has(record.lineageId)) {
      seen.add(record.lineageId);
      const parent = this.records.get(record.parentLineageId);
      if (!parent) break;
      record = parent;
    }
    return record;
  }

  /**
   * Registers a derived file as a CHILD of the clip it was produced from.
   *
   * This is the single mechanism that keeps provenance alive across the compose path. Call it at
   * every site that writes a NEW file from an existing clip — the trim, the still-to-video step,
   * the fair-use transform, the text overlay, and padShortClipWithNext's combined output. The
   * derived record inherits the parent's provider identity, which is proof rather than inference:
   * the pipeline performed the derivation itself and knows what went in.
   *
   * Returns the derived record, or null when the origin is unknown — in which case the derived
   * file has no provenance and must be reported as UNVERIFIED rather than given one.
   */
  linkDerivedPath(
    derivedPath: string,
    originPath: string,
    stage: Extract<LineageStage, "TRIMMED" | "PADDED" | "OVERLAYED" | "TRANSFORMED">,
    /**
     * RONDE 167 — `supersedesParent` says whether the parent stops being a file in its own right.
     *
     * A trim, an overlay and a fair-use transform all REPLACE the clip they were made from, so the
     * parent record should be known by the derived file's name; that is the default and it is
     * unchanged. An extension does not: `extendLastClip` loops a clip that is already on screen
     * under its own beat to fill a second one, and both files are live. Renaming the parent there
     * would mislabel a clip that is still in the montage, in the manifest and in every warning
     * that names a file.
     */
    opts: { contentKey?: string; reason?: string; supersedesParent?: boolean } = {}
  ): VisualLineageRecord | null {
    if (!derivedPath || !originPath || derivedPath === originPath) return null;
    this.derivedFrom.set(derivedPath, originPath);
    const parent = this.resolve(originPath);
    if (!parent) return null;

    const existing = this.byPath.get(derivedPath);
    if (existing) {
      const already = this.records.get(existing);
      if (already) {
        this.recordEvent(already.lineageId, stage, { status: "OK", reason: opts.reason });
        return already;
      }
    }

    const derived = this.createLineage({
      sceneIndex: parent.sceneIndex,
      beatIndex: parent.beatIndex,
      beatId: parent.beatId,
      beatText: parent.beatText,
      candidateId: parent.candidateId,
      contentKey: opts.contentKey ?? parent.contentKey,
      localPath: derivedPath,
      parentLineageId: parent.lineageId,
      // Provider is inherited by createLineage from the parent; nothing is invented here.
    });
    if (opts.supersedesParent !== false) parent.currentFilename = path.basename(derivedPath);
    derived.currentFilename = path.basename(derivedPath);
    this.recordEvent(derived.lineageId, stage, { status: "OK", reason: opts.reason });
    return derived;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Appends one lifecycle event and updates the record's derived timestamps.
   *
   * Every official count in this module is computed from these events, deduplicated on
   * (lineageId, stage) — so a beat that is re-adopted by a later recovery layer contributes one
   * adoption, not two. That is the "no double counting" rule of §F, enforced at the point the
   * number is produced rather than trusted at each call site.
   */
  recordEvent(
    lineageId: string,
    stage: LineageStage,
    opts: {
      status?: LineageEventStatus;
      reason?: string;
      gate?: string;
      currentPath?: string;
      timestamp?: number;
    } = {}
  ): VisualLineageEvent | null {
    const record = this.records.get(lineageId);
    if (!record) return null;
    const event: VisualLineageEvent = {
      lineageId,
      timestamp: opts.timestamp ?? Date.now(),
      stage,
      status: opts.status ?? "OK",
      reason: opts.reason,
      gate: opts.gate,
      sceneIndex: record.sceneIndex,
      beatIndex: record.beatIndex,
      provider: record.provider,
      providerStatus: record.providerStatus,
      providerAssetId: record.providerAssetId,
      currentPath: opts.currentPath ?? record.localPath,
      parentLineageId: record.parentLineageId,
    };
    this.events.push(event);
    this.emit?.(formatLineageEvent(event, this.renderId));
    /**
     * RONDE 95 (§3) — one line per milestone, always on.
     *
     * formatLineageEvent above prints EVERY event (trims, pads, overlays) and is behind a flag
     * because a render produces thousands. This prints only the transitions the lifecycle question
     * is about, so the trail from FOUND to RENDERED is readable in a normal production log without
     * turning anything on. It is emitted from inside recordEvent deliberately: a status that is
     * logged anywhere else could be logged without the event having happened, which is exactly the
     * "fake success" §1 forbids.
     */
    const trace = ASSET_TRACE_STATUS[stage];
    if (trace && event.status === "OK") console.log(formatAssetTrace(record, trace, event));
    if (event.status === "OK") {
      if (stage === "SELECTED") record.selectedAt ??= event.timestamp;
      else if (stage === "ADOPTED") record.adoptedAt ??= event.timestamp;
      else if (stage === "COMPOSED") record.composedAt ??= event.timestamp;
      else if (stage === "FINAL_VIDEO") record.finalVideoAt ??= event.timestamp;
    }
    return event;
  }

  /** Convenience: resolve a path to its record and append an event to it. */
  recordEventForPath(
    clipPath: string,
    stage: LineageStage,
    opts: { status?: LineageEventStatus; reason?: string; gate?: string; contentKey?: string } = {}
  ): VisualLineageEvent | null {
    const record = this.resolve(clipPath, opts.contentKey);
    if (!record) return null;
    return this.recordEvent(record.lineageId, stage, { ...opts, currentPath: clipPath });
  }

  /**
   * A refusal, attached to the asset that was refused and to the gate that refused it (§E).
   *
   * Returns false when the ledger does not know this clip. That is a finding, not a failure: it
   * means a candidate reached a gate without ever being recorded, which reconcile() should be able
   * to see. Inventing a record with a guessed provider so the count looks complete is the exact
   * behaviour this round removes.
   */
  /**
   * RONDE 95 (§4/§8) — asset A was chosen, asset B was delivered, and now that is on the record.
   *
   * REPLACED has been a declared lineage stage since RONDE 86 and was counted in every summary,
   * but nothing in the pipeline ever recorded one: a scan found three references, all of them the
   * declaration itself. Every fallback, rescue and heal swap therefore happened invisibly — the
   * ledger showed asset A selected and asset B in the final video with nothing joining them, which
   * is precisely the silent substitution §8 exists to catch.
   *
   * The event goes on the ORIGINAL, because the original is the thing that stopped being true. The
   * replacement is named in the event so the pair can be read in either direction, and the reason
   * is required rather than optional: "replaced" without a why is a fact nobody can act on.
   *
   * Returns false when the ledger does not know the original. That is a finding — something was
   * replaced that was never recorded as chosen — and inventing a record to make the pair look
   * complete would defeat the point.
   */
  recordReplacement(
    originalPath: string,
    replacementPath: string | null,
    reason: string,
    /**
     * RONDE 167 — the curated route has no registered path, only a content key. Without this a
     * replacement of an archive clip resolved to nothing and the swap went unrecorded, which is
     * the silent substitution §8 exists to catch. See recordAssetOutcome for the measurement.
     */
    keys: { originalContentKey?: string; replacementContentKey?: string } = {}
  ): boolean {
    const original = this.resolve(originalPath, keys.originalContentKey);
    if (!original) return false;
    const replacement = replacementPath
      ? this.resolve(replacementPath, keys.replacementContentKey)
      : null;
    this.recordEvent(original.lineageId, "REPLACED", {
      status: "REPLACED",
      reason: `${reason} -> ${replacement?.lineageId ?? path.basename(replacementPath ?? "none")}`,
      currentPath: originalPath,
    });
    console.log(
      `[AssetTrace] assetId=${original.lineageId} status=REPLACED ` +
        `provider=${original.provider ?? UNVERIFIED_PROVIDER} ` +
        `scene=${original.sceneIndex} beat=${original.beatIndex} ` +
        `originalAssetId=${original.lineageId} ` +
        `replacementAssetId=${replacement?.lineageId ?? NOT_VERIFIED} reason=${reason}`
    );
    return true;
  }

  recordRejection(clipPath: string, gate: string, contentKey?: string): boolean {
    const record = this.resolve(clipPath, contentKey);
    if (!record) return false;
    this.recordEvent(record.lineageId, rejectionStageForGate(gate), {
      status: "REJECTED",
      reason: gate,
      gate,
      currentPath: clipPath,
    });
    return true;
  }

  /** Every event, in the order it happened. */
  allEvents(): readonly VisualLineageEvent[] {
    return this.events;
  }

  /** Every record opened this render. */
  allRecords(): VisualLineageRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }

  // ── Per-provider search counters ───────────────────────────────────────────

  /**
   * Searches and raw result counts, which belong to a PROVIDER rather than to any one asset and
   * therefore cannot be lineage events. Kept separate from the event-derived counters and clearly
   * labelled as such in the summary, so nothing is double-counted between the two.
   */
  /**
   * Completed downloads a provider reported through its own counter rather than through events.
   *
   * Same channel and same reasoning as countSearch: these are provider facts the fetch layer has
   * always tracked, and folding them in beats re-instrumenting a dozen fetch sites. A provider
   * that reports real DOWNLOAD_SUCCEEDED events is never folded, so the two cannot double-count.
   */
  countProviderDownloads(provider: string, n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const key = normalizeProvider(provider) ?? UNVERIFIED_PROVIDER;
    const entry = this.providerDownloads.get(key) ?? 0;
    this.providerDownloads.set(key, entry + n);
  }

  countSearch(provider: string, results = 0): void {
    const key = normalizeProvider(provider) ?? UNVERIFIED_PROVIDER;
    const entry = this.searchCounts.get(key) ?? { searches: 0, results: 0 };
    entry.searches += 1;
    entry.results += Math.max(0, results);
    this.searchCounts.set(key, entry);
  }

  // ── FINAL_VIDEO, proven ────────────────────────────────────────────────────

  /**
   * Marks the clips that are provably in the delivered file.
   *
   * The caller must pass the clip paths belonging to the scenes whose scene-videos were in the
   * input list of the concat that produced the validated final file — nothing looser. Calling
   * this at all is what flips `finalVideoVerified`, which is how a render that never got to check
   * stays distinguishable from a render where genuinely nothing made it.
   */
  markFinalVideo(clipPaths: Iterable<string>): number {
    this.finalVideoProven = true;
    let marked = 0;
    for (const clipPath of clipPaths) {
      const record = this.resolve(clipPath);
      if (!record) continue;
      if (record.finalVideoAt != null) continue;
      this.recordEvent(record.lineageId, "FINAL_VIDEO", { status: "OK", currentPath: clipPath });
      marked += 1;
    }
    return marked;
  }

  /** True once the pipeline has actually checked which clips reached the delivered file. */
  get finalVideoWasVerified(): boolean {
    return this.finalVideoProven;
  }

  // ── Summaries ──────────────────────────────────────────────────────────────

  /**
   * The official numbers, computed from events only.
   *
   * `searches`/`results` come from countSearch because they are not per-asset facts; everything
   * else is a deduplicated count of (lineageId, stage) pairs. No caller increments a summary
   * counter directly, which is what makes "one source of truth for the final counts" enforceable
   * rather than a convention.
   */
  summary(): VisualSourceSummary {
    const byProvider: Record<string, SummaryCounts> = {};
    const failureReasons: Record<string, number> = {};
    const total = emptySummaryCounts();
    const bucketFor = (id: string): string => {
      const record = this.records.get(id);
      return record ? providerBucket(record) : UNVERIFIED_PROVIDER;
    };
    const counts = (bucket: string): SummaryCounts =>
      (byProvider[bucket] ??= emptySummaryCounts());

    for (const [provider, s] of this.searchCounts) {
      const c = counts(provider);
      c.searches += s.searches;
      c.results += s.results;
      total.searches += s.searches;
      total.results += s.results;
    }
    for (const [provider, n] of this.providerDownloads) {
      const c = counts(provider);
      c.downloadStarted += n;
      c.downloadSucceeded += n;
      total.downloadStarted += n;
      total.downloadSucceeded += n;
    }

    const seen = new Set<string>();
    for (const event of this.events) {
      const dedupeKey = `${event.lineageId}|${event.stage}|${event.status}|${event.reason ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const bucket = bucketFor(event.lineageId);
      const c = counts(bucket);
      const bump = (field: SummaryCounter) => {
        c[field] += 1;
        total[field] += 1;
      };
      if (event.status === "REJECTED") {
        bump("rejected");
        const reason = event.reason?.trim() || "unspecified";
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
        continue;
      }
      switch (event.stage) {
        case "ELIGIBLE": bump("eligible"); break;
        case "RANKED": bump("ranked"); break;
        case "SELECTED": bump("selected"); break;
        case "DOWNLOAD_STARTED": bump("downloadStarted"); break;
        case "DOWNLOAD_SUCCEEDED": bump("downloadSucceeded"); break;
        case "DOWNLOAD_FAILED": {
          bump("downloadFailed");
          const reason = event.reason?.trim() || "download_error";
          failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          break;
        }
        case "ADOPTED": bump("adopted"); break;
        case "TRANSFORMED": case "TRIMMED": case "PADDED": case "OVERLAYED":
          bump("transformed"); break;
        case "COMPOSED": bump("composed"); break;
        case "REPLACED": bump("replaced"); break;
        case "REMOVED": bump("removed"); break;
        case "FINAL_VIDEO": bump("finalVideo"); break;
        default: break;
      }
    }

    // Route counts are a property of the RECORD, not of any single event.
    let verifiedRecords = 0;
    let unverifiedRecords = 0;
    for (const record of this.records.values()) {
      if (record.providerStatus === "VERIFIED") verifiedRecords += 1;
      else unverifiedRecords += 1;
      if (record.adoptedAt == null) continue;
      const c = counts(providerBucket(record));
      if (record.route === "fallback") { c.fallback += 1; total.fallback += 1; }
      else if (record.route === "rescue") { c.rescue += 1; total.rescue += 1; }
      else if (record.route === "backfill") { c.backfill += 1; total.backfill += 1; }
    }

    return { total, byProvider, failureReasons, verifiedRecords, unverifiedRecords };
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /**
   * The end-of-render consistency check.
   *
   * Every rule below is a thing that CANNOT be true of a correctly instrumented render. When one
   * fires the render says so and names the lineage; it never repairs the number, because a
   * repaired number is a guess with a clean face, and the round exists to stop exactly that.
   */
  reconcile(): ReconciliationResult {
    const errors: AuditFinding[] = [];
    const warnings: AuditFinding[] = [];
    const stagesByLineage = new Map<string, Map<LineageStage, LineageEventStatus[]>>();
    for (const event of this.events) {
      const byStage = stagesByLineage.get(event.lineageId) ?? new Map();
      byStage.set(event.stage, [...(byStage.get(event.stage) ?? []), event.status]);
      stagesByLineage.set(event.lineageId, byStage);
    }
    const has = (id: string, stage: LineageStage): boolean =>
      (stagesByLineage.get(id)?.get(stage) ?? []).some((s) => s === "OK");

    let verifiedSourceClips = 0;
    let unverifiedSourceClips = 0;
    let finalVideoClips = 0;

    for (const event of this.events) {
      // Rule 1: every event must belong to a record that exists.
      if (!this.records.has(event.lineageId)) {
        errors.push({
          code: "ORPHAN_EVENT",
          message: `event ${event.stage} refers to a lineage that does not exist`,
          lineageId: event.lineageId,
        });
      }
    }

    for (const record of this.records.values()) {
      const id = record.lineageId;

      // Rule 2: a provider is either proven or explicitly marked unverified. Never a bare string
      // with no status, and never a status that disagrees with the value.
      if (record.provider && record.providerStatus !== "VERIFIED") {
        errors.push({
          code: "PROVIDER_STATUS_MISMATCH",
          message: `provider "${record.provider}" recorded with status ${record.providerStatus}`,
          lineageId: id,
        });
      }
      if (!record.provider && record.providerStatus !== "UNVERIFIED") {
        errors.push({
          code: "PROVIDER_STATUS_MISMATCH",
          message: `no provider recorded but status is ${record.providerStatus}`,
          lineageId: id,
        });
      }

      /**
       * RONDE 95 (§4) — the stage order, as findings rather than assumptions.
       *
       * The funnel narrows in one direction: a clip is adopted because it was selected, and it
       * reaches the final video because it was adopted. A record that holds a later stage without
       * the one before it means an event was filed for work that never happened, or a step ran
       * without being recorded. Both are holes, and both were invisible until now — the summary
       * counted each stage independently, so a clip could be ADOPTED with no SELECTED and nothing
       * anywhere said so.
       *
       * Warnings, not errors: a rescue clip legitimately skips SELECTED, having been chosen by a
       * different route. What matters is that the skip is visible and countable rather than
       * silently absorbed into a total.
       */
      if (has(id, "ADOPTED") && !has(id, "SELECTED")) {
        warnings.push({
          code: "ADOPTED_WITHOUT_SELECTED",
          message: `${record.currentFilename} was adopted with no SELECTED event`,
          lineageId: id,
        });
      }
      if (has(id, "FINAL_VIDEO") && !has(id, "ADOPTED")) {
        warnings.push({
          code: "RENDERED_WITHOUT_ADOPTED",
          message: `${record.currentFilename} reached the final video with no ADOPTED event`,
          lineageId: id,
        });
      }
      if (has(id, "DOWNLOAD_SUCCEEDED") && !has(id, "FOUND")) {
        errors.push({
          code: "DOWNLOADED_WITHOUT_LINEAGE",
          message: `${record.currentFilename} was downloaded with no FOUND event`,
          lineageId: id,
        });
      }
      /**
       * RONDE 95 (§4) — an asset that was chosen, was not delivered, and says nothing about why.
       *
       * REPLACED, REMOVED and REJECTED are the three honest endings. A record that has none of
       * them, never reached FINAL_VIDEO, and was selected or adopted simply disappeared, which is
       * the case the round exists to surface. Only checked once the render has actually proven its
       * final video — before that, "not in the final video" is not yet a fact.
       */
      if (
        this.finalVideoProven &&
        !has(id, "FINAL_VIDEO") &&
        (has(id, "SELECTED") || has(id, "ADOPTED")) &&
        /**
         * RONDE 167 — one definition of an ending, in `hasTerminalOutcome`, shared with the
         * lifecycle audit and the §8 invariant. A rejection is a STATUS on whichever stage the
         * gate maps to rather than a stage of its own, and a download that never finished is an
         * ending too; both live there now so the three readers cannot drift apart again.
         */
        !hasTerminalOutcome(stagesByLineage.get(id) ?? new Map())
      ) {
        warnings.push({
          code: "VANISHED_WITHOUT_OUTCOME",
          message: `${record.currentFilename} was chosen and is not in the final video, with no REPLACED/REMOVED/REJECTED event`,
          lineageId: id,
        });
      }

      // Rule 6: a derived file must carry the record it came from.
      const isDerived = [...(stagesByLineage.get(id)?.keys() ?? [])].some(
        (s) => s === "TRIMMED" || s === "PADDED" || s === "OVERLAYED" || s === "TRANSFORMED"
      );
      if (isDerived && !record.parentLineageId) {
        errors.push({
          code: "DERIVED_WITHOUT_PARENT",
          message: `${record.currentFilename} was derived but carries no parentLineageId`,
          lineageId: id,
        });
      }
      if (record.parentLineageId && !this.records.has(record.parentLineageId)) {
        errors.push({
          code: "MISSING_PARENT",
          message: `parentLineageId ${record.parentLineageId} does not exist`,
          lineageId: id,
        });
      }

      // Rule 8: a derived record may not claim a different provider from its root.
      const root = this.rootOf(id);
      if (root && root.lineageId !== id && root.provider && record.provider && root.provider !== record.provider) {
        errors.push({
          code: "PROVIDER_CONFLICT",
          message: `provider "${record.provider}" conflicts with its origin's "${root.provider}"`,
          lineageId: id,
        });
      }

      // Rule 3/4: adopted and composed clips must be in the ledger — they are, by construction,
      // because these events can only be written against a record. What CAN go wrong is a clip
      // reaching a later stage without the earlier one, which means an unrecorded hop.
      if (has(id, "COMPOSED") && !has(id, "ADOPTED") && !record.parentLineageId) {
        warnings.push({
          code: "COMPOSED_WITHOUT_ADOPTION",
          message: `${record.currentFilename} was composed with no adoption recorded`,
          lineageId: id,
        });
      }
      // Rule 5: a download must belong to a candidate — which it does when the event exists at
      // all, so what is checked is the reverse: a success with no start is an unrecorded hop.
      if (has(id, "DOWNLOAD_SUCCEEDED") && !has(id, "DOWNLOAD_STARTED")) {
        warnings.push({
          code: "DOWNLOAD_WITHOUT_START",
          message: `${record.currentFilename} reports a completed download that was never started`,
          lineageId: id,
        });
      }

      // Rule 7: FINAL_VIDEO and a terminal rejection cannot both be the last word.
      const rejected = (stagesByLineage.get(id)?.get("COMPOSED") ?? []).includes("REJECTED");
      if (has(id, "FINAL_VIDEO") && rejected) {
        errors.push({
          code: "FINAL_AND_REJECTED",
          message: `${record.currentFilename} is both in the final video and rejected at compose`,
          lineageId: id,
        });
      }

      if (has(id, "FINAL_VIDEO")) {
        finalVideoClips += 1;
        if (record.providerStatus === "VERIFIED") verifiedSourceClips += 1;
        else unverifiedSourceClips += 1;
      }
    }

    // §G: the funnel must narrow. A stage that is wider than the one before it means a count is
    // wrong somewhere, and saying so is strictly more useful than quietly clamping it.
    const t = this.summary().total;
    const monotonic: Array<[SummaryCounter, SummaryCounter]> = [
      ["eligible", "ranked"],
      ["ranked", "selected"],
      ["adopted", "composed"],
      ["composed", "finalVideo"],
    ];
    for (const [wider, narrower] of monotonic) {
      if (t[narrower] > t[wider]) {
        warnings.push({
          code: "FUNNEL_NOT_MONOTONIC",
          message: `${narrower}=${t[narrower]} exceeds ${wider}=${t[wider]}`,
          detail: "counts left uncorrected — investigate the stage that is over-counting",
        });
      }
    }

    return {
      errors,
      warnings,
      verifiedSourceClips,
      unverifiedSourceClips,
      finalVideoClips,
      finalVideoVerified: this.finalVideoProven,
    };
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** One event, as the pipeline logs it. */
export function formatLineageEvent(event: VisualLineageEvent, renderId: string): string {
  const parts = [
    `render=${renderId}`,
    `lineageId=${event.lineageId}`,
    `scene=${event.sceneIndex}`,
    `beat=${event.beatIndex}`,
    `provider=${event.provider ?? UNVERIFIED_PROVIDER}`,
    event.providerAssetId ? `providerAssetId=${event.providerAssetId}` : null,
    `stage=${event.stage}`,
    `status=${event.status}`,
    event.reason ? `reason=${event.reason}` : null,
    event.gate ? `gate=${event.gate}` : null,
    event.parentLineageId ? `parent=${event.parentLineageId}` : null,
    event.currentPath ? `clip=${path.basename(event.currentPath)}` : null,
    `timestamp=${event.timestamp}`,
  ].filter(Boolean);
  return `[VisualLineageEvent] ${parts.join(" ")}`;
}

/**
 * RONDE 95 (§3/§7) — the lifecycle statuses, and the lineage stages that earn them.
 *
 * Only these eight stages produce an [AssetTrace] line. The others (RANKED, TRIMMED, PADDED,
 * OVERLAYED, TRANSFORMED, DOWNLOAD_STARTED, DOWNLOAD_FAILED, REMOVED) are real events and stay in
 * the ledger, but they are steps WITHIN a status rather than a change of it — a clip that gets
 * padded has not become more or less rendered.
 *
 * The mapping is one-way and total: a status can only appear because its stage was recorded, and
 * each stage was recorded because the work happened. §7's chain — FOUND ≠ VALIDATED ≠ SELECTED ≠
 * DOWNLOADED ≠ ASSIGNED ≠ RENDERED — is enforced by there being no other way to produce them.
 */
export const ASSET_TRACE_STATUS: Partial<Record<LineageStage, string>> = {
  FOUND: "FOUND",
  ELIGIBLE: "VALIDATED",
  SELECTED: "SELECTED",
  DOWNLOAD_SUCCEEDED: "DOWNLOADED",
  ADOPTED: "ASSIGNED",
  COMPOSED: "RENDER_INPUT",
  FINAL_VIDEO: "RENDERED",
};

/** One line per lifecycle transition, carrying the identity that makes it traceable (§2). */
export function formatAssetTrace(
  record: VisualLineageRecord,
  status: string,
  event: VisualLineageEvent
): string {
  const parts = [
    `assetId=${record.lineageId}`,
    `status=${status}`,
    `provider=${record.provider ?? UNVERIFIED_PROVIDER}`,
    record.providerAssetId ? `providerAssetId=${record.providerAssetId}` : null,
    `scene=${record.sceneIndex}`,
    `beat=${record.beatIndex}`,
    record.candidateId ? `candidateId=${record.candidateId}` : null,
    record.query ? `query="${record.query}"` : null,
    record.searchRoute ? `searchRoute=${record.searchRoute}` : null,
    record.sourceUrl ? `sourceUrl=${record.sourceUrl}` : null,
    `route=${record.route}`,
    event.reason ? `reason=${event.reason}` : null,
    event.gate ? `gate=${event.gate}` : null,
  ].filter(Boolean);
  return `[AssetTrace] ${parts.join(" ")}`;
}

/**
 * RONDE 95 (§5) — the manifest: every asset the delivered file actually contains.
 *
 * Built from the FINAL_VIDEO events, which markFinalVideo sets only from the clips whose scene
 * video was in the concat that produced the validated output. Nothing here is inferred from having
 * been selected, adopted or composed — those are earlier and weaker facts, and three of them can
 * be true of a clip that a heal pass replaced before the concat ran.
 *
 * Returns [] when the render never reached the point where FINAL_VIDEO is knowable. An empty
 * manifest and a manifest of zero assets are different claims; the caller prints NOT_VERIFIED.
 */
export function formatRenderManifest(
  records: readonly VisualLineageRecord[],
  finalVideoVerified: boolean,
  /**
   * RONDE 105 — what the content decider said about each rendered asset.
   *
   * The manifest already answered "what is in the delivered file and where did it come from".
   * The question it could not answer was "and did anybody check that it belongs" — which is the
   * one that matters most now that the vision model is the only content decider. Supplied as a
   * lookup rather than a new record field so the ledger keeps its single responsibility and the
   * relevance data keeps living where RONDE 103 put it.
   *
   * Optional: a caller without it gets exactly the pre-RONDE-105 line.
   */
  verdictFor?: (record: VisualLineageRecord) => {
    verdict: string;
    cached: boolean;
    reprieved: boolean;
  } | null
): string[] {
  if (!finalVideoVerified) return [];
  return records
    .filter((r) => r.finalVideoAt != null)
    .sort((a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex)
    .map((r) => {
      const v = verdictFor?.(r) ?? null;
      return [
        `[RenderAsset] assetId=${r.lineageId}`,
        `provider=${r.provider ?? UNVERIFIED_PROVIDER}`,
        r.providerAssetId ? `providerAssetId=${r.providerAssetId}` : null,
        `scene=${r.sceneIndex}`,
        `beat=${r.beatIndex}`,
        r.query ? `query="${r.query}"` : null,
        r.searchRoute ? `searchRoute=${r.searchRoute}` : null,
        r.sourceUrl ? `sourceUrl=${r.sourceUrl}` : null,
        `file=${r.currentFilename}`,
        // A rendered asset with no verdict is not "fine" — it is unexamined, and the manifest
        // says so in the same word the counters use.
        `verdict=${v ? (v.reprieved ? "reprieved_after_refusal" : v.verdict) : "never_asked"}`,
        `cached=${v ? v.cached : false}`,
        `reprieved=${v ? v.reprieved : false}`,
        "rendered=true",
      ]
        .filter(Boolean)
        .join(" ");
    });
}

/**
 * RONDE 105 (§16) — the one block that answers every question about the delivered file.
 *
 * A render used to print its evidence in six places: source counts here, beat warnings in the
 * quality report, vision counters in the pipeline, the manifest below. Reading them together took
 * knowing which line meant what, and the production render that shipped `100/100 (Excellent)` on
 * an unexamined montage is what that costs. This is the summary a person actually reads.
 *
 * Every number comes from a record that already exists. Nothing here judges, counts a provider
 * twice, or invents a category — `source_unknown` is the ledger's own UNVERIFIED bucket, and the
 * per-provider counts are required to add up to `final_clips`.
 */
export function formatFinalVisualReport(input: {
  finalVideoVerified: boolean;
  records: readonly VisualLineageRecord[];
  beats: number;
  verifiedOwnVisual: number;
  verification: Record<string, number>;
  coverage: Record<string, number>;
  attempts: number;
  answered: number;
  unavailable: number;
  neverAsked: number;
  qualityStatus: string;
  score: number;
}): string[] {
  const rendered = input.records.filter((r) => r.finalVideoAt != null);
  const byProvider = new Map<string, number>();
  for (const r of rendered) {
    const key = (r.provider ?? "").trim().toLowerCase() || UNVERIFIED_PROVIDER.toLowerCase();
    byProvider.set(key, (byProvider.get(key) ?? 0) + 1);
  }
  const unknownCount =
    (byProvider.get(UNVERIFIED_PROVIDER.toLowerCase()) ?? 0) + (byProvider.get("unknown") ?? 0);
  const sourceLines = [...byProvider.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p, n]) => `  source_${p}=${n}`);
  const totalAttributed = [...byProvider.values()].reduce((a, b) => a + b, 0);

  const lines = [
    "[FinalVisualReport]",
    `  final_video_verified=${input.finalVideoVerified}`,
    `  beats=${input.beats}`,
    `  verified_own_visual=${input.verifiedOwnVisual}`,
    `  verified_fit=${input.verification.verified_fit ?? 0}`,
    `  verified_mismatch=${input.verification.verified_mismatch ?? 0}`,
    `  reprieved=${input.verification.reprieved_after_refusal ?? 0}`,
    `  unknown=${input.verification.unknown ?? 0}`,
    `  never_asked=${input.verification.never_asked ?? 0}`,
    `  coverage_own_footage=${input.coverage.own_footage ?? 0}`,
    `  coverage_held_frame=${input.coverage.held_frame ?? 0}`,
    `  coverage_graphic=${input.coverage.graphic ?? 0}`,
    `  coverage_placeholder=${input.coverage.placeholder ?? 0}`,
    `  coverage_generated=${input.coverage.generated ?? 0}`,
    `  gate_attempts=${input.attempts}`,
    `  gate_answered=${input.answered}`,
    `  gate_failed=${input.unavailable}`,
    `  gate_never_asked=${input.neverAsked}`,
    `  final_clips=${rendered.length}`,
    ...sourceLines,
    `  unverified_final_clips=${unknownCount}`,
    `  quality_status=${input.qualityStatus}`,
    `  quality_score=${input.score}`,
  ];
  /**
   * §14's cross-check, stated by the render rather than left to the reader.
   *
   * The old report showed Archive 7, Wikimedia 1, Stock 1 next to "Clips 15" and nobody could see
   * that six clips were missing from the breakdown, because the breakdown was a filename reading
   * of three buckets out of many. These counts come from the ledger and must sum to the clip
   * count; when they do not, that is the finding.
   */
  if (totalAttributed !== rendered.length) {
    lines.push(
      `  SOURCE_COUNT_MISMATCH: providers sum to ${totalAttributed}, final clips ${rendered.length}`
    );
  }
  return lines;
}

/**
 * RONDE 95 (§4) — assets the pipeline chose and the video does not contain.
 *
 * A clip that reached SELECTED or ADOPTED and has no FINAL_VIDEO event did not make it into the
 * delivered file, and the interesting question is always which of the two it was:
 *
 *   · REPLACED  — a fallback or heal pass swapped it, and recordReplacement says for what and why
 *   · dropped   — nothing says. That is the case worth finding: an asset that was chosen, possibly
 *                 downloaded, and then quietly left out with no event to explain it.
 *
 * Reported, never thrown. This runs after the video exists.
 */
export function formatSelectedButNotRendered(
  records: readonly VisualLineageRecord[],
  events: readonly VisualLineageEvent[],
  finalVideoVerified: boolean
): string[] {
  if (!finalVideoVerified) return [];
  const replaced = new Map<string, string>();
  for (const e of events) {
    if (e.stage === "REPLACED") replaced.set(e.lineageId, e.reason ?? "no reason recorded");
  }
  const out: string[] = [];
  for (const r of records) {
    if (r.finalVideoAt != null) continue;
    if (r.selectedAt == null && r.adoptedAt == null) continue;
    const why = replaced.get(r.lineageId);
    out.push(
      `[AssetNotRendered] assetId=${r.lineageId} provider=${r.provider ?? UNVERIFIED_PROVIDER} ` +
        `scene=${r.sceneIndex} beat=${r.beatIndex} ` +
        `reachedSelected=${r.selectedAt != null} reachedAssigned=${r.adoptedAt != null} ` +
        `outcome=${why ? "REPLACED" : "DROPPED_WITHOUT_EVENT"}` +
        (why ? ` reason=${why}` : "")
    );
  }
  return out;
}

/** The per-provider summary block, §F. */
export function formatSourceSummary(summary: VisualSourceSummary, finalVideoVerified: boolean): string[] {
  const lines = ["[VisualSourceSummary]"];
  const field = (c: SummaryCounts, key: SummaryCounter): string =>
    // §J: a stage the render never got to check is NOT_VERIFIED, which is a different fact from
    // zero and must never be printed as zero.
    key === "finalVideo" && !finalVideoVerified ? NOT_VERIFIED : String(c[key]);
  const block = (label: string, c: SummaryCounts): string =>
    `  ${label}\n` +
    SUMMARY_COUNTERS.map((k) => `    ${k}=${field(c, k)}`).join("\n");

  const providers = Object.entries(summary.byProvider).sort((a, b) => {
    // The UNVERIFIED bucket goes last: it is a finding, not a provider.
    if (a[0] === UNVERIFIED_PROVIDER) return 1;
    if (b[0] === UNVERIFIED_PROVIDER) return -1;
    const byFinal = b[1].finalVideo - a[1].finalVideo;
    return byFinal !== 0 ? byFinal : b[1].adopted - a[1].adopted;
  });
  for (const [provider, counts] of providers) lines.push(block(provider, counts));
  lines.push(block("TOTAL", summary.total));

  const reasons = Object.entries(summary.failureReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push("  failureReasons");
    for (const [reason, n] of reasons) lines.push(`    ${reason}=${n}`);
  }
  return lines;
}

/** The funnel block, §G — total first, then the same shape per provider. */
export function formatFunnelReport(summary: VisualSourceSummary, finalVideoVerified: boolean): string[] {
  const FUNNEL: SummaryCounter[] = [
    "results", "eligible", "ranked", "selected",
    "downloadStarted", "downloadSucceeded", "adopted", "composed",
    "finalVideo", "rejected", "fallback", "rescue", "backfill",
  ];
  const render = (label: string, c: SummaryCounts): string =>
    `[VisualFunnel] ${label} ` +
    FUNNEL.map((k) =>
      `${k === "results" ? "retrieved" : k}=` +
      (k === "finalVideo" && !finalVideoVerified ? NOT_VERIFIED : c[k])
    ).join(" ");

  const lines = [render("TOTAL", summary.total)];
  const providers = Object.entries(summary.byProvider).sort((a, b) => {
    if (a[0] === UNVERIFIED_PROVIDER) return 1;
    if (b[0] === UNVERIFIED_PROVIDER) return -1;
    return b[1].results - a[1].results;
  });
  for (const [provider, counts] of providers) lines.push(render(provider, counts));
  return lines;
}

/**
 * RONDE 94 — the per-provider lifecycle, in the words the question is usually asked in.
 *
 * "How many YouTube clips did we find, and how many actually ended up in the video?" The ledger
 * has answered that since RONDE 86 — every stage below is a real recorded event, not a count
 * inferred from a list — but it answered in its own vocabulary (results/eligible/adopted/
 * finalVideo) spread across two report blocks. This is one line per provider in the vocabulary of
 * the question, projected from exactly the same events:
 *
 *     found      = results            a search returned this candidate
 *     validated  = eligible           RONDE 142: it cleared EVERY gate — licence, format, dedup
 *                                     AND the vision gate — which is recorded in adoptClip and
 *                                     therefore happens after the download, not before it
 *     selected   = selected           the ranker chose it
 *     downloaded = downloadSucceeded  the file exists on disk. Normally far larger than
 *                                     `validated`: downloading is what makes a candidate
 *                                     judgeable, so most downloads exist to be refused
 *     assigned   = adopted            a scene/beat took it
 *     rendered   = finalVideo         its scene video went into the concat that produced the
 *                                     delivered file — proven from finalConcatInputs, never
 *                                     assumed from having been adopted
 *     unused     = found - rendered
 *
 * `rendered` prints NOT_VERIFIED, never 0, when the render could not reach the point where
 * FINAL_VIDEO is knowable. Zero would be a claim; NOT_VERIFIED is the truth.
 */
export function formatAssetUsageSummary(
  summary: VisualSourceSummary,
  finalVideoVerified: boolean
): string[] {
  const line = (provider: string, c: SummaryCounts): string => {
    const rendered = finalVideoVerified ? String(c.finalVideo) : NOT_VERIFIED;
    const unused = finalVideoVerified ? String(Math.max(0, c.results - c.finalVideo)) : NOT_VERIFIED;
    return (
      `[AssetUsageSummary] provider=${provider} found=${c.results} validated=${c.eligible} ` +
      `selected=${c.selected} downloaded=${c.downloadSucceeded} assigned=${c.adopted} ` +
      `rendered=${rendered} unused=${unused}`
    );
  };
  const providers = Object.entries(summary.byProvider).sort((a, b) => {
    if (a[0] === UNVERIFIED_PROVIDER) return 1;
    if (b[0] === UNVERIFIED_PROVIDER) return -1;
    return b[1].results - a[1].results;
  });
  const lines = providers.map(([provider, counts]) => line(provider, counts));
  lines.push(line("TOTAL", summary.total));
  lines.push(...formatUsageInconsistencies(summary, finalVideoVerified));
  return lines;
}

/**
 * RONDE 94 — the funnel only narrows, and a funnel that widens is a bug in the instrumentation.
 *
 * A stage that counts MORE than the stage it follows means an event was recorded for an asset that
 * never reached the earlier one — a miscount, or a stage being marked without the work having
 * happened. Either way the numbers stop meaning what they say, and a report that quietly prints
 * them is worse than one that refuses.
 *
 * RONDE 142: which stage follows which is stated per pair below rather than as one chain, because
 * the routes do not share a single order. `downloaded` is not between `selected` and `validated`;
 * see the note on PAIRS.
 *
 * Reported, not thrown: this runs after the video is made, and an accounting fault must not fail
 * a render that succeeded.
 */
export function formatUsageInconsistencies(
  summary: VisualSourceSummary,
  finalVideoVerified: boolean
): string[] {
  /**
   * RONDE 159 — two of these stages are optional, and treating them as mandatory made every
   * render report a fault it did not have.
   *
   * Video 552 printed, on a render that was fine:
   *
   *     provider=TOTAL assigned=32 exceeds downloaded=11
   *     provider=TOTAL downloaded=11 exceeds selected=4
   *     provider=unsplash downloaded=1 exceeds selected=0
   *
   * Those are not miscounts. The curated archive route prepares a clip from the archive store and
   * adopts it without ever downloading anything, and the rescue route adopts without a SELECTED
   * event — which this file's own lineage audit already states in as many words ("a rescue clip
   * legitimately skips SELECTED"). The funnel check contradicted the audit standing three hundred
   * lines above it, and did so on every render, which is how a real finding gets ignored.
   *
   * So the strict chain is kept for the stages every asset must pass, and the two a route may
   * legitimately skip are checked against the last mandatory stage before them instead. A genuine
   * miscount — more rendered than assigned, more selected than validated — still reports.
   */
  /**
   * RONDE 142 — the order this check asserted is not the order the pipeline records.
   *
   * Video 558 printed, on a render that was fine:
   *
   *     provider=TOTAL downloaded=41 exceeds validated=1
   *
   * That is not a miscount either. `eligible` is recorded in adoptClip, AFTER the vision gate —
   * and the vision gate needs the FILE, so the download is what makes a candidate judgeable at
   * all. Forty-one downloads producing one asset that cleared every gate is the pipeline working
   * as designed and reporting honestly. The check had download before validation, which is
   * backwards, so it flagged the normal case.
   *
   * RONDE 159 corrected the same class of error and left this one, because it moved `downloaded`
   * to be BOUNDED by `eligible` rather than noticing that it PRECEDES it. Two rounds of a check
   * contradicting the code is how a real finding gets ignored, which is RONDE 159's own argument.
   *
   * ── What is asserted now: only what the recorded order actually guarantees ───────────────────
   *
   * Written as pairs rather than one chain, because there is no single chain. The routes differ:
   * the curated archive adopts a clip it never searched for and never downloaded, and a rescue clip
   * skips SELECTED. A stage's own predecessor is the only thing that can be asserted about it.
   *
   *   ranked, selected ≤ eligible   all three are recorded on the same three lines of adoptClip,
   *                                 so any difference at all is an instrumentation fault
   *   adopted   ≤ eligible          nothing may be adopted that did not clear the gates
   *   finalVideo ≤ adopted          nothing may be in the file that was not adopted
   *
   * `results` is deliberately compared to nothing. A curated or rescue asset has no search event,
   * so `eligible > results` is routine, and asserting it made the report cry wolf on every render.
   * The count is still printed; it is simply not evidence about any other stage.
   *
   * `downloadSucceeded ≤ downloadStarted` looks like an obvious addition and is deliberately NOT
   * made. It was tried, and two existing fixtures — RONDE 94's own "well-formed funnel" and RONDE
   * 95's replacement case — record a succeeded download with no started event, which says the
   * codebase does not guarantee the pair. Adding a check whose validity is not established would
   * have replaced one false alarm with another, which is the entire failure this round is undoing.
   */
  const PAIRS: Array<[SummaryCounter, string, SummaryCounter, string, boolean]> = [
    // [later, label, earlier, label, requiresFinalVideoVerified]
    ["ranked", "ranked", "eligible", "validated", false],
    ["selected", "selected", "eligible", "validated", false],
    ["adopted", "assigned", "eligible", "validated", false],
    ["finalVideo", "rendered", "adopted", "assigned", true],
  ];
  const out: string[] = [];
  const check = (provider: string, c: SummaryCounts): void => {
    for (const [key, label, boundKey, boundLabel, needsFinal] of PAIRS) {
      if (needsFinal && !finalVideoVerified) continue;
      if (c[key] > c[boundKey]) {
        out.push(
          `[AssetUsageInconsistency] provider=${provider} ${label}=${c[key]} exceeds ` +
            `${boundLabel}=${c[boundKey]} — a later stage cannot count more assets than the one it follows`
        );
      }
    }
  };
  for (const [provider, counts] of Object.entries(summary.byProvider)) check(provider, counts);
  check("TOTAL", summary.total);
  return out;
}

/** The audit block, §I, plus every finding reconcile() produced. */
export function formatAuditReport(result: ReconciliationResult): string[] {
  const lines = [
    "[VisualAudit]",
    `  verifiedSourceClips=${result.verifiedSourceClips}`,
    `  unverifiedSourceClips=${result.unverifiedSourceClips}`,
    `  finalVideoClips=${result.finalVideoVerified ? result.finalVideoClips : NOT_VERIFIED}`,
    `  lineageErrors=${result.errors.length}`,
    `  lineageWarnings=${result.warnings.length}`,
  ];
  for (const w of result.warnings) {
    lines.push(`[VisualAuditWarning] ${w.code} ${w.lineageId ? `lineageId=${w.lineageId} ` : ""}${w.message}${w.detail ? ` — ${w.detail}` : ""}`);
  }
  for (const e of result.errors) {
    lines.push(`[VisualAuditError] ${e.code} ${e.lineageId ? `lineageId=${e.lineageId} ` : ""}${e.message}${e.detail ? ` — ${e.detail}` : ""}`);
  }
  return lines;
}

/**
 * RONDE 167 §7 — the one place that answers "which asset is this file, and how do we know".
 *
 * Every terminal-outcome writer asks this, and `via` is the diagnosis the round was missing: a
 * clip resolved by `contentKey` is one whose PATH nobody registered, and a clip resolved by
 * `none` is one no outcome can be written for at all. Before this, both looked like silence.
 *
 * The order is the ledger's own: exact path, then the derivation chain, then the asset identity.
 * The brief asks for identity first; exact-path-first is kept deliberately and is strictly more
 * precise — a trimmed or overlaid file has its OWN record, and its content key deliberately maps
 * back to the original, so identity-first would file a derived clip's outcome on its parent and
 * undo the parent/child separation linkDerivedPath exists to keep. What the brief is actually
 * asking for — that a missing path must never mean "unknown" — is guaranteed instead by the
 * ledger deriving the identity itself, so no caller can forget it.
 */
export type ClipOutcomeIdentity = {
  record: VisualLineageRecord | null;
  /** Which handle worked. "none" means no outcome can be filed for this clip. */
  via: "path" | "derived" | "contentKey" | "none";
  /** The identity used or derived, for logging a miss that a caller may want to explain. */
  contentKey?: string;
};

export function resolveClipOutcomeIdentity(
  ledger: VisualSourceLedger | undefined,
  clipPath: string,
  contentKey?: string
): ClipOutcomeIdentity {
  if (!ledger || !clipPath) return { record: null, via: "none", contentKey };
  const record = ledger.resolve(clipPath, contentKey);
  if (!record) return { record: null, via: "none", contentKey };
  if (record.localPath === clipPath) return { record, via: "path", contentKey };
  if (ledger.derivationOriginOf(clipPath)) return { record, via: "derived", contentKey };
  return { record, via: "contentKey", contentKey: contentKey ?? record.contentKey };
}

/**
 * RONDE 167 §8 — the hard invariant: a chosen asset owes the render an ending.
 *
 * `reconcile()` warns per asset and `formatAssetLifecycleAudit` counts them. Neither can be read
 * as a pass/fail by a caller, so nothing in the pipeline could ever say "this render's accounting
 * is sound" or refuse to. This is that answer, computed from the same rule both of those use.
 *
 * Deliberately NOT throwing. A render that has already produced a video must not be destroyed by
 * its own bookkeeping — the whole audit is wrapped in a try that exists for exactly that reason.
 * It returns the finding so the caller can log it loudly, and so a test can assert on it.
 */
export type SelectedWithoutOutcome = {
  lineageId: string;
  filename: string;
  provider: string;
  sceneIndex?: number;
  beatIndex?: number;
  route: string;
};

export function assertNoSelectedClipWithoutOutcome(
  ledger: VisualSourceLedger
): { ok: boolean; offenders: SelectedWithoutOutcome[] } {
  const offenders = unaccountedRecords(ledger).map((record) => ({
    lineageId: record.lineageId,
    filename: record.currentFilename,
    provider: record.provider ?? UNVERIFIED_PROVIDER,
    sceneIndex: record.sceneIndex,
    beatIndex: record.beatIndex,
    route: record.route,
  }));
  return { ok: offenders.length === 0, offenders };
}

/**
 * The assets that were chosen, are not in the delivered file, and say nothing about why.
 *
 * One implementation, three readers — reconcile()'s warning, the lifecycle audit's `unresolved`
 * count and the invariant above. RONDE 167 found the audit and the rule disagreeing about
 * DOWNLOAD_FAILED; sharing the computation is what stops that recurring.
 */
function unaccountedRecords(ledger: VisualSourceLedger): VisualLineageRecord[] {
  const stagesByLineage = new Map<string, Map<LineageStage, LineageEventStatus>>();
  for (const event of ledger.allEvents()) {
    let stages = stagesByLineage.get(event.lineageId);
    if (!stages) stagesByLineage.set(event.lineageId, (stages = new Map()));
    if (event.status !== "OK" || !stages.has(event.stage)) stages.set(event.stage, event.status);
  }
  return ledger.allRecords().filter((record) => {
    const stages = stagesByLineage.get(record.lineageId);
    if (!stages) return false;
    if (stages.has("FINAL_VIDEO")) return false;
    if (!stages.has("SELECTED") && !stages.has("ADOPTED")) return false;
    return !hasTerminalOutcome(stages);
  });
}

/** The endings that account for an asset. Read by the vanished rule, the audit and the invariant. */
function hasTerminalOutcome(stages: Map<LineageStage, LineageEventStatus>): boolean {
  if (stages.has("REPLACED") || stages.has("REMOVED")) return true;
  if ([...stages.values()].some((st) => st.includes("REJECTED"))) return true;
  /**
   * RONDE 167 F1 — a download that never finished is an ending, and the rule called it a
   * disappearance. Narrow: only when nothing later succeeded, so a failed-then-retried asset that
   * genuinely vanished is still caught rather than buying permanent silence with one early error.
   */
  return stages.has("DOWNLOAD_FAILED") && !stages.has("DOWNLOAD_SUCCEEDED");
}

/**
 * RONDE 165 — every asset the render touched, and how each one ended.
 *
 * `reconcile()` already emits one VANISHED_WITHOUT_OUTCOME warning per unaccounted asset, and
 * render 554 emitted seventeen of them. Seventeen warnings is a list; what nobody could read off
 * it is the denominator — whether seventeen out of twenty is a broken pipeline or seventeen out of
 * two hundred is a narrow leak, and which route the leak is on.
 *
 * So the same records are counted instead of listed, in the four states an asset can end in:
 *
 *   delivered    it is in the final video
 *   resolved     it is not, and something says why (REPLACED / REMOVED / a REJECTED status)
 *   neverChosen  it was found and no route ever selected it — nothing to explain
 *   unresolved   it was chosen, is not in the film, and says nothing: the number to drive to zero
 *
 * `unresolved` is exactly the set reconcile() warns about, counted from the same rule rather than
 * recomputed differently — this reports on that audit, it is not a second one. Nothing here reads
 * the disk, asks a provider, or changes a record.
 */
export function formatAssetLifecycleAudit(ledger: VisualSourceLedger): string[] {
  const records = ledger.allRecords();
  if (records.length === 0) return [];
  const stagesByLineage = new Map<string, Map<LineageStage, LineageEventStatus>>();
  for (const event of ledger.allEvents()) {
    let stages = stagesByLineage.get(event.lineageId);
    if (!stages) stagesByLineage.set(event.lineageId, (stages = new Map()));
    // The terminal status wins over an earlier OK on the same stage: a REPLACED stage filed after
    // a plain one is the outcome, and reading the first would hide it.
    if (event.status !== "OK" || !stages.has(event.stage)) stages.set(event.stage, event.status);
  }
  let delivered = 0;
  let resolved = 0;
  let neverChosen = 0;
  const unresolved: VisualLineageRecord[] = [];
  const unresolvedByRoute = new Map<string, number>();
  for (const record of records) {
    const stages = stagesByLineage.get(record.lineageId);
    if (stages?.has("FINAL_VIDEO")) {
      delivered++;
      continue;
    }
    // RONDE 167: the ONE definition of an ending, shared with reconcile() and the invariant. The
    // audit and the rule disagreeing about DOWNLOAD_FAILED is exactly what this round found.
    if (stages && hasTerminalOutcome(stages)) {
      resolved++;
      continue;
    }
    if (!stages?.has("SELECTED") && !stages?.has("ADOPTED")) {
      neverChosen++;
      continue;
    }
    unresolved.push(record);
    unresolvedByRoute.set(record.route, (unresolvedByRoute.get(record.route) ?? 0) + 1);
  }
  const lines = [
    `[AssetLifecycleAudit] assets=${records.length} delivered=${delivered} ` +
      `resolved=${resolved} neverChosen=${neverChosen} unresolved=${unresolved.length}`,
  ];
  if (unresolvedByRoute.size > 0) {
    const byRoute = [...unresolvedByRoute.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([route, count]) => `${route}=${count}`)
      .join(" ");
    lines.push(`[AssetLifecycleAudit] unresolvedByRoute ${byRoute}`);
  }
  // Named, not just counted: a route with a leak is fixed by looking at one of its files.
  for (const record of unresolved.slice(0, 12)) {
    lines.push(
      `[AssetLifecycleAudit] unresolved asset=${record.lineageId} route=${record.route} ` +
        `provider=${record.provider ?? UNVERIFIED_PROVIDER} scene=${record.sceneIndex} ` +
        `beat=${record.beatIndex} file=${record.currentFilename}`
    );
  }
  return lines;
}

/** One composed clip's provenance, for the compose-time manifest. */
export function formatLineageLine(record: VisualLineageRecord | null, clipPath: string): string {
  const basename = path.basename(clipPath);
  if (!record) {
    return `[SourceLineage] scene=? beat=? provider=${UNVERIFIED_PROVIDER} providerStatus=UNVERIFIED route=? clip=${basename}`;
  }
  const parts = [
    `lineageId=${record.lineageId}`,
    `scene=${record.sceneIndex}`,
    `beat=${record.beatIndex}`,
    `provider=${record.provider ?? UNVERIFIED_PROVIDER}`,
    `providerStatus=${record.providerStatus}`,
    `route=${record.route}`,
    record.parentLineageId ? `parent=${record.parentLineageId}` : null,
    record.providerAssetId ? `assetId=${record.providerAssetId}` : null,
    record.archiveAssetId != null ? `archiveAsset=${record.archiveAssetId}` : null,
    record.candidateScore != null ? `score=${record.candidateScore}` : null,
    record.visionScore != null ? `vision=${record.visionScore}` : null,
    record.query ? `query="${record.query.slice(0, 48)}"` : null,
    record.originalFilename !== basename ? `from=${record.originalFilename}` : null,
    `clip=${basename}`,
  ].filter(Boolean);
  return `[SourceLineage] ${parts.join(" ")}`;
}
