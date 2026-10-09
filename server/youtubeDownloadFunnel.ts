/**
 * P1 — THE RENDER'S DOWNLOADS, COUNTED WHERE THEY END.
 *
 * Render 643 asked YouTube for 14 stock videos and got 5, and the only per-render account was
 * `downloadOutcomes` by status: no line said how many of those exits were real transfers rather than
 * a refusal remembered from earlier, which refusal class each failure was, or that NDl1ztoOseI —
 * refused during the render — arrived through the background prefetch at 20:29, after the film was
 * delivered. This counts what `reportDownload` already knows at its one exit; it asks nothing new.
 *
 * Render-scoped like the refusal memo beside it: started where the render resets that memo, printed
 * and closed with the render's YouTube summary. A download reported while no render is open is the
 * background prefetch (it only runs when the worker is idle): it is set against the last render's
 * own outcome for that video, so "refused in the render, delivered after it" is a line, not a guess.
 */

export type YoutubeDownloadExit = {
  videoId: string;
  status: string;
  reason: string;
  /** One per route actually asked; empty when the exit was decided before any transfer. */
  attempts: readonly { status: string; detail: string }[];
};

type RenderTally = {
  renderId: number | string;
  /** Exits of `downloadYouTubeCCClip`, every one. */
  exits: number;
  /** FIX 4 — exits where the service was actually asked for bytes (a transfer started). */
  attempts: number;
  /** FIX 4 — exits that recorded a route attempt but never started a transfer, by why. */
  notStartedByClass: Record<string, number>;
  delivered: number;
  /** Delivered without a transfer: the same seconds or the same request already had the file. */
  reused: number;
  failedByClass: Record<string, number>;
  /** Exits decided before any transfer, by why (known_unusable, refused_this_render, …). */
  skippedByClass: Record<string, number>;
  /** videoId → what this render last saw for it. */
  outcome: Map<string, { refused: string | null; delivered: boolean }>;
  deliveredAfterRefusal: Set<string>;
};

let current: RenderTally | null = null;
let lastRender: { renderId: number | string; outcome: RenderTally["outcome"] } | null = null;

/** The class an existing refusal already carries; the raw status when it carries none. */
export function youtubeDownloadFailureClass(exit: Pick<YoutubeDownloadExit, "status" | "attempts">): string {
  const last = exit.attempts[exit.attempts.length - 1];
  const detail = last?.detail ?? "";
  /** `youtubeServiceRefusalReason`: `http_403:stream_refused`, `http_502:other:…`. */
  const service = detail.match(/^http_\d+:([a-z_]+)/);
  if (service) return service[1]!;
  if (detail.startsWith("cloud_egress_blocked")) return "cloud_egress_blocked";
  /** `${code}:${detail}` from the content verdict: NO_VIDEO_STREAM, BLACK_FRAMES, … */
  if (exit.status === "DOWNLOAD_INVALID_CONTENT") {
    const code = detail.match(/^([A-Z][A-Z_]+):/);
    if (code) return code[1]!;
  }
  return exit.status || "UNKNOWN";
}

/**
 * FIX 4 — A ROUTE NOTED IS NOT A TRANSFER STARTED. Two notes are written without the service ever
 * being called: the scene budget below the download floor (`scene_budget_<n>s_left`) and the cloud
 * egress latch (`cloud_egress_blocked:…`). `transferStarted` cannot tell them apart: nothing in
 * `downloadYouTubeCCClip` sets it any more (lost with the RapidAPI route in 799fa6b).
 */
const NOT_STARTED_DETAIL = /^(scene_budget_\d+s_left|cloud_egress_blocked)/;
export function youtubeDownloadTransferStarted(exit: Pick<YoutubeDownloadExit, "attempts">): boolean {
  return exit.attempts.some((a) => !NOT_STARTED_DETAIL.test(a.detail ?? ""));
}

/** Why an exit that never transferred anything ended where it did: the token before the first `:`. */
function skipClass(reason: string): string {
  const head = (reason || "").split(":")[0]!.trim();
  return head || "UNKNOWN";
}

export function startYoutubeDownloadFunnel(renderId: number | string): void {
  closeYoutubeDownloadFunnel();
  current = {
    renderId,
    exits: 0,
    attempts: 0,
    notStartedByClass: {},
    delivered: 0,
    reused: 0,
    failedByClass: {},
    skippedByClass: {},
    outcome: new Map(),
    deliveredAfterRefusal: new Set(),
  };
}

/** Ends the render's tally; downloads after this are the background's. Idempotent. */
export function closeYoutubeDownloadFunnel(): void {
  if (!current) return;
  lastRender = { renderId: current.renderId, outcome: current.outcome };
  current = null;
}

/**
 * One exit of `downloadYouTubeCCClip`. Returns a line to print when the exit is worth one on its own
 * (a background delivery of a video the last render had refused), else null.
 */
export function noteYoutubeDownloadExit(exit: YoutubeDownloadExit): string | null {
  const ok = exit.status === "DOWNLOAD_SUCCESS";
  const transferred = youtubeDownloadTransferStarted(exit);
  if (!current) {
    if (!ok || !transferred || !lastRender) return null;
    const before = lastRender.outcome.get(exit.videoId);
    if (!before?.refused || before.delivered) return null;
    return `[YouTubeFunnel] afterRender=${lastRender.renderId} video=${exit.videoId} deliveredByPrefetch refusedInRender=${before.refused}`;
  }
  const t = current;
  t.exits++;
  const seen = t.outcome.get(exit.videoId) ?? { refused: null, delivered: false };
  if (!transferred) {
    if (ok) t.reused++;
    else if (exit.attempts.length > 0) {
      /** A route was noted and never called: not a transfer, not a refusal of the video. */
      const k = (exit.attempts[exit.attempts.length - 1]!.detail ?? "").match(NOT_STARTED_DETAIL)?.[1]?.replace(/_\d+s_left$/, "") ?? "UNKNOWN";
      t.notStartedByClass[k] = (t.notStartedByClass[k] ?? 0) + 1;
    } else {
      const k = skipClass(exit.reason);
      t.skippedByClass[k] = (t.skippedByClass[k] ?? 0) + 1;
    }
    t.outcome.set(exit.videoId, seen);
    return null;
  }
  t.attempts++;
  if (ok) {
    t.delivered++;
    if (seen.refused) t.deliveredAfterRefusal.add(exit.videoId);
    seen.delivered = true;
  } else {
    const k = youtubeDownloadFailureClass(exit);
    t.failedByClass[k] = (t.failedByClass[k] ?? 0) + 1;
    seen.refused = k;
  }
  t.outcome.set(exit.videoId, seen);
  return null;
}

const byCount = (r: Record<string, number>) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");

/** The render's one line, or null when no render is open. */
export function formatYoutubeDownloadFunnel(): string | null {
  const t = current;
  if (!t) return null;
  const failed = Object.values(t.failedByClass).reduce((a, b) => a + b, 0);
  const videos = [...t.outcome.values()];
  return (
    `[YouTubeFunnel] render=${t.renderId} downloads exits=${t.exits} transfers=${t.attempts} delivered=${t.delivered} ` +
    `failed=${failed} {${byCount(t.failedByClass)}} notStarted={${byCount(t.notStartedByClass)}} reused=${t.reused} skipped={${byCount(t.skippedByClass)}} ` +
    `videos=${videos.length} videosDelivered=${videos.filter((v) => v.delivered).length} videosRefused=${videos.filter((v) => v.refused && !v.delivered).length} ` +
    `deliveredAfterRefusal=${t.deliveredAfterRefusal.size}` +
    (t.deliveredAfterRefusal.size ? ` [${[...t.deliveredAfterRefusal].join(",")}]` : "")
  );
}

/** STEP 0 — the open render's download counts for the quality line (`[QualityRescue]`); null when no render is open. */
export function youtubeDownloadFunnelCounts(): {
  transfers: number;
  delivered: number;
  videos: number;
  videosDelivered: number;
  failedByClass: Readonly<Record<string, number>>;
} | null {
  const t = current;
  if (!t) return null;
  const videos = [...t.outcome.values()];
  return {
    transfers: t.attempts,
    delivered: t.delivered,
    videos: videos.length,
    videosDelivered: videos.filter((v) => v.delivered).length,
    failedByClass: { ...t.failedByClass },
  };
}

/** Tests only. */
export function resetYoutubeDownloadFunnelForTests(): void {
  current = null;
  lastRender = null;
}
