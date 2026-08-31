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

export type TrackKind =
  | "VIDEO"
  | "VOICE"
  | "MUSIC"
  | "SFX"
  /** RONDE 148 §23 — room tone and atmosphere, which duck more gently than music. */
  | "AMBIENT"
  | "CAPTIONS"
  | "TEXT"
  | "GRAPHICS";

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

/* ═══════════════════════ RONDE 148 §8 — transforms, camera, effects ═══════════════════════ */

/**
 * How the source fills the frame, before any camera movement.
 *
 * `fit` is the whole-frame decision and the three values are genuinely different pictures:
 *   contain  the whole source is visible, padded — nothing is lost, bars may appear
 *   cover    the frame is filled, the overflow is cropped — nothing is padded, edges are lost
 *   crop     an explicit rectangle of the source, in normalised 0..1 coordinates
 *
 * `contain` stays the default because it is what the renderer has always done, so a timeline
 * written before this round renders identically — which is what keeps the golden test honest.
 */
export type FitMode = "contain" | "cover" | "crop";

export type ClipTransform = {
  fit?: FitMode;
  /**
   * The source rectangle, normalised 0..1, used when `fit` is "crop".
   *
   * Normalised rather than pixels so a crop survives a source being re-fetched at a different
   * resolution — which is exactly what rehydration does. Pixel crops would silently mean something
   * different after the provider re-encoded their file.
   */
  crop?: { x: number; y: number; width: number; height: number };
  /** Extra scale applied after the fit. 1 = none. */
  scale?: number;
  /** Where the scaled picture sits in the frame, normalised: 0.5/0.5 is centred. */
  positionX?: number;
  positionY?: number;
  /** 0..1. Below 1 the clip is composited over black. */
  opacity?: number;
};

/**
 * A camera move over the clip's own duration.
 *
 * `MotionKind` already existed and stays, because the whole pipeline writes it; this is the
 * PARAMETERISED form the cameraPlanner actually produces (a zoom from 1.0 to 1.12 with a
 * direction), and `motion` remains the coarse label. When both are present, `camera` wins and
 * `motion` is what an older reader sees.
 */
export type ClipCamera = {
  /** The planner's movement name — cameraPlanner's CameraMovementType. */
  type: string;
  startScale?: number;
  endScale?: number;
  /** Normalised centre of interest at the start and end of the move. */
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  /** 0..1, from the planner. Used to scale the move when explicit scales are absent. */
  intensity?: number;
};

/**
 * A visual effect the planner asked for, carried whether or not the renderer can execute it.
 *
 * §9/§15: "Geen stille verwijdering." An effect the renderer cannot do is REPORTED as
 * `unsupported_effect` with the planner's own reason — it stays in the document so that a later
 * renderer can execute it and so an operator can see what the plan asked for.
 */
export type ClipEffect = {
  /** cinematicEditingEngine VisualEffectType. */
  effectType: string;
  /** 0..1. */
  intensity: number;
  reason?: string;
};

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
  /** RONDE 148 — the parameterised move. When present it supersedes `motion`. */
  camera?: ClipCamera;
  /** RONDE 148 — fit, crop, scale, position, opacity. Absent means contain-and-pad, as before. */
  transform?: ClipTransform;
  /** RONDE 148 — what the effectsPlanner asked for. Executed where possible, reported otherwise. */
  effects?: ClipEffect[];
  transitionIn: TransitionKind;
  transitionOut: TransitionKind;
  /** Seconds the transition takes. The planner decides it; the renderer executes it. */
  transitionInSec?: number;
  transitionOutSec?: number;
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

/**
 * RONDE 148 §12/§18 — GRAPHICS is no longer an alias for text.
 *
 * It was `TimelineText[]`, which meant a map, a location card and a callout could only be
 * represented as a string on screen — and `motionGraphicsPlanner` plans exactly those, with a
 * `data` payload per graphic type. Aliasing them to text threw that payload away at the door, so
 * the planner could never have been connected without this.
 *
 * `data` is deliberately opaque, mirroring `MotionGraphicInstruction.data` in the engine's own
 * types: a counter's fromValue/toValue and a map's normX/normY have nothing in common, and a union
 * of every graphic's payload here would have to be edited every time the planner learns a new one.
 * Consumers narrow by `graphicType`, which is what the engine already does.
 */
export type TimelineGraphic = {
  id: string;
  /** The planner's own vocabulary — see cinematicEditingEngine MotionGraphicType. */
  graphicType: string;
  data: Record<string, unknown>;
  start: number;
  end: number;
  /** A caption-like label, when the graphic has one. Rendered through ASS like other text. */
  label?: string;
  style?: TextStyle;
  disabled?: boolean;
  /** Why the planner asked for it, carried so an unsupported graphic can say what was lost. */
  reason?: string;
};

export type TimelineTrack =
  | { kind: "VIDEO"; clips: TimelineVideoClip[] }
  | { kind: "VOICE"; clips: TimelineAudioClip[] }
  | { kind: "MUSIC"; clips: TimelineAudioClip[] }
  | { kind: "SFX"; clips: TimelineAudioClip[] }
  /**
   * §23 — room tone, atmosphere and environment beds, separate from MUSIC.
   *
   * They duck differently (cinematicAudio uses a gentler ratio for ambience than for music) and a
   * person switching the music off should not lose the room they are standing in.
   */
  | { kind: "AMBIENT"; clips: TimelineAudioClip[] }
  | { kind: "CAPTIONS"; captions: TimelineCaption[] }
  | { kind: "TEXT"; texts: TimelineText[] }
  | { kind: "GRAPHICS"; graphics: TimelineGraphic[] };

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
      { kind: "AMBIENT", clips: [] },
      { kind: "CAPTIONS", captions: [] },
      { kind: "TEXT", texts: [] },
      { kind: "GRAPHICS", graphics: [] },
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
  kind: "VOICE" | "MUSIC" | "SFX" | "AMBIENT"
): TimelineAudioClip[] {
  const track = t.tracks.find((x) => x.kind === kind);
  return track &&
    (track.kind === "VOICE" ||
      track.kind === "MUSIC" ||
      track.kind === "SFX" ||
      track.kind === "AMBIENT")
    ? track.clips
    : [];
}

export function captionTrack(t: ProjectTimeline): TimelineCaption[] {
  const track = t.tracks.find((x) => x.kind === "CAPTIONS");
  return track && track.kind === "CAPTIONS" ? track.captions : [];
}

/**
 * The TEXT track's elements.
 *
 * RONDE 148 — this used to accept "GRAPHICS" too, back when that track was also `TimelineText[]`.
 * It no longer is: a graphic carries a type and a payload, and squeezing it through a text-shaped
 * accessor is precisely what stopped `motionGraphicsPlanner` from ever being connected. Graphics
 * have their own accessor below.
 */
export function textTrackOf(t: ProjectTimeline, kind: "TEXT"): TimelineText[] {
  const track = t.tracks.find((x) => x.kind === kind);
  return track && track.kind === "TEXT" ? track.texts : [];
}

/**
 * The GRAPHICS track, reading BOTH shapes.
 *
 * RONDE 148 changed this track from `TimelineText[]` to `TimelineGraphic[]`, and every timeline
 * saved before that change still carries the old shape in its JSON column. Reading `track.graphics`
 * on one of those gives `undefined`, and the first thing that happens next is `.filter` on nothing —
 * which is how this was found: eighteen of the golden test's twenty-five cases crashed at once.
 *
 * So the old shape is READ, not rejected: a legacy text element becomes a graphic whose label is
 * its text, which is exactly what it was. The words survive the migration, no timeline needs
 * rewriting, and nothing has to know which era a document came from.
 */
export function graphicsTrack(t: ProjectTimeline): TimelineGraphic[] {
  const track = t.tracks.find((x) => x.kind === "GRAPHICS");
  if (!track || track.kind !== "GRAPHICS") return [];
  return normaliseGraphicsTrack(track);
}

/**
 * One GRAPHICS track, read in either shape.
 *
 * Exported because two places need it — the accessor above and `timelineStore`'s text edit — and a
 * second copy of a compatibility shim is how one of them ends up not having the fix.
 */
export function normaliseGraphicsTrack(track: {
  kind: "GRAPHICS";
  graphics?: TimelineGraphic[];
}): TimelineGraphic[] {
  if (Array.isArray(track.graphics)) return track.graphics;
  const legacy = (track as unknown as { texts?: TimelineText[] }).texts;
  if (!Array.isArray(legacy)) return [];
  return legacy.map((t2) => ({
    id: t2.id,
    graphicType: "text",
    data: {},
    start: t2.start,
    end: t2.end,
    label: t2.text,
    style: t2.style,
    disabled: t2.disabled,
  }));
}

/** Every graphic that also puts words on screen — the ones the ASS pass can draw. */
export function graphicsWithLabels(t: ProjectTimeline): TimelineGraphic[] {
  return graphicsTrack(t).filter((g) => !g.disabled && Boolean(g.label?.trim()));
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
