/**
 * EVERY SUBJECT ALIKE — video 623.
 *
 * "Dit moet ook voor elk onderwerp gelden en voor elke naam." The code gave Elon Musk, Tesla,
 * SpaceX, Kylie Jenner and the Titanic their own queries, scores, quotas, evidence gates, hero
 * searches, script rules and on-screen labels; every other subject got none of it. Those are gone,
 * and this file keeps them gone: no code line names one of those subjects, and the rules that
 * replaced them answer the same way for any person, company or thing.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { extractBeatRealEntities, extractPersonNamesFromText, setRenderPeopleReadingForTests, stockCategoryGateForTest } from "./videoPipeline";
import { scriptStillOnTopic } from "./scriptWriter";
import { isRejectedStockClip } from "./visualJudge";

const SERVER = __dirname;
const codeLines = (file: string) =>
  fs
    .readFileSync(path.join(SERVER, file), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

describe("no code line names one subject", () => {
  const SUBJECTS = /\b(musk|elon|kylie|kardashians?|jenner|tesla|spacex|starlink|cybertruck|gigafactory|neuralink|titanic)\b/i;
  /** Prompt text shown to the model as an example of a format, not a rule the code applies. */
  const PROMPT_EXAMPLES = new Set(["visualDirector.ts"]);

  it("in every server module", () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(SERVER)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || PROMPT_EXAMPLES.has(f)) continue;
      codeLines(f).forEach((l, i) => {
        if (SUBJECTS.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no named-person tables for labels or query expansion", () => {
    expect(codeLines("assetDirector.ts").join("\n")).not.toContain("KNOWLEDGE_GRAPH");
    expect(codeLines("videoPipeline.ts").join("\n")).not.toMatch(/REAL_ENTITY_RULES|isMuskTeslaTopic|GOLDEN_MUSK_QUERIES|muskTopic/);
  });
});

describe("a named thing is a rule, whatever it is", () => {
  afterEach(() => setRenderPeopleReadingForTests(null));

  it("people, companies and things from the sentence itself", () => {
    const of = (t: string) => extractBeatRealEntities(t).map((r) => `${r.kind}:${r.stockQueries[0]}`);
    expect(of("Marie Curie worked in Paris with Pierre Curie.")).toEqual(["person:Marie Curie", "person:Pierre Curie"]);
    expect(of("The Hindenburg burned at Lakehurst in 1937.")).toContain("object:Hindenburg");
    expect(of("Henry Ford built his first factory in Detroit.")).toContain("person:Henry Ford");
    expect(of("Social media turned him into a meme.")).toEqual([]);
  });

  it("a name the render's reading does not call a person is a thing, not a gated person", () => {
    setRenderPeopleReadingForTests(["Steve Jobs"]);
    const kinds = extractBeatRealEntities("In 1976 Steve Jobs founded a company in Palo Alto.").map((r) => `${r.kind}:${r.stockQueries[0]}`);
    expect(kinds).toContain("person:Steve Jobs");
    expect(kinds).not.toContain("person:Palo Alto");
  });

  it("the same query and the same gate for any person", () => {
    for (const name of ["Frida Kahlo", "Nelson Mandela", "Ada Lovelace"]) {
      const [rule] = extractBeatRealEntities(`${name} changed everything that year.`);
      expect(rule?.kind, name).toBe("person");
      expect(rule?.youtubeQueries, name).toEqual([name]);
    }
  });
});

describe("names that open with a particle or a Dutch function word", () => {
  it("proven by the same name in the middle of a sentence", () => {
    expect(extractPersonNamesFromText("The author Dan Brown lives in Exeter. Dan Brown wrote the novel in a year.")).toContain("Dan Brown");
    expect(extractPersonNamesFromText("Vincent van Gogh was born in 1853. Van Gogh painted sunflowers.")).toEqual(["Vincent van Gogh"]);
    /** The shorter form is the same person as the fuller one, so only the fuller one stays. */
    const gaulle = extractPersonNamesFromText("President Charles de Gaulle returned. De Gaulle spoke to France.");
    expect(gaulle.some((n) => /charles de gaulle$/i.test(n))).toBe(true);
    expect(gaulle).not.toContain("De Gaulle");
  });

  it("and never on a sentence opening alone", () => {
    expect(extractPersonNamesFromText("De Nederlandse regering viel in 2023.")).toEqual([]);
  });
});

describe("stock footage: form is refused, subject is not", () => {
  it("no category has a quota, and no subject is a category", () => {
    for (const q of ["tesla factory", "rocket launch", "solar panels", "container ship", "ford assembly line", "apollo moon landing"]) {
      const g = stockCategoryGateForTest(new Map([["generic", 99]]), q);
      expect(g.category, q).toBe("generic");
      expect(g.atLimit, q).toBe(false);
    }
  });

  it("a miniature, a render or a diorama is still refused", () => {
    expect(stockCategoryGateForTest(new Map(), "miniature rocket diorama").atLimit).toBe(true);
    expect(isRejectedStockClip("/x/pexels-cgi-render.mp4", "cgi city")).toBe(true);
  });

  it("a bridge, a ship, a highway, a courtroom or a car brand is not refused for what it shows", () => {
    for (const [file, q] of [
      ["pexels-golden-gate-bridge.mp4", "bridge"],
      ["pexels-cargo-ship-harbor.mp4", "cargo ship"],
      ["pexels-highway-traffic.mp4", "highway"],
      ["pexels-courtroom-judge.mp4", "courtroom"],
      ["pexels-ford-mustang.mp4", "ford"],
    ]) {
      expect(isRejectedStockClip(`/x/${file}`, q), file).toBe(false);
    }
  });
});

describe("the script and its labels", () => {
  it("a script is on topic by the topic's own words, for any name", () => {
    expect(scriptStillOnTopic("The rise of Frida Kahlo", "# Frida\n\nKahlo painted in Coyoacán.")).toBe(true);
    expect(scriptStillOnTopic("The rise of Frida Kahlo", "# Other\n\nA story about bridges.")).toBe(false);
  });

  it("a script without sections is read, not recursed until the stack runs out", () => {
    expect(scriptStillOnTopic("Frida Kahlo", "# Other\n\nA story about bridges and rivers.")).toBe(false);
    expect(scriptStillOnTopic("Frida Kahlo", "# Frida\n\nKahlo painted her own face again and again.")).toBe(true);
  });

  it("the script writer has one brand rule for every subject", () => {
    const writer = codeLines("scriptWriter.ts").join("\n");
    expect(writer).not.toContain("isMuskTopic");
    expect(codeLines("routers.ts").join("\n")).not.toContain("isMuskTeslaPromptTopic");
  });
});
