/**
 * RONDE 124 — EVERY PLANNED GRAPHIC GETS EXACTLY ONE ENDING.
 *
 * ── What the graphics reporting could not say ────────────────────────────────────────────────
 *
 * A graphic's whole record of itself was a `string[]`. `translateEdl` pushes a sentence into
 * `unsupported` for a graphic no component draws, `formatCinematicGraphics` counts the ones on the
 * track that pass `graphicIsRenderable`, and `remotionRenderer` counts `graphicsDrawn` again on the
 * other side of the process boundary. Three counts, three modules, no join — and `skipped` was
 * derived by matching the prefix `"motion graphic "` on free text, so the number depended on the
 * wording of a sentence.
 *
 * Nothing was hidden and nothing failed. What could not be done was the one check that matters:
 * ADD THE ENDINGS UP AND SEE WHETHER THEY ACCOUNT FOR THE PLAN. Render 572 planned five graphics,
 * reported five rendered and zero skipped, and its EDL separately named an unsupported
 * `highlight_box` — two statements that cannot both be about the same five graphics, and no
 * structure in which to notice that.
 *
 * ── What this module is ─────────────────────────────────────────────────────────────────────
 *
 * The join, as a pure function over what the pipeline already produces. Every graphic the planner
 * emitted is matched to its timeline element by the SAME id `translateEdl` computes, and to the
 * renderer's own report when there is one. Each one comes out with exactly one outcome, and
 * `unaccounted` is a defect rather than a rounding difference.
 *
 * ── What it deliberately is NOT ─────────────────────────────────────────────────────────────
 *
 * Not a second graphics engine, not a renderer, not a decision-maker. It changes no plan, draws
 * nothing, and moves nothing. It has no opinion about whether a graphic SHOULD be drawn — it reads
 * `graphicIsRenderable`, the renderer's own predicate, exactly as the three counters already do.
 *
 * ── The one semantic correction it does make ────────────────────────────────────────────────
 *
 * `rendered` has never meant "in the video". It means "passed the predicate while sitting on the
 * track", which is a statement about the PLAN. The four stages below keep the distinction the
 * counters ran together, and `DRAWN` is the only one that is evidence from the renderer:
 *
 *     PLANNED       the planner emitted it
 *     TRANSLATED    it reached the timeline, under a name the renderer knows
 *     RENDER_INPUT  the renderer's props carried it
 *     DRAWN         the renderer reported drawing it
 *
 * Even `DRAWN` is the renderer's own count and not a frame inspection — `graphicsOverlayInk` is
 * what reads pixels back, and it answers for the whole overlay rather than per graphic. So this
 * module never uses the word "delivered", and nothing here may be read as proof that a viewer saw
 * anything.
 */
import { graphicIsRenderable, graphicRendererClass } from "./graphicsVocabulary";
import { timelineElementId } from "./projectTimeline";
import { rendererGraphicType, graphicLabel, RENDERABLE_EFFECTS } from "./edlToTimeline";

/* ═══════════════════════ the vocabulary ═══════════════════════ */

/** Progress. A graphic sitting on one of these has not finished its life yet. */
export const GRAPHIC_STAGES = ["PLANNED", "TRANSLATED", "RENDER_INPUT", "DRAWN"] as const;
export type GraphicStage = (typeof GRAPHIC_STAGES)[number];

/**
 * Endings. A graphic that reaches one of these is finished, and the reason is part of the record.
 *
 *   DROPPED_UNSUPPORTED     no component in this build draws that type
 *   DROPPED_INVALID_PAYLOAD the type is drawable and THIS graphic's payload is not — a chart with
 *                           no series, a map point with no coordinate, a text card with no words
 *   DROPPED_DISABLED        a human switched it off in the editor
 *   DROPPED_NOT_TRANSLATED  the planner emitted it and no timeline element carries it
 *   DROPPED_RENDER_ERROR    the renderer had it and did not draw it
 */
export const GRAPHIC_DROPS = [
  "DROPPED_UNSUPPORTED",
  "DROPPED_INVALID_PAYLOAD",
  "DROPPED_DISABLED",
  "DROPPED_NOT_TRANSLATED",
  "DROPPED_RENDER_ERROR",
] as const;
export type GraphicDrop = (typeof GRAPHIC_DROPS)[number];

export type GraphicOutcome = GraphicStage | GraphicDrop;

/** True for an outcome that ends a graphic's life. `DRAWN` ends it well; the drops end it badly. */
export function isTerminalGraphicOutcome(outcome: GraphicOutcome): boolean {
  return outcome === "DRAWN" || (GRAPHIC_DROPS as readonly string[]).includes(outcome);
}

/* ═══════════════════════ one graphic's life ═══════════════════════ */

export type PlannedGraphic = {
  beatId: string;
  /** The planner's own name, before translation. Kept because the drop reason has to name it. */
  graphicType: string;
  data: Record<string, unknown>;
  startSec: number;
  reason: string;
};

export type GraphicLife = {
  /** The timeline element id, computed exactly as `translateEdl` computes it. */
  id: string;
  beatId: string;
  /** What the planner asked for. */
  plannedType: string;
  /** What the timeline calls it — the same when there is no translation entry. */
  rendererType: string;
  outcome: GraphicOutcome;
  /** Why, for every outcome that is not plain progress. Never empty on a drop. */
  detail?: string;
  /** `explicit` when the type has a design of its own, `generic` for the default text card. */
  rendererClass?: "explicit" | "generic" | "unsupported";
};

/* ═══════════════════════ what the renderer said ═══════════════════════ */

/**
 * The renderer's own report, when the caller has one.
 *
 * Optional, and its absence is not treated as failure: the plan can be audited before a render
 * happens, and calling a graphic DROPPED_RENDER_ERROR because no render has run yet would be a
 * fabricated ending. Without it a graphic stops at TRANSLATED, which is exactly what is known.
 */
export type RendererGraphicsReport = {
  /** The ids the renderer's props carried. */
  inputIds: readonly string[];
  /** The ids the renderer reported drawing. */
  drawnIds: readonly string[];
};

/* ═══════════════════════ the join ═══════════════════════ */

/** A timeline graphic, structurally — so this module needs no ProjectTimeline import cycle. */
export type TimelineGraphicLike = {
  id: string;
  graphicType: string;
  data?: Record<string, unknown>;
  label?: string | null;
  disabled?: boolean;
};

export type GraphicsLifecycleInput = {
  /** Every graphic the planner emitted, across every decision. */
  planned: readonly PlannedGraphic[];
  /** The GRAPHICS track of the timeline the plan produced. */
  onTrack: readonly TimelineGraphicLike[];
  renderer?: RendererGraphicsReport;
};

export type GraphicsLifecycle = {
  lives: GraphicLife[];
  counts: Record<GraphicOutcome, number>;
  /**
   * Planned graphics whose ending could not be determined at all.
   *
   * Always empty by construction today — every branch below assigns an outcome — and asserted to
   * be empty by RONDE 124's tests, so a future branch that forgets one fails there rather than
   * quietly shrinking a total.
   */
  unaccounted: string[];
};

function emptyCounts(): Record<GraphicOutcome, number> {
  const counts = {} as Record<GraphicOutcome, number>;
  for (const s of GRAPHIC_STAGES) counts[s] = 0;
  for (const d of GRAPHIC_DROPS) counts[d] = 0;
  return counts;
}

/**
 * Every planned graphic, with exactly one outcome.
 *
 * The id is recomputed rather than looked up by position: `translateEdl` derives it from
 * `(beatId, rendererType, startSec)` and a positional join would silently mispair the moment a
 * decision gains or loses a graphic. Recomputing means the join is the same function on both
 * sides, which is the only way the two can never disagree.
 */
export function graphicsLifecycle(input: GraphicsLifecycleInput): GraphicsLifecycle {
  const byId = new Map(input.onTrack.map((g) => [g.id, g]));
  const inputIds = input.renderer ? new Set(input.renderer.inputIds) : null;
  const drawnIds = input.renderer ? new Set(input.renderer.drawnIds) : null;

  const lives: GraphicLife[] = [];
  const counts = emptyCounts();
  const unaccounted: string[] = [];

  for (const p of input.planned) {
    const rendererType = rendererGraphicType(p.graphicType);
    const id = timelineElementId("gfx", p.beatId, rendererType, p.startSec);
    const base = { id, beatId: p.beatId, plannedType: p.graphicType, rendererType };

    const onTrack = byId.get(id);
    if (!onTrack) {
      lives.push({
        ...base,
        outcome: "DROPPED_NOT_TRANSLATED",
        detail: `the planner emitted "${p.graphicType}" and no timeline element carries it`,
      });
      continue;
    }
    if (onTrack.disabled) {
      lives.push({ ...base, outcome: "DROPPED_DISABLED", detail: "switched off in the editor" });
      continue;
    }

    const data = onTrack.data ?? {};
    const label = onTrack.label ?? graphicLabel(rendererType, data) ?? null;
    const rendererClass = graphicRendererClass(onTrack.graphicType, data, label);

    if (!graphicIsRenderable(onTrack.graphicType, data, label)) {
      /**
       * The two ways a graphic fails the predicate are different findings, and running them
       * together is how `highlight_box` (no component, ever) and a chart with no numbers (a
       * payload problem on a type that draws perfectly) came out as one number.
       */
      const knownType = rendererClass !== "unsupported" || RENDERER_KNOWS(onTrack.graphicType);
      lives.push({
        ...base,
        rendererClass,
        outcome: knownType ? "DROPPED_INVALID_PAYLOAD" : "DROPPED_UNSUPPORTED",
        detail: knownType
          ? `"${onTrack.graphicType}" is drawable and this payload is not`
          : `no component in this build draws "${p.graphicType}"`,
      });
      continue;
    }

    if (!inputIds) {
      lives.push({ ...base, rendererClass, outcome: "TRANSLATED" });
      continue;
    }
    if (!inputIds.has(id)) {
      lives.push({
        ...base,
        rendererClass,
        outcome: "DROPPED_RENDER_ERROR",
        detail: "on the timeline and absent from the renderer's props",
      });
      continue;
    }
    if (drawnIds?.has(id)) {
      lives.push({ ...base, rendererClass, outcome: "DRAWN" });
      continue;
    }
    lives.push({
      ...base,
      rendererClass,
      outcome: "DROPPED_RENDER_ERROR",
      detail: "the renderer received it and did not report drawing it",
    });
  }

  for (const life of lives) {
    counts[life.outcome] += 1;
    if (!isTerminalGraphicOutcome(life.outcome) && life.outcome !== "TRANSLATED") {
      unaccounted.push(life.id);
    }
  }
  return { lives, counts, unaccounted };
}

/**
 * Does this build have a component for the name at all?
 *
 * Read through `graphicIsRenderable` with a payload that satisfies every shape it checks, so the
 * answer is "the NAME is known" rather than "this payload works". Written as a function rather
 * than a second exported set, because a second set is exactly how the three vocabularies in
 * `graphicsVocabulary`'s own header drifted apart.
 */
function RENDERER_KNOWS(graphicType: string): boolean {
  return graphicIsRenderable(
    graphicType,
    {
      label: "probe",
      series: [{ label: "a", value: 1 }],
      normX: 0.5,
      normY: 0.5,
      /** RONDE 124 — the region rule too, or `highlight_box` probes as a type nobody can draw. */
      normW: 0.2,
      normH: 0.2,
      shape: "circle",
    },
    "probe"
  );
}

/* ═══════════════════════ effects, the same question ═══════════════════════ */

export type PlannedEffect = { beatId: string; effectType: string; reason: string };

export type EffectLife = {
  beatId: string;
  effectType: string;
  outcome: "CARRIED" | "DROPPED_UNSUPPORTED";
  detail?: string;
};

/**
 * Every planned visual effect, with an ending.
 *
 * The same defect in a smaller place: `dust`, `particles` and `lens_flare` are in the planner's
 * `VisualEffectType` and not in `RENDERABLE_EFFECTS`, so the effects planner asks for them on
 * archive footage and no filter executes them. That was already reported as a sentence; this makes
 * it a count, so "three effects were planned and not executed" is a number an invariant can read.
 */
export function effectsLifecycle(planned: readonly PlannedEffect[]): {
  lives: EffectLife[];
  carried: number;
  dropped: number;
} {
  const lives = planned.map<EffectLife>((e) =>
    RENDERABLE_EFFECTS.has(e.effectType)
      ? { beatId: e.beatId, effectType: e.effectType, outcome: "CARRIED" }
      : {
          beatId: e.beatId,
          effectType: e.effectType,
          outcome: "DROPPED_UNSUPPORTED",
          detail: `no filter in this renderer executes "${e.effectType}"`,
        }
  );
  return {
    lives,
    carried: lives.filter((l) => l.outcome === "CARRIED").length,
    dropped: lives.filter((l) => l.outcome === "DROPPED_UNSUPPORTED").length,
  };
}

/* ═══════════════════════ saying it ═══════════════════════ */

/**
 * One line for the render log, plus one per drop.
 *
 * `planned` and the outcome counts always add up — that is the point of the line. The word
 * "delivered" is deliberately absent: nothing in this module inspects a frame.
 */
export function formatGraphicsLifecycle(
  renderId: string,
  lifecycle: GraphicsLifecycle,
  effects?: { carried: number; dropped: number }
): string[] {
  const c = lifecycle.counts;
  const planned = lifecycle.lives.length;
  const dropped = GRAPHIC_DROPS.reduce((n, d) => n + c[d], 0);
  const head =
    `[Graphics] lifecycle render=${renderId} planned=${planned} ` +
    `translated=${c.TRANSLATED} renderInput=${c.RENDER_INPUT} drawn=${c.DRAWN} ` +
    `dropped=${dropped} unaccounted=${lifecycle.unaccounted.length}` +
    (effects ? ` effectsCarried=${effects.carried} effectsDropped=${effects.dropped}` : "");

  const lines = [head];
  for (const d of GRAPHIC_DROPS) {
    if (c[d] === 0) continue;
    const example = lifecycle.lives.find((l) => l.outcome === d);
    lines.push(
      `[Graphics] lifecycle render=${renderId} ${d}=${c[d]} — ` +
        `e.g. beat ${example?.beatId} "${example?.plannedType}": ${example?.detail ?? "no detail"}`
    );
  }
  if (lifecycle.unaccounted.length > 0) {
    lines.push(
      `[Graphics] lifecycle render=${renderId} UNACCOUNTED=${lifecycle.unaccounted.length} — ` +
        "these graphics were planned and this build cannot say what became of them"
    );
  }
  return lines;
}
