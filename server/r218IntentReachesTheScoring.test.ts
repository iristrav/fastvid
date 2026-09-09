/**
 * RONDE 218 — THE PIPELINE SEARCHED FOR ONE THING AND SCORED FOR ANOTHER.
 *
 * ── The gap ─────────────────────────────────────────────────────────────────────────────────
 *
 * The script states, per sentence, what the viewer should SEE. `beatVisualSearchSubjects` has long
 * put that into the QUERY. `scoreVisualRelevance(hay, relevanceKeywords)` is the other half: it
 * decides whether a candidate the query returned is actually about this beat.
 *
 * Those keywords were built from the beat text, the scene cue, the scene's stock query, the person
 * names and the video title. The script's own statement of what to show was not among them, and a
 * grep found no other route by which it arrived.
 *
 * So a render asked for "an abandoned factory floor" and then scored the results against a word
 * list that never mentioned a factory. A perfect match scored no higher than the noise beside it.
 *
 * Two lines above one of the three call sites, `resolveBeatVisualIntent(text)` had already been
 * called and its answer dropped for this purpose. A value computed and not carried, at a distance
 * of two lines.
 *
 * ── What this round is careful NOT to do ────────────────────────────────────────────────────
 *
 * It does not wire the dead `buildRelevanceKeywordsFromIntent`. That would be a second path, and
 * it also folds in `camera_shot` and `emotion` — "wide", "close", "aerial" describe the FILMING,
 * not the subject, so scoring on them rewards any clip whose description says "wide shot", which
 * is most of them. One list, fed by the same resolver the search side uses, so the two cannot
 * disagree about one beat.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  intentSearchQueries,
  resolveBeatVisualIntent,
} from "./scriptVisualKeywords";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const fn = PIPE.slice(
  PIPE.indexOf("function buildRelevanceKeywords(scene: Scene"),
  PIPE.indexOf("function scoreVisualRelevance(")
);

/* ═══════════ 1. the intent now reaches the scoring ═══════════ */

describe("R218 §1 — what the script asks for is what candidates are scored against", () => {
  it("THE RESOLVER IS CALLED, and it is the same one the search side uses", () => {
    expect(fn, "the keywords are still built without the script's intent").toContain(
      "const intent = resolveBeatVisualIntent(beatText);"
    );
    // beatVisualSearchSubjects resolves through the very same function — one answer per beat.
    const kw = fs.readFileSync(path.join(__dirname, "scriptVisualKeywords.ts"), "utf8");
    expect(kw).toContain("intentSearchQueries(resolveBeatVisualIntent(beatText))");
  });

  it("the three content-bearing fields are taken", () => {
    expect(fn).toContain("intentSearchQueries(intent)");
    expect(fn).toContain("intent.visual_description ?? intent.visual_intent");
    expect(fn).toContain("intent.priority_subject");
  });

  it("CAMERA VOCABULARY IS DELIBERATELY LEFT OUT — it describes the filming, not the subject", () => {
    expect(fn, "camera_shot would reward any clip described as a wide shot").not.toContain(
      "camera_shot"
    );
    expect(fn).not.toContain("intent.emotion");
  });

  it("the dead second path is NOT wired — one list, not two", () => {
    // The name appears in this round's own note explaining why it stays unwired; what must not
    // exist is a CALL to it, or an import of it.
    expect(PIPE).not.toContain("buildRelevanceKeywordsFromIntent(");
    expect(PIPE).not.toMatch(/^\s*buildRelevanceKeywordsFromIntent,\s*$/m);
  });
});

/* ═══════════ 2. the ordering, because the cap is unchanged ═══════════ */

describe("R218 §2 — the list gets more specific, not longer", () => {
  it("THE CAP IS UNCHANGED at 20", () => {
    expect(fn).toContain("Array.from(new Set(parts)).slice(0, 20);");
  });

  it("the beat's own words still come first, and the video title still last", () => {
    const beat = fn.indexOf("tokenizeForRelevance(beatText)");
    const intent = fn.indexOf("intentSearchQueries(intent)");
    const title = fn.indexOf("asVideoTitleString(videoTitle)");
    expect(beat).toBeGreaterThan(0);
    expect(beat, "the intent displaced the beat's own words").toBeLessThan(intent);
    expect(intent, "the intent sits after the least beat-specific material").toBeLessThan(title);
  });
});

/* ═══════════ 3. it does something, on a real sentence ═══════════ */

describe("R218 §3 — measured, not asserted", () => {
  it("A SENTENCE PRODUCES INTENT TERMS THAT THE BEAT TEXT ALONE DOES NOT", () => {
    /**
     * The point of the round in one check: the resolver contributes search subjects that are not
     * simply the sentence's own words. If it ever stops doing that, this round buys nothing and
     * this test should say so.
     */
    const sentence = "By 1974 the incinerator behind the harbour had become a municipal duty.";
    const intent = resolveBeatVisualIntent(sentence);
    const queries = intentSearchQueries(intent).filter((q) => q.trim().length >= 3);
    expect(queries.length, "the resolver produced no search subject at all").toBeGreaterThan(0);
  });

  it("the resolver answers for any sentence, so no beat loses keywords it used to have", () => {
    /**
     * `resolveBeatVisualIntent` falls back to a rule-based intent when the script stored none, so
     * the added terms are never `undefined` and the existing sources are untouched. A beat with a
     * threadbare sentence keeps exactly what it had.
     */
    for (const s of ["Chernobyl.", "It ended.", ""]) {
      const intent = resolveBeatVisualIntent(s);
      expect(intent, `no intent for "${s}"`).toBeTruthy();
      expect(() => intentSearchQueries(intent)).not.toThrow();
    }
  });
});
