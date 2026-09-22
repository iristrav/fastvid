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
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { stockCategoryGateForTest } from "./videoPipeline";

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
const atCap = () =>
  new Map<string, number>([
    ["generic", 4],
    ["tesla", 3],
    ["rocket", 2],
    ["solar", 1],
    ["gigafactory", 1],
    ["factory", 2],
  ]);

/* ═══════════ §1 — the ladder has no words for this film ═══════════ */

describe("§1 — what the classifier says about a 1945 documentary", () => {
  it("EVERY ONE of render 597's queries classifies as generic", () => {
    for (const q of R597_QUERIES) {
      expect(stockCategoryGateForTest(new Map(), q, false).category, q).toBe("generic");
    }
  });

  it("which is the fall-through, not a judgement — the ladder is Musk vocabulary", () => {
    const at = SRC.indexOf("function stockVisualCategory(");
    const body = SRC.slice(at, SRC.indexOf('return "generic";', at));
    for (const word of ["gigafactory", "solar", "tesla", "falcon", "spacex", "cybertruck"]) {
      expect(body, `${word} left the ladder`).toContain(word);
    }
  });
});

/* ═══════════ §2 — the defect and its repair ═══════════ */

describe("§2 — a render-wide quota nobody chose", () => {
  it("THE SOURCE IS ASKED, with the counter at the cap that used to shut it", () => {
    const used = atCap();
    for (const q of R597_QUERIES) {
      expect(stockCategoryGateForTest(used, q, false).atLimit, `${q} was refused`).toBe(false);
    }
  });

  it("and it stays asked however far past the cap the render goes", () => {
    const used = new Map<string, number>([["generic", 40]]);
    expect(stockCategoryGateForTest(used, "reichstag", false).atLimit).toBe(false);
  });

  it("A MUSK VIDEO IS UNCHANGED — generic still caps there, where the word means something", () => {
    const used = new Map<string, number>([["generic", 2]]);
    expect(stockCategoryGateForTest(used, "a warehouse interior", true).category).toBe("generic");
    expect(stockCategoryGateForTest(used, "a warehouse interior", true).atLimit).toBe(true);
  });

  it("the guard reads the topic, and nothing else", () => {
    expect(SRC).toContain('if (!muskTopic && category === "generic") return false;');
  });
});

/* ═══════════ §3 — NOTHING WAS RELAXED ═══════════ */

describe("§3 — every other refusal is the one it was", () => {
  it("the limits table is untouched", () => {
    expect(SRC).toContain("  generic: 4,");
    expect(SRC).toContain("  gigafactory: 1,");
    expect(SRC).toContain("  rocket: 2,");
  });

  it("A NAMED CATEGORY STILL CAPS ON A DOCUMENTARY — this change is about `generic` alone", () => {
    const used = atCap();
    const g = stockCategoryGateForTest(used, "assembly line manufacturing", false);
    expect(g.category).toBe("factory");
    expect(g.atLimit, "the named categories kept their quotas").toBe(true);
  });

  it("the two content refusals still refuse, on any topic and at any count", () => {
    for (const [q, cat] of [
      ["a tabletop diorama of a city", "blocked_model"],
      ["dashcam on the motorway", "blocked_offtopic"],
    ] as const) {
      const g = stockCategoryGateForTest(new Map(), q, false);
      expect(g.category).toBe(cat);
      expect(g.atLimit, `${cat} stopped refusing`).toBe(true);
    }
  });

  it("and they are refused BEFORE the counting, so no count can excuse them", () => {
    const at = SRC.indexOf("function categoryAtLimit(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    const blocked = body.indexOf('category === "blocked_model"');
    const guard = body.indexOf('if (!muskTopic && category === "generic")');
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked, "the content refusal must come first").toBeLessThan(guard);
  });
});

/* ═══════════ §4 — the neighbours, named and left alone ═══════════ */

describe("§4 — the same defect one category over, deliberately not fixed here", () => {
  /**
   * Asserted as CURRENT BEHAVIOUR, not as desired behaviour. Both are this round's defect one
   * notch further and neither has a render behind it; they belong to their own round with their
   * own measurement. Pinned so that whoever takes them can see exactly what changes.
   */
  it("a space-race documentary meets the wall one category over", () => {
    const used = new Map<string, number>([["rocket", 2]]);
    const g = stockCategoryGateForTest(used, "rocket launch pad ignition", false);
    expect(g.category).toBe("rocket");
    expect(g.atLimit, "still capped render-wide on a non-Musk topic").toBe(true);
  });

  it("and a film about the moon landing has its own subject in the blocklist", () => {
    /** `blocked_model` matches saturn|apollo|lunar|moon-landing|space shuttle. */
    const g = stockCategoryGateForTest(new Map(), "apollo 11 lunar module", false);
    expect(g.category).toBe("blocked_model");
    expect(g.atLimit).toBe(true);
  });

  it("the code says both out loud where the gate is", () => {
    expect(SRC).toContain("TWO NEIGHBOURS FOUND HERE AND DELIBERATELY NOT FIXED");
  });
});
