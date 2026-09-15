/**
 * RONDE 250 — THE BUILDER RONDE 249 PROMOTED TO FIRST PLACE WITHOUT LOOKING AT IT.
 *
 * RONDE 249 put `buildPersonCelebrityVideoQueries` ahead of the twelve-entry entity table on every
 * YouTube route, because the script's person is better evidence than a fixed list. It never checked
 * what that builder emits. On render 584's own sentence it emitted this:
 *
 *     "Kris Jenner Beverly Hills Los Angeles"   ← the typed question
 *     "Kris Jenner Los Angeles"                 ← the typed question
 *     "Kris Jenner inside"                      ← the three longest words of the sentence,
 *     "Kris Jenner angeles"                        appended one by one …
 *     "Kris Jenner conference"
 *     "Kris Jenner"                             ← the best query, sixth
 *     "Kris Jenner inside angeles conference"   ← … and joined together
 *
 * Those four are the exact strings the render's log carried, and this is where they were made:
 * `tokenizeForRelevance(clean).filter((t) => t.length >= 4).slice(0, 3)` — long enough and early
 * enough, which is the positional heuristic RONDE 71 removed from `extractBeatSubject` for
 * producing "berlin under constant". It survived here.
 *
 * It also appended words of the person's own name, so "Adolf Hitler" asked for "Adolf Hitler adolf".
 */
import { describe, expect, it } from "vitest";
import { buildPersonCelebrityVideoQueries } from "./videoPipeline";

/** Render 584, scene 2, beat 0. */
const RENDER_584 = "Inside a Los Angeles conference room, Kris Jenner watches the Beverly Hills deal close in 2022.";
const HITLER = "In April 1945, Adolf Hitler married Eva Braun in the Berlin bunker.";

const asked = (person: string, beat: string, i = 0): string[] =>
  buildPersonCelebrityVideoQueries(person, beat, i);

describe("1. sentence debris no longer rides behind the name", () => {
  it("the four queries render 584 actually sent are gone", () => {
    const qs = asked("Kris Jenner", RENDER_584).map((q) => q.toLowerCase());
    for (const junk of [
      "kris jenner inside",
      "kris jenner angeles",
      "kris jenner conference",
      "kris jenner inside angeles conference",
    ]) {
      expect(qs, junk).not.toContain(junk);
    }
  });

  /** "Los Angeles" is a place; "angeles" on its own is half of one. */
  it("and no query carries a bare fragment of a multi-word place", () => {
    for (const q of asked("Kris Jenner", RENDER_584)) {
      const low = q.toLowerCase();
      if (!low.includes("angeles")) continue;
      expect(low, `"${q}" has "angeles" without "los"`).toMatch(/\blos angeles\b/);
    }
  });

  it("nor a word of the person's own name, twice over", () => {
    for (const q of asked("Adolf Hitler", HITLER, 1)) {
      expect(q.toLowerCase(), q).not.toBe("adolf hitler adolf");
      expect(q.toLowerCase().split(/\s+/).filter((w) => w === "adolf").length, q).toBeLessThan(2);
    }
  });
});

describe("2. what it asks instead", () => {
  it("the bare name is near the front, not sixth", () => {
    const qs = asked("Kris Jenner", RENDER_584);
    const at = qs.indexOf("Kris Jenner");
    expect(at, "the bare name must be asked").toBeGreaterThan(-1);
    expect(at, "it came sixth of seven on render 584").toBeLessThan(3);
  });

  /**
   * And it stays there. It used to sit inside the rotation, so which beat index came up decided
   * how late the plainest question was asked.
   */
  it("wherever the beat sits in the rotation", () => {
    for (const i of [0, 1, 2, 3, 7]) {
      expect(asked("Kris Jenner", RENDER_584, i).indexOf("Kris Jenner"), `beat ${i}`).toBeLessThan(3);
    }
  });

  it("the typed question still leads, with the place the beat named", () => {
    expect(asked("Kris Jenner", RENDER_584)[0]).toBe("Kris Jenner Beverly Hills Los Angeles");
    expect(asked("Adolf Hitler", HITLER, 1)[0]).toBe("Adolf Hitler Eva Braun Berlin");
  });

  /**
   * THE SOURCE THAT SURVIVES ON MERIT. `scriptEventSearchQueries` is a closed list of occasions a
   * camera is actually pointed at, and it fires only when the beat says one — so this is kept
   * where the token path is not.
   */
  it("and a real occasion the beat names still reaches the provider", () => {
    const qs = asked("Kylie Jenner", "Kylie Jenner walked the red carpet at the premiere.");
    expect(qs.map((q) => q.toLowerCase())).toContain("kylie jenner red carpet");
  });
});

describe("3. the trade, stated rather than hidden", () => {
  /**
   * A beat naming no occasion and carrying no visual cue is left with the typed question and the
   * name — three queries where there were nine. The six it lost were debris, and variety made of
   * debris is not variety; what still separates two beats about one person is the typed prefix,
   * which differs by place, year and verb.
   */
  it("a plain beat asks few questions, and every one of them means something", () => {
    const qs = asked("Kris Jenner", RENDER_584);
    expect(qs.length).toBeLessThanOrEqual(4);
    for (const q of qs) expect(q.startsWith("Kris Jenner"), q).toBe(true);
  });

  it("the builder is not emptied — it still answers", () => {
    expect(asked("Kris Jenner", RENDER_584).length).toBeGreaterThanOrEqual(2);
    expect(asked("Adolf Hitler", HITLER, 1).length).toBeGreaterThanOrEqual(2);
  });
});
