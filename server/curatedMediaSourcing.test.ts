import { describe, expect, it } from "vitest";
import {
  buildBeatMatchTags,
  buildCuratedQueryTags,
  curatedAssetContentKey,
  curatedClipPathAssetId,
  extractTopicAnchorTags,
  isCuratedInterviewAsset,
  scoreArchiveMetadata,
  scoreCuratedAsset,
  isCuratedStaticInteriorAsset,
  isCuratedPreparedStillClip,
  isCuratedPreparedVideoClip,
  rotateCuratedCandidates,
} from "./curatedMediaSourcing";
import type { MediaArchiveAsset } from "./db";

describe("curatedMediaSourcing", () => {
  it("buildBeatMatchTags anchors bunker sentence to scene search tags", () => {
    const { beatTags, allTags } = buildBeatMatchTags(
      {
        text: "Hitler zat diep ondergronds in zijn bunker en gaf orders.",
        index: 2,
        searchQuery: "hitler bunker",
        powerWord: "hitler bunker",
        keywords: [],
      },
      { text: "Hitler documentary scene" },
      "Hitler Documentary"
    );
    expect(allTags).toEqual(expect.arrayContaining(["bunker", "hitler"]));
    expect(beatTags.some((t) => t.includes("bunker") || t === "hitler")).toBe(true);
  });

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

  it("scoreCuratedAsset penalizes off-topic era mismatches in WWII docs", () => {
    const medieval: MediaArchiveAsset = {
      id: 99,
      archiveId: 1,
      title: "Middeleeuws uithangbord in nacht",
      tags: ["middeleeuws", "nacht"],
      mediaType: "image",
      mimeType: "image/jpeg",
      storageUrl: "/local-storage/m.jpg",
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
    const beatTags = ["berlin", "1945", "hitler"];
    const topicAnchors = ["hitler", "wwii"];
    expect(scoreCuratedAsset(medieval, ["hitler"], beatTags, topicAnchors)).toBeLessThanOrEqual(0);
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

  it("prefers action footage over propaganda poster clips", () => {
    const beatText = "Hitler gives a speech at a rally";
    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { keywords: ["speech", "rally"], text: beatText, index: 0 },
      { text: beatText },
      "Hitler documentary"
    );
    const poster = {
      id: 20,
      archiveId: 1,
      title: "Nazi propaganda poster campaign",
      tags: ["hitler", "poster"],
      mediaType: "video" as const,
      mimeType: "video/mp4",
      storageUrl: "/x",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 5,
      sourceUrl: null,
      sourceLabel: null,
    };
    const speech = {
      ...poster,
      id: 21,
      title: "Hitler geeft toespraak bij bijeenkomst",
      tags: ["hitler", "speech"],
    };
    const posterScore = scoreCuratedAsset(poster, ["hitler"], beatTags, topicAnchors, beatText);
    const speechScore = scoreCuratedAsset(speech, ["hitler"], beatTags, topicAnchors, beatText);
    expect(speechScore).toBeGreaterThan(posterScore);
  });

  it("scoreArchiveMetadata matches archive name and niche tags without manual linking", () => {
    const hitlerScore = scoreArchiveMetadata(
      { name: "Hitler Documentary Archive", nicheTags: ["hitler", "wwii"] },
      ["speech", "berlin"],
      ["hitler", "reich"]
    );
    const titanicScore = scoreArchiveMetadata(
      { name: "Titanic Maritime Collection", nicheTags: ["titanic", "ship"] },
      ["speech", "berlin"],
      ["hitler", "reich"]
    );
    expect(hitlerScore).toBeGreaterThan(titanicScore);
  });

  it("scoreArchiveMetadata infers from archive name when niche tags are empty", () => {
    const score = scoreArchiveMetadata(
      { name: "Cold War Berlin", description: "Checkpoint and wall footage", nicheTags: [] },
      ["checkpoint", "wall"],
      ["berlin"]
    );
    expect(score).toBeGreaterThanOrEqual(8);
  });

  it("extractTopicAnchorTags keeps short ww2 token", () => {
    const anchors = extractTopicAnchorTags("WW2 Documentary: Battle of Berlin");
    expect(anchors).toContain("ww2");
  });

  it("isCuratedStaticInteriorAsset flags bunker/cell shots", () => {
    expect(isCuratedStaticInteriorAsset({ title: "Cel met bed en tafel", tags: [] })).toBe(true);
    expect(isCuratedStaticInteriorAsset({ title: "Militaire parade in Berlijn", tags: ["parade"] })).toBe(false);
  });

  it("rotateCuratedCandidates shifts start per video seed", () => {
    const pool = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const a = rotateCuratedCandidates(pool, 100, 0).map((x) => x.id);
    const b = rotateCuratedCandidates(pool, 200, 0).map((x) => x.id);
    expect(a).not.toEqual(b);
    expect(a.sort()).toEqual([1, 2, 3, 4]);
  });
});
