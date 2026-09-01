/**
 * RONDE 157B — the rules a finished edit is judged against.
 *
 * ── Where these live, and why it matters ────────────────────────────────────────────────────
 *
 * §157B is explicit: "Deze regels horen in planning/validation. Niet als stille renderer-correctie."
 *
 * So every function here REPORTS and none of them repairs. That is not a limitation, it is the
 * point. A renderer that quietly drops the fourth consecutive Ken Burns move produces a video that
 * is better than the plan and a plan that no longer describes the video — and the next time
 * somebody opens the editor, the timeline says something the film never did. A report keeps the two
 * honest: the planner can act on it, a human can overrule it, and the render does what it was told.
 *
 * ── Advisory, not blocking ──────────────────────────────────────────────────────────────────
 *
 * These are EDITORIAL judgements, not technical faults. Three identical shots in a row is usually a
 * mistake and is occasionally the whole point of the sequence. So the output is a list of findings
 * with severities, and nothing here refuses a render. `timelineValidator` is where technical
 * impossibility lives; this is where taste lives, and taste does not get a veto.
 */
import {
  audioTrackOf,
  captionTrack,
  graphicsTrack,
  videoTrack,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";

/* ═══════════════════════ what a finding looks like ═══════════════════════ */

export type QualityRuleCode =
  | "repeated_shot"
  | "repeated_transition"
  | "excessive_camera"
  | "excessive_effects"
  | "caption_overload"
  | "graphics_overload"
  | "sfx_overload"
  | "voice_masked"
  | "graphic_covers_caption";

export type QualityFinding = {
  code: QualityRuleCode;
  /** "notice" is worth knowing; "warning" is usually a real problem. Neither blocks a render. */
  severity: "notice" | "warning";
  /** The element ids involved, so an editor can jump straight to them. */
  elementIds: string[];
  atSec: number;
  reason: string;
};

/* ═══════════════════════ the thresholds, and where they come from ═══════════════════════ */

/**
 * How many identical consecutive shots before it reads as a mistake.
 *
 * Three. Two identical shot types in a row is an ordinary cut between two angles of the same
 * subject; three is where a viewer starts to feel the edit has stopped moving. This is a judgement
 * and it is written down here rather than buried in a condition so it can be argued with.
 */
export const MAX_CONSECUTIVE_SAME_SHOT = 2;
export const MAX_CONSECUTIVE_SAME_TRANSITION = 3;

/**
 * The share of a video that may carry a camera move.
 *
 * A documentary that pushes on every shot feels restless and, worse, hides which moments were meant
 * to matter — the move stops being emphasis when everything has it. 60% leaves room for a rhythm.
 */
export const MAX_CAMERA_SHARE = 0.6;

/** Effects on more than half the clips reads as a filter applied to the film, not as editing. */
export const MAX_EFFECT_SHARE = 0.5;

/** Captions per minute beyond which the screen is never without words. */
export const MAX_CAPTIONS_PER_MINUTE = 40;
/** Graphics per minute beyond which cards are competing with the film rather than serving it. */
export const MAX_GRAPHICS_PER_MINUTE = 12;
export const MAX_SFX_PER_MINUTE = 20;

/**
 * The level a music or ambient bed may sit at while the voice is speaking, WITHOUT ducking.
 *
 * Above this the bed competes with the narration. The number is the gain, not a dB figure, because
 * that is what the timeline stores; 0.35 linear is roughly -9dB, which is about where a bed starts
 * to intrude on speech in a documentary mix.
 */
export const MAX_UNDUCKED_BED_GAIN = 0.35;

/* ═══════════════════════ the rules ═══════════════════════ */

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Runs of the same shot type, and of the same transition.
 *
 * `sceneIndex` is deliberately NOT consulted: a run that crosses a scene boundary is still a run,
 * and a viewer does not see scene boundaries.
 */
function repeatedRuns(clips: readonly TimelineVideoClip[]): QualityFinding[] {
  const findings: QualityFinding[] = [];

  const runsOf = <T>(
    value: (c: TimelineVideoClip) => T,
    limit: number,
    code: QualityRuleCode,
    describe: (v: T, n: number) => string
  ) => {
    let runStart = 0;
    for (let i = 1; i <= clips.length; i++) {
      const same = i < clips.length && value(clips[i]!) === value(clips[runStart]!);
      if (same) continue;
      const length = i - runStart;
      if (length > limit) {
        const run = clips.slice(runStart, i);
        findings.push({
          code,
          severity: length > limit + 1 ? "warning" : "notice",
          elementIds: run.map((c) => c.id),
          atSec: run[0]!.timelineStart,
          reason: describe(value(run[0]!), length),
        });
      }
      runStart = i;
    }
  };

  runsOf(
    (c) => c.motion ?? "none",
    MAX_CONSECUTIVE_SAME_SHOT,
    "repeated_shot",
    (v, n) => `${n} consecutive clips all use camera "${String(v)}" — the edit stops moving`
  );
  runsOf(
    (c) => c.transitionIn,
    MAX_CONSECUTIVE_SAME_TRANSITION,
    "repeated_transition",
    (v, n) => `${n} consecutive joins are all "${String(v)}"`
  );

  return findings;
}

/**
 * Judge one finished timeline.
 *
 * Returns every finding, ordered by time, so a report reads in the order a viewer would meet the
 * problems. Deterministic: no clock, no randomness, no I/O.
 */
export function judgeTimeline(timeline: ProjectTimeline): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const clips = videoTrack(timeline)
    .filter((c) => !c.disabled)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  const minutes = Math.max(1 / 60, timeline.durationSec / 60);

  /* ── repetition ────────────────────────────────────────────────────────────────────────── */
  findings.push(...repeatedRuns(clips));

  /* ── too much of a good thing ──────────────────────────────────────────────────────────── */
  if (clips.length > 0) {
    const withCamera = clips.filter((c) => c.camera && (c.motion ?? "none") !== "none");
    if (withCamera.length / clips.length > MAX_CAMERA_SHARE) {
      findings.push({
        code: "excessive_camera",
        severity: "warning",
        elementIds: withCamera.map((c) => c.id),
        atSec: 0,
        reason:
          `${withCamera.length} of ${clips.length} clips have a camera move ` +
          `(over ${(MAX_CAMERA_SHARE * 100).toFixed(0)}%) — the move stops reading as emphasis ` +
          "when every shot has one",
      });
    }

    const withEffects = clips.filter((c) => (c.effects?.length ?? 0) > 0);
    if (withEffects.length / clips.length > MAX_EFFECT_SHARE) {
      findings.push({
        code: "excessive_effects",
        severity: "warning",
        elementIds: withEffects.map((c) => c.id),
        atSec: 0,
        reason:
          `${withEffects.length} of ${clips.length} clips carry an effect — this reads as a ` +
          "filter applied to the film rather than as editing",
      });
    }
  }

  /* ── density ───────────────────────────────────────────────────────────────────────────── */
  const captions = captionTrack(timeline).filter((c) => !c.disabled);
  if (captions.length / minutes > MAX_CAPTIONS_PER_MINUTE) {
    findings.push({
      code: "caption_overload",
      severity: "notice",
      elementIds: captions.slice(0, 8).map((c) => c.id),
      atSec: captions[0]?.start ?? 0,
      reason: `${(captions.length / minutes).toFixed(0)} captions per minute — the screen is never without words`,
    });
  }

  const graphics = graphicsTrack(timeline).filter((g) => !g.disabled);
  if (graphics.length / minutes > MAX_GRAPHICS_PER_MINUTE) {
    findings.push({
      code: "graphics_overload",
      severity: "warning",
      elementIds: graphics.slice(0, 8).map((g) => g.id),
      atSec: graphics[0]?.start ?? 0,
      reason: `${(graphics.length / minutes).toFixed(0)} graphics per minute — the cards compete with the film`,
    });
  }

  const sfx = audioTrackOf(timeline, "SFX").filter((c) => !c.disabled);
  if (sfx.length / minutes > MAX_SFX_PER_MINUTE) {
    findings.push({
      code: "sfx_overload",
      severity: "notice",
      elementIds: sfx.slice(0, 8).map((c) => c.id),
      atSec: sfx[0]?.start ?? 0,
      reason: `${(sfx.length / minutes).toFixed(0)} sound effects per minute`,
    });
  }

  /* ── §157B: "audio mag nooit voice maskeren" ───────────────────────────────────────────── */
  const voice = audioTrackOf(timeline, "VOICE").filter((c) => !c.disabled);
  for (const kind of ["MUSIC", "AMBIENT"] as const) {
    for (const bed of audioTrackOf(timeline, kind).filter((c) => !c.disabled)) {
      const ducks = bed.duckUnderVoice || bed.ducking?.enabled;
      if (ducks) continue;
      /** Only a bed that overlaps actual narration can mask it. */
      const speaking = voice.find((v) => overlaps(bed, v));
      if (!speaking) continue;
      if (bed.gain > MAX_UNDUCKED_BED_GAIN) {
        findings.push({
          code: "voice_masked",
          severity: "warning",
          elementIds: [bed.id, speaking.id],
          atSec: Math.max(bed.start, speaking.start),
          reason:
            `${kind} track at gain ${bed.gain.toFixed(2)} plays under the voice without ducking ` +
            `(over ${MAX_UNDUCKED_BED_GAIN}) — the narration will be hard to follow`,
        });
      }
    }
  }

  /* ── §157B: "graphics mogen captions niet onleesbaar maken" ────────────────────────────── */
  /**
   * This one is a NOTICE and not a warning on purpose.
   *
   * `captionLayout` already resolves these geometrically before the render, and only reports
   * `caption_collision_unresolved` when it genuinely cannot. So a temporal overlap here usually
   * means "the layout engine had work to do", not "the video is wrong" — and saying so at warning
   * level would train a reader to ignore the whole report.
   */
  for (const g of graphics) {
    const clash = captions.find((c) => overlaps(g, c));
    if (!clash) continue;
    const gPos = g.style?.position ?? "bottom";
    const cPos = clash.style.position;
    if (gPos !== cPos) continue;
    findings.push({
      code: "graphic_covers_caption",
      severity: "notice",
      elementIds: [g.id, clash.id],
      atSec: Math.max(g.start, clash.start),
      reason:
        `graphic "${g.graphicType}" and a caption both want the "${gPos}" position at the same ` +
        "time — the layout engine will have to move one of them",
    });
  }

  return findings.sort((a, b) => a.atSec - b.atSec || a.code.localeCompare(b.code));
}

/** One line per finding, for the render log. Ids and reasons only — never a payload. */
export function formatQualityFindings(findings: readonly QualityFinding[]): string[] {
  return findings.map(
    (f) =>
      `[Director] ${f.severity} ${f.code} at ${f.atSec.toFixed(2)}s ` +
      `(${f.elementIds.slice(0, 3).join(", ")}${f.elementIds.length > 3 ? ", …" : ""}) — ${f.reason}`
  );
}

/** A one-line summary for a render that has nothing wrong with it, so silence is never ambiguous. */
export function formatQualitySummary(findings: readonly QualityFinding[]): string {
  const warnings = findings.filter((f) => f.severity === "warning").length;
  return (
    `[Director] quality rules: ${findings.length} finding(s), ${warnings} warning(s) — ` +
    "advisory only, nothing was changed"
  );
}
