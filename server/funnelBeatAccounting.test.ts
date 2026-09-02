/**
 * THE RETRIEVAL FUNNEL WAS INVISIBLE TO THE BEAT AUDIT.
 *
 * ── The production numbers this explains ────────────────────────────────────────────────────
 *
 * A render found 992 candidates, downloaded 56, and reported:
 *
 *     COVERAGE beats=21 REAL_ASSET=1 INTENTIONAL_TEXT=1 FALLBACK=5 NO_VALID_ASSET=14
 *     TOTAL beats=21 adopted=1 placeholder=6 rejected=4 noCandidates=10
 *
 * Read literally: ten beats were never offered a single candidate, and one beat out of
 * twenty-one has real footage. The per-beat lines say `offered=0` on eighteen of the twenty-one,
 * and `visionUnavailable=0` on every single one.
 *
 * That last number is the tell. If the vision budget had been the limiter, the beats it starved
 * would say so. It is zero everywhere, so the stated hypothesis — "the image gate was not even
 * asked 29 times because the budget ran out" — is not what these beats experienced.
 *
 * ── What the code actually says ─────────────────────────────────────────────────────────────
 *
 * `noteBeatCandidatesOffered`, `noteBeatEligible` and `noteBeatAdopted` had exactly one caller
 * each: `adoptClip`. The retrieval funnel — the route that performs the downloads, runs the vision
 * gate and picks the winner — adopts through its own block and never goes through `adoptClip`.
 *
 * This is the third time the same seam has been found. RONDE 53 discovered the funnel never called
 * `recordClipAdopt` ("this is the SECOND route that never did"). RONDE 62 discovered it never
 * counted still-vs-moving clips ("render 532 reported 0/4 moving for a video holding 22 clips").
 * The beat outcome audit was the one still open.
 *
 * So `offered=0` did not mean "no candidates". `noCandidates=10` did not mean ten empty beats.
 * `REAL_ASSET=1` counted one route's adoptions. The report described `adoptClip`'s bookkeeping,
 * not the video — and `resolveBeatStatus` turns `offered === 0` into the word `no_candidates`,
 * which is how a blind counter became a claim about retrieval.
 *
 * ── What these tests do NOT claim ───────────────────────────────────────────────────────────
 *
 * They do not claim the video is fine. A measurement defect explains why the numbers cannot be
 * trusted; it does not prove the coverage is good. It proves that nobody — including this
 * programme — could tell, and that the next production log finally can.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  createBeatOutcomeAudit,
  noteBeatAdopted,
  noteBeatCandidatesOffered,
  resolveBeatStatus,
  resolveBeatCoverage,
  beatRecord,
} from "./beatOutcomeAudit";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
/** Comments quote the defect being fixed; every count below is from executable code. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/* ═══════════════════════ the counter is fed by every adopting route ═══════════════════════ */

describe("beat audit — the funnel reports what it did", () => {
  /**
   * The regression. One caller means one route counted; the funnel is the route that does the
   * downloads, so a render whose beats are served by the funnel reported nothing at all.
   */
  it("more than one route counts the candidates a beat was offered", () => {
    const calls = [...CODE.matchAll(/noteBeatCandidatesOffered\(/g)].length;
    expect(
      calls,
      "only one route counts offered candidates — a beat served by any other route reports " +
        "offered=0, which resolveBeatStatus turns into the word no_candidates"
    ).toBeGreaterThanOrEqual(2);
  });

  it("the funnel records its adoption and its acceptance", () => {
    const funnelStart = CODE.indexOf("const FUNNEL_DOWNLOAD_CONCURRENCY");
    expect(funnelStart, "the funnel download loop has moved").toBeGreaterThan(-1);
    /** From the download loop to the end of the winner block that follows it. */
    const region = CODE.slice(funnelStart, funnelStart + 40_000);
    expect(region, "the funnel counts no offered candidates").toContain("noteBeatCandidatesOffered(");
    expect(region, "the funnel records no adoption in the beat audit").toContain("noteBeatAdopted(");
    expect(region, "the funnel records no acceptance in the beat audit").toContain("noteBeatEligible(");
  });

  /**
   * It must count what it actually handed to evaluation — files on disk — and not the shortlist
   * it hoped to download. `offered` means the same thing in `adoptClip`: "candidate paths handed
   * to the adopt path (files already on disk)".
   */
  it("counts the clips it really downloaded, not the shortlist it wanted", () => {
    const at = CODE.indexOf("noteBeatCandidatesOffered(\n          dedup.beatOutcomeAudit, scene.index, beat.index");
    expect(at, "the funnel's offered-count call has changed shape").toBeGreaterThan(-1);
    const call = CODE.slice(at, CODE.indexOf(");", at));
    expect(call).toContain("downloadedClips.length");
    expect(call, "the funnel counts candidates it never downloaded").not.toContain("toScore.length");
  });
});

/* ═══════════════════════ what the blind counter produced ═══════════════════════ */

describe("beat audit — an uncounted route reads as an empty beat", () => {
  /**
   * The mechanism, reproduced on the real functions. This is what the production report was
   * doing for every beat the funnel served, and it is why `noCandidates=10` was not a fact
   * about retrieval.
   */
  it("a beat nobody counted for is labelled no_candidates", () => {
    const audit = createBeatOutcomeAudit();
    const rec = beatRecord(audit, 0, 0);
    expect(resolveBeatStatus(rec, 0)).toBe("no_candidates");
    expect(resolveBeatCoverage(rec)).toBe("NO_VALID_ASSET");
  });

  /** And the same beat, once the route that served it reports, tells the truth. */
  it("the same beat reads as adopted once its route reports", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 4);
    noteBeatAdopted(audit, 0, 0, "pexels", "clip.mp4");
    const rec = beatRecord(audit, 0, 0);
    expect(resolveBeatStatus(rec, 0)).toBe("adopted");
    expect(resolveBeatCoverage(rec)).toBe("REAL_ASSET");
  });

  /**
   * The distinction that matters for the next log: a beat that WAS offered candidates and adopted
   * none is not the same as a beat nobody offered anything to. Both used to read `no_candidates`.
   */
  it("offered-but-nothing-adopted no longer reads as no_candidates", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 1, 6);
    const rec = beatRecord(audit, 0, 1);
    expect(resolveBeatStatus(rec, 0), "six offered candidates still read as none").not.toBe("no_candidates");
    expect(resolveBeatStatus(rec, 0)).toBe("unknown");
  });
});

/* ═══════════════════════ never looked ≠ looked and unsure ═══════════════════════ */

describe("vision gate — a decline is not a verdict", () => {
  const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

  /**
   * `unknown` was returned both by a model that looked and could not decide, and by a gate that
   * declined to look at all — budget spent, gate off, no readable frame. `beatVisualStatus` says
   * so in a comment and collapses them, and its own vocabulary has carried a `never_asked` member
   * since RONDE 166 that nothing could ever produce.
   *
   * They demand opposite responses: "looked, unsure" is a fact about the picture; "never looked"
   * is a fact about the render's budget. A beat that ends with no picture because nobody looked
   * must never be reported as a beat with no valid asset.
   */
  it("a judgement says whether a model actually looked", () => {
    expect(GATE, "BeatImageJudgement carries no evaluated flag").toMatch(/evaluated:\s*boolean/);
  });

  it("only a decline is marked as not evaluated", () => {
    const declined = GATE.slice(GATE.indexOf("const declined ="), GATE.indexOf("if (!beatImageRelevanceGateEnabled())"));
    expect(declined, "a decline no longer marks itself unevaluated").toContain("unknown(reason, false)");
  });

  /** Every route that reached a model — including one that errored mid-answer — counts as looked. */
  it("a model that looked and could not decide is still evaluated", () => {
    const helper = GATE.slice(GATE.indexOf("const unknown ="), GATE.indexOf("const declined ="));
    expect(helper, "the default for a no-verdict answer is no longer 'looked'").toMatch(
      /evaluated\s*=\s*true/
    );
  });

  /** A cached or stored verdict was earned by a real look and must not read as a decline. */
  it("cached and stored verdicts count as evaluated", () => {
    for (const marker of ["cached: true, evaluated: true", "evaluated: true,"]) {
      expect(GATE, `a reused verdict is reported as never looked (${marker})`).toContain(marker);
    }
  });

  /** The whole point is that a decline is distinguishable — not that declines stop happening. */
  it("the budget decline still exists and is still counted", () => {
    expect(GATE).toContain('declined("render judgement budget spent")');
    expect(GATE).toContain("state.judgementsSkipped++");
  });
});

/* ═══════════════════════ nothing was loosened ═══════════════════════ */

describe("no gate was weakened to make coverage look better", () => {
  const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

  /** The render ceiling and the per-beat ceiling keep their values and their env overrides. */
  it("the vision budgets are unchanged", () => {
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500)');
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(GATE).toContain('envInt("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", 24, 0, 500)');
  });

  /** The gate is still on by default, and the budget check still runs before any call. */
  it("the gate is still enabled by default and still checks its budget first", () => {
    expect(GATE).toContain('process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false"');
    expect(GATE).toContain("if (state.judgementAttempts >= maxBeatImageJudgementsPerRender())");
  });

  /** And this round added no new fallback route to inflate coverage. */
  it("no new placeholder route was added", () => {
    const fillTiers = [...CODE.matchAll(/noteBeatFillTier\(/g)].length;
    expect(fillTiers, "a new fallback route appeared").toBe(3);
  });
});

/* ═══════════════════════ §7 — the provider summary sees the funnel ═══════════════════════ */

describe("asset usage — assigned counts every adopting route", () => {
  /**
   * `formatAssetUsageSummary` derives `assigned` from ADOPTED events on the lineage ledger, and
   * the only emitter was `adoptClip`. The last production render therefore read
   * `pexels assigned=0`, `openverse assigned=0`, `internet_archive assigned=0` — every provider the
   * FUNNEL serves — while wikimedia, which came through adoptClip, read `assigned=2 rendered=1`.
   * The providers were not idle; their adoptions were filed by a route that recorded nothing.
   */
  it("more than one route records an ADOPTED lineage event", () => {
    const events = [...CODE.matchAll(/recordEvent\(\s*[^,]+,\s*"ADOPTED"/g)].length;
    expect(
      events,
      "only one route records ADOPTED — every provider served by any other route reports assigned=0"
    ).toBeGreaterThanOrEqual(2);
  });

  it("the funnel records its own adoption against the resolved record", () => {
    const at = CODE.indexOf("const adoptedRecord =");
    expect(at, "the funnel records no ADOPTED lineage event").toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 600);
    expect(block, "the funnel invents a lineage record instead of resolving one").toContain(
      ".resolve("
    );
    expect(block).toContain('"ADOPTED"');
  });

  /** An unresolvable candidate must record nothing rather than fabricate a record. */
  it("records nothing when the candidate has no lineage record", () => {
    const at = CODE.indexOf("const adoptedRecord =");
    const block = CODE.slice(at, at + 600);
    expect(block).toMatch(/if \(adoptedRecord/);
  });
});
