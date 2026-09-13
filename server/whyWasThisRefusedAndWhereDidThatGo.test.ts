import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { formatProviderTrace, VisualSourceLedger } from "./visualSourceLineage";

/**
 * WHY WAS THIS PICTURE REFUSED, AND WHERE DID THAT ONE GO.
 *
 * ── The question the logs could not answer ──────────────────────────────────────────────────
 *
 * Render 577 reported `youtube_cc adopted=1 composed=0 finalVideo=0`. One clip cleared eligibility,
 * ranking, the shortlist, vision and adoption — and never reached the film. Nothing in the log said
 * WHICH clip, or at which step it stopped. The only available method was to read the whole log and
 * infer it from what was missing, which is guesswork with extra steps.
 *
 * The facts were never absent. The lineage ledger holds, per asset, the provider, the asset id, the
 * scene, the beat, the query and the route; and per event a stage, a status, a reason and the gate
 * that refused it. What was missing was a READER. `formatAssetTrace` has been exported since
 * RONDE 95 and is called by nothing at all — the same shape as `metadata.publishedAt`, which the
 * ranking engine read while the adapter wrote null.
 *
 * ── The distinction that matters ────────────────────────────────────────────────────────────
 *
 * REFUSED and OPEN-ENDED are different problems and are counted separately:
 *
 *   refused    something turned this asset down AND said why — a decision, visible and arguable
 *   openEnded  the asset's life simply stops with no terminal event — the disappearance
 *
 * Blending the two is exactly how `adopted=1 composed=0` stayed unexplained.
 */

const ledgerWith = (build: (l: VisualSourceLedger) => void): VisualSourceLedger => {
  const ledger = new VisualSourceLedger({ renderId: "r570" });
  build(ledger);
  return ledger;
};

/** One YouTube candidate, opened the way the pipeline opens one. */
const openYoutube = (
  l: VisualSourceLedger,
  o: { id: string; scene?: number; beat?: number; query?: string }
): string =>
  l.createLineage({
    sceneIndex: o.scene ?? 0,
    beatIndex: o.beat ?? 0,
    candidateId: `yt-${o.id}`,
    contentKey: `youtube_cc:${o.id}`,
    localPath: `/tmp/r/yt_${o.id}.mp4`,
    provider: "youtube_cc",
    providerAssetId: o.id,
    ...(o.query ? { query: o.query } : {}),
  }).lineageId;

describe("the trace reports one block per asset of one source", () => {
  it("an empty ledger says so rather than printing nothing", () => {
    /**
     * Silence and "no records" are different claims. A reader who sees no output cannot tell
     * whether the source was never asked or the report was never run.
     */
    const lines = formatProviderTrace(new VisualSourceLedger({ renderId: "r570" }), "youtube_cc", {
      label: "YouTubeTrace",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("assets=0");
    expect(lines[0]).toContain("opened no youtube_cc lineage record");
  });

  it("an absent ledger produces no lines at all", () => {
    expect(formatProviderTrace(undefined, "youtube_cc")).toEqual([]);
  });

  it("ONLY THE ASKED-FOR SOURCE APPEARS", () => {
    const ledger = ledgerWith((l) => {
      openYoutube(l, { id: "aaa", query: "Tokyo harbour 1954" });
      l.createLineage({
        sceneIndex: 0, beatIndex: 1, candidateId: "px-bbb", contentKey: "pexels:bbb",
        localPath: "/tmp/r/px_bbb.mp4", provider: "pexels", providerAssetId: "bbb",
      });
    });
    const text = formatProviderTrace(ledger, "youtube_cc", { label: "YouTubeTrace" }).join("\n");
    expect(text).toContain("providerAssetId=aaa");
    expect(text).not.toContain("bbb");
    expect(text).toContain("assets=1");
  });

  it("the header carries the identity a person needs to look the clip up", () => {
    const ledger = ledgerWith((l) => {
      openYoutube(l, { id: "aaa", scene: 2, beat: 3, query: "Tokyo harbour 1954" });
    });
    const header = formatProviderTrace(ledger, "youtube_cc", { label: "YouTubeTrace" })[1]!;
    expect(header).toContain("providerAssetId=aaa");
    expect(header).toContain("scene=2");
    expect(header).toContain("beat=3");
    expect(header).toContain('query="Tokyo harbour 1954"');
  });
});

describe("A REFUSAL NAMES ITS REASON AND ITS GATE", () => {
  const ledger = ledgerWith((l) => {
    const id = openYoutube(l, { id: "aaa", query: "Tokyo harbour" });
    l.recordEvent(id, "ELIGIBLE", { status: "OK", reason: "adopt_clip_gates_cleared" });
    l.recordEvent(id, "VISION", { status: "REJECTED", reason: "wrong_subject", gate: "beat_image_gate" });
  });
  const lines = formatProviderTrace(ledger, "youtube_cc", { label: "YouTubeTrace" });
  const text = lines.join("\n");

  it("the reason is printed", () => {
    expect(text).toContain("reason=wrong_subject");
  });

  it("and the gate that refused it", () => {
    expect(text).toContain("gate=beat_image_gate");
  });

  it("and the events read oldest first, so a life reads top to bottom", () => {
    expect(text.indexOf("ELIGIBLE")).toBeLessThan(text.indexOf("VISION"));
  });

  it("such an asset counts as REFUSED, not as disappeared", () => {
    expect(lines[0]).toContain("refused=1");
    expect(lines[0]).toContain("openEnded=0");
  });
});

describe("AN ASSET THAT SIMPLY STOPS IS COUNTED AS THE DISAPPEARANCE IT IS", () => {
  /**
   * Render 577's unexplained case, reproduced: adopted, then nothing. No refusal, no reason, no
   * terminal event. The summary must not let this hide among the refusals, because the two need
   * completely different investigations.
   */
  const ledger = ledgerWith((l) => {
    const id = openYoutube(l, { id: "aaa", scene: 1 });
    l.recordEvent(id, "ELIGIBLE", { status: "OK" });
    l.recordEvent(id, "ADOPTED", { status: "OK" });
  });
  const lines = formatProviderTrace(ledger, "youtube_cc", { label: "YouTubeTrace" });

  it("it is openEnded, not refused", () => {
    expect(lines[0]).toContain("openEnded=1");
    expect(lines[0]).toContain("refused=0");
  });

  it("and the summary explains the difference in words, not only in numbers", () => {
    expect(lines[0]).toContain("no terminal event");
    expect(lines[0]).toContain("disappeared");
  });

  it("its last printed event is the point at which it stopped", () => {
    expect(lines.at(-1)).toContain("ADOPTED");
  });

  it("EVERY RECORD CARRIES AT LEAST ITS OPENING EVENT — so a block is never empty", () => {
    /**
     * Measured, not assumed: `createLineage` files a FOUND event itself (visualSourceLineage.ts,
     * `this.recordEvent(record.lineageId, "FOUND", { status: "OK" })`), so a record with zero
     * events cannot be produced through the ledger's own API.
     *
     * The trace's "never updated" branch is therefore DEFENSIVE — for a record reaching it from a
     * future route that opens one some other way. Asserting the real guarantee here rather than
     * the defensive branch keeps this test about what the render actually does.
     */
    const bare = ledgerWith((l) => {
      openYoutube(l, { id: "zzz" });
    });
    const lines = formatProviderTrace(bare, "youtube_cc", { label: "YouTubeTrace" });
    expect(lines[0]).toContain("assets=1");
    expect(lines.join("\n")).toContain("FOUND");
    expect(lines.join("\n")).not.toContain("never updated");
  });

  it("and an asset holding only its opening event is openEnded — found, then nothing", () => {
    const bare = ledgerWith((l) => {
      openYoutube(l, { id: "zzz" });
    });
    expect(formatProviderTrace(bare, "youtube_cc")[0]).toContain("openEnded=1");
  });
});

describe("the trace changes nothing — it only reads", () => {
  it("it is wired into the render's own report, in the sourcing section", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain('formatProviderTrace(ledger, "youtube_cc", { label: "YouTubeTrace" })');
    expect(PIPE).toContain('pipelineReport.add("sourcing", line)');
  });

  it("AND IT READS THE SAME EVENTS THE FUNNEL READS, so the two cannot disagree", () => {
    /**
     * Structural, not aspirational: the function takes the ledger and calls `allRecords` and
     * `allEvents` — the same two accessors `formatProviderFunnelInvariant` is given. A trace with
     * its own tally would become a second source of truth about the same render.
     */
    const SRC = readFileSync(join(__dirname, "visualSourceLineage.ts"), "utf8");
    const fn = SRC.slice(
      SRC.indexOf("export function formatProviderTrace"),
      SRC.indexOf("/** One composed clip's provenance")
    );
    /** Whitespace-folded: the calls are line-broken in the source, which is formatting, not intent. */
    const folded = fn.replace(/\s+/g, "");
    expect(folded).toContain("ledger.allRecords()");
    expect(folded).toContain("ledger.allEvents()");
    expect(fn).not.toMatch(/\brecordEvent\(|\bcreateLineage\(|markEligible|recordClipAdopt/);
  });
});
