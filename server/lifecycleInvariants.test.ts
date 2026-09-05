/**
 * ONE TERMINAL STATUS PER ASSET, AND THE SIX INVARIANTS THAT SAY IT IS HONEST.
 *
 * ── Why the "does not fire" cases outnumber the "fires" cases here ──────────────────────────
 *
 * Most of these paths are healthy. ADOPTED → PUSH_REFUSED is a picture editor doing its job.
 * ADOPTED → CINEMATIC_DROPPED(reason) is the planner doing its job. A failed download never
 * reaches the renderer and never should. An invariant that fires on those is worse than no
 * invariant: it teaches the reader to scroll past the line that finally matters — which is exactly
 * how VID-0567's real finding sat unread among 42 lineage warnings.
 *
 * So every healthy path below is a test, and they are the majority on purpose.
 */
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  lifecyclesOf,
  formatLifecycleInvariants,
  type AssetLifecycle,
} from "./visualSourceLineage";

const HEALTHY = { renderSucceeded: true, deliveryHappened: true };

function ledger() {
  return new VisualSourceLedger({ renderId: "r1", videoId: 567 });
}

function candidate(l: VisualSourceLedger, id = "yt1", beat = 0) {
  return l.createLineage({
    sceneIndex: 0,
    beatIndex: beat,
    candidateId: `youtube_cc:${id}`,
    contentKey: `youtube_cc:${id}`,
    provider: "youtube_cc",
    providerAssetId: id,
    localPath: `/w/${id}.mp4`,
    mediaType: "video",
    route: "primary",
  });
}

const only = (l: VisualSourceLedger): AssetLifecycle =>
  lifecyclesOf(l.allRecords(), l.allEvents())[0]!;
const errors = (l: VisualSourceLedger, opts = HEALTHY) =>
  formatLifecycleInvariants(lifecyclesOf(l.allRecords(), l.allEvents()), opts);

/* ═══════════════ terminal status ═══════════════ */

describe("every asset gets one terminal status", () => {
  it("in the film", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(r.lineageId, "FINAL_VIDEO", { status: "OK" });
    expect(only(l).terminalStatus).toBe("FINAL");
  });

  it("refused at the push", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    l.recordRejection("/w/yt1.mp4", "off_subject", "youtube_cc:yt1");
    const a = only(l);
    expect(a.terminalStatus).toBe("DROPPED_AT_PUSH");
    expect(a.terminalReason).toBe("off_subject");
  });

  it("refused by the planner", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(r.lineageId, "CINEMATIC_DROPPED", {
      status: "REJECTED", reason: "NOT_REHYDRATABLE",
    });
    const a = only(l);
    expect(a.terminalStatus).toBe("DROPPED_AT_CINEMATIC");
    expect(a.terminalReason).toBe("NOT_REHYDRATABLE");
  });

  it("lost at download", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "DOWNLOAD_STARTED", { status: "OK" });
    l.recordEvent(r.lineageId, "DOWNLOAD_FAILED", { status: "FAILED", reason: "timeout" });
    expect(only(l).terminalStatus).toBe("DROPPED_AT_DOWNLOAD");
  });

  it("handed to the renderer", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(r.lineageId, "RENDER_INPUT", { status: "OK" });
    expect(only(l).terminalStatus).toBe("DELIVERED_INPUT");
  });

  it("never chosen at all", () => {
    const l = ledger();
    candidate(l);
    expect(only(l).terminalStatus).toBe("NEVER_SELECTED");
  });

  /** §14/§15 — being handed to ffmpeg is not proof of being on screen. */
  it("never claims the output was verified", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "FINAL_VIDEO", { status: "OK" });
    expect(only(l).finalOutputVerified).toBe("UNKNOWN");
  });

  /** A transformed child is the same asset, not a second row. */
  it("folds a derivation chain into one row", () => {
    const l = ledger();
    candidate(l);
    l.linkDerivedPath("/w/yt1_transformed.mp4", "/w/yt1.mp4", "TRANSFORMED");
    expect(lifecyclesOf(l.allRecords(), l.allEvents())).toHaveLength(1);
  });
});

/* ═══════════════ the invariants fire ═══════════════ */

describe("the six invariants catch what they are for", () => {
  it("A — adopted, never reached the planner, nothing says why", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    expect(errors(l).join("\n")).toContain("ADOPTED_ASSET_MISSING_CINEMATIC_TERMINAL_EVENT");
  });

  it("B — kept and refused at once", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
    l.recordEvent(r.lineageId, "CINEMATIC_DROPPED", { status: "REJECTED", reason: "x" });
    expect(errors(l).join("\n")).toContain("CINEMATIC_SELECTED_AND_DROPPED");
  });

  it("C — kept by the planner, never handed to the renderer", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
    expect(errors(l).join("\n")).toContain("CINEMATIC_SELECTED_WITHOUT_RENDER_INPUT");
  });

  it("D — handed to a render that succeeded, absent from its output", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
    l.recordEvent(r.lineageId, "RENDER_INPUT", { status: "OK" });
    expect(errors(l).join("\n")).toContain("RENDER_INPUT_WITHOUT_OUTPUT");
  });

  it("E — rendered output of a render that never delivered", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "DELIVERED", { status: "OK" });
    const out = errors(l, { renderSucceeded: true, deliveryHappened: false }).join("\n");
    expect(out).toContain("RENDER_OUTPUT_WITHOUT_DELIVERY");
  });

  it("F — in the film and dropped at the same time", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "CINEMATIC_DROPPED", { status: "REJECTED", reason: "x" });
    l.recordEvent(r.lineageId, "FINAL_VIDEO", { status: "OK" });
    expect(errors(l).join("\n")).toContain("FINAL_ASSET_ALSO_MARKED_DROPPED");
  });

  /** Named by identity, so the finding can be chased. */
  it("names the asset by provider and id", () => {
    const l = ledger();
    const r = candidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    const [line] = errors(l);
    expect(line).toContain("asset=youtube_cc:yt1");
    expect(line).toContain("scene=0 beat=0");
  });
});

/* ═══════════════ and stay quiet on healthy renders ═══════════════ */

describe("no false positives", () => {
  const silent = (build: (l: VisualSourceLedger) => void, opts = HEALTHY) => {
    const l = ledger();
    build(l);
    expect(errors(l, opts), errors(l, opts).join("\n")).toEqual([]);
  };

  it("adopted then refused at the push is healthy", () => {
    silent((l) => {
      const r = candidate(l);
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
      l.recordRejection("/w/yt1.mp4", "off_subject", "youtube_cc:yt1");
    });
  });

  it("adopted then dropped by the planner is healthy", () => {
    silent((l) => {
      const r = candidate(l);
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
      l.recordEvent(r.lineageId, "CINEMATIC_DROPPED", { status: "REJECTED", reason: "DUPLICATE" });
    });
  });

  it("a failed download never has to reach the renderer", () => {
    silent((l) => {
      const r = candidate(l);
      l.recordEvent(r.lineageId, "DOWNLOAD_STARTED", { status: "OK" });
      l.recordEvent(r.lineageId, "DOWNLOAD_FAILED", { status: "FAILED", reason: "http_403" });
    });
  });

  it("a candidate nobody selected never has to reach anything", () => {
    silent((l) => void candidate(l));
  });

  it("a replaced asset is explained", () => {
    silent((l) => {
      const r = candidate(l);
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
      l.recordEvent(r.lineageId, "REPLACED", { status: "REPLACED", reason: "scene_resourced" });
    });
  });

  /** The complete happy path must be silent, or the invariant is worthless. */
  it("the full successful lifecycle is silent", () => {
    silent((l) => {
      const r = candidate(l);
      l.recordEvent(r.lineageId, "SELECTED", { status: "OK" });
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
      l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
      l.recordEvent(r.lineageId, "RENDER_INPUT", { status: "OK" });
      l.recordEvent(r.lineageId, "DELIVERED", { status: "OK" });
      l.recordEvent(r.lineageId, "FINAL_VIDEO", { status: "OK" });
    });
  });

  /**
   * A RENDER THAT FAILED IS NOT A LINEAGE DEFECT.
   *
   * Invariants C and D would otherwise fire on every timeout and every cancellation, which is how
   * an alarm stops being read.
   */
  it("a failed render does not make its inputs into errors", () => {
    silent(
      (l) => {
        const r = candidate(l);
        l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
        l.recordEvent(r.lineageId, "CINEMATIC_SELECTED", { status: "OK" });
        l.recordEvent(r.lineageId, "RENDER_INPUT", { status: "OK" });
      },
      { renderSucceeded: false, deliveryHappened: false }
    );
  });
});
