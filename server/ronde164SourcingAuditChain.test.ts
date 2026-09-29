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

describe("RONDE 164 — wired into the render", () => {

  it("the render prints the tally that decides the next round", () => {
    expect(PIPE).toContain("summarizeArchiveSourcing(visualDedup.archiveSourcingAudits)");
  });

});
