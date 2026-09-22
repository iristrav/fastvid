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

/* ═══════════════════════ RONDE 630 — SAFE RENDER ═══════════════════════ */

/**
 * THE SIMPLEST TECHNICALLY ROBUST VERSION OF THE SAME REAL FILM.
 *
 * ── What this is for ────────────────────────────────────────────────────────────────────────
 *
 * Render 599 held eleven segments of validated real media and delivered nothing, because the graph
 * that JOINS them refused. RONDE 628 gave that join a ladder to climb down. This is the rung below
 * the ladder: when the flourishes themselves are implicated — an effect chain, a camera move, a
 * transition mode — the film is rendered without them rather than not at all.
 *
 * The principle is already this module's, stated at the top for a single clip: "an unexecutable
 * transition is normalised to a hard cut — the shot survives, the flourish does not". SAFE_RENDER
 * is that sentence applied to the whole timeline on purpose, instead of one clip at a time in
 * response to a validator complaint.
 *
 * ── What it removes, and why exactly these three ────────────────────────────────────────────
 *
 * Only what the VIDEO segment pass and the JOIN pass execute, because those are the passes that
 * have actually failed in production:
 *
 *   · `effects`   — `effectChain` builds split/blend/gblur/noise graphs per clip;
 *   · `camera`    — `cameraChain` builds a zoompan with an upscale in front of it;
 *   · transitions — every join becomes `hard_cut`.
 *
 * ── What it deliberately KEEPS, which is the part that makes it honest ──────────────────────
 *
 * Every clip, in the same order, at the same `timelineStart`/`timelineEnd`, from the same source,
 * with the same `sourceIn`/`sourceOut`. The VOICE, MUSIC, SFX and AMBIENT tracks untouched. The
 * captions, the text and the graphics untouched.
 *
 * So the film is the same film: same story, same narration, same real footage, same length, same
 * sync. Someone watching it sees a documentary cut plainly, not a shorter or emptier one.
 *
 * Audio and text are not stripped because they do not run through the passes that failed, and
 * removing them would be taking content away from the viewer to make a render easier — which is
 * the thing SAFE_RENDER must never become. Graphics are kept for the same reason; a graphics
 * failure is its own class and gets its own answer, not this one.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────────────────────
 *
 * Not a quality gate. Nothing here admits media that was refused, relaxes a threshold, fills a gap,
 * shortens the story or touches a placeholder. A timeline whose PICTURES are wrong is exactly as
 * wrong after this function as before it, and must still fail. SAFE_RENDER answers "the renderer
 * could not execute this treatment"; it has no answer at all for "we never found a valid shot",
 * and pretending otherwise would turn a content failure into a delivered video.
 */
export type SafeRenderChange =
  | "effects_removed"
  | "camera_removed"
  | "transition_normalised";

export type SafeRenderResult = {
  timeline: ProjectTimeline;
  /** What was taken off which clip. Empty when the timeline was already this plain. */
  changes: Array<{ clipId: string; change: SafeRenderChange }>;
};

export function safeRenderTimeline(timeline: ProjectTimeline): SafeRenderResult {
  const changes: Array<{ clipId: string; change: SafeRenderChange }> = [];

  const tracks = timeline.tracks.map((track): TimelineTrack => {
    if (track.kind !== "VIDEO") return track;
    return {
      ...track,
      clips: track.clips.map((clip) => {
        const next = { ...clip };
        if (next.effects && next.effects.length > 0) {
          changes.push({ clipId: clip.id, change: "effects_removed" });
          delete next.effects;
        }
        if (next.camera) {
          changes.push({ clipId: clip.id, change: "camera_removed" });
          delete next.camera;
        }
        /**
         * `transitionOut` is normalised with `transitionIn`: the renderer reads the INCOMING
         * transition, but a plan left carrying an outgoing dissolve it can no longer execute would
         * describe a film that was not made.
         */
        if (next.transitionIn !== "hard_cut" || next.transitionOut !== "hard_cut") {
          changes.push({ clipId: clip.id, change: "transition_normalised" });
          next.transitionIn = "hard_cut";
          next.transitionOut = "hard_cut";
          delete next.transitionInSec;
          delete next.transitionOutSec;
        }
        return next;
      }),
    } as TimelineTrack;
  });

  return { timeline: { ...timeline, tracks }, changes };
}

/** Whether SAFE_RENDER would actually change anything — a plain timeline needs no second attempt. */
export function safeRenderWouldChangeAnything(timeline: ProjectTimeline): boolean {
  return safeRenderTimeline(timeline).changes.length > 0;
}

/** The render log's account of what the safe pass gave up, and what it kept. */
export function formatSafeRender(result: SafeRenderResult): string[] {
  if (result.changes.length === 0) {
    return ["[SafeRender] the timeline carries no effects, camera moves or transitions — nothing to simplify"];
  }
  const count = (c: SafeRenderChange) => result.changes.filter((x) => x.change === c).length;
  const clips = new Set(result.changes.map((c) => c.clipId)).size;
  return [
    `[SafeRender] SAFE_RENDER_STARTED clips=${clips} effectsRemoved=${count("effects_removed")} ` +
      `cameraRemoved=${count("camera_removed")} transitionsNormalised=${count("transition_normalised")}`,
    "[SafeRender] every clip, its source, its in/out points, its position and the whole audio, " +
      "caption, text and graphics content are unchanged — this is the same film, cut plainly",
  ];
}
