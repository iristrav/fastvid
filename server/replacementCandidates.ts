/**
 * RONDE 156 — finding alternatives for a shot the person does not want.
 *
 * ── What already existed, and what this adds ────────────────────────────────────────────────
 *
 * `replaceTimelineClipSource` (timelineStore) already swaps a source while keeping the slot, and
 * `timeline.replaceClip` (timelineRouter) already performs that swap taking the identity from the
 * ARCHIVE ROW rather than from the request. Both are correct and neither changes here.
 *
 * What was missing is the step before: a person could replace a clip only if they already knew the
 * id of the asset to replace it with. This module answers "what else could go here".
 *
 * ── Why the candidates come from the archive, and only the archive ──────────────────────────
 *
 * §2 says to use the existing retrieval infrastructure and not to build a second search engine. It
 * would be technically possible to run a live provider search here, and it would be wrong twice
 * over. The replacement route accepts an `archiveAssetId` and looks the identity up itself,
 * precisely so a client cannot name its own provider and launder a source into a timeline — a live
 * search would produce candidates that route cannot accept. And a provider result is not yet an
 * asset: it has no proven licence, no probe, no adoption record.
 *
 * So candidates are archive rows: already ingested, already licensed, already probed, and already
 * addressable by the id the replacement route wants.
 *
 * ── This module ranks; it does not choose ───────────────────────────────────────────────────
 *
 * §2's last line: "de gebruiker maakt de uiteindelijke keuze. Geen automatische substitution."
 * Every function here returns a LIST with reasons attached. Nothing in FastVid calls it and then
 * takes the first row.
 */
import type { ProjectTimeline, TimelineFormat, TimelineVideoClip } from "./projectTimeline";
import { captionTrack, textTrackOf, videoTrack } from "./projectTimeline";
import { foldSearchText } from "./searchTextNormalize";

/* ═══════════════════════ what a candidate looks like on the wire ═══════════════════════ */

/**
 * One replacement option, as the editor receives it.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────
 *
 * `storageUrl`. The archive row holds one and it may be a signed S3 URL; §5 and §32 both forbid a
 * private URL reaching the browser. The editor gets `previewUrl`, which is the application's own
 * streaming endpoint keyed by asset id — the same one the existing archive browser uses — so the
 * browser can show the clip without ever holding a credential.
 */
export type ReplacementCandidate = {
  /** What the replacement route needs, and the only handle the client ever sends back. */
  archiveAssetId: number;
  provider: string;
  title: string | null;
  mediaType: "video" | "image";
  durationSec: number | null;
  widthPx: number | null;
  heightPx: number | null;
  /** This application's own streaming URL, never the provider's and never a signed one. */
  previewUrl: string | null;
  thumbnailUrl: string | null;
  /** 0..1. Comparable only within one result set — it is a ranking, not a measurement. */
  score: number;
  /** Why this scored where it did, in words, for the person choosing. */
  reason: string;
  sourcePageUrl: string | null;
};

/** The archive columns this module reads. Narrow on purpose — see `candidateFromAsset`. */
export type ArchiveAssetLike = {
  id: number;
  title: string | null;
  mediaType: "video" | "image";
  mixKind?: string | null;
  tags?: string[] | null;
  entities?: string[] | null;
  topics?: string[] | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  editorialScore?: number | null;
  isActive?: number | null;
  hasBakedEditText?: number | null;
  previewIssue?: string | null;
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
};

/* ═══════════════════════ what the clip needs ═══════════════════════ */

/**
 * Everything known about the hole the replacement has to fill.
 *
 * Built by `replacementContextFor` from the timeline itself, so the caller cannot describe a slot
 * that does not exist and the ranking cannot be steered by a client.
 */
export type ReplacementContext = {
  clipId: string;
  /** How long the slot is. A candidate shorter than this cannot fill it without looping. */
  slotDurationSec: number;
  format: TimelineFormat;
  /** The narration and on-screen words around this moment — what the shot has to illustrate. */
  words: string[];
  /** The provider currently in the slot, so an alternative from elsewhere can be preferred. */
  currentProvider: string | null;
  currentArchiveAssetId: number | null;
  /** Every archive id already used elsewhere in this video — a replacement should not duplicate. */
  usedArchiveAssetIds: number[];
};

/**
 * Read the slot's context off the timeline.
 *
 * The words come from the captions and texts that OVERLAP the clip, because those are what the
 * viewer will be reading while this shot is on screen. Using the whole script instead would score
 * every candidate against the same words and rank them all identically.
 */
export function replacementContextFor(
  timeline: ProjectTimeline,
  clipId: string
): ReplacementContext | null {
  const clips = videoTrack(timeline);
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;

  const overlaps = (a: { start: number; end: number }) =>
    a.start < clip.timelineEnd && clip.timelineStart < a.end;

  const onScreenText = [
    ...captionTrack(timeline).filter((c) => !c.disabled && overlaps(c)).map((c) => c.text),
    ...textTrackOf(timeline, "TEXT").filter((t) => !t.disabled && overlaps(t)).map((t) => t.text),
  ].join(" ");
  // RONDE 88A: folded before the ASCII split. Unfolded, the caption word "Führerbunker" split
  // into "f" and "hrerbunker" and the replacement search ran on the fragment.
  const words = foldSearchText(onScreenText)
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 3);

  return {
    clipId,
    slotDurationSec: Math.max(0, clip.timelineEnd - clip.timelineStart),
    format: timeline.format,
    words: [...new Set(words)],
    currentProvider: clip.source.provider ?? null,
    currentArchiveAssetId: clip.source.archiveAssetId ?? null,
    usedArchiveAssetIds: clips
      .map((c) => c.source.archiveAssetId)
      .filter((id): id is number => id != null),
  };
}

/* ═══════════════════════ the technical filter ═══════════════════════ */

/**
 * Why an asset cannot fill this slot at all. Null when it can.
 *
 * These are TECHNICAL refusals, not editorial ones — they are the things that would produce a
 * broken video rather than a worse one, so they remove a candidate from the list instead of
 * lowering its score. Everything debatable belongs in the ranking below.
 */
export function technicalRejection(
  asset: ArchiveAssetLike,
  context: ReplacementContext
): string | null {
  if (asset.isActive === 0) return "the asset is deactivated in the archive";
  if (asset.previewIssue) return `the asset's preview is unusable (${asset.previewIssue})`;
  /**
   * A clip with baked-in edit text from another production cannot be used: the words belong to
   * somebody else's video and would appear in this one. This is an existing FastVid gate, applied
   * here for the same reason.
   */
  if (asset.hasBakedEditText === 1) return "the asset has burned-in text from another edit";
  if (asset.id === context.currentArchiveAssetId) return "that is the clip already in this slot";

  /**
   * A VIDEO shorter than the slot would have to loop or freeze to fill it. An IMAGE has no such
   * problem — a still is held for as long as the slot needs, which is what Ken Burns is for.
   */
  if (asset.mediaType === "video" && asset.durationSec != null) {
    if (asset.durationSec + 0.05 < context.slotDurationSec) {
      return (
        `the clip is ${asset.durationSec.toFixed(1)}s and the slot is ` +
        `${context.slotDurationSec.toFixed(1)}s`
      );
    }
  }
  return null;
}

/* ═══════════════════════ the ranking ═══════════════════════ */

/** How much each signal can contribute. They sum to 1, so `score` is genuinely 0..1. */
export const CANDIDATE_WEIGHTS = {
  /** Does it show what the narration is talking about? By far the most important question. */
  relevance: 0.45,
  /** An archivist's own quality score, where the row has one. */
  editorial: 0.2,
  /** Real footage over a still, where the slot can take either. */
  motion: 0.15,
  /** Does its shape suit the frame? A portrait clip in a landscape video is mostly bars. */
  aspect: 0.12,
  /** A source the video has not already used, so a replacement adds variety. */
  freshness: 0.08,
} as const;

function relevanceScore(asset: ArchiveAssetLike, words: readonly string[]): number {
  if (words.length === 0) return 0.5;
  const haystack = [
    asset.title ?? "",
    ...(asset.tags ?? []),
    ...(asset.entities ?? []),
    ...(asset.topics ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return 0;
  const hits = words.filter((w) => haystack.includes(w)).length;
  /**
   * Saturating rather than linear: matching three of the narration's words is a strong signal and
   * matching twelve is not four times stronger. A linear score would let a heavily-tagged asset
   * out-rank a precisely relevant one just by carrying more words.
   */
  return Math.min(1, hits / Math.min(4, words.length));
}

function aspectScore(asset: ArchiveAssetLike, format: TimelineFormat): number {
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) return 0.5;
  const want = format.widthPx / format.heightPx;
  const have = asset.width / asset.height;
  /** Ratio of the two, always ≤ 1, so a 16:9 clip in a 16:9 frame scores 1 and 9:16 scores ~0.32. */
  return Math.min(want, have) / Math.max(want, have);
}

/**
 * Score one asset for one slot, with the reason it got that score.
 *
 * Deterministic and pure: the same asset and context always produce the same number, which is what
 * lets the editor show a stable list and lets a test assert on it.
 */
export function scoreCandidate(
  asset: ArchiveAssetLike,
  context: ReplacementContext
): { score: number; reason: string } {
  const relevance = relevanceScore(asset, context.words);
  const editorial = asset.editorialScore != null ? Math.max(0, Math.min(100, asset.editorialScore)) / 100 : 0.5;
  const motion = asset.mediaType === "video" ? 1 : asset.mixKind === "photo" ? 0.4 : 0.6;
  const aspect = aspectScore(asset, context.format);
  const fresh = context.usedArchiveAssetIds.includes(asset.id) ? 0 : 1;

  const score =
    relevance * CANDIDATE_WEIGHTS.relevance +
    editorial * CANDIDATE_WEIGHTS.editorial +
    motion * CANDIDATE_WEIGHTS.motion +
    aspect * CANDIDATE_WEIGHTS.aspect +
    fresh * CANDIDATE_WEIGHTS.freshness;

  /** The reason names the two strongest contributions, which is what a person actually wants. */
  const parts: Array<[string, number]> = [
    [relevance >= 0.75 ? "matches the narration closely" : relevance > 0 ? "matches some of the narration" : "no keyword match", relevance * CANDIDATE_WEIGHTS.relevance],
    [asset.mediaType === "video" ? "real footage" : "a still image", motion * CANDIDATE_WEIGHTS.motion],
    [aspect > 0.9 ? "fits the frame" : "will need padding or cropping", aspect * CANDIDATE_WEIGHTS.aspect],
  ];
  parts.sort((a, b) => b[1] - a[1]);

  /**
   * "Already used" is always said, whatever it weighs.
   *
   * Freshness carries the smallest weight, so it never wins a place in a top-two list — and yet it
   * is the one fact a person choosing between two similar clips most needs. A warning that only
   * appears when it is also the biggest number is a warning that never appears.
   */
  const alreadyUsed = fresh ? "" : "; already used in this video";

  return {
    score: Number(score.toFixed(4)),
    reason: `${parts[0]![0]}; ${parts[1]![0]}${alreadyUsed}`,
  };
}

/**
 * The candidate as the editor receives it.
 *
 * `previewUrl` is built by the CALLER, because only the server knows how this deployment streams
 * archive media — and because building it here would mean importing a storage module into a
 * ranking function.
 */
export function candidateFromAsset(
  asset: ArchiveAssetLike,
  scored: { score: number; reason: string },
  urls: { previewUrl?: string | null; thumbnailUrl?: string | null; provider: string }
): ReplacementCandidate {
  return {
    archiveAssetId: asset.id,
    provider: urls.provider,
    title: asset.title ?? null,
    mediaType: asset.mediaType,
    durationSec: asset.durationSec ?? null,
    widthPx: asset.width ?? null,
    heightPx: asset.height ?? null,
    previewUrl: urls.previewUrl ?? null,
    thumbnailUrl: urls.thumbnailUrl ?? null,
    score: scored.score,
    reason: scored.reason,
    /**
     * The provider's own page, for attribution and for a person who wants to check the source.
     * NOT the media URL — see the note on the type.
     */
    sourcePageUrl: asset.sourceUrl ?? null,
  };
}

export type RankedCandidates = {
  candidates: ReplacementCandidate[];
  /** Assets that were excluded and why, so an empty list is never a mystery. */
  rejected: Array<{ archiveAssetId: number; reason: string }>;
};

/**
 * Rank a pool of archive assets for one slot.
 *
 * ── The tie-break, and why it is not arbitrary ──────────────────────────────────────────────
 *
 * Two assets with identical scores are ordered by ID. That is not a preference — it is a promise
 * that the list does not shuffle between two requests, which it would with an unstable sort. A
 * person comparing candidates must not have them move under the cursor.
 */
export function rankReplacementCandidates<T extends ArchiveAssetLike>(
  assets: readonly T[],
  context: ReplacementContext,
  /**
   * Generic over the asset so the CALLER's callback sees its own full row.
   *
   * The ranking reads the dozen fields in `ArchiveAssetLike` and nothing else — deliberately, so
   * it cannot come to depend on a storage URL. But the caller needs `storageUrl` to build a
   * preview link, and making this generic lets it have that without widening what the ranking
   * itself can see.
   */
  toUrls: (asset: T) => { previewUrl?: string | null; thumbnailUrl?: string | null; provider: string },
  limit = 24
): RankedCandidates {
  const rejected: Array<{ archiveAssetId: number; reason: string }> = [];
  const scored: Array<{ asset: T; scored: { score: number; reason: string } }> = [];

  for (const asset of assets) {
    const refusal = technicalRejection(asset, context);
    if (refusal) {
      rejected.push({ archiveAssetId: asset.id, reason: refusal });
      continue;
    }
    scored.push({ asset, scored: scoreCandidate(asset, context) });
  }

  scored.sort((a, b) => b.scored.score - a.scored.score || a.asset.id - b.asset.id);

  return {
    candidates: scored
      .slice(0, Math.max(1, limit))
      .map((s) => candidateFromAsset(s.asset, s.scored, toUrls(s.asset))),
    rejected,
  };
}

/** One line for the log. Counts and ids only — never a URL. */
export function formatCandidateSearch(clipId: string, ranked: RankedCandidates): string {
  return (
    `[Replacement] clip=${clipId} candidates=${ranked.candidates.length} ` +
    `rejected=${ranked.rejected.length} ` +
    `top=${ranked.candidates[0]?.archiveAssetId ?? "none"}`
  );
}

/* ═══════════════════════ §3 — what a replacement may NOT change ═══════════════════════ */

/**
 * Compare a clip before and after a replacement, and name anything that changed besides the source.
 *
 * ── Why this exists as production code and not only as a test ───────────────────────────────
 *
 * §3 lists nine things a replacement must leave alone, and the failure mode is silent: a video
 * whose captions have drifted a quarter-second still plays. `replaceTimelineClipSource` is written
 * to change only the source, and this is the check that it did — run on the real edit, so a case
 * nobody tested still gets an answer.
 */
export function replacementSideEffects(
  before: ProjectTimeline,
  after: ProjectTimeline,
  clipId: string
): string[] {
  const problems: string[] = [];
  const a = videoTrack(before);
  const b = videoTrack(after);

  if (a.length !== b.length) {
    problems.push(`the video track had ${a.length} clips and now has ${b.length}`);
  }

  const compare = (x: TimelineVideoClip, y: TimelineVideoClip) => {
    if (x.id !== y.id) problems.push(`clip ${x.id} became ${y.id}`);
    if (x.timelineStart !== y.timelineStart) problems.push(`clip ${x.id} moved from ${x.timelineStart}s to ${y.timelineStart}s`);
    if (x.timelineEnd !== y.timelineEnd) problems.push(`clip ${x.id} now ends at ${y.timelineEnd}s, not ${x.timelineEnd}s`);
    if (x.transitionIn !== y.transitionIn) problems.push(`clip ${x.id} transition changed to ${y.transitionIn}`);
    if ((x.effects?.length ?? 0) !== (y.effects?.length ?? 0)) problems.push(`clip ${x.id} effects changed`);
    if (x.motion !== y.motion) problems.push(`clip ${x.id} camera changed to ${y.motion}`);
    /** Every clip EXCEPT the replaced one must keep its source too. */
    if (x.id !== clipId && x.source.archiveAssetId !== y.source.archiveAssetId) {
      problems.push(`clip ${x.id} was replaced too, and should not have been`);
    }
  };

  for (let i = 0; i < Math.min(a.length, b.length); i++) compare(a[i]!, b[i]!);

  if (before.durationSec !== after.durationSec) {
    problems.push(`the video's duration changed from ${before.durationSec}s to ${after.durationSec}s`);
  }
  /** Captions, graphics and audio are untouched by a source swap, and must stay that way. */
  for (const kind of ["CAPTIONS", "TEXT", "GRAPHICS", "VOICE", "MUSIC", "SFX", "AMBIENT"] as const) {
    const x = JSON.stringify(before.tracks.find((t) => t.kind === kind) ?? null);
    const y = JSON.stringify(after.tracks.find((t) => t.kind === kind) ?? null);
    if (x !== y) problems.push(`the ${kind} track changed during a clip replacement`);
  }

  return problems;
}
