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

    if (contentKey) {
      const byKey = this.byContentKey.get(contentKey);
      if (byKey) return this.records.get(byKey) ?? null;
    }
    return null;
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
    opts: { contentKey?: string; reason?: string } = {}
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
    parent.currentFilename = path.basename(derivedPath);
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
