/**
 * §39 — THERE IS ONE PIPELINE.
 *
 * ── What was retired ────────────────────────────────────────────────────────────────────────
 *
 * A parallel "modular pipeline" lived in `server/pipeline/`: an orchestrator, ten stage modules, a
 * Phase-8 new-engine chain, and their tests. About 1,450 lines of production code and 1,500 of
 * tests, reachable only by setting two environment variables — the second of which spelled
 * `PIPELINE_ARCHITECTURE_CONFIRM=modular-i-understand-unverified`. It never carried a render.
 *
 * ── Why it could not ship, which is not "it was unfinished" ─────────────────────────────────
 *
 * From its own docstring: it called Media Search ONCE PER SCENE, on that scene's primary beat, and
 * used the top-ranked candidate. Everything built since is per BEAT — the picture editor's
 * verdicts, the shot vocabulary and its progression rules, the Asset Director's ranking, the
 * relevance ledger, the cinematic timeline's clip-per-beat structure. Switching it on would not
 * have produced an unverified version of today's film. It would have produced a coarser one, with
 * one shot where the plan asks for six.
 *
 * It was also a second Director, a second renderer, a second timeline and a second composer, in a
 * codebase whose standing rule is that there is exactly one of each.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * That the decision does not quietly come back: no second orchestrator, no environment variable
 * that selects between architectures, and one call to `runVideoPipeline` where the render starts.
 *
 * The shared vocabulary in `server/pipeline/types.ts` is NOT part of this. Thirty-two live modules
 * import it and it was never part of the rival architecture; deleting it was never on the table,
 * and a test that confused the two would eventually be used to argue for removing it.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const dir = (p: string) => path.join(__dirname, p);

describe("the rival architecture is gone", () => {
  it("no orchestrator, no stage modules, no new-engine chain", () => {
    for (const gone of [
      "pipeline/orchestrator.ts",
      "pipeline/adapters.ts",
      "pipeline/newPipelineStages.ts",
      "pipeline/newEngineFlags.ts",
      "pipeline/observability.ts",
      "pipeline/stages",
    ]) {
      expect(fs.existsSync(dir(gone)), `${gone} is back`).toBe(false);
    }
  });

  /**
   * The shared vocabulary stays. This is the assertion that stops the round above from being read
   * as "empty the directory".
   */
  it("the shared scene and beat types stay, because live code imports them", () => {
    expect(fs.existsSync(dir("pipeline/types.ts"))).toBe(true);
  });

  /** A retirement nobody wrote down is a deletion somebody will undo by accident. */
  it("the directory records what was removed and how to recover it", () => {
    const readme = fs.readFileSync(dir("pipeline/README.md"), "utf8");
    expect(readme).toContain("Once per scene");
    expect(readme).toContain("git log -- server/pipeline/orchestrator.ts");
  });
});

describe("the render has one entry point", () => {
  const routers = () => fs.readFileSync(dir("routers.ts"), "utf8");

  it("starts the pipeline by calling it, not by choosing between two", () => {
    const src = routers();
    expect(src).toContain("const pipelineRun = runVideoPipeline(");
    expect(src).not.toContain("const pipelineFn =");
  });

  /**
   * The switch itself is the thing being removed, not just its other branch. An env var that
   * selects an architecture is a question the codebase can now answer.
   */
  it("no environment variable selects an architecture", () => {
    const src = routers();
    expect(src).not.toContain('process.env.PIPELINE_ARCHITECTURE === "modular"');
    expect(src).not.toContain("PIPELINE_ARCHITECTURE_CONFIRM");
    expect(src).not.toContain("runModularVideoPipeline");
  });

  /** And the reason is where the next person to wonder about it will be standing. */
  it("says why, at the call site", () => {
    const src = routers();
    expect(src).toContain("THE MODULAR PIPELINE IS RETIRED");
    expect(src).toContain("ONCE PER SCENE");
  });
});
