/**
 * RONDE 257 — ONE BROKEN SHOT MAY NOT COST THE WHOLE FILM.
 *
 * ── The shape, three renders running ────────────────────────────────────────────────────────
 *
 *   563   one clip overlapped its neighbour by 3.5s   → plan discarded → legacy compose
 *   574   four seconds of arithmetic put two scenes on top of each other → discarded → legacy
 *   585   one SerpAPI still could not be promised re-fetchable → discarded → legacy
 *
 * Each time the CAUSE was found and repaired, and each time the all-or-nothing was left standing.
 * It is the all-or-nothing that turns a one-shot fault into a whole-film loss: render 585 threw
 * away four camera moves, two transitions, the ambience bed and the ducking over a single picture,
 * and then delivered the film through the old route USING THAT SAME PICTURE.
 *
 * So the fourth cause is not what this repairs. The shape is.
 *
 * ── What it does, and what it refuses to do ─────────────────────────────────────────────────
 *
 * A blocking issue that names ONE CLIP is repaired on that clip and nowhere else:
 *
 *   · an unexecutable transition is normalised to a hard cut — the shot survives, the flourish does
 *     not, and RONDE 148 already established that an unexecutable flourish is a plainer video
 *     rather than a broken one;
 *   · anything else clip-scoped drops that clip, which leaves a gap the validator already treats as
 *     non-blocking because a gap produces black, "a visible and recoverable outcome".
 *
 * A blocking issue that names the TIMELINE is not repaired at all. A format with no frame rate, a
 * schema this build does not know, a picture that ends before the narration — none of those are
 * facts about one shot, and deleting shots to answer them would make the film worse while claiming
 * to fix it. Those still fall through to the caller, which still falls back.
 *
 * NOTHING HERE WEAKENS THE VALIDATOR. It is run unchanged, before and after, and its answer decides
 * everything: a repair is only attempted on an issue it raised, and the result is only used if it
 * then returns clean. What changes is what happens to a plan it refuses — repaired where the fault
 * is one shot, discarded where it is the film.
 *
 * ── Why it is bounded, and why every repair is named ────────────────────────────────────────
 *
 * Dropping a clip can reveal an issue the first pass could not see, so the loop runs again — up to
 * `MAX_REPAIR_PASSES`, because an unbounded repair loop on a plan that cannot be fixed is worse
 * than the fallback it was meant to avoid. And every repair is returned as a record with the clip,
 * the code and the reason, so `RENDER_FALLBACK_USED` is not replaced by a quieter silence: a film
 * that reached the screen with two shots removed must say which two.
 */
import {
  NON_BLOCKING_ISSUES,
  validateTimeline,
  type TimelineIssue,
  type TimelineIssueCode,
} from "./timelineValidator";
import type { ProjectTimeline, TimelineTrack } from "./projectTimeline";

/** How a single clip was answered. Neither invents picture; one keeps the shot, one does not. */
export type TimelineRepairAction = "clip_dropped" | "transition_normalised";

export type TimelineRepair = {
  clipId: string;
  code: TimelineIssueCode;
  action: TimelineRepairAction;
  /** The validator's own words for why this clip was refused. */
  reason: string;
};

/**
 * Blocking codes that are a fact about ONE CLIP and can therefore be answered on that clip.
 *
 * Deliberately a list rather than "anything with an elementId": `picture_short_of_voice` names a
 * clip too, and dropping it is the one repair guaranteed to make that fault worse. A code earns a
 * place here by being fixable by removing the shot, not by being attributable to one.
 */
const CLIP_SCOPED_BLOCKING: ReadonlySet<TimelineIssueCode> = new Set<TimelineIssueCode>([
  "missing_asset",
  "video_overlap",
  "negative_duration",
  "end_before_start",
  "zero_duration",
  "non_finite_time",
  "invalid_source_range",
  "source_out_before_in",
  "negative_source_in",
  "invalid_transition",
]);

/**
 * A plan that cannot be made valid in this many passes is not a plan with a broken shot in it.
 *
 * Four is the number of times a single drop can plausibly reveal the next fault — a clip removed,
 * its neighbour's overlap resolved, a trim exposed — and past that the repair is chasing a timeline
 * that is wrong about itself.
 */
export const MAX_REPAIR_PASSES = 4;

const blockingOnly = (issues: readonly TimelineIssue[]): TimelineIssue[] =>
  issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));

/** The transition every renderer in this build can execute. */
const SAFE_TRANSITION = "hard_cut";

function withoutClips(
  tracks: readonly TimelineTrack[],
  dropIds: ReadonlySet<string>
): TimelineTrack[] {
  return tracks.map((track) => {
    if (track.kind !== "VIDEO") return track;
    const clips = (track.clips ?? []).filter((c) => !dropIds.has(c.id));
    return { ...track, clips } as TimelineTrack;
  });
}

function withNormalisedTransitions(
  tracks: readonly TimelineTrack[],
  fixIds: ReadonlySet<string>
): TimelineTrack[] {
  return tracks.map((track) => {
    if (track.kind !== "VIDEO") return track;
    const clips = (track.clips ?? []).map((c) =>
      fixIds.has(c.id)
        ? { ...c, transitionIn: SAFE_TRANSITION, transitionOut: SAFE_TRANSITION }
        : c
    );
    return { ...track, clips } as TimelineTrack;
  });
}

export type TimelineRepairResult = {
  /** The plan to render, repaired where a repair was possible. The input is never mutated. */
  timeline: ProjectTimeline;
  /** Every clip this function touched, in the order it touched them. Empty on a clean plan. */
  repairs: TimelineRepair[];
  /** Blocking issues the repair could not answer. Empty means the plan is renderable. */
  remaining: TimelineIssue[];
};

/**
 * Make a refused plan renderable by answering its clip-scoped faults, or say it could not.
 *
 * A clean plan comes back untouched with no repairs, which is the healthy render and costs one
 * validation it was going to pay anyway.
 */
export function repairTimelineForRender(timeline: ProjectTimeline): TimelineRepairResult {
  let current = timeline;
  const repairs: TimelineRepair[] = [];

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const blocking = blockingOnly(validateTimeline(current).issues);
    if (blocking.length === 0) return { timeline: current, repairs, remaining: [] };

    const drop = new Set<string>();
    const normalise = new Set<string>();
    for (const issue of blocking) {
      if (!issue.elementId) continue;
      if (issue.track !== "VIDEO") continue;
      if (!CLIP_SCOPED_BLOCKING.has(issue.code)) continue;
      const action: TimelineRepairAction =
        issue.code === "invalid_transition" ? "transition_normalised" : "clip_dropped";
      if (action === "clip_dropped") drop.add(issue.elementId);
      else normalise.add(issue.elementId);
      repairs.push({ clipId: issue.elementId, code: issue.code, action, reason: issue.reason });
    }

    /**
     * Nothing this pass could answer. Repeating would produce the same answer and the same set, so
     * the honest move is to hand back what is left rather than spend the remaining passes on it.
     */
    if (drop.size === 0 && normalise.size === 0) {
      return { timeline: current, repairs, remaining: blocking };
    }

    /**
     * A clip refused for two reasons at once is dropped, not normalised: the drop answers both, and
     * normalising it would leave the other fault in a shot the plan still carries.
     */
    for (const id of drop) normalise.delete(id);

    let tracks = current.tracks;
    if (normalise.size > 0) tracks = withNormalisedTransitions(tracks, normalise);
    if (drop.size > 0) tracks = withoutClips(tracks, drop);
    current = { ...current, tracks };
  }

  /** Out of passes. Whatever is still blocking is reported as blocking. */
  return { timeline: current, repairs, remaining: blockingOnly(validateTimeline(current).issues) };
}

/** One line per repair, plus a total, for the render log. Empty when nothing was repaired. */
export function formatTimelineRepairs(repairs: readonly TimelineRepair[]): string[] {
  if (repairs.length === 0) return [];
  const dropped = repairs.filter((r) => r.action === "clip_dropped").length;
  const normalised = repairs.length - dropped;
  return [
    ...repairs.map(
      (r) =>
        `[TimelineRepair] ${r.action} ${r.clipId} ${r.code} — ${r.reason}`
    ),
    `[TimelineRepair] TOTAL repairs=${repairs.length} dropped=${dropped} ` +
      `transitionsNormalised=${normalised} — the plan was kept; these shots were not`,
  ];
}
