/**
 * RONDE 147 §10 — the adapter, and nothing but the adapter.
 *
 * ── What already exists, and what this must not become ───────────────────────────────────────
 *
 * `server/cinematicEditingEngine/` is 1736 lines of editing decisions, every planner with its own
 * tests: emotional pacing, shot, camera, transition, timeline, caption, motion graphics, effects
 * and sound. `edlGenerator.ts` chains them and produces an `EDL` of `EditDecision`s, each carrying
 * a `reason`. Its own header says: "Nothing renders. The output is data only, ready for a future
 * renderer (Phase 5) to consume."
 *
 * `timelineRenderer.ts` is that renderer. This file is the missing sentence between them.
 *
 * SO THIS MODULE MAKES NO EDITORIAL DECISIONS. It does not choose durations, transitions,
 * positions or which caption to show. Every one of those is already decided, with a recorded
 * reason, by a planner that was tested for it. Deciding anything here would create a second
 * opinion about the same question — the exact failure the round is meant to end.
 *
 * What it does is translate vocabulary:
 *
 *     EditDecision.clip        → TimelineVideoClip
 *     EditDecision.captions[]  → TimelineCaption / TimelineText
 *     EditDecision.transitionIn→ TimelineVideoClip.transitionIn
 *     EditDecision.camera      → TimelineVideoClip.motion
 *     EditDecision.sounds[]    → SFX track
 *
 * ── The one thing it computes, and why that is not a decision ────────────────────────────────
 *
 * `ClipInstruction.startSec/endSec` are "this clip's position on the BEAT's own timeline"
 * (0-based per its own doc comment). The project timeline is absolute. So a beat offset is added.
 * That is arithmetic on numbers the planner produced, not a choice about them — and the offset is
 * supplied by the caller, who knows where the beat sits, rather than guessed here.
 */
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FORMAT,
  DEFAULT_TEXT_STYLE,
  emptyTimeline,
  timelineElementId,
  type AssetSourceIdentity,
  type MotionKind,
  type ProjectTimeline,
  type TextStyle,
  type TimelineAudioClip,
  type ClipCamera,
  type TimelineCaption,
  type TimelineLook,
  type TimelineGraphic,
  type TimelineText,
  type TimelineVideoClip,
  type TransitionKind,
} from "./projectTimeline";
import type {
  CameraInstruction,
  CameraMovementType,
  CaptionInstruction,
  EditDecision,
  MotionGraphicType,
  TransitionType,
} from "./cinematicEditingEngine/types";
import { graphicIsRenderable } from "./graphicsVocabulary";

/**
 * The engine's transition vocabulary, mapped to the renderer's.
 *
 * `cut` and `hard_cut` are the same thing under two names, and the rest line up one to one. A
 * transition the renderer does not know becomes `hard_cut` — the safe default, because an unknown
 * transition rendered as a cut is a video that is slightly plainer than intended, while guessing
 * something else is a video that does something nobody asked for. The substitution is REPORTED
 * (see `translateEdl`) rather than made quietly.
 */
export const TRANSITION_MAP: Readonly<Record<TransitionType, TransitionKind | null>> = {
  cut: "hard_cut",
  fade: "dissolve",
  cross_dissolve: "crossfade",
  dip_to_black: "dip_to_black",
  dip_to_white: "dip_to_white",
  /**
   * Present in the engine's vocabulary and not in the renderer's.
   *
   * Mapped to null rather than to the nearest thing, so `translateEdl` can REPORT the downgrade.
   * Quietly turning a film burn into a dissolve would make the render differ from the plan with
   * nothing anywhere saying so — and the planner recorded a reason for choosing it.
   */
  blur: null,
  motion_blur: null,
  flash: null,
  light_leak: null,
  film_burn: null,
  whip: null,
  slide: null,
  push: null,
  match_cut: "hard_cut",
};

/** Camera movement → the renderer's motion vocabulary. */
export const CAMERA_MAP: Readonly<Record<CameraMovementType, MotionKind>> = {
  camera_hold: "none",
  slow_push: "slow_push",
  slow_pull: "slow_pull",
  zoom_in: "slow_push",
  zoom_out: "slow_pull",
  pan_left: "pan_left",
  pan_right: "pan_right",
  tilt_up: "pan_up",
  tilt_down: "pan_down",
  ken_burns: "slow_push",
  // No dedicated motion in the renderer's vocabulary; the closest honest answer is a slow push,
  // and the difference is small enough not to misrepresent the plan.
  parallax: "slow_push",
  virtual_dolly: "slow_push",
  camera_drift: "pan_right",
};

/**
 * RONDE 148 — the camera move as NUMBERS, from the planner's movement and intensity.
 *
 * The scales below are the honest translation of a vocabulary into geometry, and they are small on
 * purpose: a documentary push that is visible as a push is wrong. `intensity` is the planner's own
 * 0..1, so a camera_hold (intensity 0) produces no move at all rather than a token one.
 */
export function cameraFor(instruction: CameraInstruction): ClipCamera {
  const i = Math.max(0, Math.min(1, instruction.intensity));
  /** A full-intensity push travels 12% — beyond that a still starts to look like a zoom effect. */
  const zoom = 1 + 0.12 * i;
  const pan = 0.12 * i;
  const base: ClipCamera = { type: instruction.movement, intensity: i };
  switch (instruction.movement) {
    case "camera_hold":
      return { ...base, startScale: 1, endScale: 1 };
    case "zoom_in":
    case "slow_push":
    case "ken_burns":
    case "virtual_dolly":
    case "parallax":
      return { ...base, startScale: 1, endScale: zoom };
    case "zoom_out":
    case "slow_pull":
      return { ...base, startScale: zoom, endScale: 1 };
    case "pan_left":
      return { ...base, startScale: zoom, endScale: zoom, startX: 0.5 + pan, endX: 0.5 - pan, startY: 0.5, endY: 0.5 };
    case "pan_right":
    case "camera_drift":
      return { ...base, startScale: zoom, endScale: zoom, startX: 0.5 - pan, endX: 0.5 + pan, startY: 0.5, endY: 0.5 };
    case "tilt_up":
      return { ...base, startScale: zoom, endScale: zoom, startY: 0.5 + pan, endY: 0.5 - pan, startX: 0.5, endX: 0.5 };
    case "tilt_down":
      return { ...base, startScale: zoom, endScale: zoom, startY: 0.5 - pan, endY: 0.5 + pan, startX: 0.5, endX: 0.5 };
    default:
      return { ...base, startScale: 1, endScale: 1 };
  }
}

/**
 * Effects this renderer can actually execute, as ffmpeg filters that exist in both builds.
 *
 * Everything else stays on the clip and is reported. The list is short and honest rather than
 * aspirational: an effect named here must have a filter behind it in `timelineRenderer`.
 */
export const RENDERABLE_EFFECTS: ReadonlySet<string> = new Set([
  "film_grain",
  "noise",
  "vignette",
  "letterbox",
  /** RONDE 149 — split/blur/screen for the two light effects, rgbashift for the lens one. */
  "glow",
  "bloom",
  "chromatic_aberration",
]);

/**
 * The engine's motion-graphic vocabulary, mapped to the renderer's.
 *
 * ── RONDE 160 §7 — the missing connection this closes ────────────────────────────────────────
 *
 * The planner names nine kinds of motion graphic. The renderer draws thirty-two. The two lists had
 * NO NAME IN COMMON, so `graphicIsRenderable` answered "no" for every graphic the cinematic engine
 * ever planned, and `translateEdl` reported all of them as "kept on the GRAPHICS track, not drawn
 * by this renderer" — unconditionally, on every render. Nothing failed and nothing was silent; the
 * loss was reported honestly and completely, and the report was never read. The whole motion
 * graphics feature was inert on the live route.
 *
 * ── Why only three of the nine are here ──────────────────────────────────────────────────────
 *
 * A name is in this map only when a real component draws THAT PLANNER'S OWN PAYLOAD as it stands.
 * No field is renamed, added or synthesised to make an entry fit:
 *
 *   progress_bar       `{ toValue, suffix, label }`         → the percentage ring reads `toValue`
 *   statistic_counter  `{ fromValue, toValue, suffix, label }` → the counter reads from/to/suffix
 *   map                `{ locationName, normX, normY }`     → the abstract map reads normX/normY
 *
 * The other six stay untranslated and keep being reported, because translating them would mean
 * inventing content, which §11 forbids:
 *
 *   chart          carries a keyword, not a series — a chart component with nothing to plot
 *   timeline       carries events[], and a text card would have to compose a sentence from them
 *   arrow          could be drawn as the `arrow` shape, but the shape draws no text and the
 *                  planner's whole payload is the label of the thing being pointed at
 *   comparison     no component draws a side-by-side
 *   highlight_box  no component draws a box around a region of the picture
 *   animated_icon  `icon` needs a name this build has a path for; a brand name is not one
 */
export const RENDERER_GRAPHIC_TYPE: Readonly<Partial<Record<MotionGraphicType, string>>> = {
  progress_bar: "progress",
  statistic_counter: "counter",
  map: "map_point",
  /**
   * RONDE 178 — `timeline` is the graphic the live route plans most often, and it was undrawable.
   *
   * R160 translated the three types its own fixtures produced. The end-to-end test on real beat
   * text then showed which types a REAL render plans, and `timeline` — a dated historical event —
   * was top of the list and reached no component at all.
   *
   * `timeline_event` is a declared renderable name and draws the event as a card. The planner's
   * words survive: `graphicLabel` reads the year and label out of the `events` entry the planner
   * itself wrote, and the original name stays in `reason` as `[planned as "timeline"]`.
   *
   * The other five planner types — chart, comparison, animated_icon, highlight_box, arrow — are
   * deliberately NOT translated. There is no component that draws a highlight box or a side-by-side
   * comparison, and pointing them at a text card would substitute one graphic for another. They
   * stay on the GRAPHICS track and are reported as undrawn, which is the honest answer and the one
   * `formatGraphics` now puts in the render log.
   */
  timeline: "timeline_event",
};

/** The renderer's name for a planned graphic, or the planner's own when there is no translation. */
export function rendererGraphicType(graphicType: string): string {
  return RENDERER_GRAPHIC_TYPE[graphicType as MotionGraphicType] ?? graphicType;
}

/**
 * The words a graphic puts on screen, taken from the planner's payload — never invented.
 *
 * A map's `locationName` and a counter's `suffix` are what the planner decided this graphic says.
 * Returning undefined when there is no text is the right answer: it means the graphic is not a
 * words-on-screen graphic, and it will be reported as undrawn rather than rendered as an empty box.
 */
export function graphicLabel(graphicType: string, data: Record<string, unknown>): string | undefined {
  for (const key of ["text", "label", "title", "locationName", "caption", "name"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  /**
   * RONDE 178 — a timeline's words live one level down, inside its own `events` entry.
   *
   * The planner writes `{ events: [{ year, label }] }`, so every key above misses and the graphic
   * was reported undrawable for having no words while carrying exactly the words it wanted on
   * screen. Read from the planner's payload, joined the way the card shows it — nothing added.
   */
  const events = data.events;
  if (Array.isArray(events) && events.length > 0) {
    const first = events[0] as Record<string, unknown> | undefined;
    const year = typeof first?.year === "string" ? first.year.trim() : "";
    const label = typeof first?.label === "string" ? first.label.trim() : "";
    const joined = [year, label].filter(Boolean).join(" — ");
    if (joined) return joined;
  }
  return undefined;
}

/** Caption position → the renderer's text position. */
function positionFor(caption: CaptionInstruction): TextStyle["position"] {
  switch (caption.position) {
    case "top": return "top";
    case "center": return "center";
    case "lower-third": return "lower_third";
    // bottom, bottom-left and bottom-right all sit at the bottom; the renderer centres text and
    // has no horizontal alignment yet, so the left/right variants land in the same place. Reported
    // by translateEdl rather than silently equated.
    case "bottom":
    case "bottom-left":
    case "bottom-right":
    default: return "bottom";
  }
}

/**
 * Which track a caption belongs on.
 *
 * `subtitle` is spoken narration and goes to CAPTIONS. Everything else — a title, a date card, a
 * lower third, a statistic — is an editorial overlay and goes to TEXT. They are different tracks
 * because a user switching captions off must not lose the date cards with them.
 */
export function trackForCaption(caption: CaptionInstruction): "CAPTIONS" | "TEXT" {
  return caption.captionType === "subtitle" ? "CAPTIONS" : "TEXT";
}

function styleFor(caption: CaptionInstruction): TextStyle {
  const base = trackForCaption(caption) === "CAPTIONS" ? DEFAULT_CAPTION_STYLE : DEFAULT_TEXT_STYLE;
  return { ...base, position: positionFor(caption) };
}

export type EdlTranslationInput = {
  decision: EditDecision;
  /**
   * Where this decision's SCENE starts on the whole video, seconds. The caller knows; this must
   * not guess.
   *
   * RONDE 150 — this field used to be called `beatOffsetSec`, and the name was a trap. Every time
   * value inside an `EditDecision` is SCENE-relative, not beat-relative: `planClipTiming` passes
   * `beatVoiceStartSec` ("this beat's voice-over start time within the scene") straight into
   * `planSubBeatCuts`, which begins its first cut at exactly that number. So a caller who read the
   * old name literally and passed the beat's own start added the beat offset twice, producing a
   * video of double the length with every clip drifting further from the narration — a fault that
   * renders perfectly and is silently out of sync. One offset per scene, added to numbers that are
   * already scene-relative, is the arithmetic that was always intended.
   */
  sceneOffsetSec: number;
  /** The permanent identity for the decision's chosen candidate, from the lineage ledger. */
  identity: AssetSourceIdentity;
  /**
   * RONDE 151 §7 — the cut the RENDER already made into the provider's original, when it made one.
   *
   * Absent means this render did not pre-trim the asset, or did not measure the offset. It never
   * means zero: see the composition in `translateEdl` for why the difference matters on a
   * re-render.
   */
  sourceTrim?: { inSec: number; outSec?: number };
};

export type EdlTranslation = {
  timeline: ProjectTimeline;
  /** Fields the engine expressed and the renderer cannot yet execute. Reported, never dropped. */
  unsupported: string[];
};

/**
 * Turn a set of edit decisions into a project timeline.
 *
 * Deterministic: ids are derived from the decision's own beat and candidate (see
 * `timelineElementId`), so translating the same EDL twice produces byte-identical output. A
 * counter or a clock here would break §12 and make an edit made against one translation
 * unrecognisable in the next.
 */
export function translateEdl(params: {
  videoId: number;
  inputs: readonly EdlTranslationInput[];
  format?: typeof DEFAULT_FORMAT;
  /** The narration, when it has been persisted. RONDE 146 stores this per video. */
  voice?: { url: string; durationSec: number } | null;
  /**
   * R160 BUG 1 — the video's colour treatment.
   *
   * ── The bug this closes ──────────────────────────────────────────────────────────────────
   *
   * This function never set `timeline.look`, so every video the cinematic route planned came out
   * with NO grade at all: `gradeChain` returns null for an absent look, and the whole of
   * documentaryStyle's source-aware calibration — the thing that makes a Library of Congress scan,
   * a Pexels drone shot and a generated establishing shot belong in one film — was unreachable
   * from the new path. The eight looks added in RONDE 153 were unreachable with it.
   *
   * Nothing failed and no test caught it, because a timeline with no look is a perfectly valid
   * timeline. It renders; it just renders ungraded.
   *
   * Absent still means "no grade", so a caller that says nothing gets exactly what this function
   * produced before — which keeps every existing test and the golden render unchanged.
   */
  look?: TimelineLook;
}): EdlTranslation {
  const timeline = emptyTimeline(params.videoId, params.format ?? DEFAULT_FORMAT);
  if (params.look) timeline.look = params.look;
  const unsupported: string[] = [];

  const clips: TimelineVideoClip[] = [];
  const captions: TimelineCaption[] = [];
  const texts: TimelineText[] = [];
  const sfx: TimelineAudioClip[] = [];
  const graphics: TimelineGraphic[] = [];

  for (const { decision, sceneOffsetSec, identity, sourceTrim } of params.inputs) {
    const clip = decision.clip;
    const start = sceneOffsetSec + clip.startSec;
    const end = sceneOffsetSec + clip.endSec;

    const mapped = TRANSITION_MAP[decision.transitionIn.type] ?? null;
    if (mapped === null) {
      unsupported.push(
        `transition "${decision.transitionIn.type}" (${decision.transitionIn.reason}) — ` +
          "rendered as a hard cut"
      );
    }

    clips.push({
      id: timelineElementId("vc", decision.beatId, clip.candidateId, clip.startSec),
      kind: clip.assetType === "image" ? "image" : "video",
      source: identity,
      /**
       * RONDE 151 §7 — the planner's trim, composed with the trim the RENDER already applied.
       *
       * `trimStartSec/trimEndSec` are the planner's words for sourceIn/out, and they are relative
       * to the file the pipeline handed it — which for most provider routes is not the provider's
       * asset but a clip already cut out of it by `trimRemoteVideoToClip`. `sourceTrim` is that
       * first cut, from the lineage record.
       *
       * The timeline's `sourceIn` must be relative to what the REHYDRATOR will produce, and the
       * rehydrator fetches the provider's original. So the two offsets are added. Without this a
       * re-render starts at second 0 of the full asset and shows a different shot, with nothing
       * anywhere reporting a problem.
       *
       * With no recorded first cut the planner's numbers stand unchanged — which is correct for a
       * clip that was never pre-trimmed, and is not a guess about one that was: an unmeasured trim
       * leaves the record's field absent, and absent reaches here as `undefined`.
       */
      sourceIn: sourceTrim ? Number((sourceTrim.inSec + clip.trimStartSec).toFixed(3)) : clip.trimStartSec,
      sourceOut: sourceTrim ? Number((sourceTrim.inSec + clip.trimEndSec).toFixed(3)) : clip.trimEndSec,
      timelineStart: Number(start.toFixed(3)),
      timelineEnd: Number(end.toFixed(3)),
      motion: CAMERA_MAP[decision.camera.movement] ?? "none",
      /**
       * RONDE 148 — the camera move, PARAMETERISED, not just labelled.
       *
       * `motion` keeps the coarse name for older readers; `camera` carries what the planner
       * actually decided — the movement type and how pronounced it should be — so the renderer can
       * execute a 1.00→1.12 push rather than guessing what "slow_push" means.
       */
      camera: cameraFor(decision.camera),
      /**
       * Carried, not dropped. An effect the renderer cannot execute is reported in `unsupported`
       * AND kept here, so the plan survives in the document and a later renderer can run it.
       */
      effects: decision.effects.map((e) => ({
        effectType: e.effectType,
        intensity: e.intensity,
        reason: e.reason,
      })),
      transitionIn: mapped ?? "hard_cut",
      transitionInSec: decision.transitionIn.durationSec,
      transitionOut: "hard_cut",
      previewSource: "asset",
      sceneIndex: decision.sceneIndex,
    });

    for (const caption of decision.captions) {
      const el = {
        id: timelineElementId("cap", decision.beatId, caption.captionType, caption.startSec),
        text: caption.subtitle ? `${caption.text}\n${caption.subtitle}` : caption.text,
        start: Number((sceneOffsetSec + caption.startSec).toFixed(3)),
        end: Number((sceneOffsetSec + caption.endSec).toFixed(3)),
        style: styleFor(caption),
      };
      if (caption.position === "bottom-left" || caption.position === "bottom-right") {
        unsupported.push(
          `caption position "${caption.position}" on beat ${decision.beatId} — the renderer ` +
            "centres text, so it is drawn bottom-centre"
        );
      }
      if (trackForCaption(caption) === "CAPTIONS") captions.push(el);
      else texts.push({ ...el, animation: caption.animation === "none" ? "none" : "fade" });
    }

    for (const sound of decision.sounds) {
      sfx.push({
        id: timelineElementId("sfx", decision.beatId, sound.soundType, sound.timeSec),
        source: { provider: "cinematic_audio", providerAssetId: sound.soundType },
        start: Number((sceneOffsetSec + sound.timeSec).toFixed(3)),
        end: Number((sceneOffsetSec + sound.timeSec + 1.5).toFixed(3)),
        gain: Math.max(0, Math.min(1, sound.volume)),
        fadeInSec: sound.fadeInSec,
        fadeOutSec: sound.fadeOutSec,
      });
    }

    /**
     * RONDE 148 §12 — motion graphics land on the GRAPHICS track WITH their payload.
     *
     * They used to be counted and thrown away, because that track was `TimelineText[]` and a map's
     * normX/normY has nowhere to live in a string. Now the planner's `data` survives translation
     * whether or not this renderer can draw it: what the renderer cannot do is reported below, and
     * what the planner decided stays in the document.
     */
    for (const graphic of decision.motionGraphics) {
      /**
       * RONDE 160 §7 — translated to the renderer's name, and the planner's name kept in the reason.
       *
       * The type on the timeline has to be the one the renderer understands, or the graphic is not
       * drawn. But "the planner asked for a map" is a decision with a reason attached, and losing
       * it would make the document unable to explain itself. So the original name travels in
       * `reason`, which is the field that exists for exactly that.
       */
      const rendererType = rendererGraphicType(graphic.graphicType);
      const label = graphicLabel(rendererType, graphic.data);
      graphics.push({
        id: timelineElementId("gfx", decision.beatId, rendererType, graphic.startSec),
        graphicType: rendererType,
        data: graphic.data,
        start: Number((sceneOffsetSec + graphic.startSec).toFixed(3)),
        end: Number((sceneOffsetSec + graphic.startSec + graphic.durationSec).toFixed(3)),
        label,
        reason:
          rendererType === graphic.graphicType
            ? graphic.reason
            : `${graphic.reason} [planned as "${graphic.graphicType}"]`,
      });
      /**
       * The renderer's OWN answer, not a second list.
       *
       * This used to consult `GRAPHICS_WITH_A_LABEL`, a hand-written set in this file whose comment
       * still said "those the ASS pass can draw today" — it predated the Remotion graphics layer
       * and was never updated. It called `statistic` drawable and `bar_chart`, `map_point`, `title`
       * and `counter` undrawable, all of which draw perfectly. Asking `graphicIsRenderable` means
       * this report and the component's own decision are the same answer, by construction.
       */
      if (!graphicIsRenderable(rendererType, graphic.data, label ?? null)) {
        unsupported.push(
          `motion graphic "${graphic.graphicType}" on beat ${decision.beatId} ` +
            `(${graphic.reason}) — kept on the GRAPHICS track, not drawn by this renderer`
        );
      }
    }
    for (const effect of decision.effects) {
      if (!RENDERABLE_EFFECTS.has(effect.effectType)) {
        unsupported.push(
          `visual effect "${effect.effectType}" on beat ${decision.beatId} (${effect.reason}) — ` +
            "kept on the clip, not executed by this renderer"
        );
      }
    }
  }

  /**
   * RONDE 178 — two text overlays in the same place at the same moment, named.
   *
   * ── What the end-to-end test found ────────────────────────────────────────────────────────
   *
   * On a dated historical beat the caption planner produces a timeline label at `bottom` and a
   * location tag at `bottom-left`. Those are two DIFFERENT positions as far as the planner is
   * concerned. `positionFor` collapses both to `bottom`, because the renderer centres text and has
   * no horizontal alignment — and the two are then drawn on top of each other, unreadably, in a
   * render nobody had looked at.
   *
   * ── Why this reports rather than moves ────────────────────────────────────────────────────
   *
   * `captionLayout` already resolves collisions geometrically, and `remotionProps` already applies
   * it — to CAPTIONS. Free text is deliberately excluded there, with a reason: a text element is an
   * OBSTACLE that captions are moved to avoid, so moving the text would move the thing the caption
   * was moved away from. Overruling that here would be a layout decision made in the wrong module.
   *
   * And moving one changes what a customer sees, on a question — which vertical band a location tag
   * belongs in — that cannot be settled without looking at a rendered frame. So the collision is
   * named, in the same channel as the position collapse that causes it, and stays visible per render
   * in the `[EDL] unsupported` lines until somebody can look at one.
   */
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (a.style.position !== b.style.position) continue;
      if (a.start >= b.end || b.start >= a.end) continue;
      unsupported.push(
        `two text overlays share position "${a.style.position}" between ` +
          `${Math.max(a.start, b.start).toFixed(2)}s and ${Math.min(a.end, b.end).toFixed(2)}s — ` +
          `they are drawn on top of each other`
      );
    }
  }

  clips.sort((a, b) => a.timelineStart - b.timelineStart);
  const duration = clips.length > 0 ? Math.max(...clips.map((c) => c.timelineEnd)) : 0;

  timeline.tracks = [
    { kind: "VIDEO", clips },
    {
      kind: "VOICE",
      clips: params.voice
        ? [{
            id: timelineElementId("voice", params.videoId, params.voice.url),
            source: { provider: "narration", canonicalUrl: params.voice.url },
            start: 0,
            end: params.voice.durationSec,
            gain: 1,
          }]
        : [],
    },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: sfx },
    { kind: "CAPTIONS", captions },
    { kind: "AMBIENT", clips: [] },
    { kind: "TEXT", texts },
    { kind: "GRAPHICS", graphics },
  ];
  timeline.durationSec = Number(duration.toFixed(3));
  return { timeline, unsupported };
}

/** What the translation could not carry across, for the render log. */
export function formatEdlTranslation(result: EdlTranslation): string[] {
  const clipCount = result.timeline.tracks.find((t) => t.kind === "VIDEO");
  const clips = clipCount && clipCount.kind === "VIDEO" ? clipCount.clips.length : 0;
  const lines = [
    `[EdlToTimeline] clips=${clips} duration=${result.timeline.durationSec.toFixed(2)}s ` +
      `unsupported=${result.unsupported.length}`,
  ];
  for (const u of result.unsupported) lines.push(`   not executed: ${u}`);
  return lines;
}
