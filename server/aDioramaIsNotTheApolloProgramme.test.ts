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
 *
 * ── VIDEO 623 — AND THEN THE TOPIC HALF WENT ────────────────────────────────────────────────
 *
 * "Whose film this is" was only ever asked for one subject: the Musk/SpaceX videos, the only
 * films on which the other space programmes were refused. That subject's mode is gone, so the
 * question is gone with it — the Apollo programme is askable on every film — and the rocket and
 * space quotas this file pinned as "the cap this round did not take" went too. What a clip IS
 * (a diorama, a render, a miniature) is still refused on every subject, first, before anything
 * is counted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { stockCategoryGateForTest } from "./videoPipeline";
import { isRejectedStockClip } from "./visualJudge";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const gate = (query: string, used = new Map<string, number>()) => stockCategoryGateForTest(used, query);

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
  it("THE SUBJECT IS ASKED FOR, on every film", () => {
    for (const q of MOON_DOC) {
      expect(gate(q).atLimit, `${q} is still refused`).toBe(false);
      expect(gate(q).category, q).toBe("generic");
    }
  });
});

/* ═══════════ §2 — no film has a mode of its own ═══════════ */

describe("§2 — no subject decides what another subject may show", () => {
  it("the Musk-only refusals and their sanitiser are gone", () => {
    expect(SRC).not.toContain("function sanitizeSceneForMuskTopic(");
    expect(SRC).not.toContain('"blocked_other_programme"');
  });
});

/* ═══════════ §3 — NOTHING ABOUT FAKE FOOTAGE WAS RELAXED ═══════════ */

describe("§3 — a diorama is a diorama on any subject", () => {
  it("fake footage is refused", () => {
    for (const q of FAKE) {
      expect(gate(q).category).toBe("blocked_model");
      expect(gate(q).atLimit, `${q} became askable`).toBe(true);
    }
  });

  it("a dashcam clip is still refused as stock for what it is", () => {
    expect(isRejectedStockClip("/x/pexels-dashcam-motorway.mp4", "dashcam on the motorway")).toBe(true);
  });

  it("A CONTENT REFUSAL IS STILL DECIDED BEFORE ANY COUNTING", () => {
    const at = SRC.indexOf("function categoryAtLimit(");
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    const blocked = body.indexOf("categoryIsBlockedContent(category)");
    const counting = body.indexOf("dedup.usedCategories.get(category)");
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked, "a count could excuse a blocked category").toBeLessThan(counting);
  });
});

/* ═══════════ §4 — one question, one answer ═══════════ */

describe("§4 — the readers cannot disagree", () => {
  it("every reader of the blocked category asks the same predicate", () => {
    /** ONE ROUTE: the predicate is the VisualJudge's; the pipeline's query-level reader imports it. */
    const VJ = readFileSync(join(__dirname, "visualJudge.ts"), "utf8");
    const at = VJ.indexOf("function categoryIsBlockedContent(");
    expect(at, "the shared predicate is gone").toBeGreaterThan(-1);
    expect(VJ.slice(at, VJ.indexOf("\n}", at))).toContain('return category === "blocked_model";');
    expect(SRC).not.toContain("function categoryIsBlockedContent(");
  });

  it("RONDE 617's rule still holds — generic does not gate a documentary", () => {
    expect(gate("adolf hitler führerbunker").category).toBe("generic");
    expect(gate("adolf hitler führerbunker").atLimit).toBe(false);
  });

  it("THE CAP RONDE 617 LEFT OPEN IS CLOSED: rockets and space have no quota", () => {
    const used = new Map<string, number>([["rocket", 2], ["space", 1], ["generic", 50]]);
    expect(gate("rocket launch pad ignition", used).atLimit).toBe(false);
    expect(gate("astronaut in orbit", used).atLimit).toBe(false);
  });
});
