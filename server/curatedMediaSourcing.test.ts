import { describe, expect, it } from "vitest";
import {
  buildCuratedQueryTags,
  curatedAssetContentKey,
  curatedClipPathAssetId,
  extractTopicAnchorTags,
  scoreCuratedAsset,
} from "./curatedMediaSourcing";
import type { MediaArchiveAsset } from "./db";

describe("curatedMediaSourcing", () => {
  it("buildCuratedQueryTags normalizes beat and scene text", () => {
    const tags = buildCuratedQueryTags(
      { keywords: ["Titanic"], text: "The ship struck an iceberg", index: 1, searchQuery: "deck" },
      { text: "Passengers on deck", visualCue: "maritime disaster", pexelsQuery: "ocean" },
      "Titanic Documentary"
    );
    expect(tags).toContain("titanic");
    expect(tags).toContain("deck");
    expect(tags).toContain("maritime");
  });

  it("extractTopicAnchorTags keeps subject tokens from title", () => {
    const anchors = extractTopicAnchorTags("Hitler: Rise and Fall of the Third Reich");
    expect(anchors).toContain("hitler");
    expect(anchors).toContain("reich");
    expect(anchors).not.toContain("rise");
  });

  it("scoreCuratedAsset prefers anchor-tagged assets over generic video topics", () => {
    const asset: MediaArchiveAsset = {
      id: 1,
      archiveId: 9,
      title: "Hitler speech 1939",
      tags: ["hitler", "nazi", "germany"],
      mediaType: "image",
      mimeType: "image/jpeg",
      storageUrl: "/local-storage/a.jpg",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1000,
      width: 1920,
      height: 1080,
      durationSec: null,
      sourceUrl: null,
      sourceLabel: null,
    };
    const genericVideo: MediaArchiveAsset = {
      ...asset,
      id: 2,
      title: "Ocean liner deck",
      tags: ["titanic", "ship", "historical"],
      mediaType: "video",
      mimeType: "video/mp4",
    };

    const anchors = ["hitler"];
    const queryTags = buildCuratedQueryTags(
      { keywords: ["germany", "turmoil"], text: "Germany was in turmoil", index: 0, searchQuery: "germany" },
      { text: "Germany was in turmoil" },
      "Hitler: Rise and Fall of the Third Reich"
    );

    const hitlerScore = scoreCuratedAsset(asset, ["hitler", "wwii"], queryTags, anchors);
    const titanicScore = scoreCuratedAsset(genericVideo, ["titanic"], queryTags, anchors);
    expect(hitlerScore).toBeGreaterThan(titanicScore);
  });

  it("curatedAssetContentKey is stable per asset id", () => {
    expect(curatedAssetContentKey(42)).toBe("curated:asset:42");
  });

  it("curatedClipPathAssetId parses asset id from output filename", () => {
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated_a17.mp4")).toBe(17);
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated.mp4")).toBeNull();
  });
});
