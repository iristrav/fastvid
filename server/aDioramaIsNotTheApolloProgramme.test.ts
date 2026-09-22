/**
 * A DIORAMA IS NOT THE APOLLO PROGRAMME — RONDE 621.
 *
 * ── One list doing two jobs ─────────────────────────────────────────────────────────────────
 *
 * `blocked_model` matched all of this, and `categoryAtLimit` refused the category unconditionally,
 * on every topic:
 *
 *     miniature | diorama | tabletop | toy | model rocket | scale model | vhs | glitch | sci-fi
 *     | cgi | saturn | apollo | lunar | moon-landing | moon-surface | space shuttle | shuttle
 *
 * The first nine words say THIS FOOTAGE IS FAKE, which is true of any film ever made. The last
 * seven say THIS IS A DIFFERENT SPACE PROGRAMME THAN SPACEX — true of a Musk video, and the entire
 * subject of a film about the moon landing. On such a film every query for its own subject was
 * refused before a provider was asked, and no log line could explain why.
 *
 * ── Why this and not the caps ───────────────────────────────────────────────────────────────
 *
 * RONDE 617 named two neighbours and fixed neither: this block, and `rocket`/`space` capped at 2
 * and 1 render-wide on every topic. Only one is taken here, deliberately. A quota of two still
 * yields two clips; a block yields none, and no amount of searching can satisfy it. The cap is
 * still open and still has no render behind it.
 *
 * ── The split is by MEANING, not by topic ───────────────────────────────────────────────────
 *
 * The fake-footage half refuses everywhere — a diorama is a diorama on any subject — and only the
 * "other programme" half asks whose film this is. The classifier knows the query and not the
 * topic; the gate knows the topic and not the query; so the classifier names the refusal and the
 * gate decides whether it binds.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { stockCategoryGateForTest } from "./videoPipeline";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const gate = (query: string, muskTopic: boolean) =>
  stockCategoryGateForTest(new Map(), query, muskTopic);

/** The subject of a film about the moon landing. */
const MOON_DOC = [
  "apollo 11 lunar module",
  "saturn v launch 1969",
  "space shuttle columbia",
  "moon landing footage",
];

/** Footage that is a model or a rendering, whatever the film is about. */
const FAKE = ["tabletop diorama city", "cgi rocket animation", "scale model spacecraft"];

/* ═══════════ §1 — the film about the moon landing ═══════════ */

describe("§1 — a documentary may search for its own subject", () => {
  it("THE SUBJECT IS ASKED FOR, where every one of these was refused", () => {
    for (const q of MOON_DOC) {
      expect(gate(q, false).atLimit, `${q} is still refused`).toBe(false);
    }
  });

  it("and it is named rather than silently reclassified", () => {
    for (const q of MOON_DOC) {
      expect(gate(q, false).category).toBe("blocked_other_programme");
    }
  });
});

/* ═══════════ §2 — THE MUSK VIDEO IS UNCHANGED ═══════════ */

describe("§2 — on a SpaceX film these are still the wrong programme", () => {
  it("ALL FOUR ARE STILL REFUSED when the film is a Musk topic", () => {
    for (const q of MOON_DOC) {
      expect(gate(q, true).atLimit, `${q} leaked onto a Musk video`).toBe(true);
    }
  });

  it("and the Musk-only scene sanitiser refuses them too — it never runs elsewhere", () => {
    /**
     * `sanitizeSceneForMuskTopic` returns early unless the film IS a Musk topic, so both refusals
     * apply there in full. The split exists for the films that function never sees.
     */
    const at = SRC.indexOf("function sanitizeSceneForMuskTopic(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    expect(body).toContain('if (!isMuskTeslaTopic(videoTitle, scene.text)) return;');
    expect(body).toContain('cat === "blocked_other_programme"');
  });
});

/* ═══════════ §3 — NOTHING ABOUT FAKE FOOTAGE WAS RELAXED ═══════════ */

describe("§3 — a diorama is a diorama on any subject", () => {
  it("fake footage is refused on a documentary", () => {
    for (const q of FAKE) {
      expect(gate(q, false).category).toBe("blocked_model");
      expect(gate(q, false).atLimit, `${q} became askable`).toBe(true);
    }
  });

  it("and on a Musk video, exactly as before", () => {
    for (const q of FAKE) expect(gate(q, true).atLimit).toBe(true);
  });

  it("the off-topic list is untouched on both", () => {
    expect(gate("dashcam on the motorway", false).category).toBe("blocked_offtopic");
    expect(gate("dashcam on the motorway", false).atLimit).toBe(true);
    expect(gate("dashcam on the motorway", true).atLimit).toBe(true);
  });

  it("A CONTENT REFUSAL IS STILL DECIDED BEFORE ANY COUNTING", () => {
    const at = SRC.indexOf("function categoryAtLimit(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    const blocked = body.indexOf("categoryIsBlockedContent(category, muskTopic)");
    const counting = body.indexOf("dedup.usedCategories.get(category)");
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked, "a count could excuse a blocked category").toBeLessThan(counting);
  });
});

/* ═══════════ §4 — one question, one answer ═══════════ */

describe("§4 — the readers cannot disagree", () => {
  it("every reader of the blocked categories asks the same predicate", () => {
    /** Two literal readers is how the two jobs came to share one list. */
    const literal = [...SRC.matchAll(/category === "blocked_model" \|\| category === "blocked_offtopic"/g)];
    expect(literal.length, "a second place decides this on its own again").toBe(1);
    const at = SRC.indexOf("function categoryIsBlockedContent(");
    expect(at, "the shared predicate is gone").toBeGreaterThan(-1);
    expect(SRC.slice(at, SRC.indexOf("\n}", at))).toContain(
      'return category === "blocked_other_programme" && muskTopic;'
    );
  });

  it("and RONDE 617's rule still holds — generic does not gate a documentary", () => {
    expect(gate("adolf hitler führerbunker", false).category).toBe("generic");
    expect(gate("adolf hitler führerbunker", false).atLimit).toBe(false);
  });

  it("THE CAP THIS ROUND DID NOT TAKE is still there, and still says so", () => {
    /** Pinned as current behaviour so the remaining half cannot be forgotten. */
    const used = new Map<string, number>([["rocket", 2]]);
    expect(stockCategoryGateForTest(used, "rocket launch pad ignition", false).atLimit).toBe(true);
  });
});
