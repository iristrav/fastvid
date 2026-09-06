/**
 * THE REPORT AND THE PIPELINE MUST READ A VARIABLE THE SAME WAY.
 *
 * ── The contradiction, from one production log ──────────────────────────────────────────────
 *
 * Render 569's worker printed both of these about the same variable:
 *
 *     [Preflight]   OFF      ENABLE_YOUTUBE_SOURCING
 *     [Fastvid] YouTube clip sourcing: enabled youtube=ready
 *
 * Six times each, six boots apart. Both readings were internally correct:
 * `youtubeSourcingEnabled()` goes through `envFlagIsOn`, which trims and lowercases, while the
 * preflight's route table did a bare `(env[flag] ?? "") === "true"`. A variable set to `TRUE`, or
 * with a trailing space, is ON for the pipeline and OFF in the report describing the pipeline.
 *
 * RONDE 18 had already learned this and its note still sits on `envFlagIsOn`: "a Railway variable
 * set to `TRUE` or ` true ` must read the same as `true`; otherwise a stray capital silently
 * disables a whole source." The pipeline's reader was fixed then. The preflight kept its own — and
 * the preflight is the one place an operator looks to find out what their deployment will do, so
 * it is the worst possible place to answer differently from the code.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That there is ONE reader, that it is tolerant in the way RONDE 18 specified, and that it is not
 * so tolerant that a variable nobody set reads as on.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { envFlagIsNotOff, envFlagIsOn } from "./envFlag";
import { checkHost, productionPreflight, type HostProbes } from "./productionPreflight";

const probes: HostProbes = {
  hasBinary: () => true,
  hasBrowser: () => true,
  canReachDatabase: async () => true,
  canReachRedis: async () => true,
  canLoadVisionModel: async () => true,
};

const routeState = async (value: string) =>
  (await productionPreflight(probes, { DATABASE_URL: "mysql://h/d", ENABLE_YOUTUBE_SOURCING: value }))
    .routes.find((r) => r.flag === "ENABLE_YOUTUBE_SOURCING")!.on;

describe("the spellings render 569 could have been set to", () => {
  it.each(["true", "TRUE", "True", " true ", "true\n", "\tTRUE"])(
    "%j reads as on",
    (value) => {
      expect(envFlagIsOn("F", { F: value })).toBe(true);
    }
  );

  /** Tolerance has a floor: a value nobody set, or set to something else, is not on. */
  it.each(["", " ", "false", "FALSE", "1", "yes", "on", "truthy", "no"])(
    "%j reads as off",
    (value) => {
      expect(envFlagIsOn("F", { F: value })).toBe(false);
    }
  );

  it("an unset variable is off", () => {
    expect(envFlagIsOn("F", {})).toBe(false);
  });

  /** The opt-out flag is the mirror image, and equally tolerant about the word it looks for. */
  it.each(["false", "FALSE", " false "])("%j turns an opt-out flag off", (value) => {
    expect(envFlagIsNotOff("F", { F: value })).toBe(false);
  });

  it("an unset opt-out flag stays on", () => {
    expect(envFlagIsNotOff("F", {})).toBe(true);
  });
});

describe("the preflight answers what the pipeline would do", () => {
  it.each(["true", "TRUE", " true "])(
    "reports the route ON for %j, as the pipeline does",
    async (value) => {
      expect(await routeState(value), "render 569 printed OFF for exactly this").toBe(true);
    }
  );

  it.each(["false", "", "1"])("reports the route OFF for %j", async (value) => {
    expect(await routeState(value)).toBe(false);
  });

  /** The two readers are one reader — asserted directly, not inferred from matching behaviour. */
  it("the preflight uses envFlagIsOn rather than its own comparison", () => {
    const src = fs.readFileSync(path.join(__dirname, "productionPreflight.ts"), "utf8");
    const at = src.indexOf("const routes = ROUTE_FLAGS.map(");
    const line = src.slice(at, src.indexOf("\n", at));
    expect(line).toContain("envFlagIsOn(flag, env)");
    expect(line, "the bare comparison is what disagreed with the pipeline").not.toContain('=== "true"');
  });

  /**
   * `sourcingPolicy` reaches `@shared/videoLengths`, and `productionPreflightCli` runs from an
   * arbitrary working directory where that alias does not resolve. So the shared reader has to be
   * import-free, and this test is what stops a later edit from quietly giving it a dependency and
   * breaking the CLI in a way only a foreign cwd reveals.
   */
  it("the shared reader imports nothing", () => {
    const src = fs.readFileSync(path.join(__dirname, "envFlag.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  /** And `sourcingPolicy` keeps exporting it, so its ten existing callers are untouched. */
  it("sourcingPolicy still exports the same two functions", () => {
    const src = fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(src).toContain('export { envFlagIsOn, envFlagIsNotOff } from "./envFlag";');
  });
});

describe("the host checks are unaffected", () => {
  /** A flag reader change must not move anything else in the report. */
  it("still reports the same host entries", async () => {
    const ids = (await checkHost(probes, { DATABASE_URL: "mysql://h/d" })).map((h) => h.id);
    expect(ids).toContain("clip_vision");
    expect(ids).toContain("chrome_headless_shell");
    expect(ids).toContain("clip_model_cache");
  });
});
