/**
 * ASSIGNED → COMPOSE, THE LAST SILENT GAP.
 *
 * ── Where this is instrumented, and why there ───────────────────────────────────────────────
 *
 * `composeSceneVideoInner` is forty pages long and drops clips in many places — a gate, a
 * duplicate, a decode failure, a rescue that rebuilds the list. Instrumenting each means finding
 * all of them and remembering the next one, which is the seam this codebase has split on fourteen
 * times.
 *
 * `returnComposed` is already documented in the source as "the one place every compose route
 * leaves through", and both sides of the question are in scope there: `clips` is exactly what
 * compose was handed, `pendingUsedClips` is exactly what it kept. The difference is what it
 * dropped — by construction, with nothing left to forget.
 *
 * ── Where the reason comes from ─────────────────────────────────────────────────────────────
 *
 * Not from the diff. A diff knows THAT a clip went, never WHY. The gates that refused it already
 * file terminal outcomes on the ledger, so a clip with an ending recorded keeps that ending and
 * its own reason; only a clip that left with nothing recorded gets `UNKNOWN`. That is the honest
 * answer and the one worth chasing in the next render. No reason is invented.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  lifecyclesOf,
  formatLifecycleInvariants,
} from "./visualSourceLineage";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const HEALTHY = { renderSucceeded: true, deliveryHappened: true };

function ledger() {
  return new VisualSourceLedger({ renderId: "r1", videoId: 568 });
}
function asset(l: VisualSourceLedger, id = "yt1") {
  const r = l.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: `youtube_cc:${id}`,
    contentKey: `youtube_cc:${id}`,
    provider: "youtube_cc",
    providerAssetId: id,
    localPath: `/w/${id}.mp4`,
    mediaType: "video",
    route: "primary",
  });
  l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
  return r;
}
const only = (l: VisualSourceLedger) => lifecyclesOf(l.allRecords(), l.allEvents())[0]!;
const errors = (l: VisualSourceLedger, o = HEALTHY) =>
  formatLifecycleInvariants(lifecyclesOf(l.allRecords(), l.allEvents()), o);

/* ═══════════════ the two compose endings ═══════════════ */

describe("compose gives every clip it was handed an ending", () => {
  it("a kept clip is COMPOSE_SELECTED and stays healthy", () => {
    const l = ledger();
    const r = asset(l);
    l.recordEvent(r.lineageId, "COMPOSE_INPUT", { status: "OK" });
    l.recordEvent(r.lineageId, "COMPOSE_SELECTED", { status: "OK" });
    l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
    l.recordEvent(r.lineageId, "RENDER_INPUT", { status: "OK" });
    l.recordEvent(r.lineageId, "FINAL_VIDEO", { status: "OK" });
    const a = only(l);
    expect(a.composeSelected).toBe(true);
    expect(a.terminalStatus).toBe("FINAL");
    expect(errors(l)).toEqual([]);
  });

  it("a dropped clip becomes DROPPED_AT_COMPOSE, not UNEXPLAINED", () => {
    const l = ledger();
    const r = asset(l);
    l.recordEvent(r.lineageId, "COMPOSE_INPUT", { status: "OK" });
    l.recordEvent(r.lineageId, "COMPOSE_DROPPED", { status: "REJECTED", reason: "UNKNOWN" });
    const a = only(l);
    expect(a.terminalStatus).toBe("DROPPED_AT_COMPOSE");
    expect(a.terminalReason).toBe("UNKNOWN");
    expect(errors(l)).toEqual([]);
  });

  /** The gap invariant G exists for: compose saw it and said nothing either way. */
  it("compose seeing a clip and deciding nothing breaks invariant G", () => {
    const l = ledger();
    const r = asset(l);
    l.recordEvent(r.lineageId, "COMPOSE_INPUT", { status: "OK" });
    expect(errors(l).join("\n")).toContain("ASSIGNED_ASSET_MISSING_COMPOSE_OUTCOME");
  });

  /**
   * An adopted clip that never reached compose is invariant A's case. Firing both on one asset
   * would double-report a single gap, which is how a report stops being read.
   */
  it("does not also fire G for an asset compose never saw", () => {
    const l = ledger();
    asset(l);
    const out = errors(l).join("\n");
    expect(out).toContain("ADOPTED_ASSET_MISSING_CINEMATIC_TERMINAL_EVENT");
    expect(out).not.toContain("ASSIGNED_ASSET_MISSING_COMPOSE_OUTCOME");
  });

  /** A compose drop is terminal, so the earlier rules stop asking about it too. */
  it("a compose drop silences the adopted-asset invariant", () => {
    const l = ledger();
    const r = asset(l);
    l.recordEvent(r.lineageId, "COMPOSE_INPUT", { status: "OK" });
    l.recordEvent(r.lineageId, "COMPOSE_DROPPED", { status: "REJECTED", reason: "DUPLICATE" });
    expect(errors(l)).toEqual([]);
  });

  /** A derivation chain is still one row, and compose events land on the root. */
  it("folds a transformed child into one lifecycle", () => {
    const l = ledger();
    asset(l);
    l.linkDerivedPath("/w/yt1_transformed.mp4", "/w/yt1.mp4", "TRANSFORMED");
    const child = l.resolve("/w/yt1_transformed.mp4")!;
    l.recordEvent(child.lineageId, "COMPOSE_INPUT", { status: "OK" });
    l.recordEvent(child.lineageId, "COMPOSE_SELECTED", { status: "OK" });
    const rows = lifecyclesOf(l.allRecords(), l.allEvents());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.composeSelected).toBe(true);
    expect(rows[0]!.provider).toBe("youtube_cc");
  });
});

/* ═══════════════ the instrumentation is at the single exit ═══════════════ */

describe("compose is instrumented at its one exit", () => {
  const exitBlock = () => {
    const at = PIPE.indexOf("const returnComposed = async (");
    expect(at, "the single compose exit is gone").toBeGreaterThan(-1);
    return PIPE.slice(at, at + 3500);
  };

  it("records input, kept and dropped from the same place", () => {
    const b = exitBlock();
    expect(b).toContain('"COMPOSE_INPUT"');
    expect(b).toContain('"COMPOSE_SELECTED"');
    expect(b).toContain('"COMPOSE_DROPPED"');
  });

  /** Input is the array compose was handed — not a candidate list or an audit. */
  it("reads the real input and the real kept list", () => {
    const b = exitBlock();
    expect(b).toContain("const kept = new Set(pendingUsedClips);");
    expect(b).toContain("for (const clipPath of clips)");
  });

  /** Identity through the ledger's own resolver, never a path or a position. */
  it("resolves identity canonically", () => {
    const b = exitBlock();
    expect(b).toContain("clipContentKey(clipPath)");
    expect(b).toContain("recordEventForPath(clipPath");
    expect(b).not.toMatch(/clips\[\s*i\s*\]/);
  });

  /**
   * A clip a gate already refused keeps that gate's reason. Overwriting it with UNKNOWN would
   * destroy the better answer the pipeline already had.
   */
  it("does not overwrite an ending another gate already recorded", () => {
    const b = exitBlock();
    expect(b).toContain("hasOutcomeFor(clipPath, contentKey)");
    expect(b.indexOf("hasOutcomeFor")).toBeLessThan(b.indexOf('"COMPOSE_DROPPED"'));
  });

  /** No invented reasons — UNKNOWN is the only one this site may write. */
  it("writes UNKNOWN rather than guessing", () => {
    const at = PIPE.indexOf('"COMPOSE_DROPPED"');
    expect(PIPE.slice(at, at + 200)).toContain('reason: "UNKNOWN"');
  });

  it("emits a per-scene compose summary", () => {
    expect(PIPE).toContain("[ComposeBeatSummary]");
    const at = PIPE.indexOf("[ComposeBeatSummary]");
    const line = PIPE.slice(at, at + 300);
    for (const f of ["composeInputs=", "composeSelected=", "composeDropped="]) {
      expect(line, `the summary has no ${f}`).toContain(f);
    }
  });

  /** A render without a ledger must not crash on the instrumentation. */
  it("is a no-op when the render carries no ledger", () => {
    const b = exitBlock();
    expect(b).toContain("composeOptions?.dedup?.sourcingCache?.lineage");
    expect(b).toContain("if (composeLedger) {");
  });
});
