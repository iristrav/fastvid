/**
 * VIDEO 661 — the second half of the fix round from render 70 (video 661).
 *
 *   C  a page of text filling the frame (the static book page shown three times) does not belong
 *   D  a recognisably different place (the port of Oakland under a sentence about Rotterdam) does
 *      not belong — the picture editor says "wrong place:", and a provider title that names only
 *      another place is refused before anyone pays to look
 *   G  the outline's instructions and questions ("Delve into…", "What are the broader implications…")
 *      are not read out as narration
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { acceptableRule, buildBeatImagePrompt } from "./beatImageRelevanceGate";
import { placesIn, wrongPlaceInTitle } from "./placeMismatch";
import { isWriterInstructionSentence, stripWriterInstructions } from "./scriptWriter";
import { judgeCandidateMetadata, type CandidateJudgeInput } from "./visualJudge";
import { classifyMismatch, mismatchSeverity } from "./visualMismatchFeedback";
import { sheetPrompt } from "./youtubePreviewSheet";

const LINE = "Rotterdam's port, Europe's busiest, saw container traffic fall for the first time in a decade.";

/* ═══════════ C ═══════════ */

describe("C — a page of text filling the frame does not belong", () => {
  it("the picture editor is told so, with the one exception: a line about that very document", () => {
    const prompt = buildBeatImagePrompt(LINE, 3, "How Inflation Shook Europe in 2026");
    expect(prompt).toMatch(/a page of text fills the frame — a book, newspaper, magazine,/);
    expect(prompt).toMatch(/unless the line is about that very document/);
    expect(prompt).toMatch(/Begin your\s+reason with "text page:"/);
  });

  it("the YouTube contact sheet carries the same rule, both looks", () => {
    for (const kind of ["storyboard", "sharp"] as const) {
      expect(sheetPrompt("Europe inflation", [LINE], [{ n: 1, sec: 1 }], kind)).toMatch(/a page of text filling the frame/);
    }
  });

  it("a 'text page' refusal is a hard refusal — never soft, never promoted to acceptable", () => {
    const kind = classifyMismatch({ depicts: "a printed book page about trade statistics", reason: "text page: a book page fills the frame" });
    expect(kind).toBe("TITLE_CARD");
    expect(mismatchSeverity(kind)).not.toBe("SOFT_MISMATCH");
    const refused = { verdict: "does_not_fit" as const, depicts: "a printed page", reason: "text page: a book page about trade" };
    expect(acceptableRule(refused, { subject_matches: true, situation_matches: false })).toBe(refused);
  });
});

/* ═══════════ D ═══════════ */

describe("D — a recognisably different place does not belong", () => {
  it("the picture editor is told so, with render 70's own example", () => {
    const prompt = buildBeatImagePrompt(LINE, 3, "How Inflation Shook Europe in 2026");
    expect(prompt).toMatch(/recognisably different place than the one the line/);
    expect(prompt).toMatch(/the port of Oakland under a line about Rotterdam/);
    expect(prompt).toMatch(/Begin your reason with "wrong place:"/);
    expect(sheetPrompt("Europe inflation", [LINE], [{ n: 1, sec: 1 }], "sharp")).toMatch(/recognisably different place/);
  });

  it("a 'wrong place' refusal is hard — never the soft 'right sort of thing elsewhere', never promoted", () => {
    const kind = classifyMismatch({ depicts: "container cranes at the Port of Oakland", reason: "wrong place: this is the port of Oakland, not Rotterdam" });
    expect(kind).toBe("UNRELATED");
    expect(mismatchSeverity(kind)).toBe("TOTALLY_UNRELATED");
    const refused = { verdict: "does_not_fit" as const, depicts: "port cranes", reason: "wrong place: Oakland" };
    expect(acceptableRule(refused, { subject_matches: true, situation_matches: false })).toBe(refused);
  });

  it("render 70: 'Port-Oakland.jpg' under a sentence about Rotterdam names only another place", () => {
    expect(wrongPlaceInTitle(LINE, "Port-Oakland.jpg")).toEqual({ said: ["rotterdam"], titled: ["oakland"] });
  });

  it("the sentence's place, the same country, or no listed place at all decides nothing", () => {
    expect(wrongPlaceInTitle(LINE, "Port of Rotterdam aerial, Maasvlakte")).toBeNull();
    expect(wrongPlaceInTitle(LINE, "Container ship leaving Amsterdam")).toBeNull(); // same country
    expect(wrongPlaceInTitle(LINE, "Dutch harbour, Netherlands 2025")).toBeNull();
    expect(wrongPlaceInTitle(LINE, "container cranes at dusk")).toBeNull(); // the title names no place
    expect(wrongPlaceInTitle("Prices rose across the continent.", "Port of Oakland")).toBeNull(); // the sentence names none
    /** a nationality word in the sentence names its country */
    expect(wrongPlaceInTitle("Dutch exporters felt it first.", "Rotterdam terminal")).toBeNull();
    expect(wrongPlaceInTitle("Dutch exporters felt it first.", "Port of Oakland")).not.toBeNull();
  });

  it("whole words only, ambiguous names left out", () => {
    expect(placesIn("Parisian café").map((p) => p.name)).toEqual([]);
    expect(placesIn("New England harbour").map((p) => p.name)).toEqual([]);
    expect(placesIn("Port_Oakland-cranes").map((p) => p.name)).toEqual(["oakland"]);
  });

  it("the metadata judge refuses such a candidate before any look; an unlisted title is untouched", () => {
    const base = (title: string): CandidateJudgeInput => ({
      path: "/w/scene_2_serp_3.mp4",
      sourceQuery: "Rotterdam port containers",
      beatText: LINE,
      videoTitle: "How Inflation Shook Europe in 2026",
      meta: { providerText: { title } },
      requireBeatMatch: false,
      scriptAnchored: false,
      entityRules: [],
      signals: { beatMatch: 2, queryInBeat: true, providerTitleSharesNothing: false },
      where: "s2b1",
    });
    expect(judgeCandidateMetadata(base("Port-Oakland.jpg"))).toMatchObject({ decision: "REJECT", reason: "wrong_place_in_title" });
    expect(judgeCandidateMetadata(base("Port of Rotterdam containers")).reason).not.toBe("wrong_place_in_title");
    expect(judgeCandidateMetadata(base("container terminal at night")).reason).not.toBe("wrong_place_in_title");
  });
});

/* ═══════════ G ═══════════ */

describe("G — the outline's instructions and questions are not read out", () => {
  it("render 70's two sentences are recognised", () => {
    expect(isWriterInstructionSentence("Delve into specific economic milestones that shaped the decade.")).toBe(true);
    expect(isWriterInstructionSentence("What are the broader implications for European households?")).toBe(true);
    expect(isWriterInstructionSentence("Explore how energy prices drove the surge.")).toBe(true);
    expect(isWriterInstructionSentence("In this section, the viewer learns about the ECB.")).toBe(true);
  });

  it("narration stays: statements, story questions, 'Imagine…', 'Consider…', 'Add to that…'", () => {
    for (const s of [
      "Prices rose eleven percent in a single year.",
      "But how did it all begin?",
      "Why did nobody see it coming?",
      "Imagine paying double for bread overnight.",
      "Consider the numbers.",
      "Add to that the cost of energy.",
      "The implications were felt in every kitchen.", // a statement about implications is narration
    ]) {
      expect(isWriterInstructionSentence(s), s).toBe(false);
    }
  });

  it("only the instruction is cut out of its line; headings and [VISUAL] lines untouched", () => {
    const script = [
      "# How Inflation Shook Europe",
      "",
      "## The surge",
      "[VISUAL: supermarket shelves]",
      "Prices rose eleven percent in 2026. Delve into specific economic milestones. Families felt it first.",
      "Bread, rent and energy all cost more by the summer, and wages did not follow for another year.",
      "",
      "## Aftermath",
      "What are the broader implications for European households? The ECB raised rates in March.",
      "By the autumn the steepest rise in a generation had slowed, but prices never came back down.",
    ].join("\n");
    const { script: out, removed } = stripWriterInstructions(script);
    expect(removed).toEqual(["Delve into specific economic milestones.", "What are the broader implications for European households?"]);
    expect(out).toContain("# How Inflation Shook Europe");
    expect(out).toContain("[VISUAL: supermarket shelves]");
    expect(out).toContain("Prices rose eleven percent in 2026. Families felt it first.");
    expect(out).toContain("The ECB raised rates in March.");
    expect(out).not.toMatch(/Delve|broader implications/);
  });

  it("a script that would lose more than a third of its words is left as it was", () => {
    const script = "Explore the causes. Discuss the effects. Prices rose.";
    expect(stripWriterInstructions(script)).toEqual({ script, removed: [] });
  });

  it("it runs on GENERATED scripts (draft and length revision), never on a script the customer edited", () => {
    const ENGINE = fs.readFileSync(path.join(__dirname, "scriptEngine.ts"), "utf8");
    expect(ENGINE).toContain("const cleaned = stripWriterInstructions(markdownScript);");
    expect(ENGINE).toContain("stripWriterInstructions(stripVisualTagsFromScript(refined.trim())).script");
    const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(ROUTERS).not.toContain("stripWriterInstructions");
  });
});
