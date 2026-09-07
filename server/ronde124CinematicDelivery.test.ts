/**
 * RONDE 124 §2 — THE SWITCH THAT DECIDES WHAT THE VIEWER GETS, READ ONE WAY.
 *
 * ── The proven defect ───────────────────────────────────────────────────────────────────────
 *
 * Renders 568, 571 and 572 all delivered the compose montage, and all three said why:
 *
 *     [RenderJob] route=legacy_compose RENDER_FALLBACK_USED
 *                 reason=CINEMATIC_RENDER_PATH is not enabled
 *
 * `cinematicRenderPathEnabled` read `process.env.CINEMATIC_RENDER_PATH === "true"` — a bare
 * comparison — while `productionPreflight` reads the SAME variable through `envFlagIsOn`, which
 * trims and lowercases. A worker set to `TRUE`, or with a trailing space, therefore had the
 * preflight reporting the flag ON and the pipeline taking the legacy route.
 *
 * That is not a hypothesis about how flags might go wrong: `envFlag.ts`'s own header records the
 * identical contradiction from render 569's log, on `ENABLE_YOUTUBE_SOURCING`, and RONDE 18
 * settled the tolerant reading as the rule for every deployment flag. This was one of the last
 * places still on the strict form, and it was the one that chooses the delivered file.
 *
 * ── What this file holds ────────────────────────────────────────────────────────────────────
 *
 * That the two readers can never disagree again, that nothing was loosened in the process, and
 * that every route the pipeline can take still announces itself. The fallback is NOT removed —
 * §16 forbids that and it is the right design — it simply may never be silent.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  CINEMATIC_PLAN_ERROR,
  cinematicRenderPathEnabled,
  formatProductionRoute,
  formatRenderRoute,
} from "./cinematicProduction";
import { envFlagIsOn } from "./envFlag";
import { ROUTE_FLAGS } from "./productionPreflight";

const SERVER = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SERVER, f), "utf8");

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.CINEMATIC_RENDER_PATH;
  if (value === undefined) delete process.env.CINEMATIC_RENDER_PATH;
  else process.env.CINEMATIC_RENDER_PATH = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CINEMATIC_RENDER_PATH;
    else process.env.CINEMATIC_RENDER_PATH = before;
  }
}

/* ═══════════════ 7. CINEMATIC_RENDER_PATH decides the route, once ═══════════════ */

describe("§14.7 — the render-path flag is read the same way everywhere", () => {
  it("the operator's TRUE means what the operator meant", () => {
    /** The exact shapes a Railway variable arrives in when somebody types it by hand. */
    for (const value of ["true", "TRUE", "True", " true ", "\ttrue\n"]) {
      expect(withFlag(value, cinematicRenderPathEnabled), JSON.stringify(value)).toBe(true);
    }
  });

  it("and NOTHING was loosened — it is still opt-in and still off by default", () => {
    for (const value of [undefined, "", "false", "FALSE", "0", "no", "yes", "1", "on"]) {
      expect(withFlag(value, cinematicRenderPathEnabled), String(value)).toBe(false);
    }
  });

  it("the pipeline and the preflight now give the same answer for every value", () => {
    /**
     * THE DEFECT, as an equality. The preflight's whole job is to tell an operator what this
     * deployment will do, and it was the one place allowed to answer differently from the code.
     */
    expect(ROUTE_FLAGS).toContain("CINEMATIC_RENDER_PATH");
    for (const value of [undefined, "", "true", "TRUE", " true ", "false", "FALSE", "1", "no"]) {
      expect(
        withFlag(value, cinematicRenderPathEnabled),
        `pipeline and preflight disagree for ${JSON.stringify(value)}`
      ).toBe(withFlag(value, () => envFlagIsOn("CINEMATIC_RENDER_PATH")));
    }
  });

  it("no flag on the delivery route is read with a bare comparison any more", () => {
    /**
     * Structural, because this defect class returns one module at a time. The scope is the
     * cinematic/graphics/render-delivery route — sourcing flags are another round's business and
     * are deliberately not touched here.
     */
    const deliveryModules = [
      "cinematicProduction.ts",
      "cinematicEffectsEngine.ts",
      "postRenderSpotCheck.ts",
    ];
    for (const mod of deliveryModules) {
      const code = read(mod).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const bare = [...code.matchAll(/process\.env\.[A-Z_]+ [!=]== "(true|false)"/g)].map((m) => m[0]);
      expect(bare, `${mod} still reads a deployment flag with a bare comparison`).toEqual([]);
    }
  });

  it("ALLOW_BURNED_IN_TEXT keeps the STRICT reading, and that is not an oversight", () => {
    /**
     * The one exception, and the reason the rule is about ROUTE flags rather than all flags.
     *
     * A route flag reads tolerantly because a stray capital silently disabling a source is worse
     * than a typo being ignored. `ALLOW_BURNED_IN_TEXT` runs the other way: it is a content policy,
     * and an accidental `1` or `TRUE` must not start burning text into customers' pictures. R113
     * pins exactly that, and this round briefly made it tolerant before that test caught it —
     * which is the test doing its job, and the reason the exception is written down here.
     */
    const src = read("onScreenTextPolicy.ts");
    expect(src).toContain('process.env.ALLOW_BURNED_IN_TEXT === "true"');
    expect(src).toContain("loosening a gate");
  });

  it("the route line reads the real predicate, so it cannot claim a state the pipeline ignores", () => {
    const on = withFlag("TRUE", () => formatProductionRoute(7));
    const off = withFlag(undefined, () => formatProductionRoute(7));
    expect(on).toContain("CINEMATIC_RENDER_PATH=on");
    expect(off).toContain("CINEMATIC_RENDER_PATH=off");
    expect(off).toContain("route=legacy_compose");
    expect(off).toContain("reason=");
  });
});

/* ═══════════════ 8. a fallback is allowed, silence is not ═══════════════ */

describe("§14.8 — every legacy delivery says so, with its reason", () => {
  it("the flag being off is stated as the reason, not inferred from a missing line", () => {
    const line = formatRenderRoute({ videoId: 572, route: "legacy_compose", planOk: true });
    expect(line).toContain("RENDER_FALLBACK_USED");
    expect(line).toContain("reason=CINEMATIC_RENDER_PATH is not enabled");
  });

  it("an unusable plan carries the planner's OWN code — CINEMATIC_TIMELINE_INVALID included", () => {
    /**
     * Render 571's shape. The reason has to be the planner's code rather than a generic sentence,
     * because "the timeline did not validate" and "the flag is off" call for different actions.
     */
    const line = formatRenderRoute({
      videoId: 571,
      route: "legacy_compose",
      planOk: false,
      reason: CINEMATIC_PLAN_ERROR.TIMELINE_INVALID,
    });
    expect(line).toContain("RENDER_FALLBACK_USED");
    expect(line).toContain("CINEMATIC_TIMELINE_INVALID");
  });

  it("every plan-failure code can reach the line — none of them is a silent path", () => {
    for (const code of Object.values(CINEMATIC_PLAN_ERROR)) {
      const line = formatRenderRoute({ videoId: 1, route: "legacy_compose", planOk: false, reason: code });
      expect(line, code).toContain(code);
      expect(line, code).toContain("RENDER_FALLBACK_USED");
    }
  });

  it("the cinematic route names itself and never carries the fallback word", () => {
    const line = formatRenderRoute({ videoId: 1, route: "cinematic_timeline", planOk: true });
    expect(line).toContain("route=cinematic_timeline");
    expect(line).not.toContain("RENDER_FALLBACK_USED");
  });

  it("the fallback still EXISTS — removing it is not what this round did", () => {
    /**
     * §16: the legacy path may not be deleted. A cinematic plan that cannot be built must still
     * produce a video, and the failure must be visible rather than fatal.
     */
    const src = read("cinematicProduction.ts");
    expect(src).toContain('export type RenderRoute = "cinematic_timeline" | "legacy_compose";');
    expect(src).toContain("RENDER_FALLBACK_USED");
  });
});

/* ═══════════════ §3 — the timeline validator was not weakened ═══════════════ */

describe("§3 — CINEMATIC_TIMELINE_INVALID is still a real refusal", () => {
  it("the plan is still refused when the timeline does not validate", () => {
    /**
     * Render 563's root cause was fixed in `cinematicPipelineInputs` by LAYING OUT unmeasured
     * beats along their own holds instead of defaulting them to second zero, which is what made
     * every beat in a scene overlap. That fix is a change to the INPUT, and the validator that
     * caught the overlap is untouched — this asserts it still blocks, because the tempting repair
     * for a validation failure is to stop validating.
     */
    const src = read("cinematicProduction.ts");
    expect(src).toContain("TIMELINE_INVALID: \"CINEMATIC_TIMELINE_INVALID\"");
    expect(src).toContain("validateTimeline");
    expect(src).toContain("NON_BLOCKING_ISSUES");
  });

  it("the render-563 input fix is still in place, with its evidence", () => {
    const src = read("cinematicPipelineInputs.ts");
    expect(src).toContain("const start = beat.voiceStartSec ?? beatCursorSec;");
    expect(src, "the `?? 0` that made every beat claim second zero must not come back").not.toContain(
      "beat.voiceStartSec ?? 0"
    );
  });
});

/* ═══════════════ §7/§8 — collisions resolve, and the caption fallback is not silent ═══════════════ */

describe("§7 — a collision moves a graphic, and never deletes one", () => {
  /**
   * RONDE 185 already built and pixel-tested this: graphics are laid out against each other first,
   * every relocation records the anchor it wanted and the anchor it got, and a graphic that cannot
   * be given a free band is STILL DRAWN and reported. `ronde185GraphicsCollision.test.ts` proves
   * the geometry, including a real render in which two graphics occupy two separated bands.
   *
   * What was missing is the tie to this round's lifecycle: DROPPED_COLLISION is a drop the brief
   * asks for, and it must stay unreachable — because a graphic is never dropped for colliding.
   * If the layout engine ever starts deleting instead of moving, this fails.
   */
  it("the layout engine moves graphics rather than removing them", () => {
    const src = read("remotionProps.ts");
    expect(src).toContain("graphicMoves");
    expect(src).toContain("placedGraphics.push(");
    /** The props are built from the whole track minus `disabled` — never minus "collided". */
    expect(src).toContain("graphicsTrack(timeline)\n      .filter((g) => !g.disabled)");
  });

  it("there is no DROPPED_COLLISION outcome, because colliding never ends a graphic", () => {
    const lifecycle = read("graphicsLifecycle.ts");
    expect(lifecycle).toContain("DROPPED_UNSUPPORTED");
    expect(
      lifecycle,
      "a collision drop would mean the layout engine deletes — it moves, and R185 proves it"
    ).not.toContain("DROPPED_COLLISION");
  });

  it("the quality judge reports a clash as a NOTICE, not as a removal", () => {
    const rules = read("directorQualityRules.ts");
    expect(rules).toContain('code: "graphic_covers_caption"');
    expect(rules).toContain('severity: "notice"');
  });
});

describe("§8 — an unsupported caption position is deterministic and stated", () => {
  it("bottom-left and bottom-right are reported by name, never silently moved", () => {
    const src = read("edlToTimeline.ts");
    expect(src).toContain('caption.position === "bottom-left" || caption.position === "bottom-right"');
    expect(src).toContain('caption position "${caption.position}" on beat');
    expect(src).toContain("centres text, so it is drawn bottom-centre");
  });

  it("the mapping is a pure switch with a named default — the same input always lands the same", () => {
    /**
     * Determinism is the property §8 asks for when support is not added. `positionFor` is a switch
     * over the planner's vocabulary with `bottom` as its documented default, so two renders of one
     * timeline place a caption identically. Real left/right anchors would mean teaching the layout
     * engine two new anchor names — `positionStyle`, `layoutCaption` and `graphicBoxSize` all key
     * on that vocabulary — which is a wider change than this round carries beside a delivery fix.
     */
    const src = read("edlToTimeline.ts");
    const at = src.indexOf("function positionFor(caption: CaptionInstruction)");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toContain('case "bottom-left":');
    expect(body).toContain('case "bottom-right":');
    expect(body).toContain('default: return "bottom";');
  });
});
