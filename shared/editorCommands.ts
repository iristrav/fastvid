/**
 * EDITOR COMMANDS — what an instruction like "make this faster" does to the timeline.
 *
 * The AI never edits the timeline itself and never renders. It answers with a short list of these
 * operations; the editor applies them to its draft through the same pure edits a person's clicks
 * use (`./timelineEdits`), so an AI edit is undoable, autosaved and rendered exactly like a manual
 * one. A replacement is the one operation that cannot be done locally — it needs the archive and
 * the Visual Judge — so it is returned to the caller, which runs the editor's own replace route.
 */
import {
  type EditableTimeline,
  type EditableVideoClip,
  removeTextElement,
  removeVideoClip,
  setAllCaptionsShown,
  setAllCaptionsStyle,
  setAudioClip,
  setTextElementShown,
  setVideoClipLength,
  setVideoClipSpeed,
  tightenPacing,
  videoClipsOf,
  withVideoClips,
} from "./timelineEdits";

export const CAMERA_MOVES = ["camera_hold", "slow_push", "slow_pull", "pan_left", "pan_right", "tilt_up", "tilt_down"] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** The transitions the editor offers: a small documentary set, every one rendered by xfade. */
export const EDITOR_TRANSITIONS = ["hard_cut", "crossfade", "dissolve", "dip_to_black", "slide_left", "slide_right", "zoom", "blur"] as const;
export type EditorTransition = (typeof EDITOR_TRANSITIONS)[number];

/** The effects the editor offers, each executed by the renderer's `effectChain`. */
export const EDITOR_EFFECTS = ["vignette", "blur", "exposure", "contrast", "film_grain", "letterbox"] as const;
export type EditorEffect = (typeof EDITOR_EFFECTS)[number];

/**
 * A camera move, in the numbers `edlToTimeline.cameraFor` uses at full intensity, so a move a
 * person or the AI picks looks like one the planner would have picked — one vocabulary.
 */
export function cameraPreset(type: string): { type: string; startScale: number; endScale: number; intensity: number } {
  const zoom = 1.12;
  switch (type) {
    case "camera_hold": return { type, startScale: 1, endScale: 1, intensity: 0 };
    case "slow_push": return { type, startScale: 1, endScale: zoom, intensity: 1 };
    case "slow_pull": return { type, startScale: zoom, endScale: 1, intensity: 1 };
    default: return { type, startScale: zoom, endScale: zoom, intensity: 1 };
  }
}

type ClipTarget = string | "all";

export type EditorOp =
  | { op: "tighten_pacing"; maxShotSec: number }
  | { op: "set_clip_length"; clipId: string; seconds: number }
  | { op: "remove_clip"; clipId: string }
  | { op: "set_speed"; clipId: string; speed: number }
  | { op: "set_camera"; clipId: ClipTarget; movement: CameraMove }
  | { op: "set_transition"; clipId: ClipTarget; transition: EditorTransition; seconds?: number }
  | { op: "set_effect"; clipId: ClipTarget; effect: EditorEffect; intensity: number }
  | { op: "show_element"; id: string; shown: boolean }
  | { op: "remove_element"; id: string }
  | { op: "set_text"; id: string; text: string }
  | { op: "captions_shown"; shown: boolean }
  | { op: "captions_style"; fontSizePx?: number; position?: string; backgroundOpacity?: number }
  | { op: "set_volume"; track: "VOICE" | "MUSIC" | "SFX" | "AMBIENT"; gain: number }
  | { op: "replace_clip"; clipId: string };

export type AppliedOps<T> = {
  timeline: T;
  /** One line per operation, saying what happened or why it did nothing. */
  log: string[];
  /** Clips to replace through the archive + Visual Judge route, in order. */
  replaceClipIds: string[];
};

type TextKind = "TEXT" | "CAPTIONS" | "GRAPHICS";
const LIST: Record<TextKind, string> = { TEXT: "texts", CAPTIONS: "captions", GRAPHICS: "graphics" };

function findTextKind(t: EditableTimeline, id: string): TextKind | null {
  for (const kind of ["TEXT", "CAPTIONS", "GRAPHICS"] as const) {
    const track = t.tracks.find((x) => x.kind === kind) as Record<string, unknown> | undefined;
    const els = (track?.[LIST[kind]] as Array<{ id: string }> | undefined) ?? [];
    if (els.some((e) => e.id === id)) return kind;
  }
  return null;
}

function mapClips<T extends EditableTimeline>(t: T, target: ClipTarget, fn: (c: EditableVideoClip) => EditableVideoClip): T {
  const clips = videoClipsOf(t);
  if (target !== "all" && !clips.some((c) => c.id === target)) return t;
  return withVideoClips(t, clips.map((c) => (target === "all" || c.id === target ? { ...fn(c), editedByUser: true } : c)));
}

/** Apply operations in order. Unknown ids do nothing and say so; nothing throws. */
export function applyEditorOps<T extends EditableTimeline>(timeline: T, ops: readonly EditorOp[]): AppliedOps<T> {
  let t = timeline;
  const log: string[] = [];
  const replaceClipIds: string[] = [];
  const hasClip = (id: string) => videoClipsOf(t).some((c) => c.id === id);
  for (const op of ops) {
    switch (op.op) {
      case "tighten_pacing": {
        const before = videoClipsOf(t).length;
        t = tightenPacing(t, op.maxShotSec);
        log.push(`pacing: shots longer than ${op.maxShotSec}s cut — ${before} → ${videoClipsOf(t).length} shots`);
        break;
      }
      case "set_clip_length":
        if (!hasClip(op.clipId)) { log.push(`no shot ${op.clipId}`); break; }
        t = setVideoClipLength(t, op.clipId, op.seconds);
        log.push(`shot ${op.clipId} → ${op.seconds}s`);
        break;
      case "remove_clip":
        if (!hasClip(op.clipId)) { log.push(`no shot ${op.clipId}`); break; }
        t = removeVideoClip(t, op.clipId);
        log.push(`shot ${op.clipId} removed`);
        break;
      case "set_speed":
        if (!hasClip(op.clipId)) { log.push(`no shot ${op.clipId}`); break; }
        t = setVideoClipSpeed(t, op.clipId, op.speed);
        log.push(`shot ${op.clipId} plays at ${op.speed}×`);
        break;
      case "set_camera":
        t = mapClips(t, op.clipId, (c) => ({ ...c, camera: cameraPreset(op.movement) }));
        log.push(`camera ${op.movement} on ${op.clipId === "all" ? "every shot" : `shot ${op.clipId}`}`);
        break;
      case "set_transition":
        t = mapClips(t, op.clipId, (c) =>
          c.timelineStart <= 0.001
            ? c
            : { ...c, transitionIn: op.transition, ...(op.seconds != null ? { transitionInSec: op.seconds } : {}) }
        );
        log.push(`transition ${op.transition} into ${op.clipId === "all" ? "every shot" : `shot ${op.clipId}`}`);
        break;
      case "set_effect":
        t = mapClips(t, op.clipId, (c) => withEffect(c, op.effect, op.intensity));
        log.push(`${op.effect} ${op.intensity > 0 ? `at ${Math.round(op.intensity * 100)}%` : "off"} on ${op.clipId === "all" ? "every shot" : `shot ${op.clipId}`}`);
        break;
      case "show_element":
      case "remove_element":
      case "set_text": {
        const kind = findTextKind(t, op.id);
        if (!kind) { log.push(`no text ${op.id}`); break; }
        if (op.op === "show_element") t = setTextElementShown(t, kind, op.id, op.shown);
        else if (op.op === "remove_element") t = removeTextElement(t, kind, op.id);
        else t = setText(t, kind, op.id, op.text);
        log.push(`${op.op.replace("_", " ")} ${op.id}`);
        break;
      }
      case "captions_shown":
        t = setAllCaptionsShown(t, op.shown);
        log.push(`subtitles ${op.shown ? "on" : "off"}`);
        break;
      case "captions_style": {
        const patch: Record<string, unknown> = {};
        if (op.fontSizePx != null) patch.fontSizePx = Math.max(24, Math.min(140, op.fontSizePx));
        if (op.position) patch.position = op.position;
        if (op.backgroundOpacity != null) patch.backgroundOpacity = Math.max(0, Math.min(1, op.backgroundOpacity));
        t = setAllCaptionsStyle(t, patch);
        log.push(`subtitle style ${JSON.stringify(patch)}`);
        break;
      }
      case "set_volume": {
        const track = t.tracks.find((x) => x.kind === op.track) as { clips?: Array<{ id: string }> } | undefined;
        for (const c of track?.clips ?? []) t = setAudioClip(t, op.track, c.id, { gain: op.gain });
        log.push(`${op.track} volume ${op.gain}`);
        break;
      }
      case "replace_clip":
        if (!hasClip(op.clipId)) { log.push(`no shot ${op.clipId}`); break; }
        replaceClipIds.push(op.clipId);
        log.push(`shot ${op.clipId} will be replaced`);
        break;
    }
  }
  return { timeline: t, log, replaceClipIds };
}

/** Turn one editor effect on at an intensity (0..1), or off at 0. Other effects are kept. */
export function withEffect(c: EditableVideoClip, effect: string, intensity: number): EditableVideoClip {
  const effects = ((c.effects as Array<{ effectType: string; intensity: number }> | undefined) ?? []).filter(
    (e) => e.effectType !== effect
  );
  const i = Math.max(0, Math.min(1, intensity));
  if (i > 0) effects.push({ effectType: effect, intensity: Number(i.toFixed(2)) });
  const next: EditableVideoClip = { ...c, effects };
  if (effects.length === 0) delete next.effects;
  return next;
}

function setText<T extends EditableTimeline>(t: T, kind: TextKind, id: string, text: string): T {
  const field = LIST[kind];
  const key = kind === "GRAPHICS" ? "label" : "text";
  return {
    ...t,
    tracks: t.tracks.map((tr) =>
      tr.kind === kind
        ? {
            ...tr,
            [field]: ((tr as Record<string, unknown>)[field] as Array<{ id: string }>).map((e) =>
              e.id === id ? { ...e, [key]: text, editedByUser: true } : e
            ),
          }
        : tr
    ),
  };
}

/**
 * A compact picture of the timeline for the AI: ids, times and what is on screen — never URLs.
 */
export function timelineForAssistant(t: EditableTimeline): string {
  const lines: string[] = [`duration ${t.durationSec.toFixed(1)}s`];
  for (const c of videoClipsOf(t)) {
    const camera = (c.camera as { type?: string } | undefined)?.type ?? "none";
    const title = ((c.source as { title?: string } | undefined)?.title ?? "").slice(0, 60);
    const speed = typeof c.speed === "number" ? ` speed=${c.speed}` : "";
    lines.push(
      `shot ${c.id} ${c.timelineStart.toFixed(1)}-${c.timelineEnd.toFixed(1)}s ${c.kind} camera=${camera} transition=${String(c.transitionIn ?? "hard_cut")}${speed} "${title}"`
    );
  }
  for (const kind of ["TEXT", "GRAPHICS"] as const) {
    const track = t.tracks.find((x) => x.kind === kind) as Record<string, unknown> | undefined;
    for (const e of ((track?.[LIST[kind]] as Array<Record<string, unknown>>) ?? [])) {
      const label = String(e.text ?? e.label ?? e.graphicType ?? "").slice(0, 50);
      lines.push(`${kind.toLowerCase()} ${String(e.id)} ${Number(e.start).toFixed(1)}-${Number(e.end).toFixed(1)}s ${e.disabled ? "hidden" : "shown"} "${label}"`);
    }
  }
  const captions = (t.tracks.find((x) => x.kind === "CAPTIONS") as { captions?: Array<{ disabled?: boolean }> } | undefined)?.captions ?? [];
  lines.push(`subtitles ${captions.length} (${captions.filter((c) => !c.disabled).length} shown)`);
  for (const kind of ["MUSIC", "SFX", "AMBIENT"] as const) {
    const n = ((t.tracks.find((x) => x.kind === kind) as { clips?: unknown[] } | undefined)?.clips ?? []).length;
    lines.push(`${kind.toLowerCase()} clips ${n}`);
  }
  return lines.join("\n");
}
