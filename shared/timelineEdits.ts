/**
 * VIDEO 619 — THE EDITOR'S EDITS, AS PURE FUNCTIONS OVER A TIMELINE.
 *
 * The editor could replace a shot and change a caption's words. A person editing a film needs to
 * add a shot, drop one, move it, make it longer or shorter, cut it in two, and put their own text
 * on screen. Every one of those is a change to the same document the renderer reads, so they live
 * here, once, and the client calls them on its draft.
 *
 * ── The three rules every edit keeps ─────────────────────────────────────────────────────────
 *
 *   1. The picture is one unbroken line from 0: after any edit the video clips are laid end to
 *      end again (the validator refuses gaps and overlaps on a concatenated track).
 *   2. The picture covers the narration: if an edit leaves it shorter than the voice, the last
 *      shot is held until the voice ends (the validator refuses a film that cuts its speaker off).
 *   3. The document's length is the picture's length (the validator refuses a mismatch).
 *
 * Pure and deterministic apart from the new ids, which the caller may pass in for tests.
 */

type AnyTrack = { kind: string } & Record<string, unknown>;

export type EditableTimeline = {
  durationSec: number;
  tracks: AnyTrack[];
};

export type EditableVideoClip = {
  id: string;
  kind: "video" | "image";
  timelineStart: number;
  timelineEnd: number;
  sourceIn?: number;
  sourceOut?: number;
  editedByUser?: boolean;
} & Record<string, unknown>;

export type EditableText = {
  id: string;
  text: string;
  start: number;
  end: number;
  disabled?: boolean;
  disabledReason?: string;
  editedByUser?: boolean;
} & Record<string, unknown>;

/** The shortest shot the editor will make. Shorter than this is a flash, not a shot. */
export const MIN_SHOT_SEC = 0.5;
/** How long a newly added text stays on screen. */
export const NEW_TEXT_SEC = 3;

const round = (n: number): number => Number(n.toFixed(3));

let idCounter = 0;
export function newElementId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_u${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/* ═══════════════════════ reading ═══════════════════════ */

export function videoClipsOf<T extends EditableTimeline>(t: T): EditableVideoClip[] {
  const track = t.tracks.find((x) => x.kind === "VIDEO") as { clips?: EditableVideoClip[] } | undefined;
  return [...(track?.clips ?? [])].sort((a, b) => a.timelineStart - b.timelineStart);
}

function voiceEndOf(t: EditableTimeline): number {
  const track = t.tracks.find((x) => x.kind === "VOICE") as { clips?: Array<{ end: number }> } | undefined;
  return (track?.clips ?? []).reduce((m, c) => Math.max(m, c.end), 0);
}

/* ═══════════════════════ the three rules ═══════════════════════ */

/**
 * Lay the clips end to end from 0 in the given order, keeping each one's length; hold the last
 * one under the rest of the voice; make the document as long as the picture.
 */
export function withVideoClips<T extends EditableTimeline>(t: T, ordered: EditableVideoClip[]): T {
  let at = 0;
  const packed = ordered.map((c) => {
    const len = Math.max(MIN_SHOT_SEC, c.timelineEnd - c.timelineStart);
    const next = { ...c, timelineStart: round(at), timelineEnd: round(at + len) };
    at += len;
    return next;
  });
  const voiceEnd = voiceEndOf(t);
  if (packed.length > 0 && voiceEnd > at) {
    const last = packed[packed.length - 1]!;
    packed[packed.length - 1] = withLength(last, voiceEnd - last.timelineStart);
    at = voiceEnd;
  }
  return {
    ...t,
    durationSec: round(packed.length ? packed[packed.length - 1]!.timelineEnd : 0),
    tracks: t.tracks.map((tr) => (tr.kind === "VIDEO" ? { ...tr, clips: packed } : tr)),
  };
}

/** A clip made `len` seconds long, its source out-point moved with it when one is recorded. */
function withLength(c: EditableVideoClip, len: number): EditableVideoClip {
  const next: EditableVideoClip = { ...c, timelineEnd: round(c.timelineStart + len) };
  if (c.kind === "video" && c.sourceIn != null) next.sourceOut = round(c.sourceIn + len * speedOf(c));
  return next;
}

/** The slowest and fastest a shot may play; the renderer clamps to the same range. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

function speedOf(c: EditableVideoClip): number {
  const s = typeof c.speed === "number" && Number.isFinite(c.speed) ? c.speed : 1;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, s));
}

/* ═══════════════════════ shots ═══════════════════════ */

/** Put a shot after `afterId`, or at the start when `afterId` is null. */
export function insertVideoClip<T extends EditableTimeline>(
  t: T,
  clip: EditableVideoClip,
  afterId: string | null
): T {
  const clips = videoClipsOf(t);
  const at = afterId == null ? -1 : clips.findIndex((c) => c.id === afterId);
  const placed = { ...clip, editedByUser: true };
  clips.splice(at + 1, 0, placed);
  return withVideoClips(t, clips);
}

/** Drop a shot; the ones after it move up. The last remaining shot cannot be removed. */
export function removeVideoClip<T extends EditableTimeline>(t: T, id: string): T {
  const clips = videoClipsOf(t);
  if (clips.length <= 1) return t;
  return withVideoClips(t, clips.filter((c) => c.id !== id));
}

/** Swap a shot with its neighbour: -1 earlier, +1 later. */
export function moveVideoClip<T extends EditableTimeline>(t: T, id: string, direction: -1 | 1): T {
  const clips = videoClipsOf(t);
  const i = clips.findIndex((c) => c.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= clips.length) return t;
  [clips[i], clips[j]] = [clips[j]!, clips[i]!];
  return withVideoClips(t, clips);
}

/** Make a shot this many seconds long; everything after it moves with it. */
export function setVideoClipLength<T extends EditableTimeline>(t: T, id: string, seconds: number): T {
  if (!Number.isFinite(seconds)) return t;
  const len = Math.max(MIN_SHOT_SEC, seconds);
  const clips = videoClipsOf(t).map((c) =>
    c.id === id ? { ...withLength(c, len), editedByUser: true } : c
  );
  return withVideoClips(t, clips);
}

/** Start the shot at a later (or earlier) moment of its own source. */
export function setVideoClipSourceIn<T extends EditableTimeline>(t: T, id: string, seconds: number): T {
  if (!Number.isFinite(seconds)) return t;
  const clips = videoClipsOf(t).map((c) => {
    if (c.id !== id || c.kind !== "video") return c;
    const sourceIn = round(Math.max(0, seconds));
    return {
      ...c,
      sourceIn,
      sourceOut: round(sourceIn + (c.timelineEnd - c.timelineStart) * speedOf(c)),
      editedByUser: true,
    };
  });
  return withVideoClips(t, clips);
}

/** Put an identical copy of a shot right after it; everything after moves up. */
export function duplicateVideoClip<T extends EditableTimeline>(
  t: T,
  id: string,
  newId = newElementId("clip")
): T {
  const clips = videoClipsOf(t);
  const i = clips.findIndex((c) => c.id === id);
  const c = clips[i];
  if (!c) return t;
  clips.splice(i + 1, 0, { ...c, id: newId, transitionIn: "hard_cut", editedByUser: true });
  return withVideoClips(t, clips);
}

/**
 * Play a shot faster or slower. Its slot on the timeline stays the same length — the narration
 * decides the film's length — so a faster shot shows more of its source in the same seconds.
 */
export function setVideoClipSpeed<T extends EditableTimeline>(t: T, id: string, speed: number): T {
  if (!Number.isFinite(speed)) return t;
  const clips = videoClipsOf(t).map((c) => {
    if (c.id !== id || c.kind !== "video") return c;
    const next: EditableVideoClip = { ...c, speed: round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed))), editedByUser: true };
    if (Math.abs((next.speed as number) - 1) < 0.001) delete next.speed;
    return withLength(next, c.timelineEnd - c.timelineStart);
  });
  return withVideoClips(t, clips);
}

/**
 * Faster pacing without touching the narration: every shot longer than `maxShotSec` is cut into
 * equal parts that each show the next stretch of the same source — more cuts, same film length.
 */
export function tightenPacing<T extends EditableTimeline>(t: T, maxShotSec: number): T {
  const limit = Math.max(MIN_SHOT_SEC * 2, maxShotSec);
  let out = t;
  for (const c of videoClipsOf(t)) {
    const len = c.timelineEnd - c.timelineStart;
    if (len <= limit) continue;
    const parts = Math.ceil(len / limit);
    let current = c.id;
    for (let k = 1; k < parts; k++) {
      const at = c.timelineStart + (len / parts) * k;
      const nextId = newElementId("clip");
      out = splitVideoClip(out, current, at, nextId);
      current = nextId;
    }
  }
  return out;
}

/**
 * Cut a shot in two at a moment on the timeline. Each half keeps its part of the source, so the
 * cut shows the same picture it did before — it only makes a point where something can change.
 */
export function splitVideoClip<T extends EditableTimeline>(
  t: T,
  id: string,
  atSec: number,
  newId = newElementId("clip")
): T {
  const clips = videoClipsOf(t);
  const i = clips.findIndex((c) => c.id === id);
  const c = clips[i];
  if (!c) return t;
  const first = atSec - c.timelineStart;
  const second = c.timelineEnd - atSec;
  if (first < MIN_SHOT_SEC || second < MIN_SHOT_SEC) return t;
  const a: EditableVideoClip = { ...withLength(c, first), editedByUser: true };
  const b: EditableVideoClip = {
    ...c,
    id: newId,
    timelineStart: round(atSec),
    timelineEnd: c.timelineEnd,
    transitionIn: "hard_cut",
    editedByUser: true,
  };
  const sp = speedOf(c);
  if (c.kind === "video" && c.sourceIn != null) {
    b.sourceIn = round(c.sourceIn + first * sp);
    b.sourceOut = round(b.sourceIn + second * sp);
  } else if (c.kind === "video") {
    b.sourceIn = round(first * sp);
    b.sourceOut = round((first + second) * sp);
  }
  clips.splice(i, 1, a, b);
  return withVideoClips(t, clips);
}

/* ═══════════════════════ text ═══════════════════════ */

type TextKind = "TEXT" | "CAPTIONS" | "GRAPHICS";
const LIST_FIELD: Record<TextKind, string> = { TEXT: "texts", CAPTIONS: "captions", GRAPHICS: "graphics" };

function mapTextTrack<T extends EditableTimeline>(
  t: T,
  kind: TextKind,
  fn: (els: EditableText[]) => EditableText[]
): T {
  const field = LIST_FIELD[kind];
  let found = false;
  const tracks = t.tracks.map((tr) => {
    if (tr.kind !== kind) return tr;
    found = true;
    return { ...tr, [field]: fn([...(((tr as Record<string, unknown>)[field] as EditableText[]) ?? [])]) };
  });
  if (!found) tracks.push({ kind, [field]: fn([]) });
  return { ...t, tracks };
}

/** Add a text of the person's own, on screen from `atSec` for three seconds. */
export function addText<T extends EditableTimeline>(
  t: T,
  params: { text: string; atSec: number; style: Record<string, unknown>; id?: string }
): T {
  const start = round(Math.max(0, Math.min(params.atSec, Math.max(0, t.durationSec - MIN_SHOT_SEC))));
  const end = round(Math.min(Math.max(t.durationSec, start + MIN_SHOT_SEC), start + NEW_TEXT_SEC));
  const el: EditableText = {
    id: params.id ?? newElementId("txt"),
    text: params.text.trim() || "Tekst",
    start,
    end,
    style: params.style,
    animation: "fade",
    editedByUser: true,
  };
  return mapTextTrack(t, "TEXT", (els) => [...els, el].sort((a, b) => a.start - b.start));
}

/**
 * Move or resize one text, caption or graphic in time. Kept inside the film and at least
 * `MIN_SHOT_SEC` long; the element is marked as the person's own edit.
 */
export function setTextElementTiming<T extends EditableTimeline>(
  t: T,
  kind: TextKind,
  id: string,
  start: number,
  end: number
): T {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return t;
  const dur = Math.max(MIN_SHOT_SEC, t.durationSec);
  const s0 = round(Math.max(0, Math.min(start, dur - MIN_SHOT_SEC)));
  const e0 = round(Math.min(dur, Math.max(end, s0 + MIN_SHOT_SEC)));
  return mapTextTrack(t, kind, (els) =>
    els
      .map((e) => (e.id === id ? { ...e, start: s0, end: e0, editedByUser: true } : e))
      .sort((a, b) => a.start - b.start)
  );
}

/** One style change applied to every caption — "smaller subtitles", "subtitles at the top". */
export function setAllCaptionsStyle<T extends EditableTimeline>(t: T, patch: Record<string, unknown>): T {
  return mapTextTrack(t, "CAPTIONS", (els) =>
    els.map((e) => ({ ...e, style: { ...((e.style as Record<string, unknown>) ?? {}), ...patch }, editedByUser: true }))
  );
}

export function removeTextElement<T extends EditableTimeline>(t: T, kind: TextKind, id: string): T {
  return mapTextTrack(t, kind, (els) => els.filter((e) => e.id !== id));
}

/** Show or hide one text element. Showing clears the reason the pipeline switched it off. */
export function setTextElementShown<T extends EditableTimeline>(
  t: T,
  kind: TextKind,
  id: string,
  shown: boolean
): T {
  return mapTextTrack(t, kind, (els) =>
    els.map((e) => (e.id === id ? shownOrHidden(e, shown) : e))
  );
}

/** Every caption on or off at once — the subtitles, in one click. */
export function setAllCaptionsShown<T extends EditableTimeline>(t: T, shown: boolean): T {
  return mapTextTrack(t, "CAPTIONS", (els) => els.map((e) => shownOrHidden(e, shown)));
}

function shownOrHidden(e: EditableText, shown: boolean): EditableText {
  const { disabledReason: _r, ...rest } = e;
  return shown
    ? { ...rest, disabled: false, editedByUser: true }
    : { ...rest, disabled: true, editedByUser: true };
}

/** How many captions exist, and how many are on — for the subtitles button's label. */
export function captionCounts(t: EditableTimeline): { total: number; shown: number } {
  const track = t.tracks.find((x) => x.kind === "CAPTIONS") as { captions?: EditableText[] } | undefined;
  const all = track?.captions ?? [];
  return { total: all.length, shown: all.filter((c) => !c.disabled).length };
}

/* ═══════════════════════ audio ═══════════════════════ */

/** Take a music, effect or ambience clip out. The narration cannot be removed this way. */
export function removeAudioClip<T extends EditableTimeline>(
  t: T,
  kind: "MUSIC" | "SFX" | "AMBIENT",
  id: string
): T {
  return {
    ...t,
    tracks: t.tracks.map((tr) =>
      tr.kind === kind
        ? { ...tr, clips: ((tr as { clips?: Array<{ id: string }> }).clips ?? []).filter((c) => c.id !== id) }
        : tr
    ),
  };
}

export type AudioKind = "VOICE" | "MUSIC" | "SFX" | "AMBIENT";
export type AudioPatch = { gain?: number; fadeInSec?: number; fadeOutSec?: number; muted?: boolean };

/**
 * Volume, fades and mute for one audio clip. Mute is `disabled` — the renderer leaves a disabled
 * clip out of the mix — so a muted sound stays on the timeline and comes back with one click.
 */
export function setAudioClip<T extends EditableTimeline>(t: T, kind: AudioKind, id: string, patch: AudioPatch): T {
  return {
    ...t,
    tracks: t.tracks.map((tr) => {
      if (tr.kind !== kind) return tr;
      const clips = ((tr as { clips?: Array<Record<string, unknown> & { id: string; start: number; end: number }> }).clips ?? []).map((c) => {
        if (c.id !== id) return c;
        const len = Math.max(0, c.end - c.start);
        const next: Record<string, unknown> & { id: string; start: number; end: number } = { ...c };
        if (patch.gain != null && Number.isFinite(patch.gain)) next.gain = round(Math.max(0, Math.min(2, patch.gain)));
        if (patch.fadeInSec != null && Number.isFinite(patch.fadeInSec)) next.fadeInSec = round(Math.max(0, Math.min(len / 2, patch.fadeInSec)));
        if (patch.fadeOutSec != null && Number.isFinite(patch.fadeOutSec)) next.fadeOutSec = round(Math.max(0, Math.min(len / 2, patch.fadeOutSec)));
        if (patch.muted != null) {
          if (patch.muted) next.disabled = true;
          else delete next.disabled;
        }
        return next;
      });
      return { ...tr, clips };
    }),
  };
}

/** Move an effect, music or ambience clip in time, keeping its length and keeping it inside the film. */
export function setAudioClipTiming<T extends EditableTimeline>(
  t: T,
  kind: "MUSIC" | "SFX" | "AMBIENT",
  id: string,
  start: number
): T {
  if (!Number.isFinite(start)) return t;
  return {
    ...t,
    tracks: t.tracks.map((tr) => {
      if (tr.kind !== kind) return tr;
      const clips = ((tr as { clips?: Array<Record<string, unknown> & { id: string; start: number; end: number }> }).clips ?? []).map((c) => {
        if (c.id !== id) return c;
        const len = Math.max(0, c.end - c.start);
        const s0 = round(Math.max(0, Math.min(start, Math.max(0, t.durationSec - len))));
        return { ...c, start: s0, end: round(s0 + len) };
      });
      return { ...tr, clips };
    }),
  };
}
