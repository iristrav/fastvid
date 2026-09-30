/**
 * VIDEO 619 — EVERY ARCHIVE CLIP IS ONE SHOT, AT MOST ELEVEN SECONDS, WITHOUT TEXT.
 *
 * ── What the archive held ────────────────────────────────────────────────────────────────────
 *
 * The background YouTube fetch stores 30-second segments, and a segment of a news report or a
 * documentary is five shots, a dissolve and a caption. A render can only use a few seconds of it,
 * and a clip with text anywhere in it was refused WHOLE at the door — so the clean seconds after a
 * caption were thrown away with the caption.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 * A video that comes into the archive is cut where the picture changes — hard cuts AND the edges
 * of dissolves and fades, the same detector the YouTube shot rule uses (`productionShotCutDeps`) —
 * and every scene longer than `ARCHIVE_PIECE_MAX_SEC` is cut into equal parts inside that scene.
 * Each piece is checked for text on screen on its own: a piece with text is left out, a clean piece
 * becomes its own archive asset, carrying its parent's id.
 *
 * The parent is then switched off for sourcing — its pieces are offered instead — and KEPT: a film
 * that already uses it is re-rendered from it (fetching an asset by id does not ask whether it is
 * active). A clip that already is one clean shot of at most eleven seconds is left exactly as it
 * is, and only marked as looked at.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

import { ARCHIVE_PIECE_MAX_SEC } from "./archiveVideoSplitter";

/** A piece shorter than this is a flash or the inside of a transition, not a usable shot. */
export const ARCHIVE_PIECE_MIN_SEC = 2;
/** Kept clear of each cut, so a piece never starts or ends on the frame of the next shot. */
export const CUT_EDGE_PAD_SEC = 0.12;

export type PieceRange = { startSec: number; endSec: number };

/**
 * Where the pieces of a clip are, given its length and its cuts. Pure.
 *
 * Scenes are the spans between cuts; a scene shorter than `ARCHIVE_PIECE_MIN_SEC` is dropped (a
 * dissolve's own window lands here too, being the span between its two edges); a longer scene is
 * cut into the fewest equal parts that are each at most `maxSec`.
 */
export function shotPieceRanges(
  durationSec: number,
  cutsSec: readonly number[],
  opts: { maxSec?: number; minSec?: number; padSec?: number } = {}
): PieceRange[] {
  const maxSec = opts.maxSec ?? ARCHIVE_PIECE_MAX_SEC;
  const minSec = opts.minSec ?? ARCHIVE_PIECE_MIN_SEC;
  const pad = opts.padSec ?? CUT_EDGE_PAD_SEC;
  if (!(durationSec > 0)) return [];
  const bounds = [0, ...cutsSec.filter((c) => c > 0 && c < durationSec).sort((a, b) => a - b), durationSec];
  const out: PieceRange[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]! + (i > 0 ? pad : 0);
    const b = bounds[i + 1]! - (i + 1 < bounds.length - 1 ? pad : 0);
    const len = b - a;
    if (len < minSec) continue;
    const parts = Math.ceil(len / maxSec - 1e-9);
    const step = len / parts;
    for (let k = 0; k < parts; k++) {
      out.push({ startSec: round(a + k * step), endSec: round(k === parts - 1 ? b : a + (k + 1) * step) });
    }
  }
  return out;
}

const round = (n: number): number => Number(n.toFixed(3));

/** Is this clip already exactly one piece — the whole file, one shot, short enough? */
export function isAlreadyOnePiece(durationSec: number, ranges: readonly PieceRange[], maxSec = ARCHIVE_PIECE_MAX_SEC): boolean {
  if (ranges.length !== 1) return false;
  const r = ranges[0]!;
  return r.startSec <= 0.3 && durationSec - r.endSec <= 0.3 && durationSec <= maxSec + 0.3;
}

/* ═══════════════════════ the split, with its outside world passed in ═══════════════════════ */

export type PieceParent = {
  id: number;
  archiveId: number;
  mediaType: "video" | "image";
  mixKind?: string | null;
  title?: string | null;
  tags?: string[] | null;
  tagsSetByHand?: number | null;
  sourceNote?: string | null;
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
  licenseNote?: string | null;
  isActive: number;
  parentAssetId?: number | null;
  splitIntoShotsAt?: Date | null;
};

export type TextVerdict = "has_text" | "clean" | "not_asked";

export type ShotPieceDeps = {
  getAsset: (id: number) => Promise<PieceParent | null>;
  fetchAsset: (id: number, dest: string) => Promise<boolean>;
  detect: (filePath: string) => Promise<{ durationSec: number; cutsSec: number[]; incomplete?: string }>;
  extract: (input: string, output: string, startSec: number, endSec: number) => Promise<void>;
  textVerdict: (piecePath: string, cacheKey: string) => Promise<TextVerdict>;
  storePiece: (
    parent: PieceParent,
    piecePath: string,
    piece: PieceRange & { index: number; verdict: TextVerdict }
  ) => Promise<number | null>;
  markParent: (id: number, change: { deactivate: boolean }) => Promise<void>;
  /**
   * Take the clip for this process before cutting it. Several worker copies sweep the same archive;
   * without this two of them cut the same clip and store its shots twice. Absent = always yours.
   */
  claim?: (id: number) => Promise<boolean>;
  workDir?: string;
  log?: (line: string) => void;
};

export type ShotSplitOutcome =
  | { status: "skipped"; reason: string }
  | { status: "kept_whole"; durationSec: number }
  | { status: "split"; pieces: number[]; withText: number; ranges: number };

/** May this asset be cut? Videos only, never a piece, never twice, never stock. */
export function splitEligibility(a: PieceParent | null): string | null {
  if (!a) return "the asset does not exist";
  if (a.mediaType !== "video") return "not a video";
  if (a.parentAssetId != null) return "it is already a piece";
  if (a.splitIntoShotsAt != null) return "it was already cut";
  if (a.mixKind === "stock") return "stock footage is not cut";
  return null;
}

export async function splitArchiveAssetIntoShots(
  assetId: number,
  deps: ShotPieceDeps,
  opts: { allowInactive?: boolean } = {}
): Promise<ShotSplitOutcome> {
  const say = deps.log ?? ((l: string) => console.log(l));
  const parent = await deps.getAsset(assetId);
  const notEligible = splitEligibility(parent);
  if (notEligible) return { status: "skipped", reason: notEligible };
  /** A clip an operator switched off stays off: its pieces would bring it back. */
  if (parent!.isActive !== 1 && !opts.allowInactive) return { status: "skipped", reason: "switched off in the archive" };
  if (deps.claim && !(await deps.claim(assetId))) return { status: "skipped", reason: "another worker is cutting it" };

  const dir = fs.mkdtempSync(path.join(deps.workDir ?? os.tmpdir(), `archive-pieces-${assetId}-`));
  try {
    const src = path.join(dir, "source.mp4");
    if (!(await deps.fetchAsset(assetId, src))) return { status: "skipped", reason: "the file could not be fetched" };
    const found = await deps.detect(src);
    if (found.incomplete) {
      /** Cuts we did not see are cuts a piece could straddle. Left whole, looked at, and said so. */
      await deps.markParent(assetId, { deactivate: false });
      say(`[ArchivePieces] asset=${assetId} left whole — the cut scan did not finish (${found.incomplete})`);
      return { status: "skipped", reason: `cut scan incomplete: ${found.incomplete}` };
    }
    const ranges = shotPieceRanges(found.durationSec, found.cutsSec);
    const whole = isAlreadyOnePiece(found.durationSec, ranges);

    const pieces: number[] = [];
    let withText = 0;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const out = path.join(dir, `piece_${i}.mp4`);
      /** A clip that is already one piece is judged as itself, not re-encoded to judge a copy. */
      if (whole) fs.copyFileSync(src, out);
      else await deps.extract(src, out, r.startSec, r.endSec);
      const verdict = await deps.textVerdict(out, `archive-piece:${assetId}:${r.startSec}-${r.endSec}`);
      if (verdict === "has_text") {
        withText += 1;
        continue;
      }
      if (whole) break;
      const id = await deps.storePiece(parent!, out, { ...r, index: i, verdict });
      if (id != null) pieces.push(id);
    }

    if (whole && withText === 0) {
      await deps.markParent(assetId, { deactivate: false });
      say(`[ArchivePieces] asset=${assetId} kept whole — one shot, ${found.durationSec.toFixed(1)}s, no text`);
      return { status: "kept_whole", durationSec: found.durationSec };
    }
    /**
     * Switched off when something takes its place, when it carries text, or when it holds cuts and
     * no shot long enough to use — a clip with a transition in it is not offered as a shot.
     */
    const deactivate = pieces.length > 0 || withText > 0 || ranges.length === 0;
    await deps.markParent(assetId, { deactivate });
    say(
      `[ArchivePieces] asset=${assetId} ${found.durationSec.toFixed(1)}s cut into ${ranges.length} piece(s): ` +
        `kept=${pieces.length} withText=${withText} cuts=${found.cutsSec.length}` +
        (deactivate ? " — the long original is no longer offered" : "")
    );
    return { status: "split", pieces, withText, ranges: ranges.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ═══════════════════════ production wiring ═══════════════════════ */

/** The source URL a piece is known by: the parent's, plus the seconds it covers. Unique per piece. */
export function pieceSourceUrl(parentUrl: string | null | undefined, parentId: number, r: PieceRange): string {
  const base = parentUrl?.trim() || `fastvid-archive:${parentId}`;
  return `${base}#shot=${r.startSec.toFixed(2)}-${r.endSec.toFixed(2)}`;
}

export async function productionShotPieceDeps(): Promise<ShotPieceDeps> {
  const [{ productionShotCutDeps }, splitter, db, storage, filter, tagRule] = await Promise.all([
    import("./youtubeShotCuts"),
    import("./archiveVideoSplitter"),
    import("./db"),
    import("./storage"),
    import("./archiveClipFilter"),
    import("./archiveTagRule"),
  ]);
  const cutDeps = productionShotCutDeps();
  return {
    getAsset: async (id) => {
      const row = await db.getMediaArchiveAssetById(id);
      return row ? (row as unknown as PieceParent) : null;
    },
    fetchAsset: cutDeps.fetchAsset,
    detect: cutDeps.detect,
    extract: (input, output, startSec, endSec) => splitter.extractVideoSegment(input, output, startSec, endSec),
    /** VIDEO 621 — the archive's own check, never on a render's budget. */
    textVerdict: async (piecePath, key) => (await filter.archiveClipTextVerdict(piecePath, "video/mp4", key)).verdict as TextVerdict,
    storePiece: async (parent, piecePath, piece) => {
      const data = await fs.promises.readFile(piecePath);
      const { key, url } = await storage.storagePut(
        `archive-pieces/${parent.archiveId}/${parent.id}-${piece.index}.mp4`,
        data,
        "video/mp4"
      );
      const sourceUrl = pieceSourceUrl(parent.sourceUrl, parent.id, piece);
      const title = `${(parent.title ?? "Clip").slice(0, 480)} · shot ${piece.index + 1}`;
      return (
        (await db.createMediaArchiveAsset({
          archiveId: parent.archiveId,
          title,
          mediaType: "video",
          mixKind: "real_video",
          mimeType: "video/mp4",
          storageUrl: url,
          storageKey: key,
          ...(parent.tagsSetByHand === 1
            ? { tags: parent.tags ?? [], tagsSetByHand: 1 }
            : { tags: tagRule.archiveTagsAtMostTwo(parent.tags ?? [], parent.title ?? "") }),
          sourceNote: `${(parent.sourceNote ?? `archive:${parent.id}`).slice(0, 470)}#shot${piece.index + 1}`,
          licenseNote: parent.licenseNote ?? undefined,
          durationSec: Number((piece.endSec - piece.startSec).toFixed(2)),
          isActive: 1,
          sourceUrl,
          sourceUrlHash: createHash("sha256").update(sourceUrl).digest("hex"),
          sourcePlatform: parent.sourcePlatform ?? undefined,
          downloadedAt: new Date(),
          shotCutsSec: [],
          parentAssetId: parent.id,
          hasBakedEditText: piece.verdict === "clean" ? 0 : null,
        })) ?? null
      );
    },
    claim: (id) => db.claimArchiveAssetForShotSplit(id),
    markParent: async (id, change) => {
      await db.updateMediaArchiveAsset(id, {
        splitIntoShotsAt: new Date(),
        ...(change.deactivate ? { isActive: 0 } : {}),
      });
    },
  };
}

/**
 * One split at a time, in the background. Called when a video enters the archive and by the sweep;
 * a queue rather than a pool because every split runs ffmpeg and a vision check per piece, and a
 * render running beside it must not be starved of either.
 */
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<number>();

export function queueArchiveShotSplit(assetId: number, opts: { allowInactive?: boolean } = {}): void {
  if (queued.has(assetId)) return;
  queued.add(assetId);
  chain = chain
    .then(async () => splitArchiveAssetIntoShots(assetId, await productionShotPieceDeps(), opts))
    .catch((err) => console.warn(`[ArchivePieces] asset=${assetId} failed:`, (err as Error)?.message?.slice(0, 160)))
    .finally(() => queued.delete(assetId));
}

/** How many splits are waiting — the sweep only adds more when the queue is empty. */
export function queuedArchiveShotSplits(): number {
  return queued.size;
}

/**
 * The archive that was stored before this rule: a few videos at a time, only while nothing renders.
 */
export async function sweepArchiveShotSplits(isIdle: () => boolean, batch = 10): Promise<number> {
  if (!isIdle() || queued.size > 0) return 0;
  const { listArchiveAssetsAwaitingShotSplit } = await import("./db");
  const ids = await listArchiveAssetsAwaitingShotSplit(batch);
  for (const id of ids) queueArchiveShotSplit(id);
  if (ids.length) console.log(`[ArchivePieces] sweep queued ${ids.length} archive video(s) to cut into shots`);
  return ids.length;
}

export function startArchiveShotSplitSweep(isIdle: () => boolean, everyMs = 2 * 60_000): NodeJS.Timeout {
  return setInterval(() => {
    void sweepArchiveShotSplits(isIdle).catch((err) =>
      console.warn("[ArchivePieces] sweep failed:", (err as Error)?.message?.slice(0, 160))
    );
  }, everyMs);
}

/* ═══════════════════════ cut BEFORE the archive: a new download is stored as shots ═══════════════════════ */

/**
 * VIDEO 619 (follow-up) — THE ARCHIVE NEVER HOLDS THE LONG CLIP ANY MORE.
 *
 * Cutting afterwards left every 30-second download in the archive, offered as it was, until a
 * background sweep came round to it — and the sweep went oldest first. A downloaded file is now cut
 * where the picture changes before anything is stored; only its single shots go in, each checked
 * for text on its own, and each usable at once.
 */
export type LocalShotCutter = {
  detect: (filePath: string) => Promise<{ durationSec: number; cutsSec: number[]; incomplete?: string }>;
  extract: (input: string, output: string, startSec: number, endSec: number) => Promise<void>;
};

export type LocalShotCut =
  /** The file is one shot of at most eleven seconds: store it as it is. */
  | { kind: "one_shot"; durationSec: number }
  /** The file holds several shots (or one long one): these files are what gets stored. */
  | { kind: "pieces"; pieces: Array<PieceRange & { path: string }>; cuts: number }
  /** Every shot is shorter than a usable piece: nothing in it is one shot long enough. */
  | { kind: "no_clean_shot"; durationSec: number; cuts: number }
  /** The cut scan did not finish: the file is stored whole and the sweep looks again later. */
  | { kind: "unmeasured"; reason: string };

export async function cutLocalVideoIntoShots(
  localPath: string,
  workDir: string,
  cutter: LocalShotCutter
): Promise<LocalShotCut> {
  const found = await cutter.detect(localPath);
  if (found.incomplete) return { kind: "unmeasured", reason: found.incomplete };
  const ranges = shotPieceRanges(found.durationSec, found.cutsSec);
  if (isAlreadyOnePiece(found.durationSec, ranges)) return { kind: "one_shot", durationSec: found.durationSec };
  if (ranges.length === 0) return { kind: "no_clean_shot", durationSec: found.durationSec, cuts: found.cutsSec.length };
  const pieces: Array<PieceRange & { path: string }> = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    const out = path.join(workDir, `shot_${i + 1}.mp4`);
    await cutter.extract(localPath, out, r.startSec, r.endSec);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) pieces.push({ ...r, path: out });
  }
  return { kind: "pieces", pieces, cuts: found.cutsSec.length };
}

export async function productionLocalShotCutter(): Promise<LocalShotCutter> {
  const [{ productionShotCutDeps }, splitter] = await Promise.all([
    import("./youtubeShotCuts"),
    import("./archiveVideoSplitter"),
  ]);
  const cutDeps = productionShotCutDeps();
  return {
    detect: cutDeps.detect,
    extract: (input, output, startSec, endSec) => splitter.extractVideoSegment(input, output, startSec, endSec),
  };
}

/** A shot's own source URL: the download's, plus the seconds it covers. The same shot is found again. */
export function shotSourceUrl(sourceUrl: string | undefined, sourceNote: string, r: PieceRange): string {
  const base = sourceUrl?.trim() || `fastvid-source:${sourceNote}`;
  return `${base}#shot=${r.startSec.toFixed(2)}-${r.endSec.toFixed(2)}`;
}
