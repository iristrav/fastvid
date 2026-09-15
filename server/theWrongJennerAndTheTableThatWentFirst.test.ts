/**
 * RONDE 249 — WHY YOUTUBE WAS ASKED ABOUT SOMEONE THE SCRIPT NEVER MENTIONED.
 *
 * Render 584's scene 2 is about KRIS Jenner. YouTube was asked for "Kylie Jenner", 26 times in
 * eight minutes, and never for Kris Jenner at all. Two faults compounded:
 *
 *   1. `REAL_ENTITY_RULES` holds twelve hardcoded subjects, and the kylie rule's `mentionRe` ends
 *      in `jenner\b`. A surname belongs to a family, not a person, so every Jenner was Kylie.
 *
 *   2. That table's query was put to YouTube BEFORE the person the script actually names, and the
 *      first ask returned on success — so a clip of the wrong person ended the search.
 *
 * The second is the deeper one and outlives the first: `scenePersons` comes from the script and
 * the table is a fixed list, so what the beat names is better evidence than what the list knows,
 * whatever is on the list.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { extractBeatRealEntities } from "./videoPipeline";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const ids = (beat: string): string[] => extractBeatRealEntities(beat, "", "").map((r) => r.id);

/** Render 584, scene 2, beat 0 — the sentence that produced the wrong ask. */
const RENDER_584 = "Inside a Los Angeles conference room, Kris Jenner watches the Beverly Hills deal close in 2022.";

describe("1. a person rule fires on a person, not on a family", () => {
  it("the beat that named Kris Jenner no longer matches Kylie", () => {
    expect(ids(RENDER_584), "render 584 returned the kylie rule here").toEqual([]);
  });

  it("nor does a bare surname, for either person in the table", () => {
    expect(ids("Jenner arrived at the office.")).toEqual([]);
    expect(ids("Musk walked onto the stage.")).toEqual([]);
  });

  /** THE DIRECTION THAT MUST NOT MOVE — the rules still recognise the people they are for. */
  it("but the whole name still matches", () => {
    expect(ids("Kylie Jenner launched the line in 2015.")).toEqual(["kylie"]);
    expect(ids("Elon Musk walked onto the stage.")).toEqual(["musk"]);
  });

  /**
   * The other ten rules are companies, brands and objects, where the bare token IS the whole
   * name. Nothing about them changes, and `fullName` would mean nothing on them.
   */
  it("and a company, brand or object is untouched", () => {
    expect(ids("A Tesla rolled off the line.")).toEqual(["tesla"]);
    expect(ids("The Titanic left Southampton.")).toEqual(["titanic"]);
    expect(ids("The Starlink array went up on a Falcon 9.")).toEqual(
      expect.arrayContaining(["falcon9", "starlink"])
    );
  });

  /**
   * `mentionRe` is deliberately NOT narrowed. It is also read by the candidate filters, where it
   * decides what a clip has to show — a different question from when a rule may fire, and one
   * this round is not answering.
   */
  it("the mention pattern itself is left alone", () => {
    expect(PIPE, "narrowing this would change the clip filter too").toContain(
      "mentionRe: /\\b(kylie\\s+jenner|kylie\\b|jenner\\b)/i"
    );
  });

  /**
   * Enforced by the compiler rather than by remembering: `RealEntityRule` is a union whose
   * "person" arm requires `fullName`. Rule thirteen cannot be added without one, which is what
   * an optional field would have allowed — silently matching a surname again, or going quiet.
   */
  it("and the type makes a person rule carry the name it recognises", () => {
    expect(PIPE).toMatch(/kind:\s*"person";\s*\n[^}]*fullName:\s*string;/);
    for (const [id, name] of [["kylie", "Kylie Jenner"], ["musk", "Elon Musk"]] as const) {
      expect(PIPE, id).toContain(`fullName: "${name}",`);
    }
  });
});

describe("2. the script's person is asked before the hardcoded table", () => {
  /**
   * Asserted against the source because the alternative is not available to a test: these call
   * sites sit inside the beat-sourcing routes and reaching them means real YouTube HTTP. What can
   * be checked exactly is the thing that was wrong — which of the two asks comes first.
   */
  const lineOf = (offset: number): number => PIPE.slice(0, offset).split("\n").length;
  const offsets = (re: RegExp): number[] => [...PIPE.matchAll(re)].map((m) => m.index ?? 0);

  /**
   * Where the queries ENTER A LIST, not where their builder is called. A first attempt matched
   * `realEntityYoutubeQueriesForBeat(` and missed the sites that assign it to `entityYt` a line
   * above and spread the variable below — which is exactly where a fifth unswapped call site was
   * still sitting. What decides which provider question goes out first is the spread.
   */
  const TABLE_SPREAD = /\.\.\.(entityYt\b|realEntityYoutubeQueriesForBeat\()/g;
  const PERSON_SPREAD = /buildPersonCelebrityVideoQueries\(/g;

  /**
   * The fast route is where ordering was decisive rather than merely preferable: each ask returns
   * on success, so whichever runs first can end the search on its own. Anchored on the two asks'
   * own labels — `const ytMs = youtubeBeatFetchTimeoutMs(` appears on four different routes and a
   * first attempt at this test silently measured the wrong one.
   */
  it("on the fast route, where the first success used to end the search", () => {
    const person = PIPE.indexOf("`fast person YouTube (${person})`");
    const table = PIPE.indexOf('"fast event YouTube"');
    expect(person, "the person ask").toBeGreaterThan(-1);
    expect(table, "the table ask").toBeGreaterThan(-1);
    expect(person, "the table's ask returned before the script's person was tried").toBeLessThan(table);
  });

  it("and in every list that offers both", () => {
    const people = offsets(PERSON_SPREAD);
    const tables = offsets(TABLE_SPREAD);
    expect(tables.length, "table spreads found").toBeGreaterThan(3);

    let checked = 0;
    for (const table of tables) {
      /** The person ask belonging to the same list, if this list has one at all. */
      const near = people.filter((p) => Math.abs(p - table) < 800);
      if (near.length === 0) continue;
      const nearest = near.reduce((a, b) => (Math.abs(a - table) < Math.abs(b - table) ? a : b));
      expect(
        nearest,
        `line ${lineOf(table)}: the hardcoded table is offered before the script's person`
      ).toBeLessThan(table);
      checked++;
    }
    expect(checked, "lists offering both").toBeGreaterThanOrEqual(4);
  });

  /** Nothing is removed: the table still runs for every beat the person route does not satisfy. */
  it("the table is still asked, not deleted", () => {
    expect(PIPE).toContain("realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle)");
    expect(PIPE).toContain('"fast event YouTube"');
  });
});
