/**
 * Video 618 — picture queries held words the sentence never said.
 *
 * The still and stock builders sent "Kris Jenner portrait", "Kris Jenner face portrait photo",
 * "social media marketing phone", "content creator smartphone", "Reason Kardashians" (the title's
 * word) and "isnt wealth". The search gate refused every one — sixty-odd refusals — and a beat with
 * every question refused asked nothing ("STARVED built=4 asked=0") and got no picture. The owner's
 * rule: a word that is not in the sentence is never added. Words are now only removed.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { sentenceOnlyQueries, sentenceOnlyYoutubeQueries } from "./youtubeNonFootage";
import { scriptStockSearchQueries } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Video 618 — a picture query holds only words the sentence says", () => {
  const s1b2 = "She leveraged social media to turn every headline into a business.";
  const s0b1 = "This isn't wealth by accident — it is a system.";

  it("the builder's own words are removed, the sentence's words and the scene's people stay", () => {
    expect(sentenceOnlyQueries(["Kris Jenner portrait"], s1b2, ["Kris Jenner"])).toEqual(["Kris Jenner"]);
    expect(sentenceOnlyQueries(["Kris Jenner face portrait photo"], s1b2, ["Kris Jenner"])).toEqual(["Kris Jenner"]);
    expect(sentenceOnlyQueries(["social media marketing phone"], s1b2, ["Kris Jenner"])).toEqual(["social media"]);
  });

  it("a question with nothing the sentence says is not asked at all", () => {
    expect(sentenceOnlyQueries(["content creator smartphone"], s1b2)).toEqual([]);
    expect(sentenceOnlyQueries(["Reason Kardashians"], s0b1)).toEqual([]);
  });

  it("a contraction is grammar, not a subject — in any spelling", () => {
    expect(sentenceOnlyQueries(["isnt wealth"], s0b1)).toEqual(["wealth"]);
    expect(sentenceOnlyQueries(["isn't wealth"], s0b1)).toEqual(["wealth"]);
    expect(sentenceOnlyQueries(["isn't"], s0b1)).toEqual([]);
  });

  it("unlike YouTube, a stock question need not name someone", () => {
    const s = "The city skyline glowed at night.";
    expect(sentenceOnlyQueries(["city skyline night"], s)).toEqual(["city skyline night"]);
    /** The YouTube rule is unchanged: that one does need a name. */
    expect(sentenceOnlyYoutubeQueries(["city skyline night"], s)).toEqual([]);
  });

  it("duplicates collapse and nothing is ever added", () => {
    const out = sentenceOnlyQueries(["Kris Jenner portrait", "Kris Jenner", "Kris Jenner face"], s1b2, ["Kris Jenner"]);
    expect(out).toEqual(["Kris Jenner"]);
    for (const q of sentenceOnlyQueries(["social media marketing phone", "business headline plan"], s1b2)) {
      for (const w of q.toLowerCase().split(" ")) expect(s1b2.toLowerCase()).toContain(w);
    }
  });
});

describe("Video 618 — the title only lends words the narration also says", () => {
  it("a beat and scene with no subject no longer ask for the title's own word", () => {
    const q = scriptStockSearchQueries("And yet.", [], "And yet.", "The Real Reason Kardashians Are Multi-Billionaires");
    expect(q.join(" ")).not.toMatch(/reason/i);
  });

  it("a title word the scene does say is still used", () => {
    const q = scriptStockSearchQueries("And yet.", [], "and yet the billionaires", "The Real Reason Kardashians Are Multi-Billionaires");
    expect(q.join(" ").toLowerCase()).not.toContain("reason");
    expect(q.join(" ").toLowerCase()).toContain("billionaires");
  });
});

describe("Video 618 — wiring: the builders no longer add words", () => {
  it("no portrait, face or interview padding is appended anywhere a person query is built", () => {
    expect(PIPE).not.toContain("`${q} face interview`");
    expect(PIPE).not.toContain("`${person} face portrait close up`");
    expect(PIPE).not.toContain("`${person} portrait`");
    expect(PIPE).not.toContain("out.push(`${primary} face portrait photo`);");
  });

  it("the still query list and the SerpAPI still route pass through the sentence filter", () => {
    const fn = PIPE.slice(PIPE.indexOf("function buildBeatImageSearchQueries("), PIPE.indexOf("async function fetchBeatScriptImageClip("));
    expect(fn).toContain("sentenceOnlyQueries(");
    expect(fn).toContain("beat.text,\n    scenePersons");
    expect(PIPE).toContain("sentenceOnlyQueries([unique[qi] || beat.searchQuery || beat.text.slice(0, 60)], beat.text, [personName])[0] ?? \"\"");
    expect(PIPE).toContain("if (!serpQ) continue;");
  });

  it("the gate is not touched: a refused query is still refused", () => {
    const contract = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(contract).toContain("TITLE_INFERENCE_NOT_ALLOWED");
    expect(contract).toContain("return { admitted: false, text };");
  });
});
