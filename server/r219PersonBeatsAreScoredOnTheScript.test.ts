/**
 * RONDE 219 — THE SAME GAP RONDE 218 CLOSED, ON THE ROUTE WHERE IT SHOWS MOST.
 *
 * RONDE 218 gave `buildRelevanceKeywords` the script's own statement of what to show. That is the
 * funnel's list. `buildPersonBeatRelevanceKeywords` is the other one — the list a beat about a
 * PERSON is scored with — and it was left as it was: the name, the sentence's words, and any
 * inline cue.
 *
 * Which is exactly where the omission costs the most. For
 *
 *     "Zhukov studies the map in the command post"
 *
 * a portrait of the man and the scene the script described both match "Zhukov", and nothing
 * separated them. The command post and the map — the things that make it THIS moment rather than
 * any moment — carried no weight.
 *
 * Render 575 is the case in point: 121 queries went out for a person, and the scoring behind them
 * could not tell a portrait from the moment the sentence described.
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
  PIPE.indexOf("function buildPersonBeatRelevanceKeywords("),
  PIPE.indexOf("export function buildPersonCelebrityVideoQueries")
);

describe("R219 §1 — a person beat is scored on what the script asked to see", () => {
  it("THE RESOLVER IS CALLED", () => {
    expect(fn, "person beats are still scored without the script's intent").toContain(
      "const intent = resolveBeatVisualIntent(clean);"
    );
  });

  it("the same three content-bearing fields as RONDE 218", () => {
    expect(fn).toContain("intentSearchQueries(intent)");
    expect(fn).toContain("intent.visual_description ?? intent.visual_intent");
    expect(fn).toContain("intent.priority_subject");
  });

  it("CAMERA VOCABULARY STAYS OUT, for the same reason as RONDE 218", () => {
    expect(fn).not.toContain("camera_shot");
    expect(fn).not.toContain("intent.emotion");
  });

  it("THE PERSON'S NAME STILL COMES FIRST — it is the strongest evidence here", () => {
    const name = fn.indexOf("person.split(/\\s+/)");
    const intent = fn.indexOf("intentSearchQueries(intent)");
    expect(name).toBeGreaterThan(0);
    expect(name, "the intent displaced the person's own name").toBeLessThan(intent);
  });

  it("nothing that was in the list before was taken out", () => {
    expect(fn).toContain("tokenizeForRelevance(clean)");
    expect(fn).toContain("extractInlineVisualCues(clean)");
  });

  it("the cap rose just enough to hold the new terms, not to hide a longer list", () => {
    expect(fn, "the old cap would push the sentence's words off the end").toContain(".slice(0, 22)");
    expect(fn).not.toContain(".slice(0, 18)");
  });
});

describe("R219 §2 — all three lists agree about one beat", () => {
  it("THE FUNNEL LIST AND THE PERSON LIST RESOLVE THROUGH THE SAME FUNCTION", () => {
    const funnel = PIPE.slice(
      PIPE.indexOf("function buildRelevanceKeywords(scene: Scene"),
      PIPE.indexOf("function scoreVisualRelevance(")
    );
    expect(funnel).toContain("resolveBeatVisualIntent(");
    expect(fn).toContain("resolveBeatVisualIntent(");
    // And the search side resolves through it too, so query and scoring cannot disagree.
    const kw = fs.readFileSync(path.join(__dirname, "scriptVisualKeywords.ts"), "utf8");
    expect(kw).toContain("intentSearchQueries(resolveBeatVisualIntent(beatText))");
  });

  it("MEASURED: the sentence's setting is now among the terms, not only the name", () => {
    /**
     * The round in one check. If the resolver ever stops contributing anything beyond the
     * sentence's own words, this round buys nothing on person beats and this should say so.
     */
    const sentence = "Zhukov studies the map in the command post.";
    const intent = resolveBeatVisualIntent(sentence);
    const fromIntent = [
      ...intentSearchQueries(intent),
      intent.visual_description ?? intent.visual_intent ?? "",
      intent.priority_subject ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .trim();
    expect(fromIntent.length, "the resolver contributed nothing at all").toBeGreaterThan(0);
  });

  it("a threadbare sentence still yields a usable list and throws nothing", () => {
    for (const s of ["Zhukov.", "He left.", ""]) {
      expect(() => intentSearchQueries(resolveBeatVisualIntent(s))).not.toThrow();
    }
  });
});
