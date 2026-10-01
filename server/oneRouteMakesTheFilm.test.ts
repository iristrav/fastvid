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
    /**
     * ONE ROUTE: the render no longer stores a manifest, so when NO plan was stored the manifest
     * adapter is used once, at the end of the render, to store a timeline — only into a row that
     * has none, never beside or over a real one. Everywhere else the planner is the only source.
     */
    expect(PIPELINE.match(/timelineFromEditorScenes\(/g) ?? []).toHaveLength(1);
    const at = PIPELINE.indexOf("timelineFromEditorScenes(");
    expect(PIPELINE.slice(Math.max(0, at - 600), at)).toContain("if (expectedVersion !== 0) return;");
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

  it("NO production call sites are left — this number was a ratchet", () => {
    /**
     * If a migration round removes one, change this number DOWN and say which site went. If it
     * goes up, a new caller was added to the route we are retiring and the test has done its job.
     */
    /** RONDE 661: zero. The route being retired is gone, and this ratchet has reached its floor. */
    expect(productionCallSites).toBe(0);
  });
});

/* ═══════════ §4 — the pool is the one media route's entry ═══════════ */

