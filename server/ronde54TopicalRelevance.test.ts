import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildTopicMatcher,
  assessCandidateTopicality,
  topicalRankingBonus,
  rejectOffTopicCandidates,
} from "./candidateTopicalRelevance";

/**
 * RONDE 54 — only footage that belongs in the video.
 *
 * Every case below is a real candidate title from render 530 or 531, a documentary titled
 * "Why Hitler Chose Death: The Dark End of the Third Reich". Five of them shipped.
 *
 * The CLIP vision score cannot make this call — render 531 measured the sticker at 0.2226 and
 * the genuine Signed Photograph of Adolf Hitler at 0.2116, so the wrong image scored higher than
 * the right one. These tests therefore pin the metadata verdict, which is the signal that does
 * separate them, and in particular pin the cases that must NOT be rejected.
 */

const TOPIC = () =>
  buildTopicMatcher(
    "Why Hitler Chose Death: The Dark End of the Third Reich",
    ["hitler", "eva", "braun", "bunker", "wwii"],
    "In April 1945, within hours of marrying, Adolf Hitler and Eva Braun died in the Führerbunker in Berlin."
  );

const assess = (title: string, assetId = "") =>
  assessCandidateTopicality({ title, assetId }, TOPIC());

describe("RONDE 54 — footage that belongs is kept", () => {
  it("candidates that name the subject are topical", () => {
    expect(assess("Signed Photograph of Adolf Hitler").verdict).toBe("topical");
    expect(assess("Hitler Did Not Escape From Bunker – WW2 Documentary").verdict).toBe("topical");
    expect(assess("Adolf Hitler, 20. april 1945.jpg").verdict).toBe("topical");
    expect(assess("Klara Hitler.jpg").verdict).toBe("topical");
    expect(assess("Hitler and Mussolini June 1940.jpg").verdict).toBe("topical");
  });

  it("a catalogue number is never rejected — it says nothing, which is not the same as saying no", () => {
    // Both are genuine WWII photographs from the German federal archive whose entire title is
    // an archive name and a shelf number. They share no word with "Hitler" — exactly like the
    // sticker does not. A rule demanding topical evidence would delete real archive footage.
    expect(assess("Bundesarchiv Bild 183-1989-0322-506").verdict).toBe("neutral");
    expect(assess("Bundesarchiv Bild 121-0723, Marburg").verdict).toBe("neutral");
    // The shelf number contains "1989"; that must not be read as the candidate's era.
    expect(assess("Bundesarchiv Bild 183-1989-0322-506").eraConflict).toBe(false);
  });

  it("providers that supply no usable metadata are left alone", () => {
    expect(assess("archive clip").verdict).toBe("neutral");
    expect(assess("unknown").verdict).toBe("neutral");
    expect(assess("WLP-Videos", "WLP-Videos").verdict).toBe("neutral");
    // Institution and object words describe where a thing is kept, not what it shows.
    expect(assess("footage from the National Archives of Military Hospital").verdict).toBe("neutral");
  });
});

describe("RONDE 54 — footage that does not belong is rejected", () => {
  it("rejects the two of the five it can actually prove wrong", () => {
    // RONDE 57 narrowed rejection to a provable era conflict. These two carry one.
    expect(assess("faces of ancient europe 1-500 A.D.", "faces-of-ancient-europe-1-500-a.-d_202506").verdict)
      .toBe("off_topic");
    expect(assess("trae crowder comments 12 02 2022", "trae-crowder-comments-12-02-2022").verdict)
      .toBe("off_topic");
  });

  it("the other three survive as unjudged, and that is the deliberate trade", () => {
    // These three are wrong, and keyword overlap cannot say so: they share no word with the
    // topic, and neither does "Ruins of a bombed city", which is exactly the shot this video
    // needs. The rule that caught them also deleted that one — see the B-roll block below.
    // Unjudged means no ranking bonus, so they sit below everything that named the subject.
    for (const [title, assetId] of [
      ["white lives matter montana sticker", "white-lives-matter-montana-sticker"],
      ["bulgarian national union customs", "bulgarian-national-union-customs"],
      ["verdachte huub wijfjes", "verdachte-huub-wijfjes"],
    ] as const) {
      const a = assess(title, assetId);
      expect(a.verdict).toBe("neutral");
      expect(topicalRankingBonus(a.verdict)).toBe(0);
    }
    // And a candidate that DID name the subject outranks them.
    expect(topicalRankingBonus(assess("Signed Photograph of Adolf Hitler").verdict)).toBeGreaterThan(0);
  });

  it("names the reason, so a production log says why", () => {
    expect(assess("faces of ancient europe 1-500 A.D.").reason).toMatch(/ancient|medieval/);
    expect(assess("trae crowder comments 12 02 2022").reason).toMatch(/2022.*from the topic period/);
    expect(assess("white lives matter montana sticker").reason).toMatch(/no topical evidence/);
  });

  it("B-roll that belongs is never deleted for failing to say so", () => {
    // The measurement that forced RONDE 57. Every one of these was rejected by the previous
    // rule, in a documentary about Berlin in 1945.
    for (const title of ["Ruins of a bombed city", "Soldiers marching", "Typewriter close up"]) {
      expect(assess(title).verdict).not.toBe("off_topic");
    }
  });

  it("a single everyday word from the title is not topical evidence", () => {
    // "The Dark End of the Third Reich" put "dark" in the anchors, and these two were being
    // waved through on it while the B-roll above was being deleted.
    expect(assess("Dark concrete room with dim light").verdict).toBe("neutral");
    expect(assess("Candle burning in the dark").verdict).toBe("neutral");
    expect(assess("Dark concrete room with dim light").reason).toMatch(/only generic words/);
    // A generic word alongside a specific one still counts — the specific token carries it.
    expect(assess("The dark final hours of Adolf Hitler").verdict).toBe("topical");
  });

  it("an era far from the topic is a conflict; one inside it is not", () => {
    expect(assess("Berlin street scene 1943").verdict).toBe("topical"); // matches "berlin"
    expect(assess("parade footage 1938").eraConflict).toBe(false);
    expect(assess("smartphone unboxing 2021").eraConflict).toBe(true);
    expect(assess("roman empire mosaics").eraConflict).toBe(true);
  });
});

describe("RONDE 54 — the gate cannot starve a scene", () => {
  it("keeps everything when every candidate reads as off-topic", () => {
    // All three carry an era conflict, so all three would be dropped — and a beat with no
    // candidates becomes a colour card, which is worse than a weak clip.
    const all = ["ancient rome mosaics", "medieval castle tour", "smartphone review 2021"];
    const { kept, dropped } = rejectOffTopicCandidates(all, (t) => assess(t));
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it("drops only what it can prove wrong when something usable survives", () => {
    const mixed = [
      "Signed Photograph of Adolf Hitler",
      "faces of ancient europe 1-500 A.D.",
      "Bundesarchiv Bild 183-1989-0322-506",
      "Ruins of a bombed city",
    ];
    const { kept, dropped } = rejectOffTopicCandidates(mixed, (t) => assess(t));
    expect(kept).toEqual([
      "Signed Photograph of Adolf Hitler",
      "Bundesarchiv Bild 183-1989-0322-506",
      // Kept: RONDE 57 no longer deletes B-roll for failing to name the subject.
      "Ruins of a bombed city",
    ]);
    expect(dropped.map((d) => d.candidate)).toEqual(["faces of ancient europe 1-500 A.D."]);
  });

  it("without a topic to compare against, nothing is judged at all", () => {
    const empty = buildTopicMatcher(undefined, [], "");
    for (const title of ["white lives matter montana sticker", "anything at all really"]) {
      const a = assessCandidateTopicality({ title }, empty);
      // No topic tokens means no match is possible; rejecting on that would reject everything.
      expect(a.verdict).not.toBe("topical");
      expect(a.eraConflict).toBe(false);
    }
  });
});

describe("RONDE 54 — ranking effect", () => {
  it("topical outranks silence, and silence is left exactly where it was", () => {
    expect(topicalRankingBonus("topical")).toBeGreaterThan(0);
    expect(topicalRankingBonus("neutral")).toBe(0);
    expect(topicalRankingBonus("off_topic")).toBeLessThan(0);
  });

  it("the funnel actually consults it, and drops before scoring", () => {
    const src = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(src).toContain("assessCandidateTopicality(c, topicMatcher)");
    // The reject must come before the candidate is pushed, not after.
    const assessIdx = src.indexOf("const topical = topicMatcher ? assessCandidateTopicality");
    const pushIdx = src.indexOf("merged.push({", assessIdx);
    const dropIdx = src.indexOf('offTopic.push({', assessIdx);
    expect(assessIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(assessIdx);
    expect(dropIdx).toBeLessThan(pushIdx);
    // And the bonus is part of the ranking sum.
    expect(src).toContain("topicalRankingBonus(topical?.verdict ?? \"neutral\")");
    // The never-empty guard is present.
    expect(src).toContain("keeping them ");
  });

  it("archive candidates are not touched — they are ranked on their own keyword score", () => {
    const src = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
    const archiveBlock = src.slice(
      src.indexOf("// Archive candidates"),
      src.indexOf("// FASE 2 / STAP 7")
    );
    expect(archiveBlock).not.toContain("assessCandidateTopicality");
    expect(archiveBlock).toContain("const kwBase = Math.min(1, pick.score / KEYWORD_SCORE_MAX);");
  });
});
