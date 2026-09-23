/**
 * ONE ROUTE MAKES THE FILM — the production route, counted rather than assumed.
 *
 * §1 of this round asked for an inventory before anything was removed. This file IS that
 * inventory, written as assertions so it cannot drift while the migration happens across several
 * rounds. It pins what is true TODAY, including the parts that are not yet what we want.
 *
 * ── What is already single ──────────────────────────────────────────────────────────────────
 *
 *   TIMELINE   `translateEdl` is the one builder a production render uses.
 *              `timelineFromEditorScenes` is a RECOVERY adapter: `renderJobWorker` reaches it only
 *              when `job.timelineVersion === 0` and no timeline was ever saved — a video made
 *              before timelines existed. It is not a second production source.
 *
 *   RENDERER   `runRenderJob` renders every timeline, whether the pipeline calls it in-process or
 *              the editor's re-render queues it. There is one.
 *
 * ── What is NOT yet single, and is pinned here so it can only shrink ────────────────────────
 *
 *   DELIVERY   the pipeline still composes a montage FIRST and delivers it when the cinematic
 *              render does not produce a file:
 *
 *                  const deliveredUrl = cinematicDeliveredUrl ?? url;
 *
 *              Six production call sites reach `composeSceneVideo`. This file counts them. A
 *              round that migrates one makes this number go down; a round that adds one fails.
 *
 * NOTHING HERE ASSERTS THAT COMPOSE IS GONE. It is not, and a test claiming otherwise would be
 * the fake green this programme keeps refusing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const PIPELINE = read("videoPipeline.ts");
const WORKER = read("renderJobWorker.ts");
const CINEMATIC = read("cinematicPipeline.ts");

/** Every production (non-test) file that could name a route. */
const PROD = ["videoPipeline.ts", "renderJobWorker.ts", "timelineRouter.ts", "cinematicPipeline.ts"];

/* ═══════════ §1 — one timeline builder in production ═══════════ */

describe("§1 — ONE TIMELINE SOURCE", () => {
  it("translateEdl is the production builder, and only cinematicPipeline calls it", () => {
    expect(CINEMATIC).toContain("translateEdl({");
    const callers = PROD.filter((f) => /translateEdl\(\{/.test(read(f)));
    expect(callers, "a second module started building production timelines").toEqual([
      "cinematicPipeline.ts",
    ]);
  });

  it("timelineFromEditorScenes is a RECOVERY adapter, gated on there being no timeline", () => {
    /**
     * The gate is what makes it an adapter rather than a rival. If this guard ever disappears, a
     * render could build its timeline from the scene manifest while a real one sits in the row.
     */
    const at = WORKER.indexOf("timelineFromEditorScenes({");
    expect(at).toBeGreaterThan(-1);
    const before = WORKER.slice(Math.max(0, at - 1800), at);
    expect(before, "the manifest route is no longer behind a version check").toContain(
      "if (job.timelineVersion !== 0) {"
    );
    expect(before).toContain('source: "manifest"');
    expect(before, "the stored timeline must still be preferred").toContain('source: "stored"');
  });

  it("the pipeline itself never builds a timeline — it asks the planner for one", () => {
    expect(PIPELINE).toContain("planAndStoreCinematicTimeline({");
    expect(PIPELINE, "the pipeline grew its own translator").not.toContain("translateEdl(");
    expect(PIPELINE, "the pipeline grew its own manifest builder").not.toContain(
      "timelineFromEditorScenes("
    );
  });
});

/* ═══════════ §2 — one renderer ═══════════ */

describe("§2 — ONE PRODUCTION RENDERER", () => {
  it("the pipeline renders through runRenderJob, not through a renderer of its own", () => {
    expect(PIPELINE).toContain('const { runRenderJob } = await import("./renderJobWorker");');
    expect(PIPELINE, "a second timeline renderer appeared").not.toContain(
      'from "./timelineRenderer"'
    );
  });

  it("the in-process render and the queued one are the same job row, claimed once", () => {
    /**
     * `claimQueuedRenderJob` is a conditional UPDATE from queued to running. Exactly one caller
     * wins it, which is what stops the poll loop and the pipeline rendering the same row twice.
     */
    expect(PIPELINE).toContain("claimQueuedRenderJob(cutover.renderJobId)");
    expect(PIPELINE).toContain("const claimed = await claimQueuedRenderJob(");
  });

  it("the render worker knows it has no other route through it", () => {
    expect(WORKER).toContain('route: "cinematic_timeline"');
    expect(WORKER, "the worker learned a second route").not.toContain('route: "legacy_compose"');
  });
});

/* ═══════════ §3 — THE ROUTE THAT IS NOT YET GONE, COUNTED ═══════════ */

describe("§3 — legacy compose, pinned so it can only shrink", () => {
  /**
   * CALLS, not mentions and not the declaration.
   *
   * `async function composeSceneVideo(` opens with the same three tokens, so the lookbehind has to
   * exclude `function ` as well as an identifier character — counting the wrapper's own definition
   * as a caller is how this ratchet would quietly read one too high forever.
   */
  const productionCallSites = [
    ...PIPELINE.matchAll(/(?<!function )(?<![\w.])composeSceneVideo\(\s*\n/g),
  ].length;

  it("SIX production call sites today — this number is a ratchet", () => {
    /**
     * If a migration round removes one, change this number DOWN and say which site went. If it
     * goes up, a new caller was added to the route we are retiring and the test has done its job.
     */
    expect(productionCallSites).toBe(6);
  });

  it("the delivered file still prefers the cinematic render and falls back to compose", () => {
    /** The current truth, stated. `??` is the whole migration in one operator. */
    expect(PIPELINE).toContain("const deliveredUrl = cinematicDeliveredUrl ?? url;");
  });

  it("and the fallback is never silent — the route is named on every render", () => {
    expect(PIPELINE).toContain('route: cinematicDeliveredUrl ? "cinematic_timeline" : "legacy_compose"');
    expect(PIPELINE).toContain("RENDER_FALLBACK_USED");
  });

  it("THE AXLE IS GONE: the planner no longer NEEDS compose to have run", () => {
    /**
     * This was the real reason compose could not be deleted. `composedUsedClips[i]` is written BY
     * the compose stage, so reading only that made compose an INPUT to the cinematic plan rather
     * than a fallback behind it. The canonical retrieval state became the fallback, which is what
     * makes a future removal a migration instead of a rewrite.
     *
     * RONDE 632 went one step further, and this assertion moves with it: the canonical set is now
     * the PRIMARY source and compose contributes only what canonical does not already hold. The
     * axle is not merely spare, it is off the car — compose's list can be empty on every scene and
     * the planner still has every adopted clip.
     */
    expect(PIPELINE).toContain("const canonicalForScene = sceneVisualResults[i]?.clips ?? [];");
    expect(PIPELINE).toContain("canonical: canonicalForScene,");
    expect(PIPELINE).toContain("clipPaths: plannerSource.clipPaths,");
  });

  it("and the divergence between the two is measured on every render", () => {
    /** The number the removal decision will be made on. */
    expect(PIPELINE).toContain("[CinematicSourceDecision]");
    expect(PIPELINE).toContain("[CinematicSourceDivergence]");
  });
});

/* ═══════════ §4 — the pool is the one media route's entry ═══════════ */

describe("§4 — every pool caller supplies the same providers", () => {
  it("the retrieval funnel asks YouTube and the archive — RONDE 603's repair, still wired", () => {
    const FUNNEL = read("retrievalFunnel.ts");
    expect(FUNNEL).toContain("youtubeSearch: req.youtubeSearch");
    expect(FUNNEL).toContain("archiveSearch: req.archiveSearch");
  });

  it("and the pool still distinguishes 'not supplied' from 'found nothing'", () => {
    /** RONDE 177's rule. Collapsing the two is what hid the funnel defect for six rounds. */
    expect(read("scenePool.ts")).toContain('skipped.youtube_cc = "no_search_function_supplied";');
  });
});
