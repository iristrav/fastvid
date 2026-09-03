/**
 * WHERE EACH SOURCE LOSES ITS FOOTAGE.
 *
 * ── The question the existing report cannot answer ──────────────────────────────────────────
 *
 * `[AssetUsageSummary]` counts found / validated / selected / downloaded / assigned / rendered per
 * provider. A render with 137 downloads and 7 adoptions raises exactly one question that table is
 * unable to answer: where did the other 130 stop.
 *
 * Almost all of them stop at the picture editor. Its verdicts live in `BeatRelevanceLedger`, keyed
 * by clip path, with no idea which provider anything came from — while the lineage ledger knows the
 * provider and nothing about verdicts. Two complete records, neither able to answer the joint
 * question, which is why a source that supplies plenty of candidates and has every one refused has
 * always looked, in the report, exactly like a source that supplied nothing.
 */
import { describe, expect, it } from "vitest";

import { formatProviderFunnel, providerVisionFunnel } from "./providerFunnel";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";

const decision = (over: Partial<BeatRelevanceDecision> = {}): BeatRelevanceDecision => ({
  verdict: "fits",
  allowed: true,
  reprieved: false,
  cached: false,
  depicts: "",
  reason: "",
  route: "adopt",
  evaluated: true,
  ...over,
});

const ledgerOf = (
  entries: Array<[string, Partial<BeatRelevanceDecision>]>
): BeatRelevanceLedger => ({
  byClipPath: new Map(
    entries.map(([clipPath, d]) => [
      clipPath,
      { ctx: {} as never, decision: decision(d) },
    ])
  ),
  byContentKey: new Map(),
  spendByBeat: new Map(),
});

const providers = (map: Record<string, string>) => (clipPath: string) => map[clipPath] ?? null;

describe("verdicts are attributed to the source the clip came from", () => {
  it("splits one ledger across the providers that supplied it", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([
        ["/a.mp4", { verdict: "fits" }],
        ["/b.mp4", { verdict: "does_not_fit" }],
        ["/c.mp4", { verdict: "fits" }],
      ]),
      providerOf: providers({ "/a.mp4": "pexels", "/b.mp4": "pexels", "/c.mp4": "wwii_archive" }),
    });
    const pexels = rows.find((r) => r.provider === "pexels")!;
    expect(pexels.judged).toBe(2);
    expect(pexels.fits).toBe(1);
    expect(pexels.refused).toBe(1);
    expect(rows.find((r) => r.provider === "wwii_archive")!.fits).toBe(1);
  });

  /**
   * `evaluated: false` is the gate declining — a spent budget, a switched-off gate, no usable
   * frame. Counting those as judged would make a render that asked nothing look like one whose
   * candidates were all rejected.
   */
  it("a clip nobody looked at is not counted as judged", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([
        ["/a.mp4", { evaluated: false, verdict: "unknown" }],
        ["/b.mp4", { verdict: "fits" }],
      ]),
      providerOf: providers({ "/a.mp4": "pexels", "/b.mp4": "pexels" }),
    });
    expect(rows[0]!.judged).toBe(1);
  });

  /**
   * A verdict read back from cache is a real verdict about a real look — it simply did not cost
   * this render a call. Excluding it would undercount what the editor decided.
   */
  it("a cached verdict still counts as a look", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([["/a.mp4", { cached: true, verdict: "does_not_fit" }]]),
      providerOf: providers({ "/a.mp4": "youtube_cc" }),
    });
    expect(rows[0]!.judged).toBe(1);
    expect(rows[0]!.refused).toBe(1);
  });

  it("a refusal and a shrug are different outcomes", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([
        ["/a.mp4", { verdict: "does_not_fit" }],
        ["/b.mp4", { verdict: "unknown" }],
      ]),
      providerOf: providers({ "/a.mp4": "p", "/b.mp4": "p" }),
    });
    expect(rows[0]!.refused).toBe(1);
    expect(rows[0]!.unclear).toBe(1);
  });

  /**
   * A reprieve is the gate being OVERRULED because every alternative was refused too. It is
   * counted apart from an acceptance, because a film full of them is a retrieval failure wearing
   * a gate's clothes.
   */
  it("a refused clip used anyway is counted as a reprieve, not an acceptance", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([["/a.mp4", { verdict: "does_not_fit", reprieved: true }]]),
      providerOf: providers({ "/a.mp4": "pexels" }),
    });
    expect(rows[0]!.fits).toBe(0);
    expect(rows[0]!.refused).toBe(1);
    expect(rows[0]!.reprieved).toBe(1);
  });

  /**
   * An unattributable clip is its own row. Redistributing it across the sources that CAN be proven
   * would put invented footage on their record — the same rule `[AssetUsageSummary]` follows.
   */
  it("a clip whose source cannot be proven is not redistributed", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([["/a.mp4", { verdict: "fits" }], ["/b.mp4", { verdict: "fits" }]]),
      providerOf: providers({ "/a.mp4": "pexels" }),
    });
    expect(rows.find((r) => r.provider === "pexels")!.judged).toBe(1);
    expect(rows.find((r) => r.provider === "UNVERIFIED")!.judged).toBe(1);
  });

  it("UNVERIFIED sorts last, so the provable sources read first", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([
        ["/a.mp4", {}],
        ["/b.mp4", {}],
        ["/c.mp4", {}],
      ]),
      providerOf: providers({ "/a.mp4": "pexels" }),
    });
    expect(rows[rows.length - 1]!.provider).toBe("UNVERIFIED");
  });

  it("an empty ledger produces no rows rather than a table of zeros", () => {
    expect(providerVisionFunnel({ ledger: ledgerOf([]), providerOf: () => null })).toEqual([]);
  });
});

describe("the report names the problem, not only the numbers", () => {
  it("states an acceptance rate per source", () => {
    const lines = formatProviderFunnel(
      providerVisionFunnel({
        ledger: ledgerOf([
          ["/a.mp4", { verdict: "fits" }],
          ["/b.mp4", { verdict: "does_not_fit" }],
          ["/c.mp4", { verdict: "does_not_fit" }],
          ["/d.mp4", { verdict: "does_not_fit" }],
        ]),
        providerOf: () => "pexels",
      })
    );
    expect(lines[0]).toContain("accepted=25%");
  });

  /**
   * The finding this whole module exists for. A source that supplied plenty and had every single
   * clip refused is a RETRIEVAL problem — the queries are finding the wrong material — and in a
   * table of numbers it reads as one low number among others unless something says so.
   */
  it("calls out a source that supplied plenty and contributed nothing", () => {
    const lines = formatProviderFunnel(
      providerVisionFunnel({
        ledger: ledgerOf(
          Array.from({ length: 9 }, (_, i) => [`/p${i}.mp4`, { verdict: "does_not_fit" as const }])
        ),
        providerOf: () => "pexels",
      })
    ).join("\n");
    expect(lines).toContain("NOT ONE was accepted");
    expect(lines).toContain("finding the wrong material");
  });

  /** Two refusals is not evidence of a pattern. The call-out has to need a real sample. */
  it("does not call out a source on a handful of refusals", () => {
    const lines = formatProviderFunnel(
      providerVisionFunnel({
        ledger: ledgerOf([
          ["/a.mp4", { verdict: "does_not_fit" }],
          ["/b.mp4", { verdict: "does_not_fit" }],
        ]),
        providerOf: () => "pexels",
      })
    ).join("\n");
    expect(lines).not.toContain("NOT ONE was accepted");
  });

  /**
   * A film held together by reprieves is not a film whose gate is working. Saying so is the
   * difference between a report and a scoreboard.
   */
  it("says when the gate is being overruled more often than satisfied", () => {
    const lines = formatProviderFunnel(
      providerVisionFunnel({
        ledger: ledgerOf([
          ["/a.mp4", { verdict: "does_not_fit", reprieved: true }],
          ["/b.mp4", { verdict: "does_not_fit", reprieved: true }],
          ["/c.mp4", { verdict: "fits" }],
        ]),
        providerOf: () => "pexels",
      })
    ).join("\n");
    expect(lines).toContain("being overruled more often than it is being satisfied");
  });

  it("a healthy render gets numbers and no warnings", () => {
    const lines = formatProviderFunnel(
      providerVisionFunnel({
        ledger: ledgerOf([
          ["/a.mp4", { verdict: "fits" }],
          ["/b.mp4", { verdict: "fits" }],
          ["/c.mp4", { verdict: "does_not_fit" }],
        ]),
        providerOf: () => "wwii_archive",
      })
    ).join("\n");
    expect(lines).toContain("accepted=67%");
    expect(lines).not.toContain("NOT ONE");
    expect(lines).not.toContain("overruled");
  });

  it("says plainly when nothing reached the picture editor at all", () => {
    expect(formatProviderFunnel([])[0]).toContain("no clip from any provider reached");
  });

  it("every row is one line, plus a total", () => {
    const rows = providerVisionFunnel({
      ledger: ledgerOf([["/a.mp4", {}], ["/b.mp4", {}]]),
      providerOf: providers({ "/a.mp4": "x", "/b.mp4": "y" }),
    });
    expect(formatProviderFunnel(rows)).toHaveLength(rows.length + 1);
  });
});

/* ═══════════════════════ the query family a beat is left with ═══════════════════════ */

describe("a starved beat is the finding, not a blocked query", () => {
  const engine = () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "mediaResearchEngine.ts"), "utf8");
  };

  /**
   * Render 564 blocked 388 of 755 queries, and that figure says almost nothing on its own — half
   * of those refusals are the gate doing exactly its job, refusing a noun the script never used.
   *
   * The number that matters is what a beat is LEFT with. A beat that built eleven queries and can
   * ask nine is healthy; one that built eleven and can ask one reaches nineteen providers with a
   * single phrase and takes whatever is in the one narrow pool that comes back. In the render
   * report those two beats look identical.
   */
  it("warns about starvation rather than about refusal", () => {
    const src = engine();
    expect(src).toContain("[QueryBreadth] STARVED");
    expect(src).toContain("candidates.length >= 3 && asked.length <= 1");
  });

  /** A beat that only ever built one query was never starved; it was never ambitious. */
  it("does not warn when there was nothing to lose", () => {
    expect(engine()).toContain("candidates.length >= 3");
  });

  /**
   * Naming the refused queries is what makes the warning actionable: it is the difference between
   * "this beat is thin" and "this beat is thin because the planner keeps inventing nouns".
   */
  it("names what was refused, so the cause is diagnosable", () => {
    expect(engine()).toContain("Refused: ${blocked}");
  });

  it("distinguishes one phrase from no query at all", () => {
    expect(engine()).toContain('asked.length === 0 ? "no query at all" : "one phrase"');
  });

  /** The gate itself is untouched — this reports on its output, it does not soften it. */
  it("the family is still filtered by the real validator", () => {
    expect(engine()).toContain("candidates.filter((q) => validateSearchQuery(q, provenance).ok)");
  });
});
