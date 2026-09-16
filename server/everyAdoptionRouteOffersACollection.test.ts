/**
 * RONDE 253 — EVERY ADOPTION ROUTE OFFERS A COLLECTION, AND THE TWO THAT DO NOT SAY WHY.
 *
 * ── Why this is repo-wide and RONDE 252's test was not ──────────────────────────────────────
 *
 * RONDE 252 repaired two loops and pinned them by NAME: it finds `for (const pool of adoptPools)`
 * and `function adoptBestCelebrityClip`, slices a window around each, and asserts no single-element
 * call survives inside it. That is the right test for a repair, and it is the wrong test for a
 * class: the twenty-ninth call site, added next round, is outside both windows.
 *
 * This is the class. `adoptClip` documents itself as "the multi-candidate entry point: 29 call
 * sites hand it the paths a route produced for one beat". It ranks what it is handed, declares the
 * beat's vision review pool from that ranking, and walks the result preferring a FIT. Every one of
 * those three jobs is a no-op on a list of one.
 *
 * So the rule is stated once, over the whole file, with its two exceptions named: a call may hand
 * over a single-element array ONLY where the fetch that produced it asked for exactly one
 * candidate. Europeana and the Openverse web-wide fallback do. There is no list to offer and
 * manufacturing one would be a fiction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { stripComments } from "./sourceScan.test.support";

const RAW = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * Comments removed before anything is matched.
 *
 * Both RONDE 252 fixes carry a note QUOTING the line they replaced, and a matcher that reads prose
 * finds the defect in its own description. That happened twice while RONDE 253's tests were being
 * written, which is why it is the first thing the file does.
 *
 * RONDE 254 replaced the one-line regex this used with `stripComments`. The regex matched from a
 * block-comment opener to the next closer without asking whether the opener was code, and this file
 * has one inside a string in a fetch header — so 3748 characters, including the whole
 * `fetchPexelsClips` declaration, were invisible to a guard whose entire job is to see the whole
 * file. Nothing about what this file asserts changed; it can now see everything it asserts over.
 */
const CODE = stripComments(RAW);

/** Every `adoptClip(` whose first argument is an array LITERAL, with that literal's contents. */
const arrayLiteralCalls = (): string[] =>
  [...CODE.matchAll(/adoptClip\(\s*\[([^\]]{0,80})\]/g)].map((m) => m[1]!.trim());

describe("1. no route hands the picture editor a choice of one", () => {
  it("exactly two call sites pass an array literal, and both are the single-winner routes", () => {
    expect(arrayLiteralCalls()).toEqual(["winner.path", "winner.path"]);
  });

  /**
   * The shapes render 585 measured. Named individually because a future regression will look like
   * one of them, and `toEqual` above would report it as an opaque diff.
   */
  it("the per-candidate shapes that caused reviewPool=1 are gone from the code", () => {
    for (const shape of [/adoptClip\(\s*\[\s*c\.path\s*\]/, /adoptClip\(\s*\[\s*candidate\.path\s*\]/]) {
      expect(CODE, `${shape} is a list of one inside a loop over a list`).not.toMatch(shape);
    }
  });

  /**
   * The general form, so a new variable name cannot reintroduce it. `[winner.path]` is allowed by
   * the count=1 rule below; anything else of the shape `[<ident>.path]` is the defect.
   */
  it("and no new variable name can reintroduce the shape", () => {
    const offenders = [...CODE.matchAll(/adoptClip\(\s*\[\s*([a-zA-Z_$][\w$]*)\.path\s*\]/g)]
      .map((m) => m[1]!)
      .filter((name) => name !== "winner");
    expect(offenders, `single-candidate adoptClip via: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("2. the two exceptions are exceptions for a stated reason", () => {
  /**
   * Read BACKWARD from each exception, because forward from the fetcher's NAME lands on its
   * definition rather than on the call — which is what the first version of this test did.
   */
  it("each single-winner call sits with a fetch that asked for one candidate", () => {
    const adoptions = [...CODE.matchAll(/adoptClip\(\s*\[winner\.path\]/g)];
    expect(adoptions).toHaveLength(2);
    const asked: string[] = [];
    for (const m of adoptions) {
      const before = CODE.slice(Math.max(0, m.index! - 700), m.index!);
      const fetcher = [...before.matchAll(/(fetchEuropeanaVideos|searchWebWideVideoClips)\(/g)].pop();
      expect(fetcher, "a single-winner adoption with no fetch above it").toBeTruthy();
      asked.push(fetcher![1]!);
      const call = before.slice(fetcher!.index!);
      expect(call, `${fetcher![1]} must ask for one candidate`).toMatch(
        /sceneIndex,\s*1\s*[,)]/
      );
    }
    expect(new Set(asked).size, "two distinct routes, not one counted twice").toBe(2);
  });

  it("and takes the first result rather than ranking a list it never asked for", () => {
    expect(CODE).toContain("const winner = euroHits[0]!;");
    expect(CODE).toContain("const winner = webWideCandidates[0]!;");
  });
});

describe("3. adoptClip is still the one entry point", () => {
  /**
   * A second adoption path would make this whole file unenforceable — the rule would hold over the
   * call sites it can see while the candidates went somewhere else. R194's review pool, the
   * lineage ledger and the beat shortlist all hang off this one function.
   */
  it("there is exactly one definition of it", () => {
    expect([...CODE.matchAll(/async function adoptClip\(/g)]).toHaveLength(1);
  });

  /**
   * The window is measured on the file as written. RONDE 254's `stripComments` blanks comments in
   * place instead of collapsing them, so a body that used to fit in 14000 characters now spans the
   * comments too — the code is identical, the offsets are the file's own. Widened rather than
   * loosened: every assertion below is the one that was here.
   */
  it("it declares the beat's review pool from what it was handed", () => {
    const at = CODE.indexOf("async function adoptClip(");
    const body = CODE.slice(at, at + 45000);
    expect(body).toContain("declareVisionReviewPool(");
    expect(body).toContain("noteRanked(");
    expect(body, "the pool is cut to the beat's own cap").toContain("maxShortlistPerBeat()");
  });
});

describe("4. nothing here raises what a route may fetch", () => {
  /**
   * THIS TEST CHANGES NO BUDGET AND MUST NOT BE READ AS PERMISSION TO.
   *
   * RONDE 253 wrote here that fourteen adoption sites were still fed by a fetch asking `count=1`.
   * RONDE 254 then measured it properly — fifteen sites hand the fetch's own result straight to
   * `adoptClip`, and the difference was a scan that could not see 3748 characters of the file — and
   * changed those fifteen to `MULTI_CANDIDATE_FETCH_COUNT`. The routes that fetch into a POOL still
   * ask for one, because their cardinality was never one; `aChoiceAskedForAsAChoice` holds that
   * line, both directions.
   *
   * What is pinned here is only that the two stock routes which already asked for more still do.
   */
  it("the last-resort stock routes still ask for the two they were asking for", () => {
    const at = CODE.indexOf("const stockTryCap");
    expect(at).toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 1400);
    expect([...block.matchAll(/sceneIndex,\s*2\s*,/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("and the per-beat shortlist cap is unchanged", () => {
    const shortlist = readFileSync(path.join(__dirname, "beatShortlist.ts"), "utf8");
    expect(shortlist).toContain("export function maxShortlistPerBeat(): number {");
    expect(CODE).not.toContain("MAX_VISION_REVIEW_CANDIDATES = 16");
  });
});
