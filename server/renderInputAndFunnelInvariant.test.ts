/**
 * §7 THE RENDER'S INPUT, AND §12 WHAT THE FUNNEL CAN ACCOUNT FOR.
 *
 * ── §7: input is a different question from output ───────────────────────────────────────────
 *
 * `[RenderAsset]` is built afterwards, from the lineage ledger, and describes the DELIVERED file.
 * That is the right report for "what does this video contain" and the wrong one for "what was this
 * renderer handed" — a render that fails, is cancelled, or silently drops a clip produces no such
 * lines at all, and both questions then have the same empty answer. `[FinalRenderInputs]` and
 * `[FinalRenderAsset]` are emitted from the timeline before ffmpeg starts, so the last checkpoint
 * is on the record whatever happens next.
 *
 * ── §12: `retrieved=30` was never thirty candidates ─────────────────────────────────────────
 *
 * `[VisualFunnel] youtube_cc retrieved=30 eligible=1` invites the reading that thirty were
 * considered and twenty-nine turned down. It cannot support it. `retrieved` is a running total from
 * `countSearch(provider, results.length)`; the ledger opens a RECORD only when a candidate is
 * tagged or downloaded. The twenty-nine were never individually tracked, so there is nothing to ask
 * why about.
 *
 * `formatProviderFunnelInvariant` separates the two gaps, because they have different fixes:
 *
 *   untracked    a search result that never became a record — a limit of the design
 *   unexplained  a record with no ending — a defect, chaseable by lineage id
 *
 * and warns only on the second. Giving all thirty a reason would mean opening a record per search
 * result, a behaviour change this round forbids; guessing reasons would make the log look complete
 * and read wrong, which is the defect the whole investigation started from.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { VisualSourceLedger, formatProviderFunnelInvariant } from "./visualSourceLineage";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════ §12 — behaviour ═══════════════ */

/** One provider, `searched` results reported, `tracked` of them opened as records. */
function ledgerWith(searched: number, tracked: number, terminal: number) {
  const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 567 });
  ledger.countSearch("youtube_cc", searched);
  for (let i = 0; i < tracked; i++) {
    const rec = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: i,
      candidateId: `youtube_cc:v${i}`,
      contentKey: `youtube_cc:v${i}`,
      provider: "youtube_cc",
      providerAssetId: `v${i}`,
      localPath: `/w/v${i}.mp4`,
      mediaType: "video",
      route: "primary",
    });
    if (i < terminal) {
      ledger.recordEvent(rec.lineageId, "REMOVED", { status: "REMOVED", reason: "test" });
    }
  }
  return ledger;
}

const invariant = (l: VisualSourceLedger) =>
  formatProviderFunnelInvariant(l.summary(), l.allRecords(), l.allEvents())
    .filter((x) => x.includes("provider=youtube_cc"));

describe("the funnel says how much of itself it can account for", () => {
  /** Render 567's exact shape: thirty reported, ten tracked, all ten explained. */
  it("separates untracked search results from unexplained records", () => {
    const [line] = invariant(ledgerWith(30, 10, 10));
    expect(line).toContain("candidates=30");
    expect(line).toContain("tracked=10");
    expect(line).toContain("terminalOutcomes=10");
    expect(line).toContain("untracked=20");
    expect(line).toContain("unexplained=0");
  });

  /** Untracked is a design limit, not a defect — it must not raise the alarm. */
  it("does not break the invariant on untracked candidates alone", () => {
    expect(invariant(ledgerWith(30, 10, 10))[0]).not.toContain("INVARIANT_BROKEN");
  });

  /** A record the ledger opened and then lost track of IS the defect. */
  it("breaks on a tracked record with no ending", () => {
    const [line] = invariant(ledgerWith(30, 10, 7));
    expect(line).toContain("unexplained=3");
    expect(line).toContain("INVARIANT_BROKEN");
  });

  it("counts a clean render as fully explained", () => {
    const [line] = invariant(ledgerWith(4, 4, 4));
    expect(line).toContain("untracked=0");
    expect(line).toContain("unexplained=0");
    expect(line).not.toContain("INVARIANT_BROKEN");
  });

  /** A derived file is the same asset, not a second candidate. */
  it("does not count a transformed child as its own candidate", () => {
    const ledger = ledgerWith(2, 1, 1);
    ledger.linkDerivedPath("/w/v0_transformed.mp4", "/w/v0.mp4", "TRANSFORMED");
    const [line] = invariant(ledger);
    expect(line).toContain("tracked=1");
    expect(line).not.toContain("INVARIANT_BROKEN");
  });

  /** Counts never go negative when more was tracked than a search reported. */
  it("clamps rather than printing a negative gap", () => {
    const [line] = invariant(ledgerWith(1, 3, 3));
    expect(line).toContain("untracked=0");
    expect(line).toContain("unexplained=0");
  });
});

/* ═══════════════ §12 — wiring ═══════════════ */

describe("the invariant reaches the render log", () => {
  it("is emitted beside the funnel it qualifies", () => {
    expect(PIPE).toContain("formatProviderFunnelInvariant(summary, ledger.allRecords(), ledger.allEvents())");
    const at = PIPE.indexOf("formatProviderFunnelInvariant(summary");
    expect(PIPE.slice(at - 900, at)).toContain("formatFunnelReport(summary");
  });

  /** A broken invariant is a warning, not another line of prose. */
  it("warns only when broken", () => {
    const at = PIPE.indexOf("formatProviderFunnelInvariant(summary");
    const block = PIPE.slice(at, at + 400);
    expect(block).toContain('line.includes("INVARIANT_BROKEN")');
    expect(block).toContain("console.warn");
    expect(block).toContain("console.log");
  });
});

/* ═══════════════ §7 ═══════════════ */

describe("the render's input is on the record before ffmpeg starts", () => {
  it("summarises the input the renderer was handed", () => {
    expect(PIPE).toContain("[FinalRenderInputs]");
    const at = PIPE.indexOf("`[FinalRenderInputs]");
    const block = PIPE.slice(at, at + 500);
    for (const f of ["clips=", "realAssets=", "fallbackAssets=", "unverified=", "pictureDuration="]) {
      expect(block, `[FinalRenderInputs] has no ${f}`).toContain(f);
    }
  });

  it("emits one line per clip, with identity and window", () => {
    expect(PIPE).toContain("[FinalRenderAsset]");
    const at = PIPE.indexOf("`[FinalRenderAsset]");
    const block = PIPE.slice(at, at + 600);
    for (const f of ["asset=", "provider=", "sourceId=", "clip=", "start=", "duration=", "origin="]) {
      expect(block, `[FinalRenderAsset] has no ${f}`).toContain(f);
    }
  });

  /**
   * Identity comes from the timeline clip's own `source`, which the planner proved — not from
   * anything re-derived at the log line.
   */
  it("reads identity from the clip's proven source", () => {
    const at = PIPE.indexOf("`[FinalRenderAsset]");
    const block = PIPE.slice(at - 700, at + 600);
    expect(block).toContain("c.source.providerAssetId");
    expect(block).toContain("c.source.archiveAssetId");
    expect(block).toContain("c.source.provider");
  });

  /** A filler is a real render input and not a real ASSET; conflating them inflates every count. */
  it("distinguishes a filler from a real asset", () => {
    const at = PIPE.indexOf("const originOf =");
    const block = PIPE.slice(at, at + 500);
    expect(block).toContain("GUARANTEED_FILLER");
    expect(block).toContain("REAL_ASSET");
    expect(block).toContain("UNVERIFIED_SOURCE");
    expect(block).toContain("isPipelineFallbackClip(");
  });

  /** Emitted before the render call, or it proves nothing about a render that dies. */
  it("is emitted before runRenderJob", () => {
    expect(PIPE.indexOf("`[FinalRenderInputs]")).toBeLessThan(
      PIPE.indexOf("jobOutcome = await runRenderJob(")
    );
  });
});
