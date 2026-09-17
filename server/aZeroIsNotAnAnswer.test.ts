/**
 * A ZERO IS NOT AN ANSWER — a metric may not report a question nobody asked.
 *
 * ── The line this is about ──────────────────────────────────────────────────────────────────
 *
 *     [Graphics] lifecycle planned=1 translated=1 renderInput=0 drawn=0
 *
 * Render 589 published that, and it reads exactly one way: the renderer was handed nothing and
 * drew nothing, so the graphic was planned, translated, and then refused. That is not what
 * happened. The line comes from `formatCinematicGraphicsLifecycle`, which runs at PLAN time —
 * before any render exists — and the two zeros were not measurements. They were the absence of a
 * measurement, printed in the shape of one.
 *
 * `graphicsLifecycle` itself was already careful here: without a renderer report it leaves every
 * graphic at TRANSLATED and its own doc comment says calling it DROPPED_RENDER_ERROR "would be a
 * fabricated ending". The care stopped at the formatter.
 *
 * ── What was NOT done ───────────────────────────────────────────────────────────────────────
 *
 * The counts are untouched. Nothing was renamed, no threshold moved, no stage removed. The repair
 * is to what the number MEANS — `n/a` where there is no answer yet, a number where there is — which
 * is the difference between repairing a metric semantically and repairing it cosmetically.
 */
import { describe, expect, it } from "vitest";

import {
  graphicsLifecycle,
  formatGraphicsLifecycle,
  type PlannedGraphic,
  type TimelineGraphicLike,
} from "./graphicsLifecycle";
import { rendererGraphicType } from "./edlToTimeline";
import { timelineElementId } from "./projectTimeline";

/** One planned graphic of a type this build can certainly draw, with a payload that satisfies it. */
const PLANNED: PlannedGraphic = {
  beatId: "s0b0",
  graphicType: "lower_third",
  data: { label: "Los Angeles County Courthouse" },
  startSec: 1.5,
  reason: "names the place the beat is about",
};

/** The same graphic as the timeline carries it — the id computed the way `translateEdl` computes it. */
function onTrack(): TimelineGraphicLike[] {
  const rendererType = rendererGraphicType(PLANNED.graphicType);
  return [
    {
      id: timelineElementId("gfx", PLANNED.beatId, rendererType, PLANNED.startSec),
      graphicType: rendererType,
      data: PLANNED.data,
      label: "Los Angeles County Courthouse",
    },
  ];
}

const idOf = (): string =>
  timelineElementId("gfx", PLANNED.beatId, rendererGraphicType(PLANNED.graphicType), PLANNED.startSec);

/* ═══════════ 1 — before a render, the line says so ═══════════ */

describe("§32 — no render yet is not the same as nothing drawn", () => {
  it("the two render stages read n/a, not zero", () => {
    const life = graphicsLifecycle({ planned: [PLANNED], onTrack: onTrack() });
    const line = formatGraphicsLifecycle("r-plan", life)[0];

    expect(line).toContain("renderInput=n/a");
    expect(line).toContain("drawn=n/a");
    expect(line, "a zero still reads as a measurement").not.toContain("renderInput=0");
    expect(line, "a zero still reads as a measurement").not.toContain("drawn=0");
  });

  it("the plan stages are still real numbers — only the unmeasured ones change", () => {
    const life = graphicsLifecycle({ planned: [PLANNED], onTrack: onTrack() });
    const line = formatGraphicsLifecycle("r-plan", life)[0];
    expect(line).toContain("planned=1");
    expect(line).toContain("translated=1");
    expect(line).toContain("dropped=0");
  });

  it("the graphic itself is not given a fabricated ending", () => {
    const life = graphicsLifecycle({ planned: [PLANNED], onTrack: onTrack() });
    expect(life.lives).toHaveLength(1);
    expect(life.lives[0].outcome).toBe("TRANSLATED");
    expect(life.rendererReported).toBe(false);
  });
});

/* ═══════════ 2 — after a render, the numbers are numbers ═══════════ */

describe("§32 — once the renderer has answered, the line carries the answer", () => {
  it("a drawn graphic reports renderInput=1 drawn=1", () => {
    const id = idOf();
    const life = graphicsLifecycle({
      planned: [PLANNED],
      onTrack: onTrack(),
      renderer: { inputIds: [id], drawnIds: [id] },
    });
    const line = formatGraphicsLifecycle("r-done", life)[0];

    expect(life.rendererReported).toBe(true);
    expect(life.lives[0].outcome).toBe("DRAWN");
    /**
     * `renderInput` counts graphics the renderer's props CARRIED, cumulatively — so a drawn
     * graphic is counted at both stages, the way the four-stage vocabulary always read. It used to
     * come from `counts.RENDER_INPUT`, which is keyed by a graphic's one final outcome and is
     * therefore zero in every case there has ever been. The line said `renderInput=0 drawn=1`:
     * nothing reached the renderer, and one was drawn.
     */
    expect(life.reachedRenderInput).toBe(1);
    expect(line).toContain("renderInput=1 drawn=1");
    expect(line).not.toContain("n/a");
  });

  it("a graphic the renderer received and did not draw is a real zero, and says why", () => {
    /**
     * This is the case the plan-time zeros were impersonating. Here it IS a measurement: the
     * renderer's props carried the id and its drawn list did not.
     */
    const id = idOf();
    const life = graphicsLifecycle({
      planned: [PLANNED],
      onTrack: onTrack(),
      renderer: { inputIds: [id], drawnIds: [] },
    });
    const lines = formatGraphicsLifecycle("r-done", life);

    expect(life.rendererReported).toBe(true);
    expect(life.lives[0].outcome).toBe("DROPPED_RENDER_ERROR");
    expect(lines[0]).toContain("drawn=0");
    expect(lines[0]).not.toContain("n/a");
    expect(lines.join("\n")).toContain("DROPPED_RENDER_ERROR");
    expect(lines.join("\n")).toContain("the renderer received it and did not report drawing it");
  });

  it("a graphic the renderer never received is distinguished from one it refused", () => {
    const life = graphicsLifecycle({
      planned: [PLANNED],
      onTrack: onTrack(),
      renderer: { inputIds: [], drawnIds: [] },
    });
    expect(life.lives[0].detail).toContain("absent from the renderer's props");
  });
});

/* ═══════════ 3 — the two states cannot be confused ═══════════ */

describe("§32 — the flag is the only thing that decides", () => {
  it("the same plan reads differently before and after a render, and says which", () => {
    const id = idOf();
    const before = formatGraphicsLifecycle(
      "r",
      graphicsLifecycle({ planned: [PLANNED], onTrack: onTrack() })
    )[0];
    const after = formatGraphicsLifecycle(
      "r",
      graphicsLifecycle({
        planned: [PLANNED],
        onTrack: onTrack(),
        renderer: { inputIds: [id], drawnIds: [id] },
      })
    )[0];

    expect(before).not.toBe(after);
    expect(before).toContain("no render reported yet");
    expect(after).not.toContain("no render reported yet");
  });

  it("an empty plan before a render still says n/a rather than a row of zeros", () => {
    const line = formatGraphicsLifecycle("r", graphicsLifecycle({ planned: [], onTrack: [] }))[0];
    expect(line).toContain("planned=0");
    expect(line).toContain("renderInput=n/a");
  });
});
