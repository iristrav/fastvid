/**
 * RONDE 652 — THE CUSTOMER SEES WHICH SHOTS NEED A RIGHTS CHECK BEFORE PUBLISHING.
 *
 * FastVid uses YouTube footage whose licence it cannot always prove: a clip found under YouTube's
 * Creative Commons filter carries YouTube's own CC BY statement, but one found under the standard
 * licence or the unfiltered ("fair use") search carries none. The render log has said so for a
 * long time — "rights NOT proven, verify manually before publishing" — in a place the customer
 * never sees. The person who publishes the video carried the risk without being told.
 *
 * The operator chose to keep using that footage and to tell the customer. This module answers, for
 * one delivered timeline, which YouTube videos appear in it, where, and what is known about their
 * licence. It reads what the archive recorded when the clip was taken — the search mode that found
 * it — and claims nothing more: `creative_commons` means YouTube reported CC BY for the video, not
 * that FastVid or anyone verified it further.
 */
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";

export type FootageRightsStatus =
  /** Found under YouTube's Creative Commons filter: YouTube reports CC BY. Attribution required. */
  | "creative_commons"
  /** Found under YouTube's standard licence: reuse is not granted by the licence. */
  | "standard_youtube_licence"
  /** Found without a licence filter, or nothing was recorded. */
  | "unknown";

export type FootageArchiveRow = {
  id: number;
  licenseNote?: string | null;
  sourcePlatform?: string | null;
  sourceNote?: string | null;
  sourceUrl?: string | null;
  title?: string | null;
};

export type FootageRightsEntry = {
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  title: string | null;
  status: FootageRightsStatus;
  /** Where in the delivered video it is on screen, in seconds, merged per video. */
  appearances: Array<{ start: number; end: number }>;
};

export type FootageRightsReport = {
  entries: FootageRightsEntry[];
  /** YouTube videos whose licence is not proven — the ones to check before publishing. */
  needsCheck: number;
  /** Seconds of YouTube footage on screen, and how many of them need a check. */
  youtubeSeconds: number;
  needsCheckSeconds: number;
};

const YOUTUBE_PROVIDERS = new Set(["youtube", "youtube_cc"]);

export function classifyYoutubeFootageLicence(licenseNote: string | null | undefined): FootageRightsStatus {
  const note = licenseNote?.trim().toLowerCase() ?? "";
  if (/creative_?commons?/.test(note)) return "creative_commons";
  if (note === "youtube") return "standard_youtube_licence";
  return "unknown";
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** The YouTube id, from whichever of the recorded places holds it. Never guessed. */
export function youtubeVideoIdFor(clip: TimelineVideoClip, row?: FootageArchiveRow): string | null {
  const direct = clip.source.providerAssetId?.trim();
  if (direct && YT_ID.test(direct) && YOUTUBE_PROVIDERS.has(clip.source.provider)) return direct;
  const fromNote = row?.sourceNote?.match(/^youtube(?:_cc)?:([A-Za-z0-9_-]{11})/)?.[1];
  if (fromNote) return fromNote;
  const url = row?.sourceUrl ?? clip.source.sourcePageUrl ?? "";
  const fromUrl = url.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)?.[1];
  return fromUrl ?? null;
}

function isYoutubeClip(clip: TimelineVideoClip, row?: FootageArchiveRow): boolean {
  if (YOUTUBE_PROVIDERS.has(clip.source.provider)) return true;
  return row?.sourcePlatform != null && YOUTUBE_PROVIDERS.has(row.sourcePlatform);
}

function videoClips(timeline: ProjectTimeline): TimelineVideoClip[] {
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  return track && track.kind === "VIDEO" ? track.clips.filter((c) => !c.disabled) : [];
}

/** The archive rows the report needs: every enabled video clip that the archive holds. */
export function archiveIdsForFootageRights(timeline: ProjectTimeline): number[] {
  return [
    ...new Set(
      videoClips(timeline)
        .map((c) => c.source.archiveAssetId)
        .filter((id): id is number => typeof id === "number" && id > 0)
    ),
  ];
}

const round = (n: number) => Math.round(n * 10) / 10;

export function footageRightsReport(
  timeline: ProjectTimeline,
  rows: ReadonlyArray<FootageArchiveRow>
): FootageRightsReport {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byVideo = new Map<string, FootageRightsEntry>();
  for (const clip of videoClips(timeline)) {
    const row = clip.source.archiveAssetId != null ? byId.get(clip.source.archiveAssetId) : undefined;
    if (!isYoutubeClip(clip, row)) continue;
    const youtubeVideoId = youtubeVideoIdFor(clip, row);
    const key = youtubeVideoId ?? `clip:${clip.id}`;
    const status = classifyYoutubeFootageLicence(row?.licenseNote);
    const entry =
      byVideo.get(key) ??
      ({
        youtubeVideoId,
        youtubeUrl: youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : null,
        title: row?.title?.trim() || clip.source.title?.trim() || null,
        status,
        appearances: [],
      } satisfies FootageRightsEntry);
    /** Two archive rows of one video can disagree; the weaker claim wins. */
    if (entry.status === "creative_commons" && status !== "creative_commons") entry.status = status;
    const last = entry.appearances[entry.appearances.length - 1];
    if (last && clip.timelineStart - last.end < 0.05) last.end = Math.max(last.end, clip.timelineEnd);
    else entry.appearances.push({ start: clip.timelineStart, end: clip.timelineEnd });
    byVideo.set(key, entry);
  }
  const entries = [...byVideo.values()]
    .map((e) => ({ ...e, appearances: e.appearances.map((a) => ({ start: round(a.start), end: round(a.end) })) }))
    .sort((a, b) => (a.appearances[0]?.start ?? 0) - (b.appearances[0]?.start ?? 0));
  const seconds = (e: FootageRightsEntry) => e.appearances.reduce((s, a) => s + (a.end - a.start), 0);
  const unproven = entries.filter((e) => e.status !== "creative_commons");
  return {
    entries,
    needsCheck: unproven.length,
    youtubeSeconds: round(entries.reduce((s, e) => s + seconds(e), 0)),
    needsCheckSeconds: round(unproven.reduce((s, e) => s + seconds(e), 0)),
  };
}
