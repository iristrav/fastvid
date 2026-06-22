import { describe, expect, it } from "vitest";
import {
  buildBeatVisionQueryText,
  beatVisionContextFromProfile,
} from "./localClipVision";
import { analyzeSceneVisual } from "./visualMatchingEngine";
import { inferPrimaryGeoFromTitle } from "./vidrushQuality";
import {
  clipPreRankPoolSize,
  clipPreRankMinScore10,
  scoreAssetClipPreRank,
} from "./archiveClipEmbedding";
import type { BeatSemanticProfile } from "./semanticVisualMatching";

describe("buildBeatVisionQueryText", () => {
  it("puts visual intent and entities before raw narration", () => {
    const profile: BeatSemanticProfile = {
      beatText: "Hij stond daar waar alles begon.",
      summary: "Elon Musk at SpaceX launch pad before Starship test",
      entities: {
        persons: ["Elon Musk"],
        locations: ["SpaceX launch pad"],
        companies: ["SpaceX"],
        events: ["Starship test"],
        objects: ["rocket"],
        emotions: [],
        timePeriods: [],
        years: ["2024"],
      },
      searchTiers: [],
      topicDomain: "space_tech",
    };
    const ctx = beatVisionContextFromProfile(
      {
        text: "Hij stond daar waar alles begon.",
        searchQuery: "rocket launch pad spacex",
        powerWord: "Starship",
      },
      "Elon Musk documentary",
      profile
    );
    const query = buildBeatVisionQueryText(ctx);
    expect(query.indexOf("Elon Musk at SpaceX")).toBeLessThan(
      query.indexOf("Hij stond daar")
    );
    expect(query).toContain("Subject:");
    expect(query).toContain("Elon Musk");
    expect(query).toContain("rocket launch pad spacex");
  });

  it("strips visual tags from narration", () => {
    const query = buildBeatVisionQueryText({
      beatText: "The city grew fast. [visual: Amsterdam skyline at dusk]",
      visualDescription: "Amsterdam canal district aerial view",
    });
    expect(query).toContain("Amsterdam canal district");
    expect(query).not.toContain("[visual:");
  });

  it("coerces non-string videoTitle from metadata objects", () => {
    const analysis = analyzeSceneVisual(
      "Cyclists cross a Dutch canal bridge.",
      { title: "Why the Netherlands Is the Opposite of the U.S." } as unknown as string
    );
    expect(analysis.main_topic).toContain("Netherlands");
    expect(() => analyzeSceneVisual("Test sentence.", { foo: 1 } as unknown as string)).not.toThrow();
  });

  it("coerces numeric videoTitle for geo inference", () => {
    expect(() => inferPrimaryGeoFromTitle(42 as unknown as string)).not.toThrow();
  });
});

describe("clip pre-rank helpers", () => {
  it("clipPreRankPoolSize is smaller in fast mode", () => {
    expect(clipPreRankPoolSize(true)).toBeLessThan(clipPreRankPoolSize(false));
  });

  it("clipPreRankMinScore10 is relaxed in fast mode", () => {
    expect(clipPreRankMinScore10(true)).toBeLessThan(clipPreRankMinScore10(false));
  });

  it("scoreAssetClipPreRank returns no embeddings for unknown asset", () => {
    const pr = scoreAssetClipPreRank(999_999_999, [0.1, 0.2, 0.3], 8);
    expect(pr.hasEmbeddings).toBe(false);
    expect(pr.definiteFail).toBe(false);
  });
});
