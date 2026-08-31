/**
 * RONDE 150 §5 — ProjectTimeline → Remotion props, and back-checkable.
 *
 * ── The one rule this file exists to enforce ─────────────────────────────────────────────────
 *
 * NOTHING EDITORIAL MAY BE LOST HERE.
 *
 * This adapter is the last place the planners' decisions pass through before they become pixels,
 * and it is the easiest place in the whole chain to drop something by accident: a field that is not
 * copied simply does not appear, no type complains, and the render comes out missing a caption that
 * three planners agreed on. So the shape below is deliberately close to the timeline's own, the
 * copying is explicit, and `missingEditorialFields` reads the RESULT back and names anything that
 * went in and did not come out.
 *
 * ── Why props at all, rather than passing the timeline ───────────────────────────────────────
 *
 * Remotion serialises props to JSON and hands them to a browser. Three things follow:
 *
 *   1. Everything must survive `JSON.stringify` — no Dates, no undefined-in-arrays, no functions.
 *   2. Media URLs must be reachable FROM THE BROWSER, so a local file has to become a `file://`
 *      or a served URL. The rehydrator produces local paths, so the mapping happens here.
 *   3. §26 — an identity may travel, a credential may not. `sanitiseIdentity` keeps the provider
 *      and the id and drops everything that could carry a signature.
 *
 * ── This file makes no decisions ─────────────────────────────────────────────────────────────
 *
 * §29: planner ≠ renderer. Every value here is copied, converted between units, or defaulted to
 * the value the renderer already used. Nothing is chosen. Where a default IS applied it is named
 * and explained, so a reader can tell a copied value from a filled-in one.
 */
import {
  audioTrackOf,
  captionTrack,
  graphicsTrack,
  textTrackOf,
  videoTrack,
  type ProjectTimeline,
  type TextStyle,
  type TimelineLook,
  type TimelineVideoClip,
} from "./projectTimeline";
import { docGradeSourceKindForProvider } from "./documentaryStyle";

/* ═══════════════════════ the props Remotion receives ═══════════════════════ */

/**
 * What a clip's source is, as far as the BROWSER is concerned.
 *
 * `src` is a URL Remotion can load. `identity` travels alongside it for provenance and for the
 * report — never for fetching, which already happened in the rehydrator.
 */
export type RemotionAssetRef = {
  src: string;
  provider: string;
  providerAssetId: string | null;
  archiveAssetId: number | null;
  title: string | null;
};

export type RemotionClip = {
  id: string;
  kind: "video" | "image";
  asset: RemotionAssetRef | null;
  /** Frames, not seconds — Remotion's unit. Seconds stay on the timeline. */
  fromFrame: number;
  durationInFrames: number;
  /** In/out inside the source, in SECONDS, because that is what a media element seeks in. */
  sourceIn: number | null;
  sourceOut: number | null;
  fit: "contain" | "cover" | "crop";
  crop: { x: number; y: number; width: number; height: number } | null;
  scale: number;
  positionX: number;
  positionY: number;
  opacity: number;
  camera: {
    type: string;
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null;
  effects: Array<{ effectType: string; intensity: number; reason: string | null }>;
  transitionIn: string;
  transitionInFrames: number;
  /** The grade calibration this clip needs, derived from its provider. */
  sourceKind: string;
  sceneIndex: number | null;
};

export type RemotionTextElement = {
  id: string;
  text: string;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyle;
  animation: string;
  /** Which family of text this is, so the component can style it: caption, headline, card… */
  role: "caption" | "text";
};

export type RemotionGraphic = {
  id: string;
  graphicType: string;
  /** The planner's own payload, passed through untouched. The component reads it; nothing invents. */
  data: Record<string, unknown>;
  label: string | null;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyle | null;
  reason: string | null;
};

export type RemotionAudio = {
  id: string;
  kind: "VOICE" | "MUSIC" | "SFX" | "AMBIENT";
  src: string | null;
  fromFrame: number;
  durationInFrames: number;
  startSec: number;
  endSec: number;
  gain: number;
  fadeInSec: number | null;
  fadeOutSec: number | null;
  duckUnderVoice: boolean;
};

/**
 * Word-level caption timing, straight from the TTS alignment.
 *
 * §13: "Geen nieuwe timing berekenen." These are the measured word boundaries from ElevenLabs,
 * carried through so a caption can highlight a word at exactly the instant it is spoken.
 */
export type RemotionWordTiming = { word: string; startSec: number; endSec: number };

export type RemotionRenderProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  durationSec: number;
  look: TimelineLook | null;
  clips: RemotionClip[];
  captions: RemotionTextElement[];
  texts: RemotionTextElement[];
  graphics: RemotionGraphic[];
  audio: RemotionAudio[];
  words: RemotionWordTiming[];
  /** Carried for the render log and the report; never used to make a picture. */
  meta: { videoId: number; timelineVersion: number; schemaVersion: number };
};

/* ═══════════════════════ conversion ═══════════════════════ */

/** Seconds → frames, rounded to the nearest whole frame. Remotion cannot render half a frame. */
export function toFrames(sec: number, fps: number): number {
  if (!Number.isFinite(sec) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(0, Math.round(sec * fps));
}

/**
 * §26 — the identity that may cross into the browser.
 *
 * `mediaUrl` and `canonicalUrl` are deliberately NOT included: a provider URL routinely carries a
 * signed token in its query string, and props are serialised into a bundle that a browser loads.
 * The rehydrator has already turned the identity into a local file by the time this runs, so the
 * URL is not needed for anything.
 */
function sanitiseIdentity(clip: TimelineVideoClip, src: string | null): RemotionAssetRef | null {
  if (!src) return null;
  return {
    src,
    provider: clip.source.provider,
    providerAssetId: clip.source.providerAssetId ?? null,
    archiveAssetId: clip.source.archiveAssetId ?? null,
    title: clip.source.title ?? null,
  };
}

/**
 * Build the props for one timeline.
 *
 * `resolveMedia` maps a clip to the local file the rehydrator produced. It is injected for the
 * same reason the ffmpeg renderer injects it: this module must have no opinion about downloading.
 */
export function timelineToRemotionProps(params: {
  timeline: ProjectTimeline;
  /** clip id → a URL the browser can load (usually file://…). Null when it could not be recovered. */
  resolveMedia: (clip: TimelineVideoClip) => string | null;
  /** audio element id → a loadable URL. */
  resolveAudio?: (id: string) => string | null;
  /** The measured TTS word boundaries, when the video has them. */
  words?: RemotionWordTiming[];
}): RemotionRenderProps {
  const { timeline } = params;
  const fps = timeline.format.fps;
  const look = timeline.look ?? null;

  const clips: RemotionClip[] = videoTrack(timeline)
    .filter((c) => !c.disabled)
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .map((clip) => {
      const t = clip.transform;
      const durSec = Math.max(0, clip.timelineEnd - clip.timelineStart);
      return {
        id: clip.id,
        kind: clip.kind,
        asset: sanitiseIdentity(clip, params.resolveMedia(clip)),
        fromFrame: toFrames(clip.timelineStart, fps),
        durationInFrames: Math.max(1, toFrames(durSec, fps)),
        /**
         * §15 of RONDE 147 survives the crossing: an absent trim stays NULL, not 0. The component
         * decides what to do about an unknown trim and says so, exactly as the ffmpeg renderer does.
         */
        sourceIn: clip.sourceIn ?? null,
        sourceOut: clip.sourceOut ?? null,
        fit: t?.fit ?? "contain",
        crop: t?.crop ?? null,
        // The defaults are the identity transform — the picture the renderer produced before.
        scale: t?.scale ?? 1,
        positionX: t?.positionX ?? 0.5,
        positionY: t?.positionY ?? 0.5,
        opacity: t?.opacity ?? 1,
        camera: clip.camera
          ? {
              type: clip.camera.type,
              startScale: clip.camera.startScale ?? 1,
              endScale: clip.camera.endScale ?? 1,
              startX: clip.camera.startX ?? 0.5,
              startY: clip.camera.startY ?? 0.5,
              endX: clip.camera.endX ?? 0.5,
              endY: clip.camera.endY ?? 0.5,
            }
          : null,
        effects: (clip.effects ?? []).map((e) => ({
          effectType: e.effectType,
          intensity: e.intensity,
          reason: e.reason ?? null,
        })),
        transitionIn: clip.transitionIn,
        transitionInFrames: toFrames(clip.transitionInSec ?? 0.5, fps),
        /**
         * Derived here rather than in the browser, because `docGradeSourceKindForProvider` is
         * server code and the calibration must not be duplicated into a React component.
         */
        sourceKind:
          clip.sourceKind ??
          docGradeSourceKindForProvider(clip.source.provider, {
            archiveAssetId: clip.source.archiveAssetId,
          }),
        sceneIndex: clip.sceneIndex ?? null,
      };
    });

  const textElement = (
    el: { id: string; text: string; start: number; end: number; style: TextStyle; animation?: string },
    role: "caption" | "text"
  ): RemotionTextElement => ({
    id: el.id,
    text: el.text,
    fromFrame: toFrames(el.start, fps),
    durationInFrames: Math.max(1, toFrames(Math.max(0, el.end - el.start), fps)),
    style: el.style,
    animation: el.animation ?? "fade",
    role,
  });

  const audio: RemotionAudio[] = (["VOICE", "MUSIC", "AMBIENT", "SFX"] as const).flatMap((kind) =>
    audioTrackOf(timeline, kind)
      .filter((c) => !c.disabled)
      .map((c) => ({
        id: c.id,
        kind,
        src: params.resolveAudio?.(c.id) ?? null,
        fromFrame: toFrames(c.start, fps),
        durationInFrames: Math.max(1, toFrames(Math.max(0, c.end - c.start), fps)),
        startSec: c.start,
        endSec: c.end,
        gain: c.gain,
        fadeInSec: c.fadeInSec ?? null,
        fadeOutSec: c.fadeOutSec ?? null,
        duckUnderVoice: Boolean(c.duckUnderVoice),
      }))
  );

  return {
    fps,
    width: timeline.format.widthPx,
    height: timeline.format.heightPx,
    /**
     * The timeline's OWN duration, not the sum of the clips.
     *
     * They can differ, and when they do the validator has already reported it as
     * `duration_mismatch`. Trusting the clips here would make the renderer quietly produce a
     * different length from the document — the exact drift §22 asks the quality gate to catch.
     */
    durationInFrames: Math.max(1, toFrames(timeline.durationSec, fps)),
    durationSec: timeline.durationSec,
    look,
    clips,
    captions: captionTrack(timeline)
      .filter((c) => !c.disabled)
      .map((c) => textElement(c, "caption")),
    texts: textTrackOf(timeline, "TEXT")
      .filter((t) => !t.disabled)
      .map((t) => textElement(t, "text")),
    graphics: graphicsTrack(timeline)
      .filter((g) => !g.disabled)
      .map((g) => ({
        id: g.id,
        graphicType: g.graphicType,
        data: g.data ?? {},
        label: g.label ?? null,
        fromFrame: toFrames(g.start, fps),
        durationInFrames: Math.max(1, toFrames(Math.max(0, g.end - g.start), fps)),
        style: g.style ?? null,
        reason: g.reason ?? null,
      })),
    audio,
    words: params.words ?? [],
    meta: {
      videoId: timeline.videoId,
      timelineVersion: timeline.version,
      schemaVersion: timeline.schemaVersion ?? 1,
    },
  };
}

/* ═══════════════════════ §5 — proving nothing was lost ═══════════════════════ */

/**
 * Compare the timeline with the props built from it, and name anything that went missing.
 *
 * ── Why this exists as production code and not only as a test ────────────────────────────────
 *
 * A test proves the adapter was lossless for the cases someone thought of. This runs on the REAL
 * timeline at render time, so a video whose planners produced a combination nobody tested still
 * gets an answer — and the answer appears in the render report rather than in a silence.
 *
 * It compares COUNTS and IDS rather than deep-equality, deliberately: a props object is a
 * different shape by design (frames instead of seconds), so a deep comparison would be all noise.
 * What must hold is that every element that was in the document is also in the props, by id.
 */
export function missingEditorialFields(
  timeline: ProjectTimeline,
  props: RemotionRenderProps
): string[] {
  const missing: string[] = [];

  const compare = (label: string, source: ReadonlyArray<{ id: string }>, made: ReadonlyArray<{ id: string }>) => {
    const there = new Set(made.map((x) => x.id));
    for (const el of source) {
      if (!there.has(el.id)) missing.push(`${label} ${el.id} did not reach the renderer`);
    }
  };

  compare("clip", videoTrack(timeline).filter((c) => !c.disabled), props.clips);
  compare("caption", captionTrack(timeline).filter((c) => !c.disabled), props.captions);
  compare("text", textTrackOf(timeline, "TEXT").filter((t) => !t.disabled), props.texts);
  compare("graphic", graphicsTrack(timeline).filter((g) => !g.disabled), props.graphics);
  for (const kind of ["VOICE", "MUSIC", "AMBIENT", "SFX"] as const) {
    compare(`audio(${kind})`, audioTrackOf(timeline, kind).filter((c) => !c.disabled), props.audio);
  }

  /**
   * The editorial fields ON a clip, which a count cannot catch. These are the planners' decisions:
   * losing one produces a video that renders perfectly and is not the video that was planned.
   */
  const byId = new Map(props.clips.map((c) => [c.id, c]));
  for (const clip of videoTrack(timeline).filter((c) => !c.disabled)) {
    const made = byId.get(clip.id);
    if (!made) continue;
    if (clip.camera && !made.camera) missing.push(`clip ${clip.id} lost its camera move`);
    if ((clip.effects?.length ?? 0) !== made.effects.length) {
      missing.push(`clip ${clip.id} lost ${(clip.effects?.length ?? 0) - made.effects.length} effect(s)`);
    }
    if (clip.transitionIn !== made.transitionIn) {
      missing.push(`clip ${clip.id} transition changed from ${clip.transitionIn} to ${made.transitionIn}`);
    }
    if (clip.transform?.fit && clip.transform.fit !== made.fit) {
      missing.push(`clip ${clip.id} fit changed from ${clip.transform.fit} to ${made.fit}`);
    }
    if (clip.sourceIn != null && made.sourceIn !== clip.sourceIn) {
      missing.push(`clip ${clip.id} lost its sourceIn`);
    }
  }
  if (timeline.look && !props.look) missing.push("the video's look did not reach the renderer");
  return missing;
}

/** One line for the render log. Never a URL, never a payload — ids and counts only. */
export function formatRemotionProps(props: RemotionRenderProps): string {
  const withAsset = props.clips.filter((c) => c.asset).length;
  return (
    `[Remotion] video=${props.meta.videoId} timelineVersion=${props.meta.timelineVersion} ` +
    `${props.width}x${props.height}@${props.fps} frames=${props.durationInFrames} ` +
    `clips=${props.clips.length}(${withAsset} with media) captions=${props.captions.length} ` +
    `texts=${props.texts.length} graphics=${props.graphics.length} audio=${props.audio.length} ` +
    `words=${props.words.length} look=${props.look?.grade ?? "none"}`
  );
}
