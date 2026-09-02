/**
 * THE GATE ANSWERED 61 TIMES AND THE REPORT COUNTED 16 OF THE ANSWERS.
 *
 * ── What render 562's ledger said ───────────────────────────────────────────────────────────
 *
 *     TOTAAL  offered=79  evaluated=16  accepted=5  rejected=11  never_asked=4  calls=61
 *
 * Read as written: sixty-one calls, sixteen verdicts, forty-five calls that produced nothing. That
 * would mean the gate timed out or errored three times out of four, and it is not what happened —
 * `vision_unavailable=0` on every single beat.
 *
 * ── What the code said ──────────────────────────────────────────────────────────────────────
 *
 * There are five `checkBeatRelevance` sites, and they are all the SAME gate:
 *
 *     generateGuaranteedBeatClip   route="guaranteed:<tier>"   spend ✓   verdict ✗
 *     the adopt path               route="adopt"               spend ✓   verdict ✗
 *     the archive beat gate        route="gate:<query>"        spend ✓   verdict ✗
 *     the motion-graphic card      route="motion_graphic"      spend ✗   verdict ✗
 *     the retrieval funnel         route="funnel:<source>"     spend ✓   verdict ✓
 *
 * Four reported their spend. One reported its verdict. So `vision_calls` counted four routes and
 * `vision_evaluated` counted one, and the two numbers were never comparable — which is exactly how
 * the gap read as forty-five failed calls.
 *
 * ── The fifth time this seam has been found ─────────────────────────────────────────────────
 *
 * R53 (`recordClipAdopt`), R62 (still/moving counters), R70 (the beat outcome audit), R86 (failed
 * asset registration), and now the verdict counter. Every one was a rule each route had to
 * remember; in every one most routes did not. Recording it per route a fifth time would fix this
 * render and leave the seam open, so the CALL records both — a route cannot report half.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
/** Comments quote the defect being fixed; every count below is from executable code. */
const CODE = PIPE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/* ═══════════════════════ one call, both counters ═══════════════════════ */

describe("the vision gate's answer is counted wherever it is asked", () => {
  /**
   * The regression, stated as the thing that was actually wrong: the gate is reached from four
   * places, and only the one that went through the wrapper reported what it heard.
   */
  it("no route calls the gate without going through the recorder", () => {
    /** The wrapper's own call is the one legitimate direct call; every other one is a route. */
    const wrapperAt = CODE.indexOf("async function judgeBeatClipRelevance(");
    const outsideWrapper =
      CODE.slice(0, wrapperAt) + CODE.slice(CODE.indexOf("return decision;", wrapperAt));
    const direct = [...outsideWrapper.matchAll(/await checkBeatRelevance\(/g)];
    expect(
      direct.length,
      "a route calls checkBeatRelevance directly — its verdict is counted by nothing, which is " +
        "how 61 calls came to report 16 verdicts"
    ).toBe(0);
  });

  /**
   * Five, not four: the motion-graphic card is judged by the same gate. It always DECLINES
   * (`placeholder: true` — a card drawn from the beat's own words has no subject to be wrong
   * about), and that decline is a real per-beat outcome the ledger should show as never_asked.
   */
  it("every gate call goes through judgeBeatClipRelevance", () => {
    const wrapped = [...CODE.matchAll(/await judgeBeatClipRelevance\(/g)];
    expect(wrapped.length, "the gate's call sites are not all wrapped").toBe(5);
  });

  /** And the wrapper is the ONLY thing that calls the gate itself. */
  it("the wrapper is the single point that reaches the gate", () => {
    const at = CODE.indexOf("async function judgeBeatClipRelevance(");
    expect(at, "judgeBeatClipRelevance has moved").toBeGreaterThan(-1);
    const body = CODE.slice(at, CODE.indexOf("\n}", CODE.indexOf("return decision;", at)));
    expect(body).toContain("await checkBeatRelevance({");
    expect(body, "the wrapper does not count the spend").toContain("noteVisionSpend(");
    expect(body, "the wrapper does not count the verdict").toContain("noteBeatVisionVerdict(");
  });

  /**
   * The verdict must be recorded in exactly one place. A route keeping its own copy is the seam
   * this change exists to close, and would also double-count that route's beats.
   */
  it("exactly one place records a verdict", () => {
    const calls = [...CODE.matchAll(/noteBeatVisionVerdict\(/g)];
    expect(
      calls.length,
      "a route records its own verdict again — its beats are counted twice and the seam is back"
    ).toBe(1);
  });

  /** Likewise the spend: one recorder, so the two counters always cover the same set of routes. */
  it("exactly one place records the spend", () => {
    expect([...CODE.matchAll(/onSpend:/g)].length).toBe(1);
  });
});

/* ═══════════════════════ what the verdict is allowed to mean ═══════════════════════ */

describe("a decline is not a rejection", () => {
  /**
   * `evaluated === false` means the gate did not LOOK — budget spent, gate off, nothing to judge.
   * Mapping it to `rejected` would report the render's own budget as a fact about the catalogue,
   * which is the reading this whole vocabulary exists to prevent.
   */
  it("an unevaluated decision is never_asked, not rejected or unclear", () => {
    const at = CODE.indexOf("async function judgeBeatClipRelevance(");
    const body = CODE.slice(at, CODE.indexOf("return decision;", at));
    const mapping = body.slice(body.indexOf("noteBeatVisionVerdict("));
    expect(mapping).toMatch(/decision\.evaluated === false\s*\?\s*"never_asked"/);
    expect(mapping, "a decline is reported as a rejection").not.toMatch(
      /evaluated === false\s*\?\s*"rejected"/
    );
  });

  /** The other three arms, so the mapping cannot quietly collapse into one bucket. */
  it("maps fits, does_not_fit and everything else apart", () => {
    const at = CODE.indexOf("async function judgeBeatClipRelevance(");
    const mapping = CODE.slice(at, CODE.indexOf("return decision;", at));
    expect(mapping).toMatch(/verdict === "fits"[\s\S]{0,40}"accepted"/);
    expect(mapping).toMatch(/verdict === "does_not_fit"[\s\S]{0,40}"rejected"/);
    expect(mapping).toContain('"unclear"');
  });
});

/* ═══════════════════════ the counters stay two numbers ═══════════════════════ */

describe("spend and verdict remain separate measurements", () => {
  const LEDGER = fs.readFileSync(path.join(__dirname, "beatOutcomeAudit.ts"), "utf8");

  /**
   * They are not redundant and must not be merged. A cached verdict costs no call and is still a
   * verdict; a call that times out costs a call and yields none. What was wrong was that they
   * counted different sets of ROUTES, not that there were two of them.
   */
  it("the ledger still reports both", () => {
    expect(LEDGER).toContain("vision_calls=${rec.visionJudged}");
    expect(LEDGER).toContain("vision_evaluated=${evaluated}");
  });

  it("evaluated is still the sum of the three verdicts and nothing else", () => {
    expect(LEDGER).toContain(
      "const evaluated = rec.visionAccepted + rec.visionRejected + rec.visionUnclear;"
    );
  });

  /** `never_asked` is deliberately outside that sum — it is not a verdict. */
  it("never_asked is reported but not counted as a verdict", () => {
    expect(LEDGER).toContain("vision_never_asked=${rec.visionNeverAsked}");
    expect(
      LEDGER,
      "never_asked was folded into evaluated — a beat nobody looked at now reads as judged"
    ).not.toContain("rec.visionUnclear + rec.visionNeverAsked");
  });
});

/* ═══════════════════════ nothing about the gate itself changed ═══════════════════════ */

describe("this round only changed who counts", () => {
  const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

  it("the budgets are untouched", () => {
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500)');
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(GATE).toContain('envInt("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", 24, 0, 500)');
  });

  it("the gate is still on by default", () => {
    expect(GATE).toContain('process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false"');
  });

  /** The four routes still identify themselves, so the log can still tell them apart. */
  it("each route still names itself to the gate", () => {
    for (const route of ['route: "adopt"', "route: `funnel:", "route: `guaranteed:", 'route: queryLabel ?']) {
      expect(CODE, `the ${route} route lost its label`).toContain(route);
    }
  });
});
