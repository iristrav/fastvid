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

const RAW = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * Comments removed before anything is matched.
 *
 * Both RONDE 252 fixes carry a note QUOTING the line they replaced, and a matcher that reads prose
 * finds the defect in its own description. That happened twice while this round's tests were being
 * written, which is why it is the first thing the file does.
 */
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

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

  it("it declares the beat's review pool from what it was handed", () => {
    const at = CODE.indexOf("async function adoptClip(");
    const body = CODE.slice(at, at + 14000);
    expect(body).toContain("declareVisionReviewPool(");
    expect(body).toContain("noteRanked(");
    expect(body, "the pool is cut to the beat's own cap").toContain("maxShortlistPerBeat()");
  });
});

describe("4. nothing here raises what a route may fetch", () => {
  /**
   * THIS TEST CHANGES NO BUDGET AND MUST NOT BE READ AS PERMISSION TO. Fourteen adoption sites are
   * still fed by a fetch asking `count=1`, and each of those counts bounds how many candidates are
   * actually DOWNLOADED — `for (let i = 0; i < Math.min(pool.length, count); i++)`. Raising them
   * multiplies real transfers per beat, which is a decision with evidence behind it, not a tidy-up.
   *
   * What is pinned is only that the two stock routes which already ask for more still do.
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
