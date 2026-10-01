/**
 * GENERIC IS NOT A CATEGORY — RONDE 617.
 *
 * ── What render 597 measured ────────────────────────────────────────────────────────────────
 *
 *     [SourceSkipped] provider=… reason=CATEGORY_AT_LIMIT category=generic used=4/4 scope=render
 *
 * RONDE 604 made that line audible and deliberately changed no number — a refusal that happens
 * out loud is the precondition for deciding whether it should happen at all. This round is that
 * decision.
 *
 * `stockVisualCategory` is a regex ladder whose entire vocabulary is Musk/Tesla/SpaceX:
 * gigafactory, solar, tesla, rocket, robot, factory, space. Everything else falls through to
 * `generic`. On a documentary about 1945 there is nothing else it CAN say — measured below, every
 * one of render 597's own subject queries classifies as `generic` — and `generic` is capped at 4
 * against a counter that lives on `dedup`, which is RENDER-wide. So the stock source closed after
 * the fourth adopted clip of the whole video.
 *
 * ── Measured, one harness, one line changed ─────────────────────────────────────────────────
 *
 *     documentary, counter at 4      BEFORE  all seven queries REFUSED
 *                                    AFTER   all seven asked
 *     musk video, counters at cap    BEFORE  gigafactory REFUSED, rocket REFUSED, factory asked
 *                                    AFTER   identical
 *
 * ── WHAT WAS NOT DONE ───────────────────────────────────────────────────────────────────────
 *
 * No limit moved. `STOCK_CATEGORY_LIMITS` is the table it was, `generic` is still 4 and still 2 on
 * a Musk topic, the named categories keep their quotas on every topic, and the two content
 * refusals — `blocked_model`, `blocked_offtopic` — are untouched. This gate counts; it does not
 * judge, and every gate that does judge still runs.
 *
 * ── VIDEO 623 — THE LADDER ITSELF WENT ─────────────────────────────────────────────────────
 *
 * The ladder's words were one subject's (Musk/Tesla/SpaceX), and so were its quotas. With that
 * subject's mode gone, every query is `generic` or `blocked_model`, no category has a quota, and
 * the two neighbours this file pinned as open are closed. The claims that were about every film —
 * generic is not a quota, a content refusal comes before any counting — are still asserted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { stockCategoryGateForTest } from "./videoPipeline";
import { isRejectedStockClip } from "./visualJudge";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Render 597's own subject queries, as RONDE 613 and 614 now build them. */
const R597_QUERIES = [
  "Adolf Hitler führerbunker",
  "Adolf Hitler eva braun",
  "Adolf Hitler moments",
  "Adolf Hitler soviet",
  "berlin 1945",
  "reichstag",
  "hermann göring munich",
];

/** The render-wide counter where render 597 spent most of its beats. */
const atCap = () => new Map<string, number>([["generic", 4], ["rocket", 2], ["factory", 2]]);
const gate = (q: string, used = new Map<string, number>()) => stockCategoryGateForTest(used, q);

/* ═══════════ §1 — the ladder has no subject's words ═══════════ */

describe("§1 — what the classifier says about any documentary", () => {
  it("EVERY ONE of render 597's queries classifies as generic", () => {
    for (const q of R597_QUERIES) expect(gate(q).category, q).toBe("generic");
  });

  it("and the ladder carries no subject's vocabulary", () => {
    const at = SRC.indexOf("function stockVisualCategory(");
    const body = SRC.slice(at, SRC.indexOf('return "generic";', at)).split("\n").filter((l) => !/^\s*\*/.test(l)).join("\n");
    for (const word of ["gigafactory", "solar", "tesla", "falcon", "spacex", "cybertruck"]) {
      expect(body, `${word} is back on the ladder`).not.toContain(word);
    }
  });
});

/* ═══════════ §2 — the defect and its repair ═══════════ */

describe("§2 — a render-wide quota nobody chose", () => {
  it("THE SOURCE IS ASKED, with the counter at the cap that used to shut it", () => {
    for (const q of R597_QUERIES) expect(gate(q, atCap()).atLimit, `${q} was refused`).toBe(false);
  });

  it("and it stays asked however far past the cap the render goes", () => {
    expect(gate("reichstag", new Map([["generic", 40]])).atLimit).toBe(false);
  });

  it("no subject has a gate of its own", () => {
    expect(SRC).not.toContain("muskTopic");
    expect(SRC).toContain("function categoryAtLimit(dedup: VisualDedupState, category: string): boolean {");
  });
});

/* ═══════════ §3 — NOTHING ABOUT FORM WAS RELAXED ═══════════ */

describe("§3 — what a clip IS is still refused", () => {
  it("fake footage is refused, on any topic and at any count", () => {
    const g = gate("a tabletop diorama of a city");
    expect(g.category).toBe("blocked_model");
    expect(g.atLimit, "blocked_model stopped refusing").toBe(true);
  });

  it("a dashcam clip is refused as stock for what it is", () => {
    expect(isRejectedStockClip("/x/pexels-dashcam-motorway.mp4", "dashcam on the motorway")).toBe(true);
  });

  it("and the content refusal is decided BEFORE the counting, so no count can excuse it", () => {
    const at = SRC.indexOf("function categoryAtLimit(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    const blocked = body.indexOf("categoryIsBlockedContent(category)");
    const counting = body.indexOf("dedup.usedCategories.get(category)");
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked, "the content refusal must come first").toBeLessThan(counting);
  });
});

/* ═══════════ §4 — the neighbours, closed ═══════════ */

describe("§4 — the same defect one category over: both closed", () => {
  it("a space-race documentary is not capped at two rockets", () => {
    const g = gate("rocket launch pad ignition", new Map([["rocket", 2], ["generic", 9]]));
    expect(g.category).toBe("generic");
    expect(g.atLimit).toBe(false);
  });

  it("a moon-landing documentary may search for its own subject", () => {
    const doc = gate("apollo 11 lunar module");
    expect(doc.category).toBe("generic");
    expect(doc.atLimit).toBe(false);
  });

  it("the code says so where the gate is", () => {
    expect(SRC).toContain("VIDEO 623 — BOTH NEIGHBOURS ARE CLOSED.");
  });
});
