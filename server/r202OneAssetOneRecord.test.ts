/**
 * RONDE 202 — THE OPEN FINDINGS FROM THE 566/567 POSTMORTEM, AS FAR AS CODE CAN TAKE THEM.
 *
 * That report closed with three findings marked "open" and one marked "not proven". Two of them
 * are answerable from the code alone; the third is not, and this file says so rather than guessing.
 *
 * ── §1 — one asset, two records (report finding 04) ─────────────────────────────────────────
 *
 * One YouTube clip passed the picture editor and never reached the film. It sat under two lineage
 * numbers that were each other's mirror image:
 *
 *     #18  reachedSelected=true   reachedAssigned=false  DROPPED_WITHOUT_EVENT
 *     #30  reachedSelected=false  reachedAssigned=true   DROPPED_WITHOUT_EVENT
 *
 * The report could not name the cause without a log covering the sourcing phase. The MECHANISM,
 * though, is in the ledger: `createLineage` opened a record on every call and then wrote
 * `byContentKey.set(key, id)` — silently taking the index away from whatever was already filed
 * under that key. The earlier half of the clip's life became reachable by nothing.
 *
 * Two of its three callers already resolved first. Two out of three is exactly the shape RONDE 94
 * named, and it gets the same answer: the rule moves into the one place they all pass through.
 *
 * ── §2 — the silent null that splits a clip (same finding, the other half) ──────────────────
 *
 * `linkDerivedPath` returns null when it cannot resolve the origin, and said nothing while doing
 * it. A trimmed or transformed copy then inherits no provider, no query and no SELECTED, and the
 * next thing that adopts it opens a fresh record. This does not repair that — the route that
 * failed to register the origin is not knowable from here — but the gap is now named when it
 * opens, which is what the next render needs to answer the report's open question.
 *
 * ── §3 — `unused` was one number for two costs (report finding 05) ──────────────────────────
 *
 *     [AssetUsageSummary] TOTAL found=3995 downloaded=140 rendered=19 unused=3976
 *
 * "Those two cannot both be true", said the report. They could: `unused` was `found - rendered`,
 * so 140 real downloads sat inside it. One number for a search that returned too much and a
 * download that produced nothing — two costs with opposite fixes.
 */
import { describe, expect, it, vi } from "vitest";

import {
  VisualSourceLedger,
  emptySummaryCounts,
  formatAssetUsageSummary,
  type SummaryCounts,
  type VisualSourceSummary,
} from "./visualSourceLineage";

const ledger = () => new VisualSourceLedger({ renderId: "r202", videoId: 567 });

/* ═══════════ 1. one asset, one record ═══════════ */

describe("R202 §1 — a second sighting of one asset does not open a second record", () => {
  it("THE RENDER-567 SHAPE: selected on one record, adopted on the other, is now impossible", () => {
    const l = ledger();
    // The candidate is registered when the search finds it, and the ranker selects it.
    const found = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "youtube_cc:d5d161",
      contentKey: "youtube_cc:d5d161", provider: "youtube_cc", providerAssetId: "d5d161",
      localPath: "/w/candidate.mp4", mediaType: "video",
    });
    l.recordEvent(found.lineageId, "SELECTED", { status: "OK" });

    // The downloaded file arrives later, under a different name, and is registered again.
    const again = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "youtube_cc:d5d161",
      contentKey: "youtube_cc:d5d161", provider: "youtube_cc", providerAssetId: "d5d161",
      localPath: "/w/scene_0_ytcc_0_transformed.mp4", mediaType: "video",
    });
    l.recordEvent(again.lineageId, "ADOPTED", { status: "OK" });

    expect(again.lineageId, "the asset was filed twice").toBe(found.lineageId);
    expect(l.allRecords()).toHaveLength(1);
    // One record, one whole story — both halves of the clip's life on it.
    expect(l.hasStage(found.lineageId, "SELECTED")).toBe(true);
    expect(l.hasStage(found.lineageId, "ADOPTED")).toBe(true);
  });

  it("and the later path resolves to that one record", () => {
    const l = ledger();
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "pexels:1", contentKey: "pexels:1",
      provider: "pexels", localPath: "/w/first.mp4", mediaType: "video",
    });
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "pexels:1", contentKey: "pexels:1",
      provider: "pexels", localPath: "/w/second.mp4", mediaType: "video",
    });
    expect(l.resolve("/w/second.mp4")?.lineageId).toBe(l.resolve("/w/first.mp4")?.lineageId);
  });

  it("a provider the first sighting lacked is filled in by the second", () => {
    const l = ledger();
    const anon = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "wikimedia:W1", contentKey: "wikimedia:W1",
      localPath: "/w/anon.mp4", mediaType: "video",
    });
    expect(anon.providerStatus).toBe("UNVERIFIED");
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "wikimedia:W1", contentKey: "wikimedia:W1",
      provider: "wikimedia", providerAssetId: "W1", localPath: "/w/named.mp4", mediaType: "video",
    });
    expect(l.get(anon.lineageId)?.provider).toBe("wikimedia");
  });

  it("A DERIVED FILE KEEPS ITS OWN RECORD — the chain must survive", () => {
    const l = ledger();
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "archive:9", contentKey: "archive:9",
      provider: "archive", localPath: "/w/orig.mp4", mediaType: "video",
    });
    const trimmed = l.linkDerivedPath("/w/orig_trim.mp4", "/w/orig.mp4", "TRIMMED");
    expect(trimmed).not.toBeNull();
    expect(l.allRecords()).toHaveLength(2);
    expect(trimmed!.parentLineageId).toBe(l.resolve("/w/orig.mp4")!.lineageId);
  });

  it("A `file:` KEY IS NOT AN IDENTITY — two different clips are never merged on one", () => {
    /**
     * That key is derived from a path and its size, so two unrelated files can share it. Merging
     * on it would join two clips that have nothing to do with each other — a worse fault than the
     * one this round is fixing.
     */
    const l = ledger();
    const a = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "a", contentKey: "file:123:a.mp4",
      localPath: "/w/a.mp4", mediaType: "video",
    });
    const b = l.createLineage({
      sceneIndex: 0, beatIndex: 1, candidateId: "b", contentKey: "file:123:a.mp4",
      localPath: "/w/b.mp4", mediaType: "video",
    });
    expect(b.lineageId).not.toBe(a.lineageId);
  });

  it("a record with no key at all is never merged either", () => {
    const l = ledger();
    const a = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "x", contentKey: "",
      localPath: "/w/x.mp4", mediaType: "video",
    });
    const b = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "y", contentKey: "",
      localPath: "/w/y.mp4", mediaType: "video",
    });
    expect(b.lineageId).not.toBe(a.lineageId);
  });
});

/* ═══════════ 2. a derivation that loses its origin is named ═══════════ */

describe("R202 §2 — the silent null now says what it lost", () => {
  it("names both paths when the origin has no record", () => {
    const l = ledger();
    const seen: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((x) => void seen.push(String(x)));
    try {
      expect(l.linkDerivedPath("/w/copy.mp4", "/w/unknown_origin.mp4", "TRANSFORMED")).toBeNull();
    } finally {
      spy.mockRestore();
    }
    const line = seen.find((x) => x.includes("DERIVATION_WITHOUT_ORIGIN"))!;
    expect(line, "the split still opens in silence").toBeTruthy();
    expect(line).toContain("copy.mp4");
    expect(line).toContain("unknown_origin.mp4");
    expect(line).toContain("TRANSFORMED");
  });

  it("and it still records the mapping, so a later resolve can walk back", () => {
    const l = ledger();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      l.linkDerivedPath("/w/copy.mp4", "/w/late.mp4", "TRIMMED");
    } finally {
      spy.mockRestore();
    }
    // The origin acquires a record afterwards — the copy must find it.
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "archive:5", contentKey: "archive:5",
      provider: "archive", localPath: "/w/late.mp4", mediaType: "video",
    });
    expect(l.resolve("/w/copy.mp4")?.provider).toBe("archive");
  });

  it("a healthy derivation says nothing at all", () => {
    const l = ledger();
    l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "archive:7", contentKey: "archive:7",
      provider: "archive", localPath: "/w/o.mp4", mediaType: "video",
    });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      l.linkDerivedPath("/w/o_pad.mp4", "/w/o.mp4", "PADDED");
      expect(spy.mock.calls.map((c) => String(c[0])).filter((x) => x.includes("DERIVATION_WITHOUT_ORIGIN")))
        .toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ═══════════ 3. two costs, two numbers ═══════════ */

describe("R202 §3 — `unused` split into the two things it was hiding", () => {
  const counts = (over: Partial<SummaryCounts>): SummaryCounts => ({ ...emptySummaryCounts(), ...over });
  const summaryOf = (c: SummaryCounts): VisualSourceSummary =>
    ({ byProvider: { TOTALTEST: c }, total: c, failureReasons: {}, verifiedRecords: 0, unverifiedRecords: 0 } as never);

  it("RENDER 573's OWN NUMBERS: 3855 never fetched, 121 fetched for nothing", () => {
    const real = counts({ results: 3995, downloadSucceeded: 140, finalVideo: 19 });
    const line = formatAssetUsageSummary(summaryOf(real), true)[0]!;
    expect(line).toContain("neverFetched=3855");
    expect(line).toContain("fetchedUnused=121");
    expect(line, "the single number that hid the downloads is back").not.toContain("unused=3976");
  });

  it("RENDER 567's YouTube line no longer calls an adopted asset unused", () => {
    const yt = counts({ results: 30, eligible: 1, selected: 1, downloadSucceeded: 10, adopted: 1, finalVideo: 0 });
    const line = formatAssetUsageSummary(summaryOf(yt), true)[0]!;
    expect(line).toContain("neverFetched=20");
    expect(line).toContain("fetchedUnused=10");
    expect(line).not.toContain("unused=30");
  });

  it("the count that depends on the final video is NOT_VERIFIED with it, never 0", () => {
    const yt = counts({ results: 30, downloadSucceeded: 10, finalVideo: 0 });
    const line = formatAssetUsageSummary(summaryOf(yt), false)[0]!;
    expect(line).toContain("fetchedUnused=NOT_VERIFIED");
    // And the one that does not depend on it stays a real number.
    expect(line).toContain("neverFetched=20");
  });

  it("neither count can go negative when a provider's tallies disagree", () => {
    const odd = counts({ results: 2, downloadSucceeded: 9, finalVideo: 11 });
    const line = formatAssetUsageSummary(summaryOf(odd), true)[0]!;
    expect(line).toContain("neverFetched=0");
    expect(line).toContain("fetchedUnused=0");
  });
});
