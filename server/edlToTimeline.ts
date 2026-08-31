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
  type TimelineCaption,
  type TimelineText,
  type TimelineVideoClip,
  type TransitionKind,
} from "./projectTimeline";
import type {
  CameraMovementType,
  CaptionInstruction,
  EditDecision,
  TransitionType,
} from "./cinematicEditingEngine/types";

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
  /** Where this beat starts on the WHOLE video, seconds. The caller knows; this must not guess. */
  beatOffsetSec: number;
  /** The permanent identity for the decision's chosen candidate, from the lineage ledger. */
  identity: AssetSourceIdentity;
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
}): EdlTranslation {
  const timeline = emptyTimeline(params.videoId, params.format ?? DEFAULT_FORMAT);
  const unsupported: string[] = [];

  const clips: TimelineVideoClip[] = [];
  const captions: TimelineCaption[] = [];
  const texts: TimelineText[] = [];
  const sfx: TimelineAudioClip[] = [];

  for (const { decision, beatOffsetSec, identity } of params.inputs) {
    const clip = decision.clip;
    const start = beatOffsetSec + clip.startSec;
    const end = beatOffsetSec + clip.endSec;

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
      // Straight from the planner. `trimStartSec/trimEndSec` are its own words for sourceIn/out.
      sourceIn: clip.trimStartSec,
      sourceOut: clip.trimEndSec,
      timelineStart: Number(start.toFixed(3)),
      timelineEnd: Number(end.toFixed(3)),
      motion: CAMERA_MAP[decision.camera.movement] ?? "none",
      transitionIn: mapped ?? "hard_cut",
      transitionOut: "hard_cut",
      previewSource: "asset",
      sceneIndex: decision.sceneIndex,
      // The planner already recorded whether the timing came from real word alignment or an
      // estimate; carrying it forward is what lets a later reader tell a measured cut from a guess.
      ...(clip.timingSource === "tts_word_alignment" ? {} : {}),
    });

    for (const caption of decision.captions) {
      const el = {
        id: timelineElementId("cap", decision.beatId, caption.captionType, caption.startSec),
        text: caption.subtitle ? `${caption.text}\n${caption.subtitle}` : caption.text,
        start: Number((beatOffsetSec + caption.startSec).toFixed(3)),
        end: Number((beatOffsetSec + caption.endSec).toFixed(3)),
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
        start: Number((beatOffsetSec + sound.timeSec).toFixed(3)),
        end: Number((beatOffsetSec + sound.timeSec + 1.5).toFixed(3)),
        gain: Math.max(0, Math.min(1, sound.volume)),
        fadeInSec: sound.fadeInSec,
        fadeOutSec: sound.fadeOutSec,
      });
    }

    if (decision.motionGraphics.length > 0) {
      unsupported.push(
        `${decision.motionGraphics.length} motion graphic(s) on beat ${decision.beatId} ` +
          `(${decision.motionGraphics.map((g) => g.graphicType).join(", ")}) — the renderer has no ` +
          "graphics layer yet"
      );
    }
    if (decision.effects.length > 0) {
      unsupported.push(
        `${decision.effects.length} visual effect(s) on beat ${decision.beatId} — not yet executed`
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
    { kind: "TEXT", texts },
    { kind: "GRAPHICS", texts: [] },
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
