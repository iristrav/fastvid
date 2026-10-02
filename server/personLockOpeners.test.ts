/**
 * OCTOBER 2026 — renders 612, 613 and 616 locked their films on names that were not names:
 *
 *   612  [person lock: Dominated Despite]        (a title heading — fixed in an earlier round)
 *   613  [person lock: Opening Kim Kardashian]   (a heading word in front of the name)
 *   616  [persons: Unveil Kris Jenner, …]         (a teaser verb in front of the name)
 *
 * Script words never become part of a person's name.
 */
import { describe, expect, it } from "vitest";

import {
  extractPersonNamesFromText,
  extractPrimaryPersonFromText,
  resolvePrimaryPersonLock,
  withoutStrayLeadingWord,
} from "./videoPipeline";
import { atSentenceStart } from "./sentenceOpeners";

describe("a heading or teaser word is not the first name", () => {
  it.each([
    ["Opening Kim Kardashian turned fame into business.", "Kim Kardashian"],
    ["# Unveil Kris Jenner: The Mastermind", "Kris Jenner"],
    ["Unveil Kris Jenner and her strategy.", "Kris Jenner"],
    ["Meet Elon Musk, the man behind Tesla.", "Elon Musk"],
    ["**Discover** Coco Chanel and her empire.", "Coco Chanel"],
  ])("%s → %s", (text, name) => {
    expect(extractPersonNamesFromText(text)).toEqual([name]);
    expect(extractPrimaryPersonFromText(text)).toBe(name);
  });

  it("the script's own shorter use of the name decides, without any word list", () => {
    const text = "Viewers met Fabled Kim Kardashian on screen. Kim Kardashian built a brand.";
    expect(withoutStrayLeadingWord("Fabled Kim Kardashian", text)).toBe("Kim Kardashian");
  });

  it("a markdown heading opens a sentence", () => {
    expect(atSentenceStart("# Unveil Kris Jenner", 2)).toBe(true);
    expect(atSentenceStart("**Opening** Kim", 2)).toBe(true);
    expect(atSentenceStart("She met Kim", 8)).toBe(false);
  });
});

describe("real names keep every word", () => {
  it.each(["Martin Luther King", "Mohammed bin Salman", "Kim Kardashian West"])("%s", (name) => {
    const text = `${name} spoke at the event.`;
    expect(extractPersonNamesFromText(text)).toEqual([name]);
  });

  it("a particle is never promoted to the start of a shorter name", () => {
    const text = "Mohammed bin Salman visited. Later bin Salman left.";
    expect(withoutStrayLeadingWord("Mohammed bin Salman", text)).toBe("Mohammed bin Salman");
  });
});

describe("the film's person lock", () => {
  it("613 — a heading word does not reach the lock", () => {
    const lock = resolvePrimaryPersonLock({
      prompt: "Opening Kim Kardashian: how she built her business",
      videoTitle: "Opening Kim Kardashian",
      topicContext: "",
      script: "Kim Kardashian turned reality fame into a business empire.",
    });
    expect(lock).toBe("Kim Kardashian");
  });

  it("612 — a title heading never locks", () => {
    const lock = resolvePrimaryPersonLock({
      prompt: "Why the Roman Empire dominated despite its limitations",
      videoTitle: "Why the Roman Empire Dominated Despite Its Limitations",
      topicContext: "",
      script: "# Why the Roman Empire Dominated Despite Its Limitations\nRome grew for centuries.",
    });
    expect(lock).not.toMatch(/Dominated|Despite/);
  });
});

describe("OCTOBER 2026 (showcase render) — a middle initial is part of the name; a qualified place is no person", () => {
  it("John F. Kennedy and George W. Bush keep their initial; West Berlin is not a person", () => {
    const t = "In 1963, John F. Kennedy spoke to hundreds of thousands of people in West Berlin.";
    expect(extractPersonNamesFromText(t)).toEqual(["John F. Kennedy"]);
    expect(extractPrimaryPersonFromText(t)).toBe("John F. Kennedy");
    expect(extractPersonNamesFromText("George W. Bush visited Berlin.")).toEqual(["George W. Bush"]);
  });

  it("a compass word in front of a place is still that place; George Washington is still a person", () => {
    expect(extractPersonNamesFromText("Troops entered East Germany.")).toEqual([]);
    expect(extractPrimaryPersonFromText("They crossed into West Berlin.")).toBe("");
    expect(extractPersonNamesFromText("George Washington crossed the Delaware.")).toEqual(["George Washington"]);
  });
});
