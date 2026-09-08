/**
 * RONDE 122 §2 — LINEAGE THAT OUTLIVES THE PROCESS THAT WROTE IT.
 *
 * ── The gap, measured ────────────────────────────────────────────────────────────────────────
 *
 * `DELIVERED` has been a declared stage of a clip's life for rounds and nothing has ever written
 * it, so `lifecyclesOf` reports `delivered: false` for every asset of every render. RONDE 120's
 * census holds it as the one known gap precisely so that false is not read as a fact.
 *
 * RONDE 122 measured why. The ledger is created per render inside `createSourcingCache` and is
 * never persisted; `renderJobWorker` — the only code that uploads the output and learns its
 * viewer-facing URL, which is what DELIVERED means — contains zero references to it. A render job
 * that runs from the poll loop starts after the pipeline process is gone and has no lineage at
 * all: it holds a timeline, and a timeline knows identities but not histories.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * The persisted form of a render's lineage, and the one join key both sides can compute.
 *
 *     pipeline lineage  →  snapshot in videos.metadata  →  render job  →  render  →  upload
 *                                                                                      ↓
 *                                                                                  DELIVERED
 *
 * The join is by CANONICAL ASSET IDENTITY, never by path. Work-directory paths are deleted with
 * the work directory, and a render job that rehydrated a clip for itself holds it at a path this
 * render has never seen — matching on those would either find nothing or match the wrong thing.
 * `assetIdentityKey` is computed from a ledger record (through `identityFromAdoption`, the
 * existing bridge) and from a `TimelineVideoClip.source` (an `AssetSourceIdentity` written by that
 * same bridge), so the two sides agree by construction rather than by convention.
 *
 * ── What is deliberately NOT persisted ───────────────────────────────────────────────────────
 *
 * Local paths and media URLs. A path is an absolute work-directory path with no meaning after the
 * render, and a provider media URL is routinely a signed, expiring link — neither belongs in a
 * metadata column, and neither is needed for the join. Identity is provider + provider asset id,
 * or the archive row id, which is what survives.
 *
 * ── The rule this file exists to keep ────────────────────────────────────────────────────────
 *
 * A delivery is recorded only for an asset that a real render reported in its real output after a
 * real upload succeeded. An asset the snapshot does not know, or that the render could not
 * identify, is COUNTED AND NAMED as unmatched — never quietly delivered, never invented.
 */
import type { AssetSourceIdentity } from "./projectTimeline";
import { identityFromAdoption } from "./assetIdentity";
import {
  UNVERIFIED_PROVIDER,
  curatedAssetContentKey,
  type LineageStage,
  type VisualLineageMediaType,
  type VisualLineageRoute,
  type VisualSourceLedger,
} from "./visualSourceLineage";

/** Bumped when the stored shape changes in a way an older reader cannot handle. */
export const LINEAGE_SNAPSHOT_SCHEMA = 1;

/** The key in `videos.metadata` this snapshot is stored under. */
export const LINEAGE_SNAPSHOT_METADATA_KEY = "visualLineage";

/**
 * How many assets one snapshot may carry.
 *
 * A bound rather than a silent slice: `truncated` records how many were left out, so a reader can
 * see that the snapshot is partial instead of concluding the render used fewer assets than it did.
 * Records that reached further down the funnel are kept first — a candidate that was found and
 * dropped is the least interesting thing to persist.
 */
export const MAX_SNAPSHOT_ASSETS = 400;

/* ═══════════════════════ the join key ═══════════════════════ */

/**
 * The canonical identity of one asset, or null when it has none.
 *
 * Three answers, in the order the identity itself ranks them:
 *
 *   · an archive row id      this system holds the file; `curated:asset:<id>` is the same string
 *                            the ledger already uses as that asset's content key
 *   · provider + asset id    enough to name the asset at its provider
 *   · null                   an asset with only a provider NAME, or an unproven provider
 *
 * `null` is a real answer and the important one: a clip whose origin was never proven cannot be
 * claimed as delivered, and saying so is the whole point of RONDE 89's export blocks. A key must
 * never be conjured from a filename — RONDE 86/87 removed filename inference from provenance once
 * already and it must not come back through this door.
 */
export function assetIdentityKey(
  identity: AssetSourceIdentity | null | undefined
): string | null {
  if (!identity) return null;
  if (identity.archiveAssetId != null) return curatedAssetContentKey(identity.archiveAssetId);
  const provider = identity.provider?.trim().toLowerCase();
  if (!provider) return null;
  if (provider.toUpperCase() === UNVERIFIED_PROVIDER) return null;
  const assetId = identity.providerAssetId?.trim();
  if (!assetId) return null;
  return `${provider}:${assetId}`;
}

/** The same key for a lineage record, through the bridge that already builds its identity. */
export function assetIdentityKeyForRecord(record: {
  provider: string | null;
  providerAssetId?: string;
  sourceUrl?: string;
  originalUrl?: string;
  assetTitle?: string;
  archiveAssetId?: number;
}): string | null {
  return assetIdentityKey(identityFromAdoption(record));
}

/* ═══════════════════════ the stored shape ═══════════════════════ */

export type LineageAssetSnapshot = {
  /** The canonical identity. Unique within a snapshot — the derivation chain folds into one entry. */
  key: string;
  /**
   * Every lineage record that carried this identity, root first.
   *
   * A trim, a pad and an overlay are three records of ONE asset, and they share its identity by
   * construction (`createLineage` inherits `providerAssetId` from the parent). Folding them keeps
   * the snapshot a statement about assets, and `lineageIds` keeps the derivation visible.
   */
  lineageIds: string[];
  provider: string;
  providerAssetId?: string;
  archiveAssetId?: number;
  mediaType: VisualLineageMediaType;
  route: VisualLineageRoute;
  sceneIndex: number;
  beatIndex: number;
  title?: string;
  /** Every stage any record of this asset reached, in the order they happened, deduplicated. */
  stages: LineageStage[];
  /** Set only by `recordDelivery`, only from a render that really put this asset on screen. */
  deliveredAt?: number;
};

/**
 * Which renderer produced the file the viewer receives.
 *
 * Two routes really deliver. The cinematic timeline render is a render job and carries a job id;
 * the compose montage is produced and uploaded inside the pipeline itself and has none. Recording
 * the route is what keeps a compose delivery from reading as a render job that lost its id.
 */
export type DeliveryRoute = "render_job" | "compose_montage";

/** What the delivering renderer wrote back after its output was uploaded. */
export type LineageDeliveryRecord = {
  route: DeliveryRoute;
  /** The render job that delivered, when a render job delivered. Absent on the compose route. */
  jobId?: number;
  attempt?: number;
  /** Whether the upload became the video's current edit, or arrived after a newer render. */
  published: boolean;
  deliveredAt: number;
  /** Assets in the output that this snapshot knew. */
  delivered: number;
  /** Assets in the output whose identity this snapshot does not carry. Named, never delivered. */
  unmatchedKeys: string[];
  /** Clips in the output that carry no canonical identity at all. Counted, never delivered. */
  unidentifiedClips: number;
  /** Set when the snapshot was written for a different timeline version than the job rendered. */
  timelineVersionAtDelivery?: number;
  /**
   * THE RENDER THE SNAPSHOT CAME FROM, WHEN IT IS NOT THE ONE BEING DELIVERED.
   *
   * `videos.metadata.visualLineage` holds ONE snapshot per video, so a later render overwrites an
   * earlier one. The version check beside this catches the ordinary case, because a new render
   * produces a new timeline version — but two renders can carry the same version (a re-render of
   * an unchanged timeline is exactly that), and then the version alone says nothing.
   *
   * The snapshot has always carried `renderId` and nobody compared it. Set here when they differ,
   * so a delivery attributed to the wrong run says so instead of reading as a clean join. Absent
   * is the healthy case and absent is not "unknown": a snapshot with no renderId at all is
   * reported separately, as `NO_SNAPSHOT_RENDER`.
   */
  snapshotRenderId?: string;
};

export type VisualLineageSnapshot = {
  schemaVersion: number;
  renderId: string;
  videoId: number;
  /** The `ProjectTimeline.version` this lineage describes. */
  timelineVersion: number;
  createdAt: number;
  assets: LineageAssetSnapshot[];
  /** Records that had no canonical identity and so could never be joined to a render output. */
  unidentifiedRecords: number;
  /** Assets left out by `MAX_SNAPSHOT_ASSETS`. Absent means nothing was left out. */
  truncated?: number;
  delivery?: LineageDeliveryRecord;
};

/* ═══════════════════════ writing one ═══════════════════════ */

/**
 * Which stages make an asset worth persisting, most interesting first.
 *
 * Used only to decide what survives `MAX_SNAPSHOT_ASSETS`. An asset that reached the render is
 * kept before one that was found and never chosen — the opposite order would truncate away
 * exactly the assets a delivery record needs.
 */
const DEPTH_ORDER: LineageStage[] = [
  "FINAL_VIDEO",
  "RENDER_INPUT",
  "CINEMATIC_SELECTED",
  "COMPOSED",
  "ADOPTED",
  "DOWNLOAD_SUCCEEDED",
  "SELECTED",
];

function depthOf(stages: readonly LineageStage[]): number {
  for (let i = 0; i < DEPTH_ORDER.length; i++) {
    if (stages.includes(DEPTH_ORDER[i]!)) return DEPTH_ORDER.length - i;
  }
  return 0;
}

/** The persistable form of everything this render's ledger knows about its assets. */
export function snapshotLineage(
  ledger: VisualSourceLedger,
  opts: { videoId: number; timelineVersion: number; maxAssets?: number }
): VisualLineageSnapshot {
  const stagesByLineage = new Map<string, LineageStage[]>();
  for (const event of ledger.allEvents()) {
    let list = stagesByLineage.get(event.lineageId);
    if (!list) stagesByLineage.set(event.lineageId, (list = []));
    if (!list.includes(event.stage)) list.push(event.stage);
  }

  const byKey = new Map<string, LineageAssetSnapshot>();
  let unidentifiedRecords = 0;

  for (const record of ledger.allRecords()) {
    const key = assetIdentityKeyForRecord(record);
    if (!key) {
      unidentifiedRecords += 1;
      continue;
    }
    const stages = stagesByLineage.get(record.lineageId) ?? [];
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        lineageIds: [record.lineageId],
        provider: record.provider?.trim().toLowerCase() ?? UNVERIFIED_PROVIDER,
        providerAssetId: record.providerAssetId,
        archiveAssetId: record.archiveAssetId,
        mediaType: record.mediaType,
        route: record.route,
        sceneIndex: record.sceneIndex,
        beatIndex: record.beatIndex,
        title: record.assetTitle,
        stages: [...stages],
      });
      continue;
    }
    existing.lineageIds.push(record.lineageId);
    for (const stage of stages) if (!existing.stages.includes(stage)) existing.stages.push(stage);
  }

  const all = [...byKey.values()];
  const limit = opts.maxAssets ?? MAX_SNAPSHOT_ASSETS;
  let assets = all;
  let truncated: number | undefined;
  if (all.length > limit) {
    assets = [...all].sort((a, b) => depthOf(b.stages) - depthOf(a.stages)).slice(0, limit);
    truncated = all.length - limit;
  }

  return {
    schemaVersion: LINEAGE_SNAPSHOT_SCHEMA,
    renderId: ledger.renderId,
    videoId: opts.videoId,
    timelineVersion: opts.timelineVersion,
    createdAt: Date.now(),
    assets,
    unidentifiedRecords,
    ...(truncated ? { truncated } : {}),
  };
}

/* ═══════════════════════ reading one back ═══════════════════════ */

/**
 * Why a stored snapshot could not be used. Every one of these is REPORTED, never worked around.
 *
 *   MISSING          nothing was ever stored for this video
 *   MALFORMED        something is stored and it is not a snapshot
 *   SCHEMA_TOO_NEW   written by a newer build than this one reads
 *   EMPTY            a real snapshot that carries no identified asset
 */
export const LINEAGE_SNAPSHOT_PROBLEMS = ["MISSING", "MALFORMED", "SCHEMA_TOO_NEW", "EMPTY"] as const;
export type LineageSnapshotProblem = (typeof LINEAGE_SNAPSHOT_PROBLEMS)[number];

export type LineageSnapshotRead =
  | { ok: true; snapshot: VisualLineageSnapshot }
  | { ok: false; problem: LineageSnapshotProblem; detail: string };

function isStage(value: unknown): value is LineageStage {
  return typeof value === "string";
}

/** Parse whatever the metadata bag holds, and say plainly when it is not a usable snapshot. */
export function parseLineageSnapshot(raw: unknown): LineageSnapshotRead {
  if (raw == null) return { ok: false, problem: "MISSING", detail: "no lineage was ever stored" };
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, problem: "MALFORMED", detail: "the stored value is not readable JSON" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "MALFORMED", detail: "the stored value is not an object" };
  }
  const obj = value as Record<string, unknown>;
  const schemaVersion = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;
  if (schemaVersion > LINEAGE_SNAPSHOT_SCHEMA) {
    return {
      ok: false,
      problem: "SCHEMA_TOO_NEW",
      detail: `snapshot schemaVersion ${schemaVersion} is newer than this build reads`,
    };
  }
  if (!Array.isArray(obj.assets)) {
    return { ok: false, problem: "MALFORMED", detail: "the snapshot carries no asset list" };
  }
  const assets: LineageAssetSnapshot[] = [];
  for (const entry of obj.assets) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.key !== "string" || !a.key) continue;
    assets.push({
      key: a.key,
      lineageIds: Array.isArray(a.lineageIds) ? a.lineageIds.filter((x): x is string => typeof x === "string") : [],
      provider: typeof a.provider === "string" ? a.provider : UNVERIFIED_PROVIDER,
      providerAssetId: typeof a.providerAssetId === "string" ? a.providerAssetId : undefined,
      archiveAssetId: typeof a.archiveAssetId === "number" ? a.archiveAssetId : undefined,
      mediaType: (typeof a.mediaType === "string" ? a.mediaType : "unknown") as VisualLineageMediaType,
      route: (typeof a.route === "string" ? a.route : "primary") as VisualLineageRoute,
      sceneIndex: typeof a.sceneIndex === "number" ? a.sceneIndex : -1,
      beatIndex: typeof a.beatIndex === "number" ? a.beatIndex : -1,
      title: typeof a.title === "string" ? a.title : undefined,
      stages: Array.isArray(a.stages) ? a.stages.filter(isStage) : [],
      deliveredAt: typeof a.deliveredAt === "number" ? a.deliveredAt : undefined,
    });
  }
  if (!assets.length) {
    return { ok: false, problem: "EMPTY", detail: "the snapshot carries no identified asset" };
  }
  return {
    ok: true,
    snapshot: {
      schemaVersion,
      renderId: typeof obj.renderId === "string" ? obj.renderId : "unknown",
      videoId: typeof obj.videoId === "number" ? obj.videoId : -1,
      timelineVersion: typeof obj.timelineVersion === "number" ? obj.timelineVersion : -1,
      createdAt: typeof obj.createdAt === "number" ? obj.createdAt : 0,
      assets,
      unidentifiedRecords:
        typeof obj.unidentifiedRecords === "number" ? obj.unidentifiedRecords : 0,
      ...(typeof obj.truncated === "number" ? { truncated: obj.truncated } : {}),
      ...(obj.delivery && typeof obj.delivery === "object"
        ? { delivery: obj.delivery as LineageDeliveryRecord }
        : {}),
    },
  };
}

/* ═══════════════════════ what a render actually put on screen ═══════════════════════ */

/**
 * The canonical identities of the clips a renderer reported in its output.
 *
 * `renderedClipIds` is the renderer's own answer to "which clips are in this file" — built from
 * the clips it drew, not from the clips it was handed, so a clip that was dropped is absent. Each
 * one is looked up in the timeline it rendered and reduced to its identity.
 *
 * A clip whose identity is not canonical is counted, not keyed: a guaranteed filler and a clip
 * with an unproven provider are both real pictures and neither is an asset this pipeline can name.
 * Counting them keeps the arithmetic honest — delivered + unidentified accounts for the output.
 */
export function deliveredKeysFor(
  clips: ReadonlyArray<{ id: string; source: AssetSourceIdentity }>,
  renderedClipIds: readonly string[]
): { keys: string[]; unidentifiedClips: number } {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const keys: string[] = [];
  let unidentifiedClips = 0;
  for (const id of renderedClipIds) {
    const clip = byId.get(id);
    const key = clip ? assetIdentityKey(clip.source) : null;
    if (key) keys.push(key);
    else unidentifiedClips += 1;
  }
  return { keys, unidentifiedClips };
}

/* ═══════════════════════ recording a delivery into one ═══════════════════════ */

export type DeliveryInput = {
  /** The canonical keys of the clips the renderer reported in its output. */
  deliveredKeys: readonly string[];
  /** Clips in that output that carry no canonical identity. Counted, never delivered. */
  unidentifiedClips: number;
  route: DeliveryRoute;
  jobId?: number;
  attempt?: number;
  published: boolean;
  /** The version the job actually rendered, so a snapshot from another version is visible. */
  timelineVersion: number;
  /**
   * The render this delivery belongs to, when the caller knows it. Compared with the snapshot's
   * own `renderId`; a mismatch is recorded, never repaired and never a reason to refuse — the file
   * is already delivered, and refusing to account for it would lose the only record of that.
   */
  expectedRenderId?: string;
  now?: number;
};

export type DeliveryOutcome = {
  snapshot: VisualLineageSnapshot;
  record: LineageDeliveryRecord;
  /** Assets newly marked delivered by this call. */
  marked: number;
};

/**
 * Write DELIVERED into a snapshot, for exactly the assets a real render reported in a real upload.
 *
 * Idempotent: an asset already carrying `deliveredAt` keeps the first timestamp, so a re-run of the
 * same job cannot inflate the count. A key the snapshot does not know is put in `unmatchedKeys` —
 * the asset was in the video and this lineage cannot explain it, which is a finding, not a reason
 * to add a record. `STAGES.DELIVERED` is appended so the stage list stays the asset's history.
 */
export function recordDelivery(
  snapshot: VisualLineageSnapshot,
  input: DeliveryInput
): DeliveryOutcome {
  const at = input.now ?? Date.now();
  const byKey = new Map(snapshot.assets.map((a) => [a.key, a]));
  const unmatched: string[] = [];
  const seen = new Set<string>();
  let marked = 0;
  let delivered = 0;

  for (const key of input.deliveredKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const asset = byKey.get(key);
    if (!asset) {
      unmatched.push(key);
      continue;
    }
    delivered += 1;
    if (!asset.stages.includes("DELIVERED")) asset.stages.push("DELIVERED");
    if (asset.deliveredAt == null) {
      asset.deliveredAt = at;
      marked += 1;
    }
  }

  const record: LineageDeliveryRecord = {
    route: input.route,
    ...(input.jobId != null ? { jobId: input.jobId } : {}),
    ...(input.attempt != null ? { attempt: input.attempt } : {}),
    published: input.published,
    deliveredAt: at,
    delivered,
    unmatchedKeys: unmatched,
    unidentifiedClips: input.unidentifiedClips,
    ...(input.expectedRenderId && snapshot.renderId && input.expectedRenderId !== snapshot.renderId
      ? { snapshotRenderId: snapshot.renderId }
      : {}),
    ...(input.timelineVersion !== snapshot.timelineVersion
      ? { timelineVersionAtDelivery: input.timelineVersion }
      : {}),
  };
  return { snapshot: { ...snapshot, delivery: record }, record, marked };
}

/**
 * RONDE 122 §2 — the compose route's delivery, taken from the proof the pipeline already made.
 *
 * The cinematic route delivers through a render job, and that job records its own delivery from
 * its own output list. The compose montage has no render job: the pipeline builds it, uploads it
 * and — when the cinematic render did not deliver — hands it to the viewer itself. So the same
 * accounting is done here, and from the same kind of evidence: `markDelivered` has already written
 * DELIVERED onto exactly the records FINAL_VIDEO was proven for, and this reads that back.
 *
 * Returns null when the ledger holds no delivered asset at all. A snapshot claiming a delivery of
 * nothing is worse than no claim, and `markDelivered` returning zero already says why.
 */
export function snapshotComposeDelivery(
  ledger: VisualSourceLedger,
  opts: { videoId: number; timelineVersion: number; published: boolean; now?: number }
): DeliveryOutcome | null {
  const snapshot = snapshotLineage(ledger, {
    videoId: opts.videoId,
    timelineVersion: opts.timelineVersion,
  });
  const deliveredKeys = snapshot.assets.filter((a) => a.stages.includes("DELIVERED")).map((a) => a.key);
  if (!deliveredKeys.length) return null;
  const unidentifiedClips = ledger
    .allRecords()
    .filter((r) => r.finalVideoAt != null && !assetIdentityKeyForRecord(r)).length;
  return recordDelivery(snapshot, {
    deliveredKeys,
    unidentifiedClips,
    route: "compose_montage",
    published: opts.published,
    timelineVersion: opts.timelineVersion,
    now: opts.now,
  });
}

/* ═══════════════════════ the render job's delivery, start to finish ═══════════════════════ */

/** How the delivering job reaches the persisted lineage. Injected, so a test needs no database. */
export type LineageStore = {
  read: (videoId: number) => Promise<unknown>;
  write: (videoId: number, snapshot: VisualLineageSnapshot) => Promise<void>;
};

/**
 * DELIVERED, from a real render of a real file that a real upload accepted.
 *
 * ── Where the caller must put this, and why ──────────────────────────────────────────────────
 *
 * After the upload returned a URL, after the publish verdict, after the job row was written. Every
 * earlier point in `runRenderJob` can still fail, and a failure at any of them returns through
 * `fail()` without reaching this call — so a render that broke, an upload that was refused and a
 * timeline that would not validate all leave DELIVERED unwritten, which is the only honest
 * outcome for each of them. RONDE 122's test file pins the ordering.
 *
 * ── It is a JOIN, not a claim ────────────────────────────────────────────────────────────────
 *
 * `renderedClipIds` is the renderer's own output list. Each id is reduced to a canonical asset
 * identity through the timeline clip it names, and matched against the lineage the pipeline
 * persisted before this job ran. Nothing is created: a key the snapshot does not carry is named
 * as unmatched, a clip with no canonical identity is counted as unidentified, and a video with no
 * usable stored lineage gets a NO_LINEAGE line saying which of the four problems it is.
 *
 * ── It never fails the render ────────────────────────────────────────────────────────────────
 *
 * The file is uploaded and the row says completed before this runs. An accounting write that
 * threw here would turn a delivered video into a failed job, which is strictly worse than an
 * unrecorded delivery — so the failure is logged and the render stands.
 *
 * It lives in this module rather than in the worker so that it can be driven without a database,
 * a storage backend or an ffmpeg: it is a join between a snapshot and a clip list, and every
 * moving part it touches is already here.
 */
export async function recordDeliveredLineage(params: {
  store: LineageStore;
  job: {
    id: number;
    videoId: number;
    attempt: number;
    timelineVersion: number;
    /**
     * The production render this job belongs to, when it is known.
     *
     * One video holds ONE stored snapshot, so a later render overwrites an earlier one. The
     * version check below catches the ordinary case; two renders of an unchanged timeline carry
     * the same version and it catches nothing. Passing the id lets the join say which run it
     * actually read.
     */
    productionRenderId?: string;
  };
  /** The video-track clips of the timeline that was rendered. */
  clips: ReadonlyArray<{ id: string; source: AssetSourceIdentity }>;
  renderedClipIds: readonly string[];
  published: boolean;
  now?: number;
}): Promise<{ recorded: boolean; problem?: string }> {
  const { job } = params;
  try {
    const read = parseLineageSnapshot(await params.store.read(job.videoId));
    if (!read.ok) {
      console.warn(formatDeliveryRefusal(job.videoId, job.id, read.problem, read.detail));
      return { recorded: false, problem: read.problem };
    }
    const { keys, unidentifiedClips } = deliveredKeysFor(params.clips, params.renderedClipIds);
    const outcome = recordDelivery(read.snapshot, {
      deliveredKeys: keys,
      unidentifiedClips,
      route: "render_job",
      jobId: job.id,
      attempt: job.attempt,
      published: params.published,
      timelineVersion: job.timelineVersion,
      ...(job.productionRenderId ? { expectedRenderId: job.productionRenderId } : {}),
      now: params.now,
    });
    await params.store.write(job.videoId, outcome.snapshot);
    console.log(formatDeliveryRecord(job.videoId, outcome.record));
    for (const key of outcome.record.unmatchedKeys.slice(0, 10)) {
      console.warn(
        `[VisualDelivery] video=${job.videoId} job=${job.id} UNMATCHED asset=${key} — it is in ` +
          "the delivered file and this render's lineage does not account for it"
      );
    }
    return { recorded: true };
  } catch (err) {
    console.warn(
      `[VisualDelivery] video=${job.videoId} job=${job.id} could not record the delivery: ` +
        `${(err as Error).message.slice(0, 200)}`
    );
    return { recorded: false, problem: "WRITE_FAILED" };
  }
}

/* ═══════════════════════ saying what happened ═══════════════════════ */

/** One line for the render log. Never prints a URL, a key or a path. */
export function formatDeliveryRecord(videoId: number, record: LineageDeliveryRecord): string {
  const stale =
    record.timelineVersionAtDelivery != null
      ? ` STALE_LINEAGE(renderedVersion=${record.timelineVersionAtDelivery})`
      : "";
  /** A delivery joined against another run's lineage. Named, because the numbers beside it are its. */
  const crossRender =
    record.snapshotRenderId != null
      ? ` RENDER_ID_MISMATCH(snapshotRender=${record.snapshotRenderId})`
      : "";
  return (
    `[VisualDelivery] video=${videoId} route=${record.route} job=${record.jobId ?? "none"} ` +
    `attempt=${record.attempt ?? "none"} ` +
    `published=${record.published} deliveredAssets=${record.delivered} ` +
    `unmatched=${record.unmatchedKeys.length} unidentifiedClips=${record.unidentifiedClips}${stale}${crossRender}`
  );
}

/** Why no delivery could be recorded. Printed instead of a delivery, never alongside a silent one. */
export function formatDeliveryRefusal(
  videoId: number,
  jobId: number,
  problem: LineageSnapshotProblem,
  detail: string
): string {
  return (
    `[VisualDelivery] video=${videoId} job=${jobId} NO_LINEAGE=${problem} — ${detail}; ` +
    "the render is real and its assets cannot be attributed to this video's lineage"
  );
}
