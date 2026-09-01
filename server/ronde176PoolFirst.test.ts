/**
 * RONDE 176 — the cinematic route is POOL-FIRST, and the cascade is only ever a fallback.
 *
 * ── What was audited, and what was actually found ────────────────────────────────────────────
 *
 * The worry R176 raises is that the pool could rank a winner and the old first-hit-wins cascade
 * could then overwrite that choice — which would make the whole ranking decorative.
 *
 * Reading the route, that is NOT what happens. The cascade is reached only when every pool
 * candidate failed to DOWNLOAD, never because the ranking preferred something else. So this round
 * did not change the control flow; it changed what the log says about it, and these tests pin the
 * structure so a future edit cannot quietly reintroduce the overwrite.
 *
 * ── Why these are structural assertions ──────────────────────────────────────────────────────
 *
 * The beat loop they guard lives inside a 39k-line function that needs a workDir, a network, a
 * budget and a database to call. What matters is the SHAPE — that the fallback is inside the
 * failure branch and not after the success branch — and the shape is what is checked. The
 * behaviour of the pieces themselves is covered by the pool and ranking suites.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

import { formatFallback } from "./renderCorrelation";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");

/** The beat's retrieval branch: pool attempt through to the end of its fallback. */
function retrievalBranch(): string {
  const start = SRC.indexOf("} else if (scenePool && scenePool.candidates.length > 0) {");
  expect(start, "the pool branch is gone — the route no longer tries the pool at all").toBeGreaterThan(-1);
  const end = SRC.indexOf("    } catch (err) {", start);
  return SRC.slice(start, end);
}

describe("R176 — the pool decides, and the cascade only runs when it could not deliver", () => {
  /**
   * The structural claim. `resolveBeatClip` is the cascade; it must appear only AFTER a
   * `if (poolClip)` success branch, never in place of it.
   */
  it("the cascade sits in the failure branch, after the pool's success branch", () => {
    const branch = retrievalBranch();
    const success = branch.indexOf("if (poolClip) {");
    const fallback = branch.indexOf("resolveBeatClip(");
    expect(success, "the pool's success branch is gone").toBeGreaterThan(-1);
    expect(fallback, "the cascade is gone from the fallback").toBeGreaterThan(-1);
    expect(fallback, "the cascade runs before the pool's result is even examined").toBeGreaterThan(success);
  });

  /** A downloaded pool clip is USED — nothing after it may replace the choice. */
  it("a successful pool candidate is adopted rather than re-decided", () => {
    const branch = retrievalBranch();
    const success = branch.indexOf("if (poolClip) {");
    const elseAt = branch.indexOf("} else {", success);
    const successBlock = branch.slice(success, elseAt);
    expect(successBlock).toContain("clip = poolClip");
    /** The cascade must not appear inside the branch that already has a clip. */
    expect(successBlock, "the cascade runs even when the pool succeeded").not.toContain("resolveBeatClip(");
  });

  /**
   * The fallback is entered on a DOWNLOAD failure, which is the only honest reason to leave a
   * ranked winner behind. If this ever becomes a score comparison, the ranking has been overruled.
   */
  it("the fallback is reached by download failure, not by a score comparison", () => {
    const branch = retrievalBranch();
    const fallbackBlock = branch.slice(branch.indexOf("} else {", branch.indexOf("if (poolClip) {")));
    expect(fallbackBlock).toContain("POOL_EMPTY");
    expect(fallbackBlock).toContain("CASCADE_FALLBACK");
    /** No re-ranking, no threshold, no second opinion about which candidate was better. */
    expect(fallbackBlock).not.toMatch(/rankingScore\s*[<>]/);
    expect(fallbackBlock).not.toMatch(/score\s*[<>]=?\s*\d/);
  });

  it("names which of the two failures happened, rather than one blurred message", () => {
    const branch = retrievalBranch();
    /** "The pool found nothing" and "nothing the pool found could be fetched" are different bugs. */
    expect(branch).toContain("POOL_EMPTY: the pool produced no candidate");
    expect(branch).toContain("pool candidate(s) failed to download");
  });

  it("the fallback log carries the render's correlation id", () => {
    expect(retrievalBranch()).toContain("renderId:");
  });
});

/* ═══════════════════════ the line itself ═══════════════════════ */

describe("R176 — the fallback line answers which case it was", () => {
  it("an empty pool is reported as POOL_EMPTY", () => {
    const line = formatFallback({
      renderId: "r1",
      what: "retrieval s0b1",
      from: "pool",
      to: "cascade",
      why: "POOL_EMPTY: the pool produced no candidate for this beat",
    });
    expect(line).toContain("from=pool");
    expect(line).toContain("to=cascade");
    expect(line).toContain("POOL_EMPTY");
  });

  it("candidates that could not be fetched are reported as CASCADE_FALLBACK", () => {
    const line = formatFallback({
      renderId: "r1",
      what: "retrieval s0b1",
      from: "pool",
      to: "cascade",
      why: "CASCADE_FALLBACK: all 3 pool candidate(s) failed to download — 403 | timeout | 404",
    });
    expect(line).toContain("CASCADE_FALLBACK");
    expect(line).toContain("3 pool candidate");
  });

  /** RULE 9's shape holds here too: why, from and to are all present. */
  it("always carries why, from and to", () => {
    const line = formatFallback({
      renderId: "r1", what: "retrieval s0b1", from: "pool", to: "cascade", why: "POOL_EMPTY",
    });
    for (const part of ["why=", "from=", "to="]) expect(line).toContain(part);
  });
});
