/**
 * RONDE 95 — the asset lifecycle, finished.
 *
 * The ledger has recorded FOUND through FINAL_VIDEO since RONDE 86, but two things it declared
 * were never actually wired:
 *
 *   · REPLACED was a stage and a counted column that nothing in the pipeline ever recorded. Every
 *     fallback and heal swap was therefore invisible: asset A selected, asset B delivered, nothing
 *     joining them — which is exactly the silent substitution the round exists to catch.
 *   · searchRoute existed on the record but no downloader filled it in, so a clip could be traced
 *     back to the words it was found by and not to the call site that chose them.
 *
 * Both are wired now, and this file holds them there.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  ASSET_TRACE_STATUS,
  VisualSourceLedger,
  formatAssetUsageSummary,
  formatRenderManifest,
  formatSelectedButNotRendered,
  formatUsageInconsistencies,
} from "./visualSourceLineage";

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const LINEAGE_SRC = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");

/** A ledger with two real assets from two different providers, ready to be pushed through stages. */
function ledgerWithTwoAssets() {
  const ledger = new VisualSourceLedger({ renderId: "r95", videoId: 1 });
  const a = ledger.createLineage({
    sceneIndex: 7, beatIndex: 3, candidateId: "wikimedia:111", contentKey: "wikimedia:111",
    provider: "wikimedia", providerAssetId: "111", localPath: "/tmp/a.mp4",
    query: "Berlin Wall", searchRoute: "fetchWikimediaVideos", mediaType: "video",
  });
  const b = ledger.createLineage({
    sceneIndex: 7, beatIndex: 3, candidateId: "youtube:222", contentKey: "youtube:222",
    provider: "youtube", providerAssetId: "222", localPath: "/tmp/b.mp4",
    query: "Berlin 1989", searchRoute: "fetchYouTubeCCClips", mediaType: "video",
  });
  return { ledger, a, b };
}

/** Silence the [AssetTrace] lines recordEvent now emits, and return what was written. */
function captureLog<T>(fn: () => T): { result: T; lines: string[] } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = fn();
    return { result, lines: spy.mock.calls.map((c) => String(c[0])) };
  } finally {
    spy.mockRestore();
  }
}

/* ═══════════ §1 — replacement is recorded, once ═══════════ */

describe("RONDE 95 §1 — asset A → REPLACED → asset B", () => {
  it("TEST 1 — the replacement is a real lineage event on the original", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "compose_gate_failed"));
    const replaced = ledger.allEvents().filter((e) => e.stage === "REPLACED");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.lineageId).toBe(a.lineageId);
    expect(replaced[0]!.status).toBe("REPLACED");
    expect(replaced[0]!.reason).toContain("compose_gate_failed");
    expect(replaced[0]!.reason).toContain(b.lineageId);
  });

  it("TEST 2 — the trace line names both sides and the reason", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    const { lines } = captureLog(() =>
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "rescue_stock_clip")
    );
    const trace = lines.find((l) => l.includes("status=REPLACED"));
    expect(trace).toBeTruthy();
    expect(trace).toContain(`originalAssetId=${a.lineageId}`);
    expect(trace).toContain(`replacementAssetId=${b.lineageId}`);
    expect(trace).toContain("reason=rescue_stock_clip");
  });

  it("TEST 3 — asset B stays fully traceable after standing in for A", () => {
    const { ledger, b } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "swap");
      ledger.recordEvent(b.lineageId, "ADOPTED", { status: "OK" });
      ledger.recordEvent(b.lineageId, "COMPOSED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const record = ledger.resolve("/tmp/b.mp4")!;
    expect(record.provider).toBe("youtube");
    expect(record.searchRoute).toBe("fetchYouTubeCCClips");
    expect(record.adoptedAt).toBeGreaterThan(0);
    expect(record.finalVideoAt).toBeGreaterThan(0);
  });

  it("TEST 4 — a replaced asset is never counted as rendered", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" });
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "swap");
      // Only B goes into the concat.
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    expect(ledger.resolve("/tmp/a.mp4")!.finalVideoAt).toBeUndefined();
    expect(ledger.summary().byProvider.wikimedia!.finalVideo).toBe(0);
    expect(ledger.summary().byProvider.youtube!.finalVideo).toBe(1);
  });

  it("TEST 5 — an asset that is never replaced gets no REPLACED event", () => {
    const { ledger } = ledgerWithTwoAssets();
    captureLog(() => ledger.markFinalVideo(["/tmp/b.mp4"]));
    expect(ledger.allEvents().filter((e) => e.stage === "REPLACED")).toHaveLength(0);
    expect(ledger.summary().total.replaced).toBe(0);
  });

  it("TEST 6 — replacing an asset the ledger never saw is reported, not invented", () => {
    const { ledger } = ledgerWithTwoAssets();
    const { result } = captureLog(() =>
      ledger.recordReplacement("/tmp/never-seen.mp4", "/tmp/b.mp4", "swap")
    );
    expect(result).toBe(false);
    expect(ledger.allEvents().filter((e) => e.stage === "REPLACED")).toHaveLength(0);
  });

  it("TEST 7 — the compose path records each dropped clip exactly once", () => {
    // The guard is structural: one flag, checked before any of the three branches records.
    const idx = PIPELINE_SRC.indexOf("const settleDroppedClips =");
    expect(idx).toBeGreaterThan(-1);
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n  };", idx));
    expect(body).toContain("if (dropsRecorded || !lineage || droppedClips.length === 0) return;");
    expect(body).toContain("dropsRecorded = true;");
    // Three call sites — rescue clip, removal, guaranteed fill — and one flag between them.
    expect((PIPELINE_SRC.match(/settleDroppedClips\(/g) ?? []).length).toBe(3);
    for (const call of [
      'settleDroppedClips(rescueStockClip, "rescue_stock_clip")',
      'settleDroppedClips(null, "removed")',
      'settleDroppedClips(clip, "guaranteed_fill")',
    ]) {
      expect(PIPELINE_SRC, call).toContain(call);
    }
  });

  it("TEST 8 — a drop with no substitute is REMOVED, not REPLACED", () => {
    const idx = PIPELINE_SRC.indexOf("const settleDroppedClips =");
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n  };", idx));
    expect(body).toContain('lineage.recordEventForPath(dropped.path, "REMOVED"');
    expect(PIPELINE_SRC).toContain('if (validClips.length > 0) settleDroppedClips(null, "removed");');
  });
});

/* ═══════════ §2 — searchRoute survives the whole lifecycle ═══════════ */

describe("RONDE 95 §2 — provider and route travel together", () => {
  it("TEST 9 — the route is stored on the record", () => {
    const { ledger } = ledgerWithTwoAssets();
    expect(ledger.resolve("/tmp/a.mp4")!.searchRoute).toBe("fetchWikimediaVideos");
    expect(ledger.resolve("/tmp/b.mp4")!.searchRoute).toBe("fetchYouTubeCCClips");
  });

  it("TEST 10 — it survives every stage from FOUND to FINAL_VIDEO", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => {
      for (const stage of [
        "ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED",
        "ADOPTED", "TRANSFORMED", "COMPOSED",
      ] as const) {
        ledger.recordEvent(a.lineageId, stage, { status: "OK" });
      }
      ledger.markFinalVideo(["/tmp/a.mp4"]);
    });
    const record = ledger.resolve("/tmp/a.mp4")!;
    expect(record.searchRoute).toBe("fetchWikimediaVideos");
    expect(record.provider).toBe("wikimedia");
    expect(record.finalVideoAt).toBeGreaterThan(0);
  });

  it("TEST 11 — a derived path inherits the route rather than losing it", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => ledger.linkDerivedPath("/tmp/a_trimmed.mp4", "/tmp/a.mp4", "TRIMMED"));
    const derived = ledger.resolve("/tmp/a_trimmed.mp4");
    expect(derived).toBeTruthy();
    expect(derived!.searchRoute).toBe("fetchWikimediaVideos");
    expect(derived!.provider).toBe("wikimedia");
    expect(derived!.parentLineageId).toBe(a.lineageId);
  });

  it("TEST 12 — every provider downloader passes its own route, not a default", () => {
    for (const [fn, route] of [
      ["fetchWikimediaVideos", "fetchWikimediaVideos"],
      ["fetchFlickrCCVideos", "fetchFlickrCCVideos"],
      ["fetchSepiaSearchVideos", "fetchSepiaSearchVideos"],
      ["fetchGdeltTvNewsClips", "fetchGdeltTvNewsClips"],
      ["fetchEuropeanaVideos", "fetchEuropeanaVideos"],
      ["fetchVimeoCCVideos", "fetchVimeoCCVideos"],
      ["fetchMediaCccVideos", "fetchMediaCccVideos"],
      ["fetchNasaVideoClips", "fetchNasaVideoClips"],
      ["fetchNaraClips", "fetchNaraClips"],
      ["fetchInternetArchiveClips", "fetchInternetArchiveClips"],
      ["fetchYouTubeCCClips", "fetchYouTubeCCClips"],
    ] as const) {
      const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
      expect(idx, `${fn} missing`).toBeGreaterThan(-1);
      const body = PIPELINE_SRC.slice(idx, idx + 14000);
      expect(body, `${fn} does not pass its own searchRoute`).toContain(`searchRoute: "${route}"`);
    }
  });

  it("TEST 13 — the scene pool passes the source it actually searched", () => {
    const idx = PIPELINE_SRC.indexOf("function downloadAndTrimPoolCandidate(");
    const body = PIPELINE_SRC.slice(idx, idx + 3000);
    expect(body).toContain("searchRoute: `scenePool:${candidate.source}`");
  });

  it("TEST 14 — nothing falls back to the anonymous provider_search label", () => {
    const routes = PIPELINE_SRC.match(/searchRoute: "[a-zA-Z:_${}.]+"/g) ?? [];
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) expect(route).not.toContain("provider_search");
  });
});

/* ═══════════ §3 — render verification ═══════════ */

describe("RONDE 95 §3 — the manifest is the concat, not the intention", () => {
  it("TEST 15 — [RenderAsset] lists only what markFinalVideo proved", () => {
    const { ledger } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(ledger.resolve("/tmp/a.mp4")!.lineageId, "ADOPTED", { status: "OK" });
      ledger.recordEvent(ledger.resolve("/tmp/b.mp4")!.lineageId, "ADOPTED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const manifest = formatRenderManifest(ledger.allRecords(), ledger.finalVideoWasVerified);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toContain("provider=youtube");
    expect(manifest[0]).toContain("searchRoute=fetchYouTubeCCClips");
    expect(manifest[0]).toContain("rendered=true");
    expect(manifest.join(" ")).not.toContain("wikimedia");
  });

  it("TEST 16 — an unverified render produces no manifest at all", () => {
    const { ledger } = ledgerWithTwoAssets();
    expect(ledger.finalVideoWasVerified).toBe(false);
    expect(formatRenderManifest(ledger.allRecords(), ledger.finalVideoWasVerified)).toEqual([]);
  });

  it("TEST 17 — a selected asset that was replaced is reported with its reason", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" });
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "compose_gate_failed");
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const notRendered = formatSelectedButNotRendered(
      ledger.allRecords(), ledger.allEvents(), ledger.finalVideoWasVerified
    );
    expect(notRendered).toHaveLength(1);
    expect(notRendered[0]).toContain("outcome=REPLACED");
    expect(notRendered[0]).toContain("compose_gate_failed");
  });

  it("TEST 18 — a selected asset that vanished with no event is named as such", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const notRendered = formatSelectedButNotRendered(
      ledger.allRecords(), ledger.allEvents(), ledger.finalVideoWasVerified
    );
    expect(notRendered.some((l) => l.includes("outcome=DROPPED_WITHOUT_EVENT"))).toBe(true);
  });

  it("TEST 19 — a replacement never manufactures a FINAL_VIDEO event", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "swap"));
    // Neither side is in the final video: markFinalVideo was never called.
    expect(ledger.allEvents().filter((e) => e.stage === "FINAL_VIDEO")).toHaveLength(0);
    expect(ledger.resolve("/tmp/a.mp4")!.finalVideoAt).toBeUndefined();
    expect(ledger.resolve("/tmp/b.mp4")!.finalVideoAt).toBeUndefined();
  });

  it("TEST 20 — FINAL_VIDEO can only come from markFinalVideo's own path list", () => {
    const idx = PIPELINE_SRC.indexOf("const proven = ledger.markFinalVideo(deliveredClips);");
    expect(idx).toBeGreaterThan(-1);
    const before = PIPELINE_SRC.slice(Math.max(0, idx - 1200), idx);
    // deliveredClips is built from the scenes whose video was in finalConcatInputs. Nothing else.
    expect(before).toContain("const deliveredScenes = new Set(finalConcatInputs.filter(Boolean));");
    expect(before).toContain("if (!sceneVideo || !deliveredScenes.has(sceneVideo)) continue;");
    // And no other production call site marks it.
    expect((PIPELINE_SRC.match(/markFinalVideo\(/g) ?? []).length).toBe(1);
  });
});

/* ═══════════ §4 — the summary stays consistent through a replacement ═══════════ */

describe("RONDE 95 §4 — a swap does not corrupt the counts", () => {
  it("TEST 21 — found/selected/assigned/rendered follow the events exactly", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => {
      for (const id of [a.lineageId, b.lineageId]) {
        ledger.recordEvent(id, "ELIGIBLE", { status: "OK" });
        ledger.recordEvent(id, "SELECTED", { status: "OK" });
        ledger.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
      }
      ledger.recordEvent(b.lineageId, "ADOPTED", { status: "OK" });
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "swap");
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const summary = ledger.summary();
    const wiki = summary.byProvider.wikimedia!;
    const yt = summary.byProvider.youtube!;
    expect(wiki.selected).toBe(1);
    expect(wiki.adopted).toBe(0);
    expect(wiki.finalVideo).toBe(0);
    expect(wiki.replaced).toBe(1);
    expect(yt.adopted).toBe(1);
    expect(yt.finalVideo).toBe(1);
  });

  it("TEST 22 — the usage summary reports the same numbers the events hold", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => {
      for (const id of [a.lineageId, b.lineageId]) {
        ledger.recordEvent(id, "ELIGIBLE", { status: "OK" });
        ledger.recordEvent(id, "SELECTED", { status: "OK" });
        ledger.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
      }
      ledger.recordEvent(b.lineageId, "ADOPTED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const summary = ledger.summary();
    // countSearch is what supplies `results`; without it `found` is 0, which is honest — no search
    // was recorded in this fixture. The point is that the later stages match their events.
    const lines = formatAssetUsageSummary(summary, true);
    const yt = lines.find((l) => l.includes("provider=youtube"))!;
    expect(yt).toContain("validated=1");
    expect(yt).toContain("selected=1");
    expect(yt).toContain("downloaded=1");
    expect(yt).toContain("assigned=1");
    expect(yt).toContain("rendered=1");
  });

  it("TEST 23 — a replacement cannot make a funnel widen", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => {
      for (const id of [a.lineageId, b.lineageId]) {
        ledger.countSearch(id === a.lineageId ? "wikimedia" : "youtube", 1);
        ledger.recordEvent(id, "ELIGIBLE", { status: "OK" });
        ledger.recordEvent(id, "SELECTED", { status: "OK" });
        ledger.recordEvent(id, "DOWNLOAD_SUCCEEDED", { status: "OK" });
        ledger.recordEvent(id, "ADOPTED", { status: "OK" });
      }
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "swap");
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    expect(formatUsageInconsistencies(ledger.summary(), true)).toEqual([]);
  });
});

/* ═══════════ §4b — reconcile now names the lifecycle holes ═══════════ */

describe("RONDE 95 §4 — a stage without the one before it is a finding", () => {
  it("TEST 27 — adopted with no SELECTED is reported", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => ledger.recordEvent(a.lineageId, "ADOPTED", { status: "OK" }));
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).toContain("ADOPTED_WITHOUT_SELECTED");
  });

  it("TEST 28 — in the final video with no ADOPTED is reported", () => {
    const { ledger, b } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(b.lineageId, "SELECTED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).toContain("RENDERED_WITHOUT_ADOPTED");
  });

  it("TEST 29 — a chosen asset that vanished with no outcome is reported", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" });
      ledger.recordEvent(b.lineageId, "SELECTED", { status: "OK" });
      ledger.recordEvent(b.lineageId, "ADOPTED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const vanished = ledger.reconcile().warnings.filter((w) => w.code === "VANISHED_WITHOUT_OUTCOME");
    expect(vanished).toHaveLength(1);
    expect(vanished[0]!.lineageId).toBe(a.lineageId);
  });

  it("TEST 30 — a REPLACED asset is NOT reported as vanished", () => {
    const { ledger, a, b } = ledgerWithTwoAssets();
    captureLog(() => {
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" });
      ledger.recordEvent(b.lineageId, "SELECTED", { status: "OK" });
      ledger.recordEvent(b.lineageId, "ADOPTED", { status: "OK" });
      ledger.recordReplacement("/tmp/a.mp4", "/tmp/b.mp4", "compose_gate_failed");
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).not.toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("TEST 31 — nothing is reported before the render proved its final video", () => {
    const { ledger, a } = ledgerWithTwoAssets();
    captureLog(() => ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK" }));
    // "not in the final video" is not yet a fact.
    expect(ledger.finalVideoWasVerified).toBe(false);
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).not.toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("TEST 32 — a clean lifecycle reports no lifecycle warnings at all", () => {
    const { ledger, b } = ledgerWithTwoAssets();
    captureLog(() => {
      for (const stage of ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED",
        "DOWNLOAD_SUCCEEDED", "ADOPTED", "COMPOSED"] as const) {
        ledger.recordEvent(b.lineageId, stage, { status: "OK" });
      }
      ledger.recordEvent(ledger.resolve("/tmp/a.mp4")!.lineageId, "REMOVED", { status: "REMOVED" });
      ledger.markFinalVideo(["/tmp/b.mp4"]);
    });
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    for (const bad of ["ADOPTED_WITHOUT_SELECTED", "RENDERED_WITHOUT_ADOPTED", "VANISHED_WITHOUT_OUTCOME"]) {
      expect(codes, bad).not.toContain(bad);
    }
  });
});

/* ═══════════ §5 — one source of truth ═══════════ */

describe("RONDE 95 §5 — no parallel tracking system", () => {
  it("TEST 24 — the trace statuses come from lineage stages and nowhere else", () => {
    expect(Object.keys(ASSET_TRACE_STATUS).sort()).toEqual(
      ["ADOPTED", "COMPOSED", "DOWNLOAD_SUCCEEDED", "ELIGIBLE", "FINAL_VIDEO", "FOUND", "SELECTED"].sort()
    );
    // Emitted from inside recordEvent, so a status cannot be printed without its event.
    const idx = LINEAGE_SRC.indexOf("const trace = ASSET_TRACE_STATUS[stage];");
    expect(idx).toBeGreaterThan(-1);
    expect(LINEAGE_SRC.slice(idx, idx + 200)).toContain('event.status === "OK"');
  });

  it("TEST 25 — there is exactly one ledger class in server/", () => {
    let ledgers = 0;
    for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      ledgers += (src.match(/class \w*(Ledger|AssetTracker|ReplacementTracker|RenderTracker)\b/g) ?? []).length;
    }
    expect(ledgers).toBe(1);
  });

  it("TEST 26 — recordReplacement is the only way a REPLACED event is produced", () => {
    const emitters = LINEAGE_SRC.split("\n").filter(
      (l) => l.includes('"REPLACED"') && l.includes("recordEvent")
    );
    expect(emitters).toHaveLength(1);
    for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      if (file === "visualSourceLineage.ts") continue;
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, `${file} records REPLACED directly`).not.toMatch(/recordEvent\([^)]*"REPLACED"/);
    }
  });
});
