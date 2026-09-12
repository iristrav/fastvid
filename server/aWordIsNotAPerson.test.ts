import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  beatTextTagMatch,
  scoreCuratedAsset,
  PERSON_TAG_BONUS,
  BEAT_TEXT_WORD_BONUS,
} from "./curatedMediaSourcing";

/**
 * WHY A BRINK'S SECURITY VAN OPENED A DOCUMENTARY ABOUT THE FALL OF BERLIN.
 *
 * Render 578's first sentence, transcribed from the delivered film:
 *
 *     "Adolf Hitler envisioned a millennium-spanning Reich, yet his empire lay in ruins within
 *      just 12 years. Standing on the BRINK of utter defeat, his empire crumbling..."
 *
 * On screen for the first seventeen seconds, and for the closing nineteen: a modern armoured
 * security van with BRINKS painted down its side. 36.3 of 76 seconds, 47.6% of the film.
 *
 * The scorer had a rule that said this:
 *
 *     // Person-name guarantee: if a tag names a specific person AND the beat text
 *     // mentions that person → strong boost, clip is guaranteed to rank above generics.
 *     if (t.length >= 4 && bl.includes(t)) { score += 200; ... }
 *
 * It asked nothing about persons. Any asset tag of four characters or more occurring anywhere
 * inside the beat sentence — as a substring, not even a whole word — took 200 points, against 42
 * for an exact tag match and 85 for the strongest geographic evidence in the function. On a WWII
 * script, `bunker`, `reich`, `defeat`, `empire` and `berlin` are ordinary tags AND ordinary
 * narration words, so the guarantee fired constantly and always won.
 *
 * These tests fix the rule to its own description. They do not prove which tag the van carried —
 * that is in the operator's database, not in this repository — so nothing here asserts it.
 */

const asset = (tags: string[]) => ({ id: 1, title: "", tags, mediaType: "video" }) as never;

describe("a word the narration happens to use is not a person", () => {
  const BEAT = "Standing on the brink of utter defeat, his empire crumbling, his decision shocked the world.";

  it("A BRAND WORD IN THE SENTENCE NO LONGER BUYS THE PERSON BONUS", () => {
    const hit = beatTextTagMatch(["brink"], BEAT);
    expect(hit?.matched.toLowerCase()).toBe("brink");
    expect(hit?.isPerson, "'brink' is a noun, not somebody").toBe(false);
  });

  it("a real person mentioned in the beat still gets the guarantee", () => {
    const beat = "Whispers of Erwin Rommel's betrayal stung his pride.";
    const hit = beatTextTagMatch(["erwin rommel"], beat);
    expect(hit?.isPerson).toBe(true);
    expect(hit?.matched).toBe("Erwin Rommel");
  });

  it("THE PERSON WINS OVER THE COINCIDENCE, whatever order the tags are in", () => {
    const beat = "Joseph Goebbels whispered the unthinkable on the brink of defeat.";
    const hit = beatTextTagMatch(["brink", "defeat", "joseph goebbels"], beat);
    expect(hit?.isPerson).toBe(true);
    expect(hit?.tag).toBe("joseph goebbels");
  });

  it("and it is worth far more than the coincidence", () => {
    expect(PERSON_TAG_BONUS).toBeGreaterThan(BEAT_TEXT_WORD_BONUS * 3);
  });

  it("A COINCIDENCE NO LONGER OUTRANKS AN EXACT TAG MATCH", () => {
    /**
     * 42 is what this function pays for a tag that equals one of the beat's own curated tags —
     * the strongest ordinary evidence it has. A word that merely occurs in the sentence must
     * score below that, or the accident decides the shot. That was the whole failure.
     */
    expect(BEAT_TEXT_WORD_BONUS).toBeLessThan(42);
  });

  it("a substring is not a match any more", () => {
    // The old rule matched `rink` inside "brink" and `eich` inside "Reich".
    expect(beatTextTagMatch(["rink"], BEAT)).toBeNull();
    expect(beatTextTagMatch(["eich"], "a millennium-spanning Reich")).toBeNull();
  });

  it("but a whole word still matches, case and punctuation aside", () => {
    expect(beatTextTagMatch(["defeat"], BEAT)?.tag).toBe("defeat");
    expect(beatTextTagMatch(["reich"], "a millennium-spanning Reich, yet")?.matched).toBe("Reich");
  });

  it("short tags are still ignored", () => {
    expect(beatTextTagMatch(["on", "the", "his"], BEAT)).toBeNull();
  });

  it("an empty beat proves nothing", () => {
    expect(beatTextTagMatch(["erwin rommel"], "")).toBeNull();
    expect(beatTextTagMatch([], BEAT)).toBeNull();
  });

  it("a tag full of regex punctuation cannot break the scorer", () => {
    expect(() => beatTextTagMatch(["a(b[c", "**", "erwin rommel"], BEAT)).not.toThrow();
  });
});

describe("the score moves the way the rule says", () => {
  const BEAT = "Standing on the brink of utter defeat, his empire crumbling.";

  it("THE COINCIDENCE STILL SCORES — nothing is emptied, it just stops winning", () => {
    const coincidence = scoreCuratedAsset(asset(["brink"]), [], [], [], BEAT);
    const unrelated = scoreCuratedAsset(asset(["helicopter"]), [], [], [], BEAT);
    expect(coincidence).toBeGreaterThan(unrelated);
  });

  it("a named person still outranks a word coincidence by a wide margin", () => {
    const beat = "Erwin Rommel stood on the brink of utter defeat.";
    const person = scoreCuratedAsset(asset(["erwin rommel"]), [], [], [], beat);
    const word = scoreCuratedAsset(asset(["brink"]), [], [], [], beat);
    expect(person).toBeGreaterThan(word + 100);
  });

  it("THE BONUS IS PAID ONCE, however many words the asset shares", () => {
    /**
     * The old loop broke after its first hit; a rewrite that summed per tag would let a
     * many-tagged asset buy the same guarantee in instalments. `beatTextTagMatch` returns one
     * match or none, which is where that is settled.
     *
     * The scores below are not equal, and should not be: extra tags also match this function's
     * OTHER terms — the beat's visual tags at 22 apiece, and so on — which is ordinary evidence
     * doing its job. What may never happen is a second word-overlap bonus, so the gap is held
     * below one payment of it.
     */
    const one = scoreCuratedAsset(asset(["brink"]), [], [], [], BEAT);
    const many = scoreCuratedAsset(asset(["brink", "defeat", "empire"]), [], [], [], BEAT);
    expect(many - one).toBeLessThan(PERSON_TAG_BONUS);
    expect(beatTextTagMatch(["brink", "defeat", "empire"], BEAT)).not.toBeNull();
  });
});

describe("the rule and its comment say the same thing", () => {
  const SRC = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");

  it("the old substring test is gone from the scorer", () => {
    // Comments stripped first: the replacement's own note quotes the rule it replaced, and a
    // citation of a deleted line is not the deleted line.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("bl.includes(t)");
  });

  it("THE PERSON CHECK IS THE PIPELINE'S ONE DEFINITION, not a second copy", () => {
    expect(SRC).toContain("checkPersonName(matched, text).ok");
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code, "no hand-rolled name shape test beside it").not.toMatch(/[A-Z]\[a-z\]\+.*name/i);
  });
});
