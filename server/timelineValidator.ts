/**
 * RONDE 147 §9 — nothing renders from a timeline nobody checked.
 *
 * ── Why a validator, and why it refuses rather than repairs ──────────────────────────────────
 *
 * The timeline is becoming the source of truth for rendering, which means every bad number in it
 * becomes a bad video. A clip whose `timelineEnd` precedes its `timelineStart` produces a segment
 * of negative length; ffmpeg answers that with a zero-frame file, the concat quietly drops it, and
 * the render comes out short with nothing in the log to say why. That is the failure mode this
 * module exists to make impossible.
 *
 * IT NEVER CORRECTS ANYTHING. §9: "Geen stille correcties."
 *
 * The temptation is obvious — clamp the end to the start, drop the overlap, stretch the last clip
 * to close the gap — and every one of those turns a visible error into an invisible one. A
 * validator that repairs is a validator that hides. This one reports, names the element, and lets
 * the caller decide.
 *
 * ── What counts as a fault, and what deliberately does not ───────────────────────────────────
 *
 * Overlaps and gaps on the VIDEO track are faults, because that track is concatenated: two clips
 * claiming the same second cannot both be shown, and an unclaimed second is a hole. On the TEXT,
 * CAPTIONS and GRAPHICS tracks they are not faults at all — overlapping text is a legitimate
 * composition, and a silent stretch between two captions is what silence looks like.
 *
 * Audio is between the two: SFX overlap freely, and it is normal for a music bed to run under
 * everything. So only ordering and range are checked there.
 */
import {
  audioTrackOf,
  captionTrack,
  textTrackOf,
  videoTrack,
  type ProjectTimeline,
  type TimelineAudioClip,
  type TimelineCaption,
  type TimelineText,
  type TimelineVideoClip,
} from "./projectTimeline";
import { canRehydrate } from "./projectTimeline";

export type TimelineIssueCode =
  | "negative_duration"
  | "end_before_start"
  | "zero_duration"
  | "invalid_source_range"
  | "source_out_before_in"
  | "negative_source_in"
  | "video_overlap"
  | "video_gap"
  | "duration_mismatch"
  | "invalid_transition"
  | "out_of_track_range"
  | "missing_asset"
  | "duplicate_element_id"
  | "invalid_gain"
  | "invalid_fade";

export type TimelineIssue = {
  code: TimelineIssueCode;
  track: "VIDEO" | "VOICE" | "MUSIC" | "SFX" | "CAPTIONS" | "TEXT" | "GRAPHICS" | "TIMELINE";
  /** The element's own id, or null for a whole-timeline fault. */
  elementId: string | null;
  start: number | null;
  end: number | null;
  reason: string;
};

export type TimelineValidation = {
  ok: boolean;
  issues: TimelineIssue[];
};

/** Thrown when a render is asked for on a timeline that cannot produce one. */
export class TimelineValidationError extends Error {
  constructor(readonly issues: TimelineIssue[]) {
    super(
      `timeline has ${issues.length} blocking issue(s):\n` +
        issues.map((i) => `  ${formatTimelineIssue(i)}`).join("\n")
    );
    this.name = "TimelineValidationError";
  }
}

export function formatTimelineIssue(issue: TimelineIssue): string {
  const where =
    issue.start != null && issue.end != null
      ? ` [${issue.start.toFixed(3)}s → ${issue.end.toFixed(3)}s]`
      : "";
  return `${issue.track}/${issue.elementId ?? "-"}${where} ${issue.code}: ${issue.reason}`;
}

/** Seconds under which two boundaries are the same instant. One frame at 30fps is 0.0333. */
const EPSILON = 0.012;

function checkRange(
  track: TimelineIssue["track"],
  id: string,
  start: number,
  end: number,
  issues: TimelineIssue[]
): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    issues.push({
      code: "end_before_start", track, elementId: id, start, end,
      reason: "start or end is not a finite number",
    });
    return;
  }
  if (start < 0) {
    issues.push({
      code: "out_of_track_range", track, elementId: id, start, end,
      reason: `starts before zero (${start.toFixed(3)}s)`,
    });
  }
  const duration = end - start;
  if (duration < 0) {
    issues.push({
      code: "negative_duration", track, elementId: id, start, end,
      reason: `ends ${Math.abs(duration).toFixed(3)}s before it starts`,
    });
  } else if (duration === 0) {
    issues.push({
      code: "zero_duration", track, elementId: id, start, end,
      reason: "has no duration; it would render as nothing",
    });
  }
}

function checkVideoClip(clip: TimelineVideoClip, issues: TimelineIssue[]): void {
  checkRange("VIDEO", clip.id, clip.timelineStart, clip.timelineEnd, issues);

  if (!Number.isFinite(clip.sourceIn) || !Number.isFinite(clip.sourceOut)) {
    issues.push({
      code: "invalid_source_range", track: "VIDEO", elementId: clip.id,
      start: clip.sourceIn, end: clip.sourceOut,
      reason: "sourceIn/sourceOut is not a finite number",
    });
    return;
  }
  if (clip.sourceIn < 0) {
    issues.push({
      code: "negative_source_in", track: "VIDEO", elementId: clip.id,
      start: clip.sourceIn, end: clip.sourceOut,
      reason: `sourceIn is negative (${clip.sourceIn.toFixed(3)}s)`,
    });
  }
  if (clip.sourceOut <= clip.sourceIn) {
    issues.push({
      code: "source_out_before_in", track: "VIDEO", elementId: clip.id,
      start: clip.sourceIn, end: clip.sourceOut,
      reason: `sourceOut (${clip.sourceOut.toFixed(3)}s) is not after sourceIn (${clip.sourceIn.toFixed(3)}s)`,
    });
  }
  /**
   * §15 — an asset that cannot be recovered is named, with its provider and id.
   *
   * The renderer already refuses to invent a source (`renderSourceFor` returns null and the clip
   * is skipped with a reason). Catching it HERE means the operator finds out before ten minutes of
   * rendering rather than after.
   */
  if (!canRehydrate(clip)) {
    issues.push({
      code: "missing_asset", track: "VIDEO", elementId: clip.id,
      start: clip.timelineStart, end: clip.timelineEnd,
      reason:
        `no way to fetch this asset: provider=${clip.source.provider} ` +
        `providerAssetId=${clip.source.providerAssetId ?? "null"} ` +
        `archiveAssetId=${clip.source.archiveAssetId ?? "null"} mediaUrl=${clip.source.mediaUrl ? "yes" : "null"}`,
    });
  }
}

const VALID_TRANSITIONS = new Set([
  "hard_cut", "crossfade", "dissolve", "dip_to_black", "dip_to_white",
]);

function checkTransitions(clip: TimelineVideoClip, issues: TimelineIssue[]): void {
  for (const [field, value] of [
    ["transitionIn", clip.transitionIn],
    ["transitionOut", clip.transitionOut],
  ] as const) {
    if (!VALID_TRANSITIONS.has(value)) {
      issues.push({
        code: "invalid_transition", track: "VIDEO", elementId: clip.id,
        start: clip.timelineStart, end: clip.timelineEnd,
        reason: `${field}="${String(value)}" is not a transition this renderer knows`,
      });
    }
  }
}

/**
 * Overlaps and gaps on the concatenated video track.
 *
 * Only checked here, and only on VIDEO — see the module note. `EPSILON` absorbs the rounding that
 * comes from storing seconds as decimals; a boundary that is off by a third of a frame is the same
 * instant, and reporting it would drown the real faults.
 */
function checkVideoContinuity(
  clips: readonly TimelineVideoClip[],
  timeline: ProjectTimeline,
  issues: TimelineIssue[]
): void {
  const ordered = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const delta = cur.timelineStart - prev.timelineEnd;
    if (delta < -EPSILON) {
      issues.push({
        code: "video_overlap", track: "VIDEO", elementId: cur.id,
        start: cur.timelineStart, end: cur.timelineEnd,
        reason:
          `overlaps ${prev.id} by ${Math.abs(delta).toFixed(3)}s — two clips cannot both be on ` +
          "screen on a concatenated track",
      });
    } else if (delta > EPSILON) {
      issues.push({
        code: "video_gap", track: "VIDEO", elementId: cur.id,
        start: prev.timelineEnd, end: cur.timelineStart,
        reason: `${delta.toFixed(3)}s of nothing between ${prev.id} and ${cur.id}`,
      });
    }
  }
  if (ordered.length > 0) {
    const first = ordered[0]!;
    if (first.timelineStart > EPSILON) {
      issues.push({
        code: "video_gap", track: "VIDEO", elementId: first.id,
        start: 0, end: first.timelineStart,
        reason: `the video starts at ${first.timelineStart.toFixed(3)}s, not at zero`,
      });
    }
    const last = ordered[ordered.length - 1]!;
    const drift = Math.abs(last.timelineEnd - timeline.durationSec);
    if (timeline.durationSec > 0 && drift > 0.25) {
      issues.push({
        code: "duration_mismatch", track: "TIMELINE", elementId: null,
        start: last.timelineEnd, end: timeline.durationSec,
        reason:
          `the last clip ends at ${last.timelineEnd.toFixed(3)}s but the timeline claims ` +
          `${timeline.durationSec.toFixed(3)}s — a render must never silently get a different length`,
      });
    }
  }
}

function checkTextLike(
  track: "TEXT" | "GRAPHICS" | "CAPTIONS",
  elements: ReadonlyArray<TimelineText | TimelineCaption>,
  issues: TimelineIssue[]
): void {
  for (const el of elements) {
    checkRange(track, el.id, el.start, el.end, issues);
    if (!el.text?.trim() && !el.disabled) {
      issues.push({
        code: "zero_duration", track, elementId: el.id, start: el.start, end: el.end,
        reason: "is enabled but has no text; it would draw nothing",
      });
    }
  }
}

function checkAudio(
  track: "VOICE" | "MUSIC" | "SFX",
  clips: readonly TimelineAudioClip[],
  issues: TimelineIssue[]
): void {
  for (const clip of clips) {
    checkRange(track, clip.id, clip.start, clip.end, issues);
    if (!Number.isFinite(clip.gain) || clip.gain < 0 || clip.gain > 4) {
      issues.push({
        code: "invalid_gain", track, elementId: clip.id, start: clip.start, end: clip.end,
        reason: `gain ${String(clip.gain)} is outside 0..4 — a mix cannot be trusted past that`,
      });
    }
    const span = clip.end - clip.start;
    for (const [name, fade] of [
      ["fadeInSec", clip.fadeInSec],
      ["fadeOutSec", clip.fadeOutSec],
    ] as const) {
      if (fade == null) continue;
      if (!Number.isFinite(fade) || fade < 0) {
        issues.push({
          code: "invalid_fade", track, elementId: clip.id, start: clip.start, end: clip.end,
          reason: `${name} is ${String(fade)}`,
        });
      } else if (span > 0 && fade > span) {
        issues.push({
          code: "invalid_fade", track, elementId: clip.id, start: clip.start, end: clip.end,
          reason: `${name} (${fade.toFixed(3)}s) is longer than the clip itself (${span.toFixed(3)}s)`,
        });
      }
    }
  }
}

/** Two elements sharing an id make every later reference ambiguous. */
function checkUniqueIds(timeline: ProjectTimeline, issues: TimelineIssue[]): void {
  const seen = new Map<string, TimelineIssue["track"]>();
  const note = (track: TimelineIssue["track"], id: string, start: number, end: number) => {
    const prior = seen.get(id);
    if (prior) {
      issues.push({
        code: "duplicate_element_id", track, elementId: id, start, end,
        reason: `id is already used on the ${prior} track; an edit could not address either`,
      });
    } else {
      seen.set(id, track);
    }
  };
  for (const c of videoTrack(timeline)) note("VIDEO", c.id, c.timelineStart, c.timelineEnd);
  for (const k of ["VOICE", "MUSIC", "SFX"] as const) {
    for (const c of audioTrackOf(timeline, k)) note(k, c.id, c.start, c.end);
  }
  for (const c of captionTrack(timeline)) note("CAPTIONS", c.id, c.start, c.end);
  for (const k of ["TEXT", "GRAPHICS"] as const) {
    for (const t of textTrackOf(timeline, k)) note(k, t.id, t.start, t.end);
  }
}

/**
 * Check a timeline. Reports; never repairs.
 *
 * Disabled elements are still checked for RANGE — a user re-enabling a clip must not discover it
 * was malformed all along — but a disabled video clip is excluded from continuity, because it is
 * not going to be on screen and the gap it leaves is intentional.
 */
export function validateTimeline(timeline: ProjectTimeline): TimelineValidation {
  const issues: TimelineIssue[] = [];

  if (!Number.isFinite(timeline.durationSec) || timeline.durationSec < 0) {
    issues.push({
      code: "negative_duration", track: "TIMELINE", elementId: null,
      start: null, end: timeline.durationSec,
      reason: `durationSec is ${String(timeline.durationSec)}`,
    });
  }
  const fmt = timeline.format;
  if (!(fmt?.widthPx > 0) || !(fmt?.heightPx > 0) || !(fmt?.fps > 0)) {
    issues.push({
      code: "out_of_track_range", track: "TIMELINE", elementId: null, start: null, end: null,
      reason: `format is not renderable: ${fmt?.widthPx}x${fmt?.heightPx}@${fmt?.fps}`,
    });
  }

  const clips = videoTrack(timeline);
  for (const clip of clips) {
    checkVideoClip(clip, issues);
    checkTransitions(clip, issues);
  }
  checkVideoContinuity(clips.filter((c) => !c.disabled), timeline, issues);

  checkTextLike("TEXT", textTrackOf(timeline, "TEXT"), issues);
  checkTextLike("GRAPHICS", textTrackOf(timeline, "GRAPHICS"), issues);
  checkTextLike("CAPTIONS", captionTrack(timeline), issues);
  for (const k of ["VOICE", "MUSIC", "SFX"] as const) {
    checkAudio(k, audioTrackOf(timeline, k), issues);
  }
  checkUniqueIds(timeline, issues);

  return { ok: issues.length === 0, issues };
}

/**
 * Validate, and throw if the timeline cannot render.
 *
 * `video_gap` is reported but is NOT blocking: a gap produces black, which is a visible and
 * recoverable outcome, and refusing to render a video that has one would make a small
 * imperfection cost the whole render. Everything else stops the render, because everything else
 * produces a video that silently differs from what the timeline says.
 */
export const NON_BLOCKING_ISSUES: ReadonlySet<TimelineIssueCode> = new Set(["video_gap"]);

export function assertRenderableTimeline(timeline: ProjectTimeline): TimelineValidation {
  const result = validateTimeline(timeline);
  const blocking = result.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
  if (blocking.length > 0) throw new TimelineValidationError(blocking);
  return result;
}

/** The validator's own report lines, for the render log. */
export function formatTimelineValidation(result: TimelineValidation): string[] {
  if (result.ok) return ["[TimelineValidator] ok — no issues"];
  const blocking = result.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
  return [
    `[TimelineValidator] ${result.issues.length} issue(s), ${blocking.length} blocking`,
    ...result.issues.map((i) => `   ${formatTimelineIssue(i)}`),
  ];
}
