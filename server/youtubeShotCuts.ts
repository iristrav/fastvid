/**
 * WHERE A YOUTUBE SOURCE CUTS TO ANOTHER SHOT — MEASURED ONCE, KEPT ON THE ARCHIVE ROW. RONDE 647.
 *
 * `youtubeShotLimit` may only take a piece from inside one continuous shot of the original video.
 * That needs the source's shot boundaries in the coordinates of the file the rehydrator returns —
 * the archive asset. They are a fact about the asset, so they are measured the first time a plan
 * needs them and written to `media_archive_assets.shotCutsSec`; every later plan reads the column.
 *
 * The detector is the archive splitter's own (`detectInteriorCutTimesInFile`, scdet + scene
 * filter). No second detector. The file comes back through the production archive's own
 * read-back, so the same storage rules apply.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AssetSourceIdentity } from "./projectTimeline";
import type { YoutubeSourceFacts } from "./youtubeShotLimit";

const YOUTUBE_PROVIDERS = new Set(["youtube_cc", "youtube"]);

export type ShotCutRow = {
  sourcePlatform?: string | null;
  sourceNote?: string | null;
  durationSec?: number | null;
  shotCutsSec?: number[] | null;
};

/** Is this archive row, or this identity, footage that came from YouTube? */
export function isYoutubeOrigin(identity: AssetSourceIdentity, row: ShotCutRow | null): boolean {
  if (YOUTUBE_PROVIDERS.has((identity.provider ?? "").trim().toLowerCase())) return true;
  if (!row) return false;
  if ((row.sourcePlatform ?? "").trim().toLowerCase() === "youtube_cc") return true;
  return (row.sourceNote ?? "").trim().toLowerCase().startsWith("youtube_cc:");
}

export type ShotCutDeps = {
  getAsset: (archiveAssetId: number) => Promise<ShotCutRow | null>;
  /** Put the archive asset's stored file at `dest`. */
  fetchAsset: (archiveAssetId: number, dest: string) => Promise<boolean>;
  detect: (filePath: string) => Promise<{ durationSec: number; cutsSec: number[] }>;
  save: (archiveAssetId: number, cutsSec: number[], durationSec: number) => Promise<void>;
  workDir?: string;
  log?: (line: string) => void;
};

/**
 * The facts `limitYoutubeShots` needs for one shot, or null when the shot is not from YouTube.
 *
 * A YouTube shot with no archive row gets `measured: false` and an unknown length, and its pieces
 * simply follow each other — see `planYoutubePieces`. It is still limited to five seconds.
 */
export async function youtubeSourceFactsFor(
  identity: AssetSourceIdentity,
  deps: ShotCutDeps
): Promise<YoutubeSourceFacts | null> {
  const say = deps.log ?? ((l: string) => console.log(l));
  const id = identity.archiveAssetId ?? null;
  const row = id != null ? await deps.getAsset(id).catch(() => null) : null;
  if (!isYoutubeOrigin(identity, row)) return null;
  if (id == null || !row) {
    say(
      `[YouTubeShots] provider=${identity.provider} id=${identity.providerAssetId ?? "?"} has no ` +
        `archive row — its length and cuts are unknown`
    );
    return { sourceDurationSec: 0, cutsSec: [], measured: false };
  }
  if (Array.isArray(row.shotCutsSec) && row.durationSec && row.durationSec > 0) {
    return { sourceDurationSec: row.durationSec, cutsSec: row.shotCutsSec, measured: true };
  }

  const dir = fs.mkdtempSync(path.join(deps.workDir ?? os.tmpdir(), "fastvid_shotcuts_"));
  const dest = path.join(dir, `asset_${id}.mp4`);
  try {
    const fetched = await deps.fetchAsset(id, dest).catch(() => false);
    if (!fetched) {
      say(`[YouTubeShots] archiveAsset=${id} could not be read back — treated as one shot`);
      return {
        sourceDurationSec: row.durationSec && row.durationSec > 0 ? row.durationSec : 0,
        cutsSec: [],
        measured: false,
      };
    }
    const measured = await deps.detect(dest);
    const durationSec = measured.durationSec > 0 ? measured.durationSec : row.durationSec ?? 0;
    const cutsSec = measured.cutsSec
      .filter((c) => Number.isFinite(c) && c > 0 && c < durationSec)
      .map((c) => Number(c.toFixed(3)))
      .sort((a, b) => a - b);
    await deps.save(id, cutsSec, durationSec).catch((err: Error) => {
      say(`[YouTubeShots] archiveAsset=${id} cuts measured but not saved: ${err.message?.slice(0, 120)}`);
    });
    say(
      `[YouTubeShots] archiveAsset=${id} measured duration=${durationSec.toFixed(2)}s ` +
        `cuts=${cutsSec.length ? cutsSec.map((c) => c.toFixed(2)).join(",") : "none"}`
    );
    return { sourceDurationSec: durationSec, cutsSec, measured: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The real modules. Lazy imports, so a test can exercise `youtubeSourceFactsFor` without them. */
export function productionShotCutDeps(workDir?: string): ShotCutDeps {
  return {
    workDir,
    getAsset: async (id) => {
      const { getMediaArchiveAssetById } = await import("./db");
      const row = await getMediaArchiveAssetById(id);
      return row
        ? {
            sourcePlatform: row.sourcePlatform,
            sourceNote: row.sourceNote,
            durationSec: row.durationSec,
            shotCutsSec: (row as { shotCutsSec?: number[] | null }).shotCutsSec ?? null,
          }
        : null;
    },
    fetchAsset: async (id, dest) => {
      const [{ productionArchiveDeps }, { downloadToFileStreaming }] = await Promise.all([
        import("./productionMediaArchive"),
        import("./videoPipeline"),
      ]);
      const deps = productionArchiveDeps({
        download: async (url, to) => {
          await downloadToFileStreaming(url, to, 120_000, "youtubeShotCuts:fetch");
          return fs.existsSync(to) && fs.statSync(to).size > 0;
        },
      });
      return deps.readBack(id, dest);
    },
    detect: async (filePath) => {
      const { detectInteriorCutTimesInFile, probeVideoDurationSec, ffmpegBin } = await import("./archiveVideoSplitter");
      const { detectGradualTransitionsInFile, cutsWithTransitions } = await import("./youtubeSoftCuts");
      const durationSec = await probeVideoDurationSec(filePath);
      if (!(durationSec > 0)) return { durationSec, cutsSec: [] };
      /**
       * RONDE 654 — hard cuts AND the edges of every dissolve or fade, so a piece can sit inside
       * neither. Both passes run on the same file at the same time.
       */
      const [hard, soft] = await Promise.all([
        detectInteriorCutTimesInFile(filePath, durationSec),
        detectGradualTransitionsInFile(filePath, { ffmpegBin: ffmpegBin() }),
      ]);
      return { durationSec, cutsSec: cutsWithTransitions(hard, soft) };
    },
    save: async (id, cutsSec, durationSec) => {
      const { updateMediaArchiveAsset } = await import("./db");
      await updateMediaArchiveAsset(id, { shotCutsSec: cutsSec, durationSec });
    },
  };
}
