/**
 * VIDEO 654 — two things the log of a delivered film got wrong.
 *
 * 1. "2014 footage". The planner listed "2014", "2020" and "$600 billion" as things the viewer must
 *    see. "2014" took one of the film's four YouTube searches (music videos, an F-18, a tornado, a
 *    rocket test — one downloaded) while Toyota and Volkswagen were never searched ("budget_spent").
 *    A year, number or amount alone names no picture.
 *
 * 2. "die clips zijn ONGEZIEN aangenomen". Printed over 12 DECLINED looks on one sentence (s1b3, the
 *    per-sentence look ceiling) while `[UnjudgedFootage] adopted=0` stood a few lines below. A
 *    declined ask is not an adoption; the warning now says what the adoption counter says.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeVideo, namesOnlyANumber, validVisualNeeds, type PlannerInput } from "./youtubeVideoSearchPlanner";
import { scriptVisualNeeds } from "./youtubeVideoPool";

const SCRIPT_654: PlannerInput = {
  prompt: "How Tesla beat the giants of Detroit",
  title: "Can Tesla beat Detroit?",
  sceneTexts: [
    "Tesla started as a small startup. Elon Musk wanted to beat the giants of Detroit.",
    "In 2014, Elon Musk declared Tesla's patents open-source.",
    "In 2020, Tesla's market valuation soared past $600 billion, passing Toyota and Volkswagen.",
  ],
};

describe("1. a year, a number or an amount is not something to film", () => {
  it("bare years, numbers and amounts name no picture", () => {
    for (const s of ["2014", "2020", "$600 billion", "600 billion dollars", "50%", "3 million", "1990s"]) {
      expect(namesOnlyANumber(s), s).toBe(true);
    }
  });

  it("a subject with something to see stays, a year riding along included", () => {
    for (const s of ["Toyota", "Volkswagen", "Tesla 2014", "Tesla patents open-source", "Model 3", "Apollo 11", "F-18 Hornet"]) {
      expect(namesOnlyANumber(s), s).toBe(false);
    }
    expect(namesOnlyANumber("")).toBe(false);
  });

  it("654 replayed: the planner's list loses the year and the amount, keeps what a camera can film", () => {
    const analysis = analyzeVideo(SCRIPT_654);
    const at = (needle: string) => analysis.sentences.findIndex((s) => s.includes(needle));
    const needs = validVisualNeeds(
      [
        { subject: "2014", beats: [at("2014")] },
        { subject: "2020", beats: [at("2020")] },
        { subject: "$600 billion", beats: [at("2020")] },
        { subject: "Tesla patents open-source", beats: [at("2014")] },
        { subject: "Toyota", beats: [at("2020")] },
      ],
      analysis,
      SCRIPT_654
    );
    const subjects = needs.map((n) => n.subject);
    expect(subjects).not.toContain("2014");
    expect(subjects).not.toContain("2020");
    expect(subjects).not.toContain("$600 billion");
    expect(subjects).toContain("Tesla patents open-source");
  });

  it("the search list never turns a number into a subject, from either reader", () => {
    const sentences = SCRIPT_654.sceneTexts.join(" ").split(/(?<=\.)\s+/);
    const needs = scriptVisualNeeds(
      {
        sentences,
        visualNeeds: [
          { subject: "2014", beats: [1] },
          { subject: "$600 billion", beats: [2] },
          { subject: "Toyota", beats: [2] },
        ],
      },
      /** the narration's own reader may hand a year in too */
      (s) => (s.includes("2014") ? [{ name: "2014", kind: "subject" as never }] : [])
    );
    expect(needs.map((n) => n.name)).toEqual(["Toyota"]);
  });
});

describe("2. 'ongezien aangenomen' only when a clip WAS taken without a verdict", () => {
  let unseenAdoptionClause: (byRoute: ReadonlyMap<string, number>) => string;
  /** The pipeline module is large; it is loaded once, with time to load. */
  beforeAll(async () => {
    ({ unseenAdoptionClause } = await import("./videoPipeline"));
  }, 120_000);

  it("nothing adopted unseen: the warning says so", () => {
    expect(unseenAdoptionClause(new Map())).toBe("niets is ongezien gebruikt: een clip zonder oordeel komt de film niet in");
    expect(unseenAdoptionClause(new Map([["archive", 0]]))).not.toContain("ONGEZIEN");
  });

  it("clips adopted unseen: the warning names how many", () => {
    expect(unseenAdoptionClause(new Map([["archive", 2], ["youtube", 1]]))).toBe("3 clip(s) zijn ONGEZIEN aangenomen");
  });

  it("the three gate warnings read the adoption counter, none states it as a fact", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("const unseen = unseenAdoptionClause(visualDedup.adoptedWithSuspendedVision);");
    expect(PIPE).not.toContain("— die clips zijn ONGEZIEN aangenomen`");
    expect(PIPE).not.toContain("`elke clip in deze video is ONGEZIEN aangenomen`");
    expect(PIPE).toContain("beeldgate is ${t.skipped} keer niet eens bevraagd");
    expect((PIPE.match(/ — \$\{unseen\}`/g) ?? []).length).toBe(3);
  });
});
