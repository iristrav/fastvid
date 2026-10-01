/**
 * HOW MANY SECONDS OF THIS FILM ARE YOUTUBE — RONDE 643.
 *
 * A render that found 49 YouTube videos, downloaded none and delivered a film built from the archive,
 * Wikimedia and stock looked, from the outside, exactly like a render that worked. Every gate passed,
 * because nothing asked the one question the product is about: did any YouTube footage reach the
 * film? The lifecycle trace follows each asset; the usage summary counts per provider; neither says,
 * in seconds, what the viewer actually receives.
 *
 * This answers it from the timeline the delivered file was rendered from — the same `videoTrack`
 * the render job consumed — so it measures the film, not a plan for one.
 *
 * ── Two ways a YouTube picture reaches a film ───────────────────────────────────────────────
 *
 *   youtube_direct       a clip whose proven provider is youtube_cc (downloaded by this render)
 *   youtube_via_archive  an archive clip whose asset row says sourcePlatform = youtube_cc — which is
 *                        how everything the background prefetch (RONDE 640) fetched arrives
 *
 * Both are YouTube footage. Counting only the first would make the prefetch invisible in the one
 * number that shows whether it worked.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────────────────
 *
 * Not a gate by default. `REQUIRE_YOUTUBE_MIN_SECONDS` makes it one, for a deployment that has
 * decided a film without YouTube must not ship; unset, it reports and changes nothing.
 */
import type { TimelineVideoClip } from "./projectTimeline";

export const YOUTUBE_PROVIDER_ID = "youtube_cc";

export type YoutubeFilmClip = {
  clipId: string;
  videoId: string | null;
  origin: "youtube_direct" | "youtube_via_archive";
  seconds: number;
};

export type YoutubeFootage = {
  /** Which timeline this was measured on, said rather than implied. */
  basis: "rendered_timeline" | "planned_timeline" | "unmeasured";
  filmSec: number;
  youtubeSec: number;
  directSec: number;
  viaArchiveSec: number;
  videoIds: string[];
  clips: YoutubeFilmClip[];
};

export type ArchiveOrigin = { sourcePlatform: string | null; sourceUrl: string | null };

/** The video id in a watch URL, or null. Never guessed from anything else. */
export function youtubeIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{6,32}$/.test(v)) return v;
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      return /^[A-Za-z0-9_-]{6,32}$/.test(id) ? id : null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * ONE ROUTE — the source footage behind each archive asset of a timeline, for the DeliveryGate's
 * "one piece of footage fills the film" rule. A YouTube segment belongs to its YouTube video; a
 * shot piece cut from a longer archive clip (`parentAssetId`) belongs to that parent. Without the
 * second, the pieces of one uploaded or Internet Archive film were counted as separate footage and
 * could fill the whole film unseen.
 */
export async function footageSourceForArchiveAssets(
  clips: readonly { source?: { archiveAssetId?: number | null } }[],
  loadRow: (
    id: number
  ) => Promise<{ sourcePlatform?: string | null; sourceUrl?: string | null; parentAssetId?: number | null } | undefined | null>
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = Array.from(new Set(clips.flatMap((c) => (c.source?.archiveAssetId != null ? [c.source.archiveAssetId] : []))));
  for (const id of ids) {
    const row = await loadRow(id).catch(() => undefined);
    if (!row) continue;
    const videoId =
      (row.sourcePlatform ?? "").toLowerCase() === YOUTUBE_PROVIDER_ID ? youtubeIdFromUrl(row.sourceUrl) : null;
    if (videoId) out.set(id, `youtube:${videoId}`);
    else if (row.parentAssetId != null) out.set(id, `archive:${row.parentAssetId}`);
  }
  return out;
}

const clipSeconds = (c: TimelineVideoClip): number =>
  Math.max(0, (Number(c.timelineEnd) || 0) - (Number(c.timelineStart) || 0));

/**
 * Pure: the timeline and the archive rows it points at are passed in.
 *
 * `archiveOrigins` holds only the rows the caller could read. A clip whose archive row is missing
 * is not counted as YouTube — an unproven origin is not YouTube footage.
 */
export function youtubeFootageInTimeline(
  clips: readonly TimelineVideoClip[],
  archiveOrigins: ReadonlyMap<number, ArchiveOrigin>,
  basis: YoutubeFootage["basis"]
): YoutubeFootage {
  const live = clips.filter((c) => !c.disabled);
  const found: YoutubeFilmClip[] = [];
  for (const c of live) {
    const seconds = clipSeconds(c);
    if (c.source?.provider === YOUTUBE_PROVIDER_ID) {
      found.push({ clipId: c.id, videoId: c.source.providerAssetId ?? null, origin: "youtube_direct", seconds });
      continue;
    }
    const assetId = c.source?.archiveAssetId;
    const origin = assetId != null ? archiveOrigins.get(assetId) : undefined;
    if (origin && (origin.sourcePlatform ?? "").toLowerCase() === YOUTUBE_PROVIDER_ID) {
      found.push({ clipId: c.id, videoId: youtubeIdFromUrl(origin.sourceUrl), origin: "youtube_via_archive", seconds });
    }
  }
  const sum = (xs: readonly number[]) => Number(xs.reduce((a, b) => a + b, 0).toFixed(2));
  return {
    basis,
    filmSec: sum(live.map(clipSeconds)),
    youtubeSec: sum(found.map((f) => f.seconds)),
    directSec: sum(found.filter((f) => f.origin === "youtube_direct").map((f) => f.seconds)),
    viaArchiveSec: sum(found.filter((f) => f.origin === "youtube_via_archive").map((f) => f.seconds)),
    videoIds: Array.from(new Set(found.flatMap((f) => (f.videoId ? [f.videoId] : [])))),
    clips: found,
  };
}

/** The film had no timeline this system can read (the legacy compose route). Said, not zeroed. */
export function unmeasuredFootage(): YoutubeFootage {
  return { basis: "unmeasured", filmSec: 0, youtubeSec: 0, directSec: 0, viaArchiveSec: 0, videoIds: [], clips: [] };
}

/**
 * One line, always printed, and loud when the answer is zero.
 *
 * The funnel counts come from the lifecycle trace, so a zero says WHERE YouTube stopped rather than
 * only that it did.
 */
export function formatYoutubeFootage(
  videoId: number,
  f: YoutubeFootage,
  funnel?: { found?: number; downloaded?: number; adopted?: number },
  /**
   * VIDEO 616 — `delivered: false` marks a timeline the delivery gate refused: measured, so an
   * archive clip of YouTube origin is counted as YouTube, and said to be a film nobody received.
   * `adopted` is this render's fresh YouTube adoptions; archive clips of YouTube origin are counted
   * separately, from the timeline, as `adoptedViaArchive`.
   */
  opts: { delivered?: boolean } = {}
): string {
  const viaArchiveVideos = new Set(f.clips.filter((c) => c.origin === "youtube_via_archive").map((c) => c.videoId ?? c.clipId)).size;
  const tail =
    (funnel
      ? ` found=${funnel.found ?? "?"} downloaded=${funnel.downloaded ?? "?"} adopted=${funnel.adopted ?? "?"}` +
        (viaArchiveVideos > 0 ? ` adoptedViaArchive=${viaArchiveVideos}` : "")
      : "") + (opts.delivered === false && f.basis !== "unmeasured" ? " — NOT DELIVERED (measured on the refused timeline)" : "");
  if (f.basis === "unmeasured") {
    return `[YouTubeInFilm] video=${videoId} basis=unmeasured — the delivered film has no readable timeline${tail}`;
  }
  const share = f.filmSec > 0 ? Math.round((f.youtubeSec / f.filmSec) * 100) : 0;
  if (f.youtubeSec <= 0) {
    return (
      `[YouTubeInFilm] video=${videoId} basis=${f.basis} youtubeSec=0 filmSec=${f.filmSec} share=0% — ` +
      `NO YOUTUBE FOOTAGE IN THIS FILM${tail}`
    );
  }
  return (
    `[YouTubeInFilm] video=${videoId} basis=${f.basis} youtubeSec=${f.youtubeSec} filmSec=${f.filmSec} ` +
    `share=${share}% direct=${f.directSec}s viaArchive=${f.viaArchiveSec}s ` +
    `videos=${f.videoIds.join(",") || "unidentified"}${tail}`
  );
}
