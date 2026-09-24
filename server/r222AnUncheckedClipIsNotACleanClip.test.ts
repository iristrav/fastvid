/**
 * RONDE 222 §B — THE ARCHIVE RECORDED A JUDGEMENT NOBODY MADE.
 *
 * Video 574 delivered twenty-seven seconds of footage carrying a broadcaster's on-screen "5" logo —
 * roughly forty per cent of the film — and its render log contains not one `hasBakedEditText`
 * verdict. Nothing looked at that clip, and the archive held it as inspected and clean.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────────────────────
 *
 * `detectOnScreenTextInImages` returned `false` from four different places that are not answers:
 * no frames to send, a reply without the field, a timeout, a transport error. `false` reads as
 * "this clip carries no added text". `archiveIngestion` then wrote `hasBakedEditText: 0` into a
 * permanent row, and every later render short-circuits on that row instead of looking.
 *
 * One unanswered vision call became a standing claim about the pixels, for every future video.
 *
 * ── What this round does NOT do ────────────────────────────────────────────────────────────
 *
 * It does not tighten the gate. An unchecked clip is still ADMITTED and still USED — refusing
 * everything unjudged would empty the archive whenever the vision path is slow, budgeted out or
 * switched off, which is a far worse failure than the one being guarded against. The budget skip
 * keeps failing open, the beat gate keeps failing open, and no threshold moves.
 *
 * What changes is what gets written down. This is the same distinction the project already draws
 * for vision (APPROVED / REJECTED / UNCLEAR / NOT_ASKED) and for the retrieval budget; it was
 * missing only here.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const FILTER = fs.readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");
const INGEST = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

/* ═══════════ 1. the detector can say "I do not know" ═══════════ */

describe("R222 §1 — three answers, because there were always three", () => {
  it("THE VOCABULARY EXISTS", () => {
    expect(FILTER).toContain(`export type OverlayVerdict = "has_text" | "clean" | "not_asked"`);
  });

  it("the detector's own return type admits it", () => {
    expect(FILTER).toContain(
      "async function detectOnScreenTextInImages(dataUrls: string[]): Promise<boolean | null>"
    );
  });

  it("NO FRAMES IS NOT A CLEAN CLIP", () => {
    const fn = detector();
    expect(fn).toContain("if (dataUrls.length === 0) return null;");
  });

  it("A REPLY WITHOUT THE FIELD IS NOT A CLEAN CLIP", () => {
    const fn = detector();
    expect(fn).toContain(`if (typeof parsed.hasBakedEditText !== "boolean") return null;`);
    expect(fn).toContain(`if (typeof content !== "string") return null;`);
  });

  it("A TIMEOUT OR TRANSPORT ERROR IS NOT A CLEAN CLIP", () => {
    const fn = detector();
    const cat = fn.slice(fn.lastIndexOf("} catch"));
    expect(cat, "the catch still reports a clean clip").toContain("return null;");
    expect(cat).not.toContain("return false;");
  });

  it("THE DETECTOR NO LONGER HAS ANY `return false` PATH AT ALL", () => {
    /**
     * The property rather than the spelling: every exit is either a real boolean from the model or
     * an explicit `null`. A future edit that reintroduces a bare `false` here re-creates the defect.
     */
    const fn = detector();
    expect(fn).not.toContain("return false;");
  });
});

function detector(): string {
  const at = FILTER.indexOf("async function detectOnScreenTextInImages(");
  expect(at).toBeGreaterThan(0);
  return FILTER.slice(at, FILTER.indexOf("\nasync function extractVideoPreviewJpegs("));
}

/* ═══════════ 2. every not-an-answer path is named ═══════════ */

describe("R222 §2 — the verdict function names why nobody looked", () => {
  const fn = () => {
    const at = FILTER.indexOf("export async function archiveClipBakedEditTextVerdict(");
    return FILTER.slice(at, FILTER.indexOf("export async function archiveClipHasBakedEditText("));
  };

  it("a switched-off filter is not_asked, not clean", () => {
    expect(fn()).toContain("the overlay filter is switched off in this deployment");
  });

  it("a sampling policy that declined is not_asked", () => {
    expect(fn()).toContain("the overlay sampling policy skipped this clip");
  });

  it("an image the endpoint cannot read is not_asked", () => {
    expect(fn()).toContain("could not be prepared for vision");
  });

  it("a clip no frame could be pulled from is not_asked", () => {
    expect(fn()).toContain("no frame could be extracted from this clip");
  });

  it("EVERY not_asked CARRIES A REASON", () => {
    /** `NOT_ASKED` takes the reason as its only argument, so a reasonless one cannot be built. */
    expect(FILTER).toContain(
      `const NOT_ASKED = (reason: string): OverlayVerdictResult => ({ verdict: "not_asked", reason });`
    );
  });

  it("a spent budget is not_asked, and still allows the clip", () => {
    const at = FILTER.indexOf("if (maxChecks !== undefined && overlayChecksPerformed >= maxChecks)");
    const block = FILTER.slice(at, at + 1400);
    expect(block).toContain("the overlay budget was spent");
    expect(block, "the budget skip started rejecting clips").not.toContain("has_text");
  });
});

/* ═══════════ 3. the beat gate is unchanged — nothing was tightened ═══════════ */

describe("R222 §3 — the cascade still fails open", () => {
  it("THE BOOLEAN THE BEAT GATE USES STILL COLLAPSES not_asked TO false", () => {
    const at = FILTER.indexOf("export async function cachedClipHasBakedEditText(");
    const fn = FILTER.slice(at, FILTER.indexOf("export async function cachedClipBakedEditTextVerdict("));
    expect(fn).toContain(`return result.verdict === "has_text";`);
  });

  it("the standalone boolean does too", () => {
    const at = FILTER.indexOf("export async function archiveClipHasBakedEditText(");
    const fn = FILTER.slice(at, at + 500);
    expect(fn).toContain(`.verdict === "has_text"`);
  });

  it("NO NEW REJECTION was introduced anywhere in the filter", () => {
    /**
     * The one place a clip is refused is ingestion, and only on a real `has_text`. If a second
     * refusal appears, this round quietly became a gate-tightening round.
     */
    const refusals = [...INGEST.matchAll(/verdict === "has_text"/g)];
    expect(refusals.length).toBe(1);
  });

  it("the segment check keeps its fail-open, and says so explicitly", () => {
    const at = FILTER.indexOf("export async function archiveSegmentHasOnScreenText(");
    const fn = FILTER.slice(at, at + 1600);
    expect(fn).toContain("=== true");
  });
});

/* ═══════════ 4. the permanent row stops lying ═══════════ */

describe("R222 §4 — a clip nobody looked at is stored as unjudged", () => {
  it("THE FLAT ZERO IS GONE", () => {
    expect(INGEST, "every ingested clip is still recorded as inspected-and-clean").not.toContain(
      "hasBakedEditText: 0,"
    );
  });

  it("ONLY A REAL `clean` IS WRITTEN AS CLEAN; ANYTHING ELSE IS null", () => {
    expect(INGEST).toContain(`hasBakedEditText: overlay.verdict === "clean" ? 0 : null,`);
  });

  it("ingestion asks for the verdict, not the boolean", () => {
    expect(INGEST).toContain("cachedClipBakedEditTextVerdict(");
    expect(INGEST).not.toContain("cachedClipHasBakedEditText(");
  });

  it("an unjudged admission is announced, never silent", () => {
    const at = INGEST.indexOf(`if (overlay.verdict === "not_asked")`);
    expect(at, "an unchecked clip is admitted with no line in the log").toBeGreaterThan(0);
    const block = INGEST.slice(at, at + 500);
    expect(block).toContain("console.warn");
    expect(block).toContain("WITHOUT an on-screen-text verdict");
    expect(block, "the reason is not carried into the log").toContain("overlay.reason");
  });

  it("AN UNCHECKED CLIP IS STILL ADMITTED — the archive is not starved", () => {
    /**
     * The not_asked branch warns and falls through. If it ever returns, this round turned a
     * reporting fix into a rejection, and the archive empties whenever vision is unavailable.
     */
    const at = INGEST.indexOf(`if (overlay.verdict === "not_asked")`);
    const block = INGEST.slice(at, at + 500);
    expect(block).not.toContain("return null");
  });
});

/* ═══════════ 5. a not_asked is never remembered as a fact ═══════════ */

describe("R222 §5 — the memo holds verdicts, not artefacts", () => {
  it("ONLY A REAL VERDICT IS CACHED", () => {
    /**
     * The guard is unique in the file, and it must sit between the verdict function's start and
     * the single cache write — which is the whole claim.
     */
    const guard = FILTER.indexOf(`if (result.verdict !== "not_asked") {`);
    const fnStart = FILTER.indexOf("export async function cachedClipBakedEditTextVerdict(");
    const write = FILTER.indexOf(`overlayVerdictCache.set(cacheKey, result.verdict === "has_text");`);
    expect(guard, "nothing stops a not_asked being remembered as a fact").toBeGreaterThan(0);
    expect(fnStart).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(fnStart);
    expect(guard, "the cache write is not behind the guard").toBeLessThan(write);
  });

  it("the thrown-detector path returns before it can reach the cache", () => {
    /**
     * Scoped to the catch block itself. The earlier window also swept up the cache write that
     * legitimately follows the try/catch, which is reached only when nothing threw.
     */
    const at = FILTER.indexOf("[ArchiveFilter] overlay verdict failed for");
    expect(at).toBeGreaterThan(0);
    const catchStart = FILTER.lastIndexOf("} catch (err) {", at);
    const catchEnd = FILTER.indexOf("\n  }", at);
    const block = FILTER.slice(catchStart, catchEnd);
    expect(block).toContain("return NOT_ASKED(");
    expect(block, "a thrown detector was remembered as a clean clip").not.toContain(
      "overlayVerdictCache.set"
    );
  });

  it("the cache still stores the two real answers", () => {
    expect(FILTER).toContain(`overlayVerdictCache.set(cacheKey, result.verdict === "has_text");`);
  });
});
