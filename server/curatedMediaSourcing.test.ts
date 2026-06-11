import { describe, expect, it } from "vitest";
import {
  buildBeatMatchTags,
  buildCuratedQueryTags,
  curatedAssetContentKey,
  curatedClipPathAssetId,
  extractTopicAnchorTags,
  isCuratedInterviewAsset,
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
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/local-storage/a.mp4",
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
    };
    const genericVideo: MediaArchiveAsset = {
      ...asset,
      id: 2,
      title: "Ocean liner deck",
      tags: ["titanic", "ship", "historical"],
      mediaType: "video",
      mimeType: "video/mp4",
    };

    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { keywords: ["germany", "turmoil"], text: "Germany was in turmoil", index: 0, searchQuery: "germany" },
      { text: "Germany was in turmoil" },
      "Hitler: Rise and Fall of the Third Reich"
    );

    const hitlerScore = scoreCuratedAsset(asset, ["hitler", "wwii"], beatTags, topicAnchors);
    const titanicScore = scoreCuratedAsset(genericVideo, ["titanic"], beatTags, topicAnchors);
    expect(hitlerScore).toBeGreaterThan(titanicScore);
  });

  it("scoreCuratedAsset ranks beat-text title matches over unrelated archive clips", () => {
    const berlinAsset: MediaArchiveAsset = {
      id: 3,
      archiveId: 9,
      title: "Berlin wall checkpoint",
      tags: ["berlin", "wall", "cold-war"],
      mediaType: "image",
      mimeType: "image/jpeg",
      storageUrl: "/local-storage/b.jpg",
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
    const oceanAsset: MediaArchiveAsset = {
      ...berlinAsset,
      id: 4,
      title: "Ocean liner deck",
      tags: ["titanic", "ship"],
    };
    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { keywords: ["berlin", "wall"], text: "The Berlin wall divided the city", index: 2 },
      { text: "The Berlin wall divided the city" },
      "Cold War Documentary"
    );
    const berlinScore = scoreCuratedAsset(berlinAsset, ["cold-war"], beatTags, topicAnchors);
    const oceanScore = scoreCuratedAsset(oceanAsset, ["titanic"], beatTags, topicAnchors);
    expect(berlinScore).toBeGreaterThan(oceanScore);
  });

  it("curatedAssetContentKey is stable per asset id", () => {
    expect(curatedAssetContentKey(42)).toBe("curated:asset:42");
  });

  it("curatedClipPathAssetId parses asset id from output filename", () => {
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated_a17.mp4")).toBe(17);
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated.mp4")).toBeNull();
  });

  it("penalizes historian interview clips vs historical footage", () => {
    const interview = {
      id: 5,
      title: "Historicus bespreekt Adolf Hitler",
      tags: ["hitler", "interview"],
    };
    const parade = {
      id: 6,
      title: "Militaire parade in Berlijn 1939",
      tags: ["hitler", "parade"],
    };
    expect(isCuratedInterviewAsset(interview)).toBe(true);
    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { keywords: ["hitler"], text: "Hitler in Berlin", index: 0 },
      { text: "Hitler in Berlin" },
      "Hitler documentary"
    );
    const interviewScore = scoreCuratedAsset(
      { ...interview, archiveId: 1, mediaType: "video", mimeType: "video/mp4", storageUrl: "/x", isActive: 1, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), fileSizeBytes: 1, width: 1920, height: 1080, durationSec: 5, sourceUrl: null, sourceLabel: null },
      ["hitler"],
      beatTags,
      topicAnchors
    );
    const paradeScore = scoreCuratedAsset(
      { ...parade, archiveId: 1, mediaType: "video", mimeType: "video/mp4", storageUrl: "/y", isActive: 1, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), fileSizeBytes: 1, width: 1920, height: 1080, durationSec: 5, sourceUrl: null, sourceLabel: null },
      ["hitler"],
      beatTags,
      topicAnchors
    );
    expect(paradeScore).toBeGreaterThan(interviewScore);
  });

  it("prefers video clips over still images when both match the beat", () => {
    const beatText = "Hitler gives a speech at a rally in Berlin";
    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { keywords: ["speech", "rally"], text: beatText, index: 0 },
      { text: beatText },
      "Hitler documentary"
    );
    const still: MediaArchiveAsset = {
      id: 10,
      archiveId: 1,
      title: "Hitler speech rally propaganda poster",
      tags: ["hitler", "speech"],
      mediaType: "image",
      mimeType: "image/jpeg",
      storageUrl: "/local-storage/poster.jpg",
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
    const footage: MediaArchiveAsset = {
      ...still,
      id: 11,
      title: "Hitler gives speech at rally",
      mediaType: "video",
      mimeType: "video/mp4",
      durationSec: 6,
      storageUrl: "/local-storage/speech.mp4",
    };
    const stillScore = scoreCuratedAsset(still, ["hitler"], beatTags, topicAnchors, beatText);
    const videoScore = scoreCuratedAsset(footage, ["hitler"], beatTags, topicAnchors, beatText);
    expect(videoScore).toBeGreaterThan(stillScore);
  });
});
