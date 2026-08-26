/**
 * RONDE 86 — where every picture in the finished video actually came from.
 *
 * Until this module existed, a clip's provenance lived in exactly one place: its filename.
 * `inferClipSourceFromPath` read a provider out of `__pid_<provider>-<sha>` or guessed from a
 * dozen naming conventions, and `videoQualityReport` counted sources by running that guess over
 * the final clip list. That works right up to the first rename — and the compose path renames
 * constantly: `_still` is appended when a photograph becomes a clip, `_transformed` by the
 * transform step, and `padShortClipWithNext` republishes two clips as a brand-new
 * `pad_combined_sNbM_<ts>.mp4` that carries no tag at all.
 *
 * Render 536 shipped 66 clips. 27 of them reported source=unknown. Every one had been adopted
 * from a named provider and had its adoption recorded; the recording just could not be found
 * again, because the name it was recorded under no longer existed on disk.
 *
 * The ledger below is the source of truth instead. A clip is recorded once when it is selected
 * and again when it is adopted, and every derived path — trim, pad, overlay, transform — is
 * LINKED to the path it came from. Lookup then walks: exact path → derivation chain → content
 * key → basename. A rename anywhere in that chain costs nothing, because the chain is what is
 * followed, not the name.
 *
 * The second half of the module is the retrieval funnel counter. Render 536's real numbers were
 * 2671 candidates retrieved, 39 downloaded, 67 adopted, 66 composed — a 98.5% loss before the
 * download step that no counter anywhere could attribute to a stage or a provider. Every stage
 * of that funnel now has a name and a number, per provider and in total.
 *
 * Deliberately dependency-free: no DB, no filesystem, no imports from videoPipeline (which
 * imports this file, so the reverse would be a cycle). Everything here is plain in-memory data
 * with a per-render lifetime, exactly like VisualDedupState's other maps.
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

/** Everything known about one clip's origin. Only `localPath` and `provider` are ever required. */
export type VisualLineageRecord = {
  /** The DB row this render is producing, when the pipeline was given one. */
  videoId?: number;
  /** Identifies this render even when videoId is absent (a retry re-uses the videoId). */
  renderId: string;
  sceneIndex: number;
  beatIndex: number;
  /** The candidate's identity at selection time — provider asset key, archive row, or content key. */
  candidateId: string;
  /** clipContentKey(localPath) as the caller computed it. */
  contentKey: string;
  provider: string;
  providerAssetId?: string;
  /** The URL the bytes were fetched from. */
  sourceUrl?: string;
  /** The provider's canonical page for the asset, when it differs from sourceUrl. */
  originalUrl?: string;
  localPath: string;
  originalFilename: string;
  /** Updated by linkDerivedPath as the clip is trimmed, padded and overlaid. */
  finalFilename: string;
  mediaType: VisualLineageMediaType;
  /** The query that produced this candidate. */
  query?: string;
  /** The retrieval/ranking score it won on. */
  score?: number;
  /** Vision-gate verdict at adoption, 0–10. */
  visionScore10?: number;
  /** Curated-archive row id, when the clip came from the own archive. */
  archiveAssetId?: number;
  assetTitle?: string;
  selectedAt: number;
  adoptedAt?: number;
  route: VisualLineageRoute;
  /** The adopt-audit source label, so lineage and clipAdoptAudit report the same word. */
  sourceLabel?: string;
};

export type RecordSelectionInput = Omit<
  VisualLineageRecord,
  "originalFilename" | "finalFilename" | "selectedAt" | "adoptedAt"
> & { selectedAt?: number };

/** The funnel stages, in the order a candidate passes through them. */
export const FUNNEL_STAGES = [
  "retrieved",
  "eligible",
  "ranked",
  "selected",
  "downloaded",
  "adopted",
  "composed",
  "rejected",
  "fallback",
  "rescue",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type FunnelStageCounts = Record<FunnelStage, number>;

export function emptyFunnelCounts(): FunnelStageCounts {
  const out = {} as FunnelStageCounts;
  for (const stage of FUNNEL_STAGES) out[stage] = 0;
  return out;
}

export type FunnelSummary = {
  total: FunnelStageCounts;
  byProvider: Record<string, FunnelStageCounts>;
  /** Rejections broken down by the gate that produced them. */
  rejectReasons: Record<string, number>;
};

/** Providers are compared case-insensitively and stored trimmed — "Pexels" and "pexels" are one. */
function normalizeProvider(provider: string | undefined | null): string {
  const p = (provider ?? "").trim().toLowerCase();
  return p || "unknown";
}

/**
 * A per-render ledger of clip provenance plus the retrieval funnel counters.
 *
 * One instance per render, hung off VisualDedupState, discarded with it. Nothing here throws:
 * every method is safe to call on the hot path with partial information, because a missing
 * lineage entry must degrade the REPORT, never the render.
 */
export class VisualSourceLedger {
  readonly renderId: string;
  readonly videoId?: number;

  /** localPath → record. The authoritative index. */
  private readonly byPath = new Map<string, VisualLineageRecord>();
  /** contentKey → record, for a path that was renamed without being linked. */
  private readonly byContentKey = new Map<string, VisualLineageRecord>();
  /** basename → record. Last-resort index, and the only one the old code ever had. */
  private readonly byBasename = new Map<string, VisualLineageRecord>();
  /** derived path → the path it was produced from. Walked by resolve(). */
  private readonly derivedFrom = new Map<string, string>();

  private readonly totals: FunnelStageCounts = emptyFunnelCounts();
  private readonly perProvider = new Map<string, FunnelStageCounts>();
  private readonly rejectReasons = new Map<string, number>();

  constructor(opts: { renderId: string; videoId?: number }) {
    this.renderId = opts.renderId;
    this.videoId = opts.videoId;
  }

  // ── Lineage ────────────────────────────────────────────────────────────────

  /**
   * Files a record under every handle it can later be found by.
   *
   * The basename index deliberately does NOT overwrite: two different renders' work dirs can hold
   * files with the same basename, and it is the weakest of the three lookups, so the first
   * (earliest-selected) answer is the one worth keeping.
   */
  private index(record: VisualLineageRecord): void {
    this.byPath.set(record.localPath, record);
    if (record.contentKey) this.byContentKey.set(record.contentKey, record);
    if (!this.byBasename.has(record.originalFilename)) {
      this.byBasename.set(record.originalFilename, record);
    }
  }

  /** Records a candidate at the moment it is chosen, before any download or trim. */
  recordSelection(input: RecordSelectionInput): VisualLineageRecord {
    const basename = path.basename(input.localPath);
    const record: VisualLineageRecord = {
      ...input,
      videoId: input.videoId ?? this.videoId,
      renderId: input.renderId || this.renderId,
      provider: normalizeProvider(input.provider),
      originalFilename: basename,
      finalFilename: basename,
      selectedAt: input.selectedAt ?? Date.now(),
    };
    this.index(record);
    return record;
  }

  /**
   * Marks a recorded clip as adopted into the montage.
   *
   * Accepts the path the montage actually holds, which may be several renames past the one that
   * was selected — resolve() finds the record through the derivation chain either way. When the
   * clip has no record at all (an upstream path this round has not been wired through yet), a
   * minimal record is created from what the caller knows, so the entry is never silently lost.
   */
  recordAdoption(
    clipPath: string,
    patch: Partial<VisualLineageRecord> & { provider?: string } = {}
  ): VisualLineageRecord | null {
    const existing = this.resolve(clipPath);
    const basename = path.basename(clipPath);
    if (!existing) {
      if (!patch.provider) return null;
      return this.recordSelection({
        renderId: this.renderId,
        videoId: patch.videoId,
        sceneIndex: patch.sceneIndex ?? -1,
        beatIndex: patch.beatIndex ?? -1,
        candidateId: patch.candidateId ?? basename,
        contentKey: patch.contentKey ?? basename,
        provider: patch.provider,
        providerAssetId: patch.providerAssetId,
        sourceUrl: patch.sourceUrl,
        originalUrl: patch.originalUrl,
        localPath: clipPath,
        mediaType: patch.mediaType ?? "unknown",
        query: patch.query,
        score: patch.score,
        visionScore10: patch.visionScore10,
        archiveAssetId: patch.archiveAssetId,
        assetTitle: patch.assetTitle,
        route: patch.route ?? "primary",
        sourceLabel: patch.sourceLabel,
      });
    }
    // A later, more specific value wins; an absent one never erases what is already known.
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      (existing as Record<string, unknown>)[key] = key === "provider" ? normalizeProvider(String(value)) : value;
    }
    existing.adoptedAt = patch.adoptedAt ?? Date.now();
    existing.finalFilename = basename;
    // The adopted path is itself a valid handle on this record from here on.
    this.byPath.set(clipPath, existing);
    this.byBasename.set(basename, existing);
    if (patch.contentKey) this.byContentKey.set(patch.contentKey, existing);
    return existing;
  }

  /**
   * Declares that `derivedPath` was produced from `originPath`.
   *
   * This is the single mechanism that makes lineage survive the compose path. Call it at every
   * site that writes a NEW file from an existing clip — the trim, the still-to-video step, the
   * text overlay, the transform, and `padShortClipWithNext`'s combined output. The derived path
   * then resolves to the origin's record, however many times it is renamed afterwards.
   */
  linkDerivedPath(derivedPath: string, originPath: string): void {
    if (!derivedPath || !originPath || derivedPath === originPath) return;
    this.derivedFrom.set(derivedPath, originPath);
    const record = this.resolve(originPath);
    if (!record) return;
    const basename = path.basename(derivedPath);
    record.finalFilename = basename;
    this.byPath.set(derivedPath, record);
    // Deliberately NOT overwriting an existing basename entry: two derived files can share a
    // basename across work dirs, and the first (closer to the origin) is the better answer.
    if (!this.byBasename.has(basename)) this.byBasename.set(basename, record);
  }

  /**
   * The record for a clip, found by whichever handle still works.
   *
   * Order matters: the exact path is unambiguous, the derivation chain is authoritative, the
   * content key survives renames that were never linked, and the basename is the last resort —
   * the only lookup the pre-RONDE-86 manifest had, and the one that failed on 27 of render 536's
   * 66 clips.
   */
  resolve(clipPath: string, contentKey?: string): VisualLineageRecord | null {
    if (!clipPath) return null;
    const direct = this.byPath.get(clipPath);
    if (direct) return direct;

    // Walk the derivation chain. Bounded and cycle-guarded: a mis-wired link must not hang a render.
    const seen = new Set<string>([clipPath]);
    let cursor = this.derivedFrom.get(clipPath);
    while (cursor && !seen.has(cursor)) {
      const found = this.byPath.get(cursor);
      if (found) return found;
      seen.add(cursor);
      cursor = this.derivedFrom.get(cursor);
    }

    if (contentKey) {
      const byKey = this.byContentKey.get(contentKey);
      if (byKey) return byKey;
    }
    return this.byBasename.get(path.basename(clipPath)) ?? null;
  }

  /** The provider a clip came from, or null when this ledger has never seen it. */
  providerFor(clipPath: string, contentKey?: string): string | null {
    return this.resolve(clipPath, contentKey)?.provider ?? null;
  }

  /** Every record, selection order preserved. */
  records(): VisualLineageRecord[] {
    return [...new Set(this.byPath.values())];
  }

  /** How many distinct clips this ledger has provenance for. */
  get size(): number {
    return new Set(this.byPath.values()).size;
  }

  // ── Funnel counters ────────────────────────────────────────────────────────

  /**
   * Counts `n` candidates passing `stage` for `provider`.
   *
   * Pure arithmetic on a render-scoped object — no I/O, nothing that can fail, nothing that can
   * block. Safe to call from inside a hot loop.
   */
  countFunnel(stage: FunnelStage, provider: string, n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const key = normalizeProvider(provider);
    this.totals[stage] += n;
    let counts = this.perProvider.get(key);
    if (!counts) {
      counts = emptyFunnelCounts();
      this.perProvider.set(key, counts);
    }
    counts[stage] += n;
  }

  /** Counts a rejection and attributes it to the gate that produced it. */
  countRejection(provider: string, reason: string, n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.countFunnel("rejected", provider, n);
    const key = (reason ?? "").trim() || "unspecified";
    this.rejectReasons.set(key, (this.rejectReasons.get(key) ?? 0) + n);
  }

  funnelSummary(): FunnelSummary {
    const byProvider: Record<string, FunnelStageCounts> = {};
    for (const [provider, counts] of this.perProvider) {
      byProvider[provider] = { ...counts };
    }
    return {
      total: { ...this.totals },
      byProvider,
      rejectReasons: Object.fromEntries(this.rejectReasons),
    };
  }
}

/**
 * The funnel, as one block of log lines.
 *
 * Written to be read by a human scanning a Railway log for "where did 2671 candidates go", so
 * the total comes first and the providers are ordered by how much they actually contributed
 * rather than alphabetically.
 */
export function formatFunnelReport(summary: FunnelSummary): string[] {
  const line = (label: string, c: FunnelStageCounts) =>
    `[VisualFunnel] ${label} ` +
    FUNNEL_STAGES.map((s) => `${s}=${c[s]}`).join(" ");

  const lines = [line("TOTAL", summary.total)];
  const providers = Object.entries(summary.byProvider).sort((a, b) => {
    const byAdopted = b[1].adopted - a[1].adopted;
    return byAdopted !== 0 ? byAdopted : b[1].retrieved - a[1].retrieved;
  });
  for (const [provider, counts] of providers) lines.push(line(provider, counts));

  const reasons = Object.entries(summary.rejectReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push(
      `[VisualFunnel] rejectReasons ` + reasons.map(([r, n]) => `${r}=${n}`).join(" ")
    );
  }
  return lines;
}

/**
 * The lineage, as one line per composed clip.
 *
 * Replaces the guess-from-the-filename manifest. `origin=recorded` means the ledger knew this
 * clip; `origin=inferred` means the caller had to fall back to the filename, which is now the
 * exception rather than the rule and stays visible as such.
 */
export function formatLineageLine(
  record: VisualLineageRecord | null,
  clipPath: string,
  inferredProvider: string
): string {
  const basename = path.basename(clipPath);
  if (!record) {
    return (
      `[SourceLineage] scene=? beat=? provider=${inferredProvider} origin=inferred ` +
      `route=? clip=${basename}`
    );
  }
  const parts = [
    `scene=${record.sceneIndex}`,
    `beat=${record.beatIndex}`,
    `provider=${record.provider}`,
    `origin=recorded`,
    `route=${record.route}`,
    record.providerAssetId ? `assetId=${record.providerAssetId}` : null,
    record.archiveAssetId != null ? `archiveAsset=${record.archiveAssetId}` : null,
    record.score != null ? `score=${record.score}` : null,
    record.visionScore10 != null ? `vision=${record.visionScore10}` : null,
    record.query ? `query="${record.query.slice(0, 48)}"` : null,
    record.originalFilename !== record.finalFilename ? `from=${record.originalFilename}` : null,
    `clip=${basename}`,
  ].filter(Boolean);
  return `[SourceLineage] ${parts.join(" ")}`;
}
