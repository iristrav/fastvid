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
  it("rejects the five that actually shipped", () => {
    // Render 531
    expect(assess("faces of ancient europe 1-500 A.D.", "faces-of-ancient-europe-1-500-a.-d_202506").verdict)
      .toBe("off_topic");
    expect(assess("white lives matter montana sticker", "white-lives-matter-montana-sticker").verdict)
      .toBe("off_topic");
    expect(assess("bulgarian national union customs", "bulgarian-national-union-customs").verdict)
      .toBe("off_topic");
    // Render 530
    expect(assess("trae crowder comments 12 02 2022", "trae-crowder-comments-12-02-2022").verdict)
      .toBe("off_topic");
    expect(assess("verdachte huub wijfjes", "verdachte-huub-wijfjes").verdict).toBe("off_topic");
  });

  it("names the reason, so a production log says why", () => {
    expect(assess("faces of ancient europe 1-500 A.D.").reason).toMatch(/ancient|medieval/);
    expect(assess("trae crowder comments 12 02 2022").reason).toMatch(/2022.*from the topic period/);
    expect(assess("white lives matter montana sticker").reason).toMatch(/none about this topic/);
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
    const all = ["white lives matter sticker", "bulgarian union customs", "trae crowder 2022"];
    const { kept, dropped } = rejectOffTopicCandidates(all, (t) => assess(t));
    // A beat with no candidates becomes a colour card, which is worse than a weak clip.
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it("drops only the off-topic ones when something usable survives", () => {
    const mixed = [
      "Signed Photograph of Adolf Hitler",
      "white lives matter montana sticker",
      "Bundesarchiv Bild 183-1989-0322-506",
      "faces of ancient europe 1-500 A.D.",
    ];
    const { kept, dropped } = rejectOffTopicCandidates(mixed, (t) => assess(t));
    expect(kept).toEqual([
      "Signed Photograph of Adolf Hitler",
      "Bundesarchiv Bild 183-1989-0322-506",
    ]);
    expect(dropped.map((d) => d.candidate)).toEqual([
      "white lives matter montana sticker",
      "faces of ancient europe 1-500 A.D.",
    ]);
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
