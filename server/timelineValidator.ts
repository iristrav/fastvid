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
 * Which faults exist depends on the track, so the per-track rules are written down as data in
 * `TRACK_POLICY` below rather than left implicit in the shape of the checking code. Each entry
 * carries the reason, and every reason is read off what `timelineRenderer.ts` actually does with
 * that track — concat for VIDEO, amix for the audio tracks, libass for the text ones — not off a
 * general theory of how editing ought to work.
 */
import {
  TIMELINE_SCHEMA_VERSION,
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
/**
 * The validator asks the two modules that will actually do the work, rather than keeping its own
 * idea of what is recoverable. `identityIsRehydratable` knows what a usable handle looks like;
 * `providerIsRehydratable` knows which providers have a route at all. A private third answer here
 * is how a timeline passes validation and dies ten minutes into the render.
 */
import { identityIsRehydratable } from "./assetIdentity";
import { identityHasRehydrationRoute } from "./assetRehydrator";

export type TimelineIssueCode =
  | "negative_duration"
  | "end_before_start"
  | "non_finite_time"
  | "unsupported_schema_version"
  | "caption_overlap"
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

/* ═══════════════════════ §11/§12 — the track policy, written down ═══════════════════════ */

export type TrackPolicy = {
  /**
   * `exclusive` — two elements may not claim the same instant.
   * `allowed`   — they may, and the renderer composes them.
   */
  overlap: "exclusive" | "allowed";
  /** Whether an unclaimed stretch is a fault or simply what that track sounds/looks like. */
  gap: "fault" | "normal";
  /** Reported without blocking, so an operator can see it without it costing the render. */
  overlapAdvisory?: boolean;
  /** WHY — read off the renderer, not chosen. */
  because: string;
};

/**
 * Derived from what `timelineRenderer.ts` actually does with each track — deliberately not from a
 * general theory of editing. The brief asked for the rules to be explicit rather than implied by
 * the shape of the checking code, and this is that list:
 *
 *   VIDEO             rendered as segments joined by concat (`renderTimeline`, phase 1→2). A
 *                     concatenated track shows exactly one picture at a time, so a second clip
 *                     claiming the same instant cannot be honoured and a hole shows as black.
 *   VOICE/MUSIC/SFX   all three are collected into ONE `amix=inputs=N` filter with per-clip
 *                     `adelay` and `volume`. The mixer supports overlap, so overlap is legal here
 *                     as a matter of fact, not of taste — a music bed under narration is the
 *                     normal case. Silence between clips is silence.
 *   CAPTIONS/TEXT/    all drawn by libass in one pass; overlapping events are composited. Legal,
 *   GRAPHICS          but two captions on screen at once is usually a planner mistake, so CAPTIONS
 *                     overlap is REPORTED and never blocks.
 */
export const TRACK_POLICY: Readonly<Record<TimelineIssue["track"], TrackPolicy>> = {
  VIDEO: {
    overlap: "exclusive", gap: "fault",
    because: "segments are joined with concat; one picture at a time, and a hole renders black",
  },
  VOICE: {
    overlap: "allowed", gap: "normal",
    because: "mixed with amix, so simultaneous voice clips are summed rather than lost",
  },
  MUSIC: {
    overlap: "allowed", gap: "normal",
    because: "mixed with amix; a bed running under everything else is the intended use",
  },
  SFX: {
    overlap: "allowed", gap: "normal",
    because: "mixed with amix; overlapping effects are ordinary",
  },
  CAPTIONS: {
    overlap: "allowed", gap: "normal", overlapAdvisory: true,
    because: "libass composites overlapping events, but two captions at once usually means a planning error",
  },
  TEXT: {
    overlap: "allowed", gap: "normal",
    because: "libass composites; a title over a lower third is a legitimate composition",
  },
  GRAPHICS: {
    overlap: "allowed", gap: "normal",
    because: "libass composites; graphics are meant to sit over other elements",
  },
  TIMELINE: {
    overlap: "allowed", gap: "normal",
    because: "not a track — the bucket for faults that belong to the document as a whole",
  },
};

function checkRange(
  track: TimelineIssue["track"],
  id: string,
  start: number,
  end: number,
  issues: TimelineIssue[]
): void {
  /**
   * §10 — NaN and Infinity get their OWN code.
   *
   * They used to be filed as `end_before_start`, which reads like an ordering mistake and sends
   * whoever is debugging to the wrong place. `NaN` on a boundary is a different disease: every
   * comparison against it is false, so it slips silently past every ordering check written after
   * this one and reaches ffmpeg as the string "NaN".
   */
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    issues.push({
      code: "non_finite_time", track, elementId: id, start, end,
      reason:
        `start=${String(start)} end=${String(end)} — not finite numbers; no comparison against ` +
        "these is meaningful and ffmpeg would receive the literal text",
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

  /**
   * §15 — AN ABSENT TRIM IS NOT ZERO, AND IS NOT A FAULT.
   *
   * `sourceIn`/`sourceOut` are optional because most of the pipeline does not record them yet.
   * Absent means "unknown", and the validator must neither read it as 0 nor report it as an
   * error — doing either would turn a gap in the instrumentation into a wrong number or a false
   * alarm. Only a trim that IS present gets checked.
   */
  const hasIn = clip.sourceIn != null;
  const hasOut = clip.sourceOut != null;
  if (hasIn && !Number.isFinite(clip.sourceIn)) {
    issues.push({
      code: "invalid_source_range", track: "VIDEO", elementId: clip.id,
      start: null, end: null,
      reason: `sourceIn is ${String(clip.sourceIn)}`,
    });
  }
  if (hasOut && !Number.isFinite(clip.sourceOut)) {
    issues.push({
      code: "invalid_source_range", track: "VIDEO", elementId: clip.id,
      start: null, end: null,
      reason: `sourceOut is ${String(clip.sourceOut)}`,
    });
  }
  if (hasIn && Number.isFinite(clip.sourceIn) && clip.sourceIn! < 0) {
    issues.push({
      code: "negative_source_in", track: "VIDEO", elementId: clip.id,
      start: clip.sourceIn!, end: clip.sourceOut ?? null,
      reason: `sourceIn is negative (${clip.sourceIn!.toFixed(3)}s)`,
    });
  }
  if (
    hasIn && hasOut &&
    Number.isFinite(clip.sourceIn) && Number.isFinite(clip.sourceOut) &&
    clip.sourceOut! <= clip.sourceIn!
  ) {
    issues.push({
      code: "source_out_before_in", track: "VIDEO", elementId: clip.id,
      start: clip.sourceIn!, end: clip.sourceOut!,
      reason: `sourceOut (${clip.sourceOut!.toFixed(3)}s) is not after sourceIn (${clip.sourceIn!.toFixed(3)}s)`,
    });
  }
  /**
   * §15 — an asset that cannot be recovered is named, with its provider and id.
   *
   * The renderer already refuses to invent a source (`renderSourceFor` returns null and the clip
   * is skipped with a reason). Catching it HERE means the operator finds out before ten minutes of
   * rendering rather than after.
   */
  const where =
    `provider=${clip.source.provider} ` +
    `providerAssetId=${clip.source.providerAssetId ?? "null"} ` +
    `archiveAssetId=${clip.source.archiveAssetId ?? "null"} ` +
    `mediaUrl=${clip.source.mediaUrl ? "yes" : "null"}`;
  if (!identityIsRehydratable(clip.source)) {
    issues.push({
      code: "missing_asset", track: "VIDEO", elementId: clip.id,
      start: clip.timelineStart, end: clip.timelineEnd,
      reason: `no way to fetch this asset: ${where}`,
    });
  } else if (!identityHasRehydrationRoute(clip.source)) {
    /**
     * Separate branch, separate sentence: the handle is fine and the PROVIDER is the problem. A
     * clip that says "some_new_api + a media URL" looks complete and is not recoverable, because
     * no route was ever written for that provider — and the operator needs to be told which of the
     * two it is, not just that something is missing.
     *
     * The question goes to the IDENTITY rather than the provider name, so an archive clip carrying
     * its archive's slug is judged on the fact that we hold the file — see
     * `identityHasRehydrationRoute`.
     */
    issues.push({
      code: "missing_asset", track: "VIDEO", elementId: clip.id,
      start: clip.timelineStart, end: clip.timelineEnd,
      reason: `no rehydration route exists for this provider: ${where}`,
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
  // The rule this function enforces, stated where it is enforced. See TRACK_POLICY.
  if (TRACK_POLICY.VIDEO.overlap !== "exclusive") return;
  const ordered = [...clips]
    .filter((c) => Number.isFinite(c.timelineStart) && Number.isFinite(c.timelineEnd))
    .sort((a, b) => a.timelineStart - b.timelineStart);
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

/**
 * §12 — CAPTIONS overlap is legal and still worth saying out loud.
 *
 * libass will happily composite two subtitle events, and the result is two lines of narration on
 * screen at once — always a planning error, never a style. Advisory, so it costs a render nothing.
 */
function checkCaptionOverlap(
  captions: ReadonlyArray<TimelineCaption>,
  issues: TimelineIssue[]
): void {
  if (!TRACK_POLICY.CAPTIONS.overlapAdvisory) return;
  const ordered = [...captions]
    .filter((c) => !c.disabled && Number.isFinite(c.start) && Number.isFinite(c.end))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.start < prev.end - EPSILON) {
      issues.push({
        code: "caption_overlap", track: "CAPTIONS", elementId: cur.id,
        start: cur.start, end: cur.end,
        reason:
          `overlaps ${prev.id} by ${(prev.end - cur.start).toFixed(3)}s — libass will draw both, ` +
          "which puts two lines of narration on screen at the same time",
      });
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
  /**
   * §10 — an ABSENT schema version reads as 1; a version from the FUTURE is a fault.
   *
   * Everything written before RONDE 147 has no `schemaVersion`, and treating that as an error
   * would condemn every existing timeline. A number ABOVE this build's is the opposite case: the
   * document was written by a newer build and may carry fields this one drops on save, so it is
   * refused rather than half-read.
   */
  const schema = timeline.schemaVersion ?? 1;
  if (!Number.isInteger(schema) || schema < 1 || schema > TIMELINE_SCHEMA_VERSION) {
    issues.push({
      code: "unsupported_schema_version", track: "TIMELINE", elementId: null,
      start: null, end: null,
      reason:
        `schemaVersion ${String(timeline.schemaVersion)} — this build reads up to ` +
        `${TIMELINE_SCHEMA_VERSION}; reading a newer document would silently drop the fields it ` +
        "has that this build does not know about",
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
  checkCaptionOverlap(captionTrack(timeline), issues);
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
export const NON_BLOCKING_ISSUES: ReadonlySet<TimelineIssueCode> = new Set([
  "video_gap",
  /**
   * §12 — advisory by policy. Two captions at once is almost always wrong, but it renders exactly
   * as the timeline says it should, and refusing the whole video over it would be the validator
   * making an editorial judgement instead of a technical one.
   */
  "caption_overlap",
]);

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
