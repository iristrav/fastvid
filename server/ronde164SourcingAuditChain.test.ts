/**
 * RONDE 164 — measuring the chain, before touching the budget.
 *
 * ── What this round deliberately does NOT do ─────────────────────────────────────────────────
 *
 * It does not change the download budget or the archive cap. The brief is explicit: "ALS
 * cutByBudget laag is, verhoog het budget NIET" and "DOE GEEN VERWACHTINGEN ZONDER DATA". No
 * production render carrying RONDE 163 exists yet, so there is no data that would justify moving
 * MAX_FUNNEL_CANDIDATES_TO_SCORE, and this round moves nothing.
 *
 * ── The question it makes answerable ─────────────────────────────────────────────────────────
 *
 * "Zijn we kandidaten aan het verliezen vóór VisionGate, of vinden we wel kandidaten maar zijn ze
 * daadwerkelijk onbruikbaar?"
 *
 * Those two need opposite fixes and looked identical from outside. Render 553's s1b6 reported
 * `offered=3 visionJudged=0 adopted=0`; establishing that a per-source cap caused it took reading
 * four separate log lines and reasoning across them. It is now one line per beat, plus one tally
 * per render.
 *
 * ── Why the verdict matters more than the counts ─────────────────────────────────────────────
 *
 * A render whose beats read LOST_BEFORE_VISION with cutByBudget high has a budget problem and
 * raising it will help. A render whose beats read REJECTED_BY_VISION does not: raising the budget
 * there buys more downloads to refuse. The next round needs to tell those apart from the log
 * without re-deriving it, which is what archiveSourcingVerdict is for.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  archiveSourcingVerdict,
  createArchiveSourcingAudit,
  formatArchiveSourcingAudit,
  recordBeatOutcome,
  recordShortlistStage,
  summarizeArchiveSourcing,
  type ArchiveSourcingAudit,
} from "./archiveSourcingAudit";
import {
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  buildDownloadShortlist,
  type FunnelCandidate,
  type FunnelCandidateSource,
} from "./retrievalFunnel";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const cand = (id: string, source: FunnelCandidateSource, rankingScore: number): FunnelCandidate => ({
  id,
  source,
  title: `${source} ${id}`,
  thumbnailUrl: null,
  mediaType: "video",
  embeddingSimilarity: null,
  archiveKeywordScore: null,
  clipSimilarity: null,
  rankingScore,
});

/** Render 553's beat s1b6: a deep archive result set beside one external candidate. */
const beatS1B6 = (): FunnelCandidate[] => [
  ...Array.from({ length: 25 }, (_, i) => cand(`archive:${i}`, "archive", 5 - i * 0.05)),
  cand("openverse:1", "openverse", 3.0),
];

describe("RONDE 164 — the chain is counted end to end", () => {
  it("the shortlist stage records what it found, kept and cut", () => {
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    expect(audit.afterMetadata).toBe(26);
    expect(audit.afterBeatDedup).toBe(26);
    // RONDE 170: the caps let four through, the backfill filled the two slots the budget had
    // left over. cutBySourceCap drops by exactly what was reclaimed — the totals still add up.
    expect(audit.afterSourceCap).toBe(6);
    expect(audit.backfilledFromCap).toBe(2);
    expect(audit.downloadBudget).toBe(MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(audit.cutBySourceCap).toBe(20);
    expect(audit.cutByBudget).toBe(0);
  });

  it("cutByBudget and cutBySourceCap are separated, because they mean different things", () => {
    /**
     * The whole point of the round. One says the caps bound, the other says the budget did, and
     * only the second justifies raising MAX_FUNNEL_CANDIDATES_TO_SCORE.
     */
    const manySources = Array.from({ length: 12 }, (_, i) =>
      cand(`nara:${i}`, i % 2 === 0 ? "nara" : "loc", 9 - i * 0.1)
    ).concat(Array.from({ length: 6 }, (_, i) => cand(`nasa:${i}`, "nasa", 3 - i * 0.1)));
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(manySources, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    // Every source is capped at 2 here, so the caps do the cutting, not the budget.
    expect(audit.cutBySourceCap).toBeGreaterThan(0);

    // A pool of distinct sources within their caps hits the budget instead.
    const distinct: FunnelCandidate[] = [
      cand("a:0", "archive", 9),
      cand("w:0", "wikimedia", 8),
      cand("n:0", "nasa", 7),
      cand("na:0", "nara", 6),
      cand("l:0", "loc", 5),
      cand("ia:0", "internet_archive", 4),
      cand("e:0", "europeana", 3),
      cand("ov:0", "openverse", 2),
    ];
    const budgetAudit = createArchiveSourcingAudit();
    buildDownloadShortlist(distinct, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, budgetAudit);
    expect(budgetAudit.cutByBudget).toBeGreaterThan(0);
    expect(budgetAudit.cutBySourceCap).toBe(0);
  });

  it("the beat outcome records what VisionGate did with them", () => {
    const audit = createArchiveSourcingAudit();
    recordBeatOutcome(audit, {
      candidatesFound: 25,
      downloaded: 4,
      visionJudged: 4,
      visionAccepted: 1,
      adopted: true,
    });
    expect(audit.candidatesFound).toBe(25);
    expect(audit.rejectedAfterDownload).toBe(3);
    expect(audit.adopted).toBe(1);
  });

  it("the line carries every field the audit asked for", () => {
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    recordBeatOutcome(audit, {
      candidatesFound: 25, downloaded: 4, visionJudged: 4, visionAccepted: 0, adopted: false,
    });
    const line = formatArchiveSourcingAudit("s1b6", audit);
    for (const field of [
      "beat=", "candidatesFound=", "afterBeatDedup=", "afterMetadata=", "afterSourceCap=",
      "downloadBudget=", "downloaded=", "visionJudged=", "visionAccepted=", "adopted=",
      "cutBySourceCap=", "cutByBudget=", "rejectedAfterDownload=",
    ]) {
      expect(line, field).toContain(field);
    }
  });

  it("an unmeasured stage prints as unknown, never as zero", () => {
    // "found nothing" is a finding; "nobody counted" is not, and they must not look the same.
    const line = formatArchiveSourcingAudit("s0b0", createArchiveSourcingAudit());
    expect(line).toContain("candidatesFound=?");
    expect(line).toContain("verdict=NOT_MEASURED");
  });
});

describe("RONDE 164 — the verdict tells the two failures apart", () => {
  const withStages = (over: Partial<ArchiveSourcingAudit>): ArchiveSourcingAudit => ({
    ...createArchiveSourcingAudit(),
    ...over,
  });

  it("candidates cut before VisionGate saw them — render 553's s1b6", () => {
    const audit = withStages({
      candidatesFound: 25, cutBySourceCap: 22, cutByBudget: 0,
      downloaded: 0, visionJudged: 0, visionAccepted: 0, adopted: 0,
    });
    expect(archiveSourcingVerdict(audit)).toBe("LOST_BEFORE_VISION");
  });

  it("candidates judged and refused — a different problem, a different fix", () => {
    const audit = withStages({
      candidatesFound: 25, cutBySourceCap: 22, cutByBudget: 0,
      downloaded: 4, visionJudged: 4, visionAccepted: 0, adopted: 0,
    });
    expect(archiveSourcingVerdict(audit)).toBe("REJECTED_BY_VISION");
  });

  it("nothing found at all is neither of those", () => {
    const audit = withStages({
      candidatesFound: 0, cutBySourceCap: 0, cutByBudget: 0,
      downloaded: 0, visionJudged: 0, visionAccepted: 0, adopted: 0,
    });
    expect(archiveSourcingVerdict(audit)).toBe("NO_CANDIDATES");
  });

  it("a beat with a picture says so and nothing else", () => {
    const audit = withStages({
      candidatesFound: 25, visionJudged: 3, visionAccepted: 1, adopted: 1,
    });
    expect(archiveSourcingVerdict(audit)).toBe("ADOPTED");
  });

  it("the render tally is what the next round needs before touching the budget", () => {
    /**
     * Built through recordBeatOutcome rather than by setting fields directly: derived counts like
     * rejectedAfterDownload are computed there, and a fixture that sets them by hand would test a
     * shape the render never produces.
     */
    const beat = (
      stages: Partial<ArchiveSourcingAudit>,
      outcome: Parameters<typeof recordBeatOutcome>[1]
    ): ArchiveSourcingAudit => {
      const a = withStages(stages);
      recordBeatOutcome(a, outcome);
      return a;
    };
    const lost = beat(
      { cutBySourceCap: 22, cutByBudget: 4 },
      { candidatesFound: 25, downloaded: 0, visionJudged: 0, visionAccepted: 0, adopted: false }
    );
    const refused = beat(
      { cutBySourceCap: 1, cutByBudget: 0 },
      { candidatesFound: 9, downloaded: 4, visionJudged: 4, visionAccepted: 0, adopted: false }
    );
    const line = summarizeArchiveSourcing([lost, refused, lost]);
    expect(line).toContain("LOST_BEFORE_VISION=2");
    expect(line).toContain("REJECTED_BY_VISION=1");
    expect(line).toContain("cutByBudget=8");
    expect(line).toContain("rejectedAfterDownload=4");
  });

  it("no beats, no tally — silence rather than a row of zeros", () => {
    expect(summarizeArchiveSourcing([])).toBe("");
  });
});

describe("RONDE 164 — are the top 3 archive candidates really the best 3?", () => {
  it("the scores on both sides of the cap are recorded, so the question has data", () => {
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    // Three from the cap plus whatever the backfill reclaimed — `taken` reports the shortlist
    // as it really is, so the capGap below compares what was downloaded against what was not.
    expect(audit.archive.taken.length).toBeGreaterThanOrEqual(3);
    // 20, not 22: RONDE 170 reclaimed two of them into the budget slack the caps left.
    expect(audit.archive.cut).toHaveLength(20);
    // Taken are the highest-ranked: every kept score is at least the best cut score.
    expect(Math.min(...audit.archive.taken)).toBeGreaterThanOrEqual(Math.max(...audit.archive.cut));
  });

  it("the line reports the gap between what was kept and what was cut", () => {
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    const line = formatArchiveSourcingAudit("s1b6", audit);
    expect(line).toContain("archiveTaken=[");
    expect(line).toContain("archiveCut=[");
    expect(line).toContain("capGap=");
  });

  it("a beat whose cut candidates were nearly as good is visible as a small gap", () => {
    /**
     * The measurement the brief asks for, stated as a number rather than a verdict: a cap is doing
     * its job when what it cuts scores materially below what it keeps. One beat cannot settle it,
     * so the line reports the gap and leaves the judgement to a render's worth of them.
     */
    const flat = Array.from({ length: 10 }, (_, i) => cand(`archive:${i}`, "archive", 5 - i * 0.001));
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(flat, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    const gap = Math.min(...audit.archive.taken) - Math.max(...audit.archive.cut);
    expect(gap).toBeLessThan(0.01);
    expect(formatArchiveSourcingAudit("s0b0", audit)).toContain("capGap=0.00");
  });
});

describe("RONDE 164 — the budget and the cap were NOT changed", () => {
  /**
   * The brief's condition: only adjust when production data justifies it, and no render carrying
   * RONDE 163 exists yet. These pin both numbers so a later round has to change them deliberately
   * rather than by drift — and so a mutation that moves either one is caught.
   */
  it("the download budget is unchanged at 6", () => {
    expect(MAX_FUNNEL_CANDIDATES_TO_SCORE).toBe(6);
  });

  it("the archive cap is unchanged at 3", async () => {
    const src = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(src).toContain("const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;");
    /**
     * And it still applies — to the CAP, which is what the constant governs.
     *
     * RONDE 170 did not raise it. This beat has two sources, so the caps fill four of a six-slot
     * budget and the remaining two used to be discarded; they are now filled from what the cap
     * refused. The cap's own share is unchanged, and the way to see that is the beat where the
     * budget is already full: there the backfill takes nothing and the archive gets exactly three.
     */
    const full = createArchiveSourcingAudit();
    const busyBeat = [
      ...Array.from({ length: 6 }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1)),
      ...Array.from({ length: 3 }, (_, i) => cand(`nara:${i}`, "nara", 8 - i * 0.1)),
      cand("wikimedia:0", "wikimedia", 7.5),
      cand("nasa:0", "nasa", 7.4),
    ];
    buildDownloadShortlist(busyBeat, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, full);
    expect(full.backfilledFromCap).toBe(0);
    expect(full.archive.taken).toHaveLength(3);
  });

  it("every other source's cap is unchanged", () => {
    const src = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(src).toContain("const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;");
    expect(src).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
  });
});

describe("RONDE 164 — wired into the render", () => {
  it("each beat gets its own audit and prints it", () => {
    expect(PIPE).toContain("const sourcingAudit = createArchiveSourcingAudit();");
    expect(PIPE).toContain('formatArchiveSourcingAudit(`s${scene.index}b${beat.index}`, sourcingAudit)');
  });

  it("candidatesFound is the raw retrieval count, not the post-slice one", () => {
    /**
     * The distinction render 553 turned on: 25 found, 8 after the metadata slice, 3 offered.
     * Recording the sliced number as "found" would hide the first of those two losses.
     */
    expect(PIPE).toContain("const candidatesFoundForBeat = funnelResult.candidates.length;");
    expect(PIPE).toContain("candidatesFound: candidatesFoundForBeat,");
  });

  it("VisionGate's own numbers come from VisionGate, not from a proxy", () => {
    expect(PIPE).toContain("visionJudged: scored.length,");
    expect(PIPE).toContain("visionAccepted: scored.filter((sc) => sc.visionResult.pass).length,");
  });

  it("the render prints the tally that decides the next round", () => {
    expect(PIPE).toContain("summarizeArchiveSourcing(visualDedup.archiveSourcingAudits)");
  });

  it("the audit changes no decision — it only counts", () => {
    /**
     * Nothing in the shortlist builder may branch on the audit. It is filled in at the end of a
     * decision that was already made.
     */
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    const from = funnel.indexOf("export function buildDownloadShortlist(");
    const body = funnel.slice(from, funnel.indexOf("\n}", from));
    expect(body).not.toMatch(/if\s*\(\s*audit/);
    expect(body).toContain("recordShortlistStage(audit, {");
  });
});
