/**
 * The worker heartbeat must not lie.
 *
 * ── The production false alarm this comes from ──────────────────────────────────────────────
 *
 * A Railway log showed, for twenty-five minutes:
 *
 *     [WorkerHeartbeat] downloadAndTrim s0b1 src=loc (1506s) | … s1b6 (1466s) | … s1b7 (1437s)
 *
 * Three downloads apparently hung. They were not: the same log carried
 * `[Hang] composeSceneVideo EXIT s0` and a finished `[VisualCoverageFinal]` report. The render had
 * moved on long before. The heartbeat was reporting work that had already ended.
 *
 * Two defects produced it, and they point in opposite directions:
 *
 *   · LEAKED LABELS. `downloadAndTrimPoolCandidate` set one label on entry and had eight
 *     `return null` refusal paths that never removed it. A candidate rejected for its content type,
 *     its HTTP status or its duration left its label behind for the life of the worker.
 *
 *   · GLOBAL CLEARS. Every clear in that function — and four more inside `composeSceneVideoInner`
 *     — called `clearWorkerHeartbeat()` with no argument, whose documented behaviour is to clear
 *     EVERY active label. So one download finishing erased the evidence of every other download
 *     still running.
 *
 * Together they make the heartbeat unreadable in both directions: phantom hangs that never
 * happened, and real hangs that vanish when a neighbour finishes. That is worse than no diagnostic
 * at all, because it sends the reader somewhere else entirely — and it did.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * The no-argument form still clears everything. It is the documented legacy behaviour and the
 * render-teardown path may want it; the fix is that no per-item worker uses it any more.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { clearWorkerHeartbeat, getWorkerHeartbeat, setWorkerHeartbeat } from "./videoPipeline";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The same source with comments removed.
 *
 * The comments in `videoPipeline.ts` quote the old `clearWorkerHeartbeat()` form to explain the
 * defect, which is exactly what these tests search for — so every count below is taken from
 * executable code only.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/* ═══════════════════════ the API itself ═══════════════════════ */

describe("heartbeat — a labelled clear removes one label and no others", () => {
  it("clears only its own label", () => {
    clearWorkerHeartbeat();
    setWorkerHeartbeat("downloadAndTrim s0b1 src=loc");
    setWorkerHeartbeat("downloadAndTrim s1b6 src=loc");
    clearWorkerHeartbeat("downloadAndTrim s0b1 src=loc");

    const state = getWorkerHeartbeat();
    expect(state, "the neighbour's label was erased too").toContain("s1b6");
    expect(state, "its own label survived its clear").not.toContain("s0b1");
    clearWorkerHeartbeat();
  });

  /** The legacy form is unchanged — the fix is that no per-item worker calls it. */
  it("the no-argument form still clears everything", () => {
    clearWorkerHeartbeat();
    setWorkerHeartbeat("a");
    setWorkerHeartbeat("b");
    clearWorkerHeartbeat();
    expect(getWorkerHeartbeat()).toBe("idle");
  });

  it("reports idle when nothing is running, rather than an empty line", () => {
    clearWorkerHeartbeat();
    expect(getWorkerHeartbeat()).toBe("idle");
  });
});

/* ═══════════════════════ nobody clears everyone else's work ═══════════════════════ */

describe("heartbeat — no per-item worker wipes the whole board", () => {
  /**
   * The invariant, checked on the source because it is a property of every call site rather than
   * of one function. A single `clearWorkerHeartbeat()` anywhere in the render path re-introduces
   * the defect for every concurrent download at once.
   */
  it("videoPipeline.ts contains no unlabelled clear", () => {
    const bare = [...CODE.matchAll(/clearWorkerHeartbeat\(\s*\)/g)];
    expect(
      bare.length,
      `${bare.length} unlabelled clearWorkerHeartbeat() call(s) — each one erases every other ` +
        "in-flight label, which is what made a finished download look like a 25-minute hang"
    ).toBe(0);
  });
});

/* ═══════════════════════ every label that is set is removed ═══════════════════════ */

describe("heartbeat — a label set on entry is removed on every exit", () => {
  /**
   * Checked per function rather than globally: the failure was not "a clear is missing somewhere"
   * but "this function has eight returns and clears on three of them". A `finally` is the only
   * construct a future branch cannot forget, so that is what is required here.
   */
  const SETTERS = [
    { fn: "downloadAndTrimPoolCandidate", end: "/** Stable stock trim" },
    { fn: "composeSceneVideo", end: "async function composeSceneVideoInner" },
  ] as const;

  for (const { fn, end } of SETTERS) {
    it(`${fn} removes its label in a finally`, () => {
      const start = SRC.indexOf(`function ${fn}(`);
      expect(start, `${fn} has moved`).toBeGreaterThan(-1);
      const stop = SRC.indexOf(end, start);
      const body = SRC.slice(start, stop > start ? stop : undefined);

      expect(body, `${fn} no longer names its own heartbeat label`).toContain("heartbeatLabel");
      expect(body, `${fn} sets a label it may not remove`).toMatch(
        /finally\s*\{[\s\S]{0,400}clearWorkerHeartbeat\(heartbeatLabel\)/
      );
    });
  }

  /**
   * The refusal paths specifically. `downloadAndTrimPoolCandidate` rejects candidates far more
   * often than it accepts them, so a leak on the refusal path leaks on almost every candidate —
   * which is why the log filled with labels for work that had finished.
   */
  it("the pool downloader still has the refusal paths that used to leak", () => {
    const start = CODE.indexOf("function downloadAndTrimPoolCandidate(");
    const body = CODE.slice(start, CODE.indexOf("async function trimDownloadedStockClip(", start));
    const refusals = [...body.matchAll(/\n\s*return null;/g)].length;
    expect(refusals, "the refusal paths are gone — this test is measuring the wrong function")
      .toBeGreaterThanOrEqual(5);
    /** And exactly one place removes the label, so no branch can drift out of step. */
    expect([...body.matchAll(/clearWorkerHeartbeat\(/g)]).toHaveLength(1);
  });
});
