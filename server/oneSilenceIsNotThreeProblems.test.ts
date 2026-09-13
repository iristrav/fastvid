import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { VisualSourceLedger, formatProviderFunnelInvariant } from "./visualSourceLineage";

/**
 * "UNEXPLAINED" WAS ONE BUCKET FOR THREE DIFFERENT LEAKS.
 *
 * ── What render 579 reported ────────────────────────────────────────────────────────────────
 *
 *     [ProviderFunnelInvariant] pexels           unexplained=82  INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] pixabay          unexplained=64  INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] wikimedia        unexplained=35  INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] serpapi          unexplained=28  INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] youtube_cc       unexplained=17  INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] ww2              unexplained=6   INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] unsplash         unexplained=4   INVARIANT_BROKEN
 *     [ProviderFunnelInvariant] internet_archive unexplained=1   INVARIANT_BROKEN
 *
 * Every provider broken, about 237 records the ledger opened and lost track of — and one number
 * over all of it, so nobody could tell whether that named one leak or three. Every funnel
 * conclusion drawn from this render rests on a measurement that is itself unaccounted for.
 *
 * ── Why a split and not an attribution ──────────────────────────────────────────────────────
 *
 * This function already separates `untracked` from `unexplained` for exactly this reason: two gaps
 * with different fixes must not share a number. It stopped one level too early. The records carry
 * their stage lists, and those support three honest distinctions:
 *
 *   neverFetched         opened, no transfer attempted — screened out before any bytes moved
 *   fetchStalled         a transfer began and neither outcome was ever filed
 *   fetchedThenSilent    the bytes arrived and nothing said what became of the file
 *   failedThenSucceeded  a FAILED and a SUCCEEDED on one record, which R167 F1 deliberately
 *                        declines to call terminal
 *
 * What it still refuses to say is WHICH gate. Stage lists are not decision logs, and this
 * function's own header is the rule: guessing "would make the log look complete and read wrong,
 * which is the defect this whole investigation started from."
 */

const REND = "r1";

/** One root record, driven through the stages a real candidate would file. */
function ledgerWith(specs: Array<{ provider: string; stages: string[] }>) {
  const ledger = new VisualSourceLedger({ renderId: REND });
  specs.forEach((spec, i) => {
    const { lineageId } = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: i,
      candidateId: `${spec.provider}:cand${i}`,
      contentKey: `content:${spec.provider}:${i}`,
      localPath: `/w/${spec.provider}_${i}.mp4`,
      provider: spec.provider,
      providerAssetId: `asset${i}`,
    });
    for (const stage of spec.stages) {
      ledger.recordEvent(lineageId, stage as never, {
        status: stage === "DOWNLOAD_FAILED" ? "FAILED" : "OK",
        ...(stage === "DOWNLOAD_FAILED" ? { reason: "download_timeout" } : {}),
      });
    }
  });
  return ledger;
}

const summaryFor = (providers: Record<string, number>) =>
  ({ byProvider: Object.fromEntries(Object.entries(providers).map(([p, results]) => [p, { results }])) } as never);

function lineFor(providers: Record<string, number>, specs: Array<{ provider: string; stages: string[] }>) {
  const ledger = ledgerWith(specs);
  const lines = formatProviderFunnelInvariant(
    summaryFor(providers),
    ledger.allRecords(),
    ledger.allEvents()
  );
  return lines.find((l) => l.includes(`provider=${Object.keys(providers)[0]}`))!;
}

describe("the four shapes a silent record can have", () => {
  it("NEVER FETCHED — opened and no transfer attempted", () => {
    /** The pexels/pixabay mass: screened out by a cheap gate before any bytes moved. */
    const line = lineFor({ pexels: 10 }, [{ provider: "pexels", stages: [] }]);
    expect(line).toContain("unexplained=1");
    expect(line).toContain("neverFetched=1");
    expect(line).toContain("fetchedThenSilent=0");
    expect(line).toContain("INVARIANT_BROKEN");
  });

  it("FETCHED THEN SILENT — the expensive one, render 579's youtube_cc", () => {
    /**
     * The render paid for a download and then lost the result. All seventeen of render 579's
     * youtube_cc records were this shape, and the cause is known: every one was filed under
     * `beat=-1`, so no beat funnel could pick it up.
     */
    const line = lineFor({ youtube_cc: 40 }, [
      { provider: "youtube_cc", stages: ["DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"] },
    ]);
    expect(line).toContain("fetchedThenSilent=1");
    expect(line).toContain("neverFetched=0");
  });

  it("FETCH STALLED — a transfer began and neither outcome was filed", () => {
    const line = lineFor({ pixabay: 5 }, [{ provider: "pixabay", stages: ["DOWNLOAD_STARTED"] }]);
    expect(line).toContain("fetchStalled=1");
    expect(line).toContain("fetchedThenSilent=0");
  });

  it("FAILED THEN SUCCEEDED — the contradiction R167 refuses to call an ending", () => {
    /**
     * A success after a failure means the failure was not the ending, so `hasTerminalOutcome`
     * correctly declines it. Counted apart so it stops inflating the other three: render 579 had
     * five, all from a caller that had already given up waiting.
     */
    const line = lineFor({ youtube_cc: 40 }, [
      {
        provider: "youtube_cc",
        stages: ["DOWNLOAD_STARTED", "DOWNLOAD_FAILED", "DOWNLOAD_SUCCEEDED"],
      },
    ]);
    expect(line).toContain("failedThenSucceeded=1");
    expect(line).toContain("fetchedThenSilent=0");
  });

  it("THE FOUR SHAPES SUM TO unexplained, EXACTLY", () => {
    /**
     * The property that makes the split trustworthy. If they did not add up, the breakdown would
     * be a second measurement disagreeing with the first — which is the failure mode this file's
     * own subject is about.
     */
    const line = lineFor({ mix: 99 }, [
      { provider: "mix", stages: [] },
      { provider: "mix", stages: [] },
      { provider: "mix", stages: ["DOWNLOAD_STARTED"] },
      { provider: "mix", stages: ["DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"] },
      { provider: "mix", stages: ["DOWNLOAD_STARTED", "DOWNLOAD_FAILED", "DOWNLOAD_SUCCEEDED"] },
    ]);
    const n = (key: string) => Number(line.match(new RegExp(`${key}=(\\d+)`))![1]);
    expect(n("unexplained")).toBe(5);
    expect(n("neverFetched") + n("fetchStalled") + n("fetchedThenSilent") + n("failedThenSucceeded")).toBe(
      n("unexplained")
    );
  });
});

describe("what the split does not change", () => {
  it("A TERMINATED RECORD IS STILL TERMINATED AND STILL NOT BROKEN", () => {
    /**
     * A download that failed and never succeeded is an ending — R167 F1 — so it must not appear in
     * any of the four shapes, and the provider must not be reported broken over it.
     */
    const line = lineFor({ pexels: 3 }, [
      { provider: "pexels", stages: ["DOWNLOAD_STARTED", "DOWNLOAD_FAILED"] },
    ]);
    expect(line).toContain("terminalOutcomes=1");
    expect(line).toContain("unexplained=0");
    expect(line).not.toContain("INVARIANT_BROKEN");
  });

  it("and a clean provider does not grow four zero columns", () => {
    /**
     * The shapes are printed only when there is something to shape. A line that gained four zeroes
     * on every healthy render would make the broken ones harder to see, not easier.
     */
    const line = lineFor({ pexels: 3 }, [
      { provider: "pexels", stages: ["DOWNLOAD_STARTED", "DOWNLOAD_FAILED"] },
    ]);
    expect(line).not.toContain("neverFetched=");
    expect(line).not.toContain("fetchStalled=");
  });

  it("untracked still means what it meant — a search result that never became a record", () => {
    /**
     * The older split, untouched. `candidates` is a running search total and the ledger opens a
     * record only when a candidate is tagged or downloaded; that difference is a design limit, not
     * a defect, and it must not be folded into the new columns.
     */
    const line = lineFor({ pexels: 10 }, [{ provider: "pexels", stages: [] }]);
    expect(line).toContain("candidates=10");
    expect(line).toContain("tracked=1");
    expect(line).toContain("untracked=9");
  });

  it("THE FUNCTION STILL REFUSES TO NAME A GATE", () => {
    /**
     * The header's own rule, pinned. A reason invented here would make the log look complete and
     * read wrong — and a complete-looking wrong log is what this whole investigation began from.
     */
    const src = readFileSync(join(__dirname, "visualSourceLineage.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function formatProviderFunnelInvariant"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toMatch(/recordEvent\(|recordAssetOutcome\(|createLineage\(/);
  });
});

describe("the render log reads it back out", () => {
  it("the pipeline still prints every line and warns on the broken ones", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("formatProviderFunnelInvariant(summary, ledger.allRecords()");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 300)).toContain('line.includes("INVARIANT_BROKEN")');
    expect(PIPE.slice(at, at + 300)).toContain("console.warn");
  });
});
