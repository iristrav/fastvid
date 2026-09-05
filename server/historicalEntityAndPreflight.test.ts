/**
 * RONDE 95 FINAL — the two things standing between this code and a controlled production render.
 *
 * ── Why these two, together ─────────────────────────────────────────────────────────────────
 *
 * Both are cases where the behaviour is already correct and nothing was holding it in place.
 *
 * §3 (historical entities) was fixed in RONDE 88A P1/P2, by folding the search text instead of
 * stripping it to ASCII. `searchTextIsFolded.test.ts` covers the MECHANISM — that a builder folds,
 * that no builder splits on an ASCII class. What it does not do is name the case that produced the
 * round: `Führerbunker` becoming `hrebunker` and being searched for. Measured before writing this,
 * against the real validator, so these are records of behaviour rather than hopes about it.
 *
 * §29 (preflight) is the reverse: `productionPreflight` was built in RONDE 191 and extended in
 * RONDE 205, and had exactly ONE caller — a CLI somebody has to remember to run. The environment
 * that actually renders never checked itself. And the check that matters most after RONDE 94 —
 * whether the picture editor loads at all — was not among the probes, because before RONDE 94 a
 * missing CLIP model made a render worse rather than impossible.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { emptyQueryContext, validateSearchQuery } from "./searchQueryContract";
import { foldSearchText } from "./searchTextNormalize";

const WORKER = fs.readFileSync(path.join(__dirname, "worker.ts"), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(__dirname, "productionPreflight.ts"), "utf8");

/* ═══════════════ §3 — the entity that named the problem ═══════════════ */

describe("a historical German name survives the query engine intact", () => {
  /** The sentence the round's whole entity investigation came from. */
  const script = "In April 1945 Hitler retreated to the Führerbunker beneath Berlin.";
  const ctx = () => emptyQueryContext(script, "Second World War");

  it("accepts the accented spelling the script actually uses", () => {
    expect(validateSearchQuery("Führerbunker Berlin 1945", ctx()).ok).toBe(true);
  });

  /** A provider that cannot take diacritics gets the folded spelling, still proven by the script. */
  it("accepts the folded spelling, proven by the same accented script", () => {
    expect(validateSearchQuery("fuhrerbunker Berlin 1945", ctx()).ok).toBe(true);
    expect(validateSearchQuery("Fuhrerbunker", ctx()).ok).toBe(true);
  });

  /**
   * THE DEFECT ITSELF. `hrebunker` is what ASCII-stripping `Führerbunker` produced — the `Füh`
   * dropped, the rest kept, and the fragment searched for as though it were a place. It is a real
   * word-shaped string, so the content-anchor rule cannot catch it; what catches it is that the
   * script does not contain it.
   */
  it("refuses the ASCII-truncation artefact by name", () => {
    const verdict = validateSearchQuery("hrebunker Berlin", ctx());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("UNVERIFIED_TERM");
    expect(verdict.ok === false && verdict.offendingTerm).toBe("hrebunker");
  });

  /** And every other way of cutting the word up is refused for the same reason. */
  it.each(["fuhrer bunker Berlin", "bunker fuhrerbun Berlin", "Fhrerbunker Berlin"])(
    "refuses the fragment %j",
    (query) => {
      expect(validateSearchQuery(query, ctx()).ok).toBe(false);
    }
  );

  it("keeps the historical period the script states", () => {
    expect(validateSearchQuery("Berlin April 1945", ctx()).ok).toBe(true);
  });

  /** A period the script never states is not smuggled in beside one it does. */
  it("refuses a period the script does not state", () => {
    expect(validateSearchQuery("Berlin April 1943", ctx()).ok).toBe(false);
  });

  /**
   * Folding is for MATCHING. The accented form is what a person reads, and it must survive — a
   * folding step that rewrote the script's own text would fix the search and break the screen.
   */
  it("folds for matching without altering the text itself", () => {
    expect(foldSearchText("Führerbunker")).toBe("fuhrerbunker");
    expect(foldSearchText("Führerbunker")).not.toContain("ü");
    expect(script).toContain("Führerbunker");
  });

  it("folds the other diacritics a European archive actually returns", () => {
    expect(foldSearchText("Wehrmacht Straße")).toContain("strasse");
    expect(foldSearchText("Ardennes Forêt")).toContain("foret");
    expect(foldSearchText("Łódź")).toBe(foldSearchText("Lodz"));
  });

  /** Camera vocabulary may sit beside a real historical subject; it may not replace it. */
  it("still refuses camera vocabulary with no subject, in this context too", () => {
    expect(validateSearchQuery("documentary Führerbunker", ctx()).ok).toBe(true);
    const bare = validateSearchQuery("documentary wide establishing aerial", ctx());
    expect(bare.ok).toBe(false);
    expect(bare.ok === false && bare.reason).toBe("NO_CONTENT_ANCHOR");
  });
});

/* ═══════════════ §29 — the preflight runs where the renders run ═══════════════ */

describe("the environment that renders checks itself before it renders", () => {
  /**
   * THE GAP. `productionPreflight` existed for four rounds with one caller: a CLI. A worker booted,
   * picked up a job, and discovered a missing dependency by failing at it.
   */
  it("the worker runs the preflight at boot", () => {
    expect(WORKER).toContain('await import("./productionPreflight")');
    expect(WORKER).toContain("productionPreflight({");
    expect(WORKER).toContain("formatPreflight(report)");
  });

  /** A BLOCKED verdict is stated in words an operator can act on, not buried in a report body. */
  it("says plainly when a render started now cannot ship", () => {
    expect(WORKER).toContain("PRODUCTION_RENDER_BLOCKED");
    expect(WORKER).toContain("cannot produce a ");
    expect(WORKER).toContain("report.blockers.join");
  });

  /** The verdict reaches the heartbeat, so it is visible without reading boot logs. */
  it("records the verdict where the operator already looks", () => {
    expect(WORKER).toContain("preflight=${report.verdict}");
  });

  /**
   * A preflight is a diagnostic. If it throws — a probe times out, a dynamic import fails — the
   * worker must still start; a check that can prevent a boot is worse than the gap it closes.
   */
  it("cannot itself stop the worker from starting", () => {
    const at = WORKER.indexOf('await import("./productionPreflight")');
    const region = WORKER.slice(Math.max(0, at - 2500), at + 3000);
    expect(region).toContain("[Preflight] could not run at boot");
    expect(region).toContain("} catch (err) {");
    const start = WORKER.indexOf("startVideoQueueWorker();");
    expect(start, "the queue must start after the preflight, not instead of it").toBeGreaterThan(at);
  });

  /**
   * Placed after the CLIP warm-up on purpose: the vision probe loads the model and the warm-up has
   * just loaded it, so the check is free here and would cost a cold load anywhere earlier.
   */
  it("reuses the warm-up rather than paying for a second model load", () => {
    expect(WORKER.indexOf("warmUpLocalClipVision()")).toBeLessThan(
      WORKER.indexOf('await import("./productionPreflight")')
    );
  });

  /** The probe LOADS the model. Reading a variable would answer a different question. */
  it("the vision probe is a load, not a lookup", () => {
    expect(PREFLIGHT).toContain("canLoadVisionModel: () => Promise<boolean>");
    expect(WORKER).toContain("canLoadVisionModel: async () => ensureClipPipelinesLoaded()");
    const CLI = fs.readFileSync(path.join(__dirname, "productionPreflightCli.ts"), "utf8");
    expect(CLI).toContain("ensureClipPipelinesLoaded");
  });

  /**
   * The verdict follows the configuration. With RONDE 94's gate enforced a render without CLIP is
   * guaranteed to be refused at export, so it blocks; with enforcement explicitly off the same
   * render ships unverified footage, which is a worse film rather than an impossible one.
   */
  it("the fatality of a missing model is decided by the adoption gate, not by opinion", () => {
    const at = PREFLIGHT.indexOf('h.id === "clip_vision"');
    expect(at).toBeGreaterThan(-1);
    const block = PREFLIGHT.slice(at, at + 900);
    expect(block).toContain("ENFORCE_FUNNEL_ADOPTION");
    expect(block).toContain("enforced ? blockers : degradations");
  });
});
