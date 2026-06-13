import { describe, expect, it } from "vitest";
import {
  analyzeBeatSemanticsFallback,
  assetMeetsSemanticMinimum,
  buildSemanticPexelsQueries,
  computeLexicalSemanticSimilarity,
  computeTieredRelevanceScore,
  semanticMinRelevanceScore,
} from "./semanticVisualMatching";
import type { MediaArchiveAsset } from "./db";

function asset(
  partial: Pick<MediaArchiveAsset, "id" | "title" | "tags"> & { mediaType?: "video" | "image" }
): MediaArchiveAsset {
  return {
    archiveId: 1,
    mediaType: partial.mediaType ?? "video",
    mimeType: "video/mp4",
    storageUrl: `/local-storage/a${partial.id}.mp4`,
    isActive: 1,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    fileSizeBytes: 1000,
    width: 1920,
    height: 1080,
    durationSec: 6,
    sourceUrl: null,
    sourceLabel: null,
    sourceNote: null,
    mixKind: "real_video",
    ...partial,
  };
}

describe("semanticVisualMatching", () => {
  it("builds tiered profile for Hitler invaded Poland", () => {
    const profile = analyzeBeatSemanticsFallback(
      "In September 1939, Hitler invaded Poland with the German army.",
      "WWII Documentary"
    );
    expect(profile.entities.persons.some((p) => p.includes("hitler"))).toBe(true);
    expect(profile.searchTiers[0]?.some((t) => t.includes("hitler"))).toBe(true);
    expect(profile.searchTiers.flat().some((t) => t.includes("poland"))).toBe(true);
  });

  it("builds tiered profile for Elon Musk Starship", () => {
    const profile = analyzeBeatSemanticsFallback(
      "Elon Musk launched Starship on its first orbital test flight.",
      "SpaceX Documentary"
    );
    expect(profile.entities.companies.some((c) => c.includes("spacex"))).toBe(true);
    expect(profile.searchTiers.flat().some((t) => t.includes("starship") || t.includes("elon"))).toBe(true);
  });

  it("ranks Hitler footage above generic soldiers for invasion sentence", () => {
    const profile = analyzeBeatSemanticsFallback("Hitler invaded Poland in 1939.", "WWII");
    const hitlerClip = asset({
      id: 1,
      title: "Adolf Hitler speech rally 1939",
      tags: ["hitler", "nazi", "germany"],
    });
    const polandClip = asset({
      id: 2,
      title: "German troops crossing into Poland 1939",
      tags: ["poland", "invasion", "wehrmacht"],
    });
    const genericSoldiers = asset({
      id: 3,
      title: "Unknown soldiers marching",
      tags: ["soldiers", "war", "military"],
    });

    const hitlerScore = computeTieredRelevanceScore(profile, hitlerClip);
    const polandScore = computeTieredRelevanceScore(profile, polandClip);
    const genericScore = computeTieredRelevanceScore(profile, genericSoldiers);

    expect(hitlerScore.tier).toBeLessThanOrEqual(2);
    expect(hitlerScore.relevanceScore).toBeGreaterThan(genericScore.relevanceScore);
    expect(polandScore.relevanceScore).toBeGreaterThan(genericScore.relevanceScore);
    expect(assetMeetsSemanticMinimum(hitlerScore)).toBe(true);
    expect(assetMeetsSemanticMinimum(genericScore)).toBe(false);
  });

  it("ranks Musk/Starship above generic technology", () => {
    const profile = analyzeBeatSemanticsFallback("Elon Musk launched Starship from Texas.", "SpaceX");
    const musk = asset({ id: 10, title: "Elon Musk at SpaceX launch", tags: ["elon musk", "spacex"] });
    const starship = asset({ id: 11, title: "SpaceX Starship launch pad", tags: ["starship", "rocket"] });
    const genericTech = asset({ id: 12, title: "Generic technology office", tags: ["technology", "computer"] });

    const muskScore = computeTieredRelevanceScore(profile, musk);
    const shipScore = computeTieredRelevanceScore(profile, starship);
    const techScore = computeTieredRelevanceScore(profile, genericTech);

    expect(muskScore.relevanceScore).toBeGreaterThan(techScore.relevanceScore);
    expect(shipScore.relevanceScore).toBeGreaterThan(techScore.relevanceScore);
  });

  it("lexical similarity prefers matching asset document", () => {
    const profile = analyzeBeatSemanticsFallback("Hitler in his bunker gave final orders.", "Hitler");
    const bunker = asset({ id: 20, title: "Hitler fuhrerbunker underground", tags: ["bunker", "hitler"] });
    const ocean = asset({ id: 21, title: "Ocean waves sunset", tags: ["ocean", "nature"] });
    expect(computeLexicalSemanticSimilarity(profile, bunker)).toBeGreaterThan(
      computeLexicalSemanticSimilarity(profile, ocean)
    );
  });

  it("buildSemanticPexelsQueries orders tiers for stock search", () => {
    const profile = analyzeBeatSemanticsFallback("Hitler invaded Poland in 1939.", "WWII");
    const queries = buildSemanticPexelsQueries("Hitler invaded Poland in 1939.", profile, 8);
    expect(queries[0]).toMatch(/hitler/);
    expect(queries.some((q) => q.includes("poland"))).toBe(true);
  });
});
