import { describe, expect, it } from "vitest";
import { archiveAssetRowToCandidateAsset, minimalVisualIntentFromScene, sceneBeatId, sceneToBeatInput } from "./adapters";
import type { CuratedCandidatePick, Scene } from "./types";

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    index: 2,
    text: "The city grew rapidly after the war.",
    visualCue: "aerial view of a rebuilt city skyline",
    pexelsQuery: "city skyline rebuilding",
    pexelsQueries: ["city skyline rebuilding", "post-war reconstruction"],
    aiImagePrompt: "",
    duration: 5.5,
    ...overrides,
  };
}

function candidatePick(overrides: Partial<CuratedCandidatePick> = {}): CuratedCandidatePick {
  return {
    asset: {
      id: 42,
      archiveId: 1,
      title: "Rebuilt city skyline",
      mediaType: "video",
      mixKind: "real_video",
      mimeType: "video/mp4",
      storageUrl: "https://cdn.example.com/assets/42.mp4",
      storageKey: "assets/42.mp4",
      tags: ["city", "skyline", "reconstruction"],
      sourceNote: "Public archive",
      licenseNote: "CC0",
      width: 1920,
      height: 1080,
      durationSec: 12,
      sortOrder: 0,
      isActive: 1,
      hasBakedEditText: 0,
      annotationJson: null,
      editorialScore: null,
      annotationVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CuratedCandidatePick["asset"],
    archiveName: "City Archive",
    score: 7.5,
    archiveNicheTags: ["urban", "history"],
    ...overrides,
  };
}

describe("Pipeline adapters (Phase 8)", () => {
  describe("sceneBeatId / sceneToBeatInput", () => {
    it("produces a single 'beat 0' id per scene, consistent with the modular pipeline's one-scene-one-beat model", () => {
      expect(sceneBeatId(0)).toBe("s0-b0");
      expect(sceneBeatId(3)).toBe("s3-b0");
    });

    it("sceneToBeatInput carries the scene text as spokenText", () => {
      const input = sceneToBeatInput(scene({ index: 5, text: "Hello world" }));
      expect(input).toEqual({ beatId: "s5-b0", spokenText: "Hello world" });
    });
  });

  describe("archiveAssetRowToCandidateAsset", () => {
    it("maps every legacy field to its CandidateAsset equivalent", () => {
      const candidate = archiveAssetRowToCandidateAsset(candidatePick());
      expect(candidate.candidateId).toBe("legacy_archive:42");
      expect(candidate.source).toBe("own_archive");
      expect(candidate.assetType).toBe("video");
      expect(candidate.title).toBe("Rebuilt city skyline");
      expect(candidate.tags).toEqual(["city", "skyline", "reconstruction"]);
      expect(candidate.remoteUrl).toBe("https://cdn.example.com/assets/42.mp4");
      expect(candidate.localPath).toBeNull();
      expect(candidate.license).toBe("CC0");
      expect(candidate.attribution).toBe("Public archive");
      expect(candidate.width).toBe(1920);
      expect(candidate.height).toBe(1080);
      expect(candidate.duration).toBe(12);
      expect(candidate.mimeType).toBe("video/mp4");
      expect(candidate.originalSource).toBe("City Archive");
      expect(candidate.keywordScore).toBe(7.5);
      expect(candidate.rankingScore).toBe(7.5);
      expect(candidate.retrievalReasons).toEqual(["keyword"]);
      expect(candidate.retrievalSources).toEqual([{ source: "own_archive_legacy", score: 7.5 }]);
    });

    it("converts clipVisionScore10 (0-10 scale) into clipSimilarity (0-1 scale)", () => {
      const candidate = archiveAssetRowToCandidateAsset(candidatePick({ clipVisionScore10: 8 }));
      expect(candidate.clipSimilarity).toBeCloseTo(0.8, 5);
    });

    it("leaves clipSimilarity null when clipVisionScore10 is absent", () => {
      const candidate = archiveAssetRowToCandidateAsset(candidatePick());
      expect(candidate.clipSimilarity).toBeNull();
    });

    it("pulls embeddingSimilarity from the legacy semantic match result when present", () => {
      const candidate = archiveAssetRowToCandidateAsset(
        candidatePick({ semantic: { relevanceScore: 9, tier: 1, tierLabel: "exact", embeddingSimilarity: 0.87, matchedEntities: [] } })
      );
      expect(candidate.embeddingSimilarity).toBeCloseTo(0.87, 5);
    });

    it("defaults embeddingSimilarity to null when there's no semantic match", () => {
      const candidate = archiveAssetRowToCandidateAsset(candidatePick());
      expect(candidate.embeddingSimilarity).toBeNull();
    });

    it("handles a missing title/license/sourceNote gracefully", () => {
      const pick = candidatePick();
      pick.asset = { ...pick.asset, title: null, licenseNote: null, sourceNote: null };
      const candidate = archiveAssetRowToCandidateAsset(pick);
      expect(candidate.title).toBeNull();
      expect(candidate.license).toBeNull();
      expect(candidate.attribution).toBeNull();
    });
  });

  describe("minimalVisualIntentFromScene", () => {
    it("fills in the fields the legacy Scene already carries", () => {
      const intent = minimalVisualIntentFromScene(scene());
      expect(intent.beatId).toBe("s2-b0");
      expect(intent.spokenText).toBe("The city grew rapidly after the war.");
      expect(intent.visualSubject).toBe("aerial view of a rebuilt city skyline");
      expect(intent.primaryKeyword).toBe("city skyline rebuilding");
      expect(intent.secondaryKeyword).toBe("post-war reconstruction");
    });

    it("leaves every Phase 3 entity-extraction field genuinely empty, not fabricated", () => {
      const intent = minimalVisualIntentFromScene(scene());
      expect(intent.objects).toEqual([]);
      expect(intent.brands).toEqual([]);
      expect(intent.companies).toEqual([]);
      expect(intent.countries).toEqual([]);
      expect(intent.events).toEqual([]);
      expect(intent.secondaryVisualSubjects).toEqual([]);
    });

    it("carries personNames through to the people field", () => {
      const intent = minimalVisualIntentFromScene(scene({ personNames: ["Marie Curie"] }));
      expect(intent.people).toEqual(["Marie Curie"]);
    });

    it("defaults people to an empty array when the scene has no personNames", () => {
      const intent = minimalVisualIntentFromScene(scene({ personNames: undefined }));
      expect(intent.people).toEqual([]);
    });

    it("falls back to scene text when visualCue and literalVisualCue are both absent", () => {
      const intent = minimalVisualIntentFromScene(
        scene({ visualCue: "", literalVisualCue: undefined, text: "A very specific fallback sentence." })
      );
      expect(intent.visualSubject).toBe("A very specific fallback sentence.");
    });

    it("marks cacheHit false and produces a deterministic, distinguishing intentHash", () => {
      const intent = minimalVisualIntentFromScene(scene({ index: 7 }));
      expect(intent.cacheHit).toBe(false);
      expect(intent.intentHash).toBe("legacy_adapter:s7-b0");
    });
  });
});
