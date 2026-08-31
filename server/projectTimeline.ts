/**
 * RONDE 143 — the timeline. One document that says what the video IS.
 *
 * ── Why this exists, stated as the problem it solves ─────────────────────────────────────────
 *
 * FastVid could already write down what a finished render contained: `EditorScene[]` in the
 * `videoScenes` column, one entry per scene, each with its clips and a duration in milliseconds.
 * RONDE 139 made that manifest editable. And an edit changed nothing a viewer could see, because
 * nothing can render FROM it: the manifest records what a render DID, and a renderer needs to be
 * told what to DO.
 *
 * The two differ in three ways that matter, and each of them is why the manifest cannot simply be
 * re-rendered:
 *
 *   1. NO ABSOLUTE TIME. A scene knows its own length and not where it starts, so "the text at
 *      0:23" has no representation at all.
 *   2. NO LAYERS. Narration, music, captions, overlays and graphics were arguments spread across
 *      the compose functions. Nothing could be edited because nothing was written down.
 *   3. NO WAY BACK TO THE SOURCE. `url` is a path in a work directory that is deleted at the end
 *      of every render (`fs.rmSync(workDir)`), and `available: false` on most clips says so. The
 *      manifest records where a file WAS, never where the picture CAME FROM.
 *
 * ── What a timeline is here ──────────────────────────────────────────────────────────────────
 *
 * A plain, serialisable, absolutely-timed document with typed tracks. It carries no behaviour: the
 * renderer executes it, the editor edits it, and neither may improvise. That is the whole point of
 * §11 — the AI decides during EDIT PLANNING, and the renderer only performs.
 *
 * It is deliberately NOT a replacement for `EditorScene[]`. The manifest stays exactly as it is and
 * keeps working; a timeline is BUILT from it (`timelineFromEditorScenes`) so that every video ever
 * rendered can be opened in the editor, not only the ones rendered after today.
 */
import { createHash } from "crypto";

/* ═══════════════════════ identity of a source ═══════════════════════ */

/**
 * WHERE DID THIS PICTURE COME FROM, and CAN I FETCH IT AGAIN?
 *
 * §5's requirement, and the single most important addition in this round. A work-directory path is
 * not an answer to either question: the directory is deleted when the render ends, so a timeline
 * that knows only the path knows nothing at all a day later.
 *
 * Every field is optional except `provider`, because the providers genuinely differ — an archive
 * asset has a row id and a permanent stream URL, a Wikimedia file has a title, a Pexels clip has a
 * numeric id and a media URL that may or may not still resolve. What the type enforces is that
 * SOMETHING was written down, and `canRehydrate` says whether what was written down is enough.
 */
export type AssetSourceIdentity = {
  /** The proven provider from the lineage ledger, or UNVERIFIED. Never guessed from a filename. */
  provider: string;
  /** The provider's own id for this asset — Pexels video id, Wikimedia title, YouTube videoId. */
  providerAssetId?: string;
  /** media_archive_assets.id, when this system holds the file itself. The strongest handle. */
  archiveAssetId?: number;
  /** A URL this system serves the media from, and will still serve tomorrow. */
  canonicalUrl?: string;
  /** The provider's direct media URL as it was at render time. May have expired since. */
  mediaUrl?: string;
  /** The human-facing page the media came from. For attribution and manual recovery, not fetching. */
  sourcePageUrl?: string;
  title?: string;
};

/* ═══════════════════════ tracks ═══════════════════════ */

export type TrackKind = "VIDEO" | "VOICE" | "MUSIC" | "SFX" | "CAPTIONS" | "TEXT" | "GRAPHICS";

/** How the editor should show this clip when the original media is gone. */
export type PreviewSource = "rendered_video" | "asset";

export type MotionKind =
  | "none"
  | "slow_push"
  | "slow_pull"
  | "pan_left"
  | "pan_right"
  | "pan_up"
  | "pan_down";

export type TransitionKind =
  | "hard_cut"
  | "crossfade"
  | "dissolve"
  | "dip_to_black"
  | "dip_to_white";

export type TimelineVideoClip = {
  id: string;
  kind: "video" | "image";
  /** Where the media came from, and how to get it back. */
  source: AssetSourceIdentity;
  /**
   * In/out points WITHIN the source media, in seconds.
   *
   * RONDE 147 §15 — OPTIONAL, and absent is not zero.
   *
   * "we used the whole file" and "nobody wrote the trim down" are different facts, and a
   * re-render has to tell them apart: the first means start at 0, the second means the renderer
   * must decide what to do and say that it did. Typing these as required numbers forced every
   * unknown trim to be spelled `0`, which is the silent invention §15 forbids.
   */
  sourceIn?: number;
  sourceOut?: number;
  /** Absolute position on the timeline, in seconds. */
  timelineStart: number;
  timelineEnd: number;
  motion: MotionKind;
  transitionIn: TransitionKind;
  transitionOut: TransitionKind;
  /**
   * §2 — how the EDITOR previews this clip; never how the RENDERER sources it.
   *
   * `rendered_video` means "seek the existing final MP4 to timelineStart". That is a reliable
   * picture for a clip whose original file is gone, and it is the reason the editor works at all
   * for videos rendered before this round. It is emphatically not a render source: re-rendering
   * from the previous output would bake every earlier edit into the picture and lose a generation
   * of quality each time. See `renderSourceFor`.
   */
  previewSource: PreviewSource;
  /** The scene/beat this clip illustrates, kept so a replacement can be offered from that beat. */
  sceneIndex?: number;
  beatIndex?: number;
  /** A person put this here; the pipeline did not choose it. */
  editedByUser?: boolean;
  /** Switched off by the user without being deleted. */
  disabled?: boolean;
};

export type TextStyle = {
  fontFamily?: string;
  fontSizePx: number;
  color: string;
  /** 0–1. 0 means no box. */
  backgroundOpacity: number;
  backgroundColor?: string;
  position: "top" | "center" | "bottom" | "lower_third";
  maxCharsPerLine?: number;
};

export type TextAnimation = "none" | "fade" | "fade_rise" | "fade_scale";

export type TimelineText = {
  id: string;
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  animation: TextAnimation;
  editedByUser?: boolean;
  disabled?: boolean;
};

export type TimelineCaption = {
  id: string;
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  editedByUser?: boolean;
  disabled?: boolean;
};

/** Voice, music or an effect. One file, placed on the timeline, at a level. */
export type TimelineAudioClip = {
  id: string;
  /** Where the audio came from. Narration is produced by the render and lives in storage. */
  source: AssetSourceIdentity;
  start: number;
  end: number;
  /** Linear gain. 1.0 is the file's own level. */
  gain: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Duck this under the voice track while the voice is speaking. */
  duckUnderVoice?: boolean;
  disabled?: boolean;
};

export type TimelineTrack =
  | { kind: "VIDEO"; clips: TimelineVideoClip[] }
  | { kind: "VOICE"; clips: TimelineAudioClip[] }
  | { kind: "MUSIC"; clips: TimelineAudioClip[] }
  | { kind: "SFX"; clips: TimelineAudioClip[] }
  | { kind: "CAPTIONS"; captions: TimelineCaption[] }
  | { kind: "TEXT"; texts: TimelineText[] }
  | { kind: "GRAPHICS"; texts: TimelineText[] };

export type TimelineFormat = {
  widthPx: number;
  heightPx: number;
  fps: number;
};

/**
 * RONDE 147 §8 — which SHAPE this document is in.
 *
 * Distinct from `version`, and the distinction matters: `version` counts EDITS (v1 → v2 when a
 * user changes a caption), while this counts SCHEMA changes (a reader from an older build needs
 * to know which fields exist). Conflating them would make "the user edited this twice" and "the
 * format changed" the same number.
 */
export const TIMELINE_SCHEMA_VERSION = 1;

export type ProjectTimeline = {
  /** The document's shape. Absent on anything written before RONDE 147; read as 1. */
  schemaVersion?: number;
  /** Bumped on every save. A render names the version it was made from — §10. */
  version: number;
  videoId: number;
  durationSec: number;
  format: TimelineFormat;
  tracks: TimelineTrack[];
  /**
   * The final MP4 this timeline was last rendered to, when there is one.
   *
   * Held for the editor's preview (§2), never as a render input (§3).
   */
  renderedVideoUrl?: string;
  createdAt: string;
};

/* ═══════════════════════ construction ═══════════════════════ */

export const DEFAULT_FORMAT: TimelineFormat = { widthPx: 1920, heightPx: 1080, fps: 30 };

export const DEFAULT_CAPTION_STYLE: TextStyle = {
  fontSizePx: 46,
  color: "white",
  backgroundOpacity: 0.45,
  backgroundColor: "black",
  position: "bottom",
  maxCharsPerLine: 42,
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSizePx: 86,
  color: "white",
  backgroundOpacity: 0,
  position: "center",
};

/**
 * A stable id for a timeline element.
 *
 * Derived from what the element IS rather than from a counter or a clock, so that rebuilding a
 * timeline from the same manifest twice produces the same ids — which is what lets an edit made
 * against version 3 still be recognisable in version 4. `Math.random()` here would silently break
 * §11's determinism.
 */
export function timelineElementId(prefix: string, ...parts: Array<string | number>): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
  return `${prefix}_${h}`;
}

export function emptyTimeline(videoId: number, format = DEFAULT_FORMAT): ProjectTimeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    version: 1,
    videoId,
    durationSec: 0,
    format,
    tracks: [
      { kind: "VIDEO", clips: [] },
      { kind: "VOICE", clips: [] },
      { kind: "MUSIC", clips: [] },
      { kind: "SFX", clips: [] },
      { kind: "CAPTIONS", captions: [] },
      { kind: "TEXT", texts: [] },
      { kind: "GRAPHICS", texts: [] },
    ],
    createdAt: new Date().toISOString(),
  };
}

/* ═══════════════════════ accessors ═══════════════════════ */

export function videoTrack(t: ProjectTimeline): TimelineVideoClip[] {
  const track = t.tracks.find((x) => x.kind === "VIDEO");
  return track && track.kind === "VIDEO" ? track.clips : [];
}

export function audioTrackOf(
  t: ProjectTimeline,
  kind: "VOICE" | "MUSIC" | "SFX"
): TimelineAudioClip[] {
  const track = t.tracks.find((x) => x.kind === kind);
  return track && (track.kind === "VOICE" || track.kind === "MUSIC" || track.kind === "SFX")
    ? track.clips
    : [];
}

export function captionTrack(t: ProjectTimeline): TimelineCaption[] {
  const track = t.tracks.find((x) => x.kind === "CAPTIONS");
  return track && track.kind === "CAPTIONS" ? track.captions : [];
}

export function textTrackOf(t: ProjectTimeline, kind: "TEXT" | "GRAPHICS"): TimelineText[] {
  const track = t.tracks.find((x) => x.kind === kind);
  return track && (track.kind === "TEXT" || track.kind === "GRAPHICS") ? track.texts : [];
}

/**
 * §3 — what the RENDERER must open for this clip, which is never the previous output.
 *
 * Returns null when the clip cannot be sourced at all. That is a refusal, not a fallback: rendering
 * a clip by re-encoding a section of the previous MP4 would bake in every earlier edit, lose a
 * generation of quality per save, and quietly make "replace this shot" impossible — the picture
 * being replaced is already burned into the file being used as the source.
 */
export function renderSourceFor(clip: TimelineVideoClip): { url: string } | null {
  const s = clip.source;
  if (s.canonicalUrl) return { url: s.canonicalUrl };
  if (s.mediaUrl) return { url: s.mediaUrl };
  return null;
}

/*
 * "Can this clip be fetched again?" lives in `assetIdentity.identityIsRehydratable`, NOT here.
 *
 * A `canRehydrate` used to sit at this spot and it was a second, weaker answer to the same
 * question: it accepted an UNVERIFIED provider that carried a media URL, while the rehydrator
 * refuses exactly that clip. The validator asked the weak one, so a timeline could pass validation
 * and then die at rehydration — the failure the validator exists to prevent. One definition, in
 * the module that owns identities.
 */

/* ═══════════════════════ versioning ═══════════════════════ */

/**
 * The next version of a timeline after an edit — §10.
 *
 * `createdAt` is refreshed and the version is bumped by exactly one. Nothing else is touched, so a
 * save records that something changed without the act of saving changing anything itself.
 */
export function bumpVersion(t: ProjectTimeline): ProjectTimeline {
  return { ...t, version: t.version + 1, createdAt: new Date().toISOString() };
}

/**
 * A digest of everything that affects the picture — §11's determinism, made checkable.
 *
 * `version`, `createdAt` and `renderedVideoUrl` are deliberately EXCLUDED: bumping a version or
 * pointing at a different output does not change what the renderer would produce, and a hash that
 * moved when they did would make "same timeline ⇒ same edit" untestable. Two timelines with the
 * same digest must render to the same picture.
 */
export function timelineDigest(t: ProjectTimeline): string {
  const material = {
    // `schemaVersion` is excluded along with `version` and `renderedVideoUrl`: a format revision
    // that leaves every field intact renders the same picture, and a digest that moved when the
    // schema did would make "same timeline ⇒ same edit" untestable across a build.
    durationSec: t.durationSec,
    format: t.format,
    tracks: t.tracks,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}
