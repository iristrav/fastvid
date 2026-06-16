import { describe, expect, it } from "vitest";
import {
  buildBeatMatchTags,
  buildCuratedQueryTags,
  buildGeoStockSearchQueries,
  curatedAssetContentKey,
  curatedClipPathAssetId,
  extractTopicAnchorTags,
  isCuratedInterviewAsset,
  scoreArchiveMetadata,
  scoreCuratedAsset,
  assetPassesBeatMinimum,
  isGeographyIncompatibleArchiveAsset,
  isCuratedOffTopicAsset,
  isCuratedStaticInteriorAsset,
  isCuratedPreparedStillClip,
  isCuratedPreparedVideoClip,
  rotateCuratedCandidates,
  shouldPreferPexelsOverArchive,
  shouldTryPexelsFirstForBeat,
  type CuratedCandidatePick,
} from "./curatedMediaSourcing";
import { isGenericPeopleAsset } from "./visualBeatTags";
import type { MediaArchiveAsset } from "./db";

describe("curatedMediaSourcing", () => {
  it("buildBeatMatchTags anchors any-topic sentence tokens", () => {
    const { beatTags, allTags } = buildBeatMatchTags(
      {
        text: "The Titanic struck an iceberg and began to sink.",
        index: 1,
        searchQuery: "titanic iceberg",
        powerWord: "titanic iceberg",
        keywords: [],
      },
      { text: "Maritime disaster documentary" },
      "Titanic Documentary"
    );
    expect(beatTags).toEqual(expect.arrayContaining(["titanic", "iceberg"]));
    expect(allTags).toEqual(expect.arrayContaining(["titanic"]));
  });

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
    const rotated = rotateCuratedCandidates(pool, 100, 1).map((x) => x.id);
    expect(rotated).not.toEqual([1, 2, 3, 4]);
    expect(rotated.sort()).toEqual([1, 2, 3, 4]);
  });

  it("assetPassesBeatMinimum rejects generic man for bunker sentence", () => {
    const beatText = "Hitler zat diep ondergronds in zijn bunker en gaf orders.";
    const genericMan: MediaArchiveAsset = {
      id: 50,
      archiveId: 1,
      title: "Unknown man portrait",
      tags: ["man", "portrait"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const bunkerClip: MediaArchiveAsset = {
      ...genericMan,
      id: 51,
      title: "Hitler in fuhrerbunker underground command post",
      tags: ["hitler", "bunker", "underground"],
    };
    expect(isGenericPeopleAsset(genericMan)).toBe(true);
    const { beatTags, topicAnchors } = buildBeatMatchTags(
      { text: beatText, index: 0, searchQuery: "hitler bunker", powerWord: "hitler bunker", keywords: [] },
      { text: beatText },
      "Hitler documentary"
    );
    const genericScore = scoreCuratedAsset(genericMan, ["hitler"], beatTags, topicAnchors, beatText);
    const bunkerScore = scoreCuratedAsset(bunkerClip, ["hitler"], beatTags, topicAnchors, beatText);
    expect(bunkerScore).toBeGreaterThan(genericScore);
    expect(assetPassesBeatMinimum(genericMan, beatText, genericScore, bunkerScore)).toBe(false);
    expect(assetPassesBeatMinimum(bunkerClip, beatText, bunkerScore, bunkerScore)).toBe(true);
  });

  it("rejects US skyline for Netherlands geography beat", () => {
    const title = "Why the Netherlands is the Opposite of the U.S.";
    const beatText = "In the Netherlands, bike lanes are everywhere.";
    const { beatTags, topicAnchors, videoVisualTopic } = buildBeatMatchTags(
      { text: beatText, index: 0, searchQuery: "netherlands bikes", powerWord: "netherlands", keywords: [] },
      { text: beatText },
      title
    );
    expect(videoVisualTopic).toBe("geography_urban");
    const charlotteClip: MediaArchiveAsset = {
      id: 70,
      archiveId: 1,
      title: "Charlotte North Carolina skyline stadium",
      tags: ["charlotte", "usa", "city skyline", "american city"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const amsterdamClip: MediaArchiveAsset = {
      ...charlotteClip,
      id: 71,
      title: "Amsterdam canal cycling infrastructure",
      tags: ["amsterdam", "netherlands", "canal", "cycling", "dutch city"],
    };
    const charlotteScore = scoreCuratedAsset(charlotteClip, [], beatTags, topicAnchors, beatText, videoVisualTopic);
    const amsterdamScore = scoreCuratedAsset(amsterdamClip, [], beatTags, topicAnchors, beatText, videoVisualTopic);
    expect(amsterdamScore).toBeGreaterThan(charlotteScore);
    expect(assetPassesBeatMinimum(charlotteClip, beatText, charlotteScore, amsterdamScore, undefined, videoVisualTopic)).toBe(false);
    expect(assetPassesBeatMinimum(amsterdamClip, beatText, amsterdamScore, amsterdamScore, undefined, videoVisualTopic)).toBe(true);
  });

  it("rejects Hitler footage for geography Berlin city comparison video", () => {
    const title = "Why Berlin is the Opposite of Every US City";
    const beatText = "Berlin invests heavily in public transit and walkable streets.";
    const { beatTags, topicAnchors, videoVisualTopic } = buildBeatMatchTags(
      { text: beatText, index: 0, searchQuery: "berlin transit", powerWord: "berlin", keywords: [] },
      { text: beatText },
      title
    );
    expect(videoVisualTopic).toBe("geography_urban");
    const hitlerClip: MediaArchiveAsset = {
      id: 60,
      archiveId: 1,
      title: "Hitler speech military parade Berlin 1939",
      tags: ["hitler", "nazi", "parade", "berlin"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    expect(isCuratedOffTopicAsset(hitlerClip, topicAnchors, beatTags, videoVisualTopic)).toBe(true);
    expect(assetPassesBeatMinimum(hitlerClip, beatText, 80, 80, undefined, videoVisualTopic)).toBe(false);
    const hitlerScore = scoreCuratedAsset(hitlerClip, ["berlin"], beatTags, topicAnchors, beatText, videoVisualTopic);
    expect(hitlerScore).toBeLessThanOrEqual(0);
  });

  it("prefers Pexels first for geography beats that name a country", () => {
    const title = "Why the Netherlands is the Opposite of the U.S.";
    const beatText = "In the Netherlands, cycling is part of daily life.";
    const { videoVisualTopic } = buildBeatMatchTags(
      { text: beatText, index: 0, searchQuery: "netherlands cycling", powerWord: "netherlands", keywords: [] },
      { text: beatText },
      title
    );
    expect(shouldTryPexelsFirstForBeat(beatText, videoVisualTopic)).toBe(true);
    expect(buildGeoStockSearchQueries(beatText, title)).toEqual(
      expect.arrayContaining(["amsterdam canal bicycles", "netherlands cycling infrastructure"])
    );
  });

  it("rejects archive clip without cyclists for fietsen beat", () => {
    const beatText = "Miljoenen mensen fietsen elke dag in Nederland.";
    const canalClip: MediaArchiveAsset = {
      id: 90,
      archiveId: 1,
      title: "Amsterdam canal boats",
      tags: ["amsterdam", "netherlands", "canal", "water"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const cyclingClip: MediaArchiveAsset = {
      ...canalClip,
      id: 91,
      title: "Amsterdam cyclists on canal bridge",
      tags: ["amsterdam", "netherlands", "cycling", "cyclists"],
    };
    expect(assetPassesBeatMinimum(canalClip, beatText, 70, 70)).toBe(false);
    expect(assetPassesBeatMinimum(cyclingClip, beatText, 70, 70)).toBe(true);
  });

  it("assetPassesBeatMinimum rejects canal clip for car sentence", () => {
    const beatText = "In Amerika rijden bijna alle mensen in auto's.";
    const canalClip: MediaArchiveAsset = {
      id: 90,
      archiveId: 1,
      title: "Amsterdam canal boats",
      tags: ["amsterdam", "netherlands", "canal", "water"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const trafficClip: MediaArchiveAsset = {
      ...canalClip,
      id: 92,
      title: "Highway traffic cars USA",
      tags: ["usa", "highway", "cars", "traffic"],
    };
    expect(assetPassesBeatMinimum(canalClip, beatText, 70, 70)).toBe(false);
    expect(assetPassesBeatMinimum(trafficClip, beatText, 70, 70)).toBe(true);
  });

  it("rejects B&W war archive for geography urban videos", () => {
    const bwClip: MediaArchiveAsset = {
      id: 93,
      archiveId: 1,
      title: "Zwart-wit parade Berlijn 1939",
      tags: ["zwart-wit", "parade", "berlin", "1939"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    expect(isGeographyIncompatibleArchiveAsset(bwClip)).toBe(true);
    expect(
      assetPassesBeatMinimum(
        bwClip,
        "In Amsterdam fietsen duizenden mensen.",
        80,
        80,
        undefined,
        "geography_urban"
      )
    ).toBe(false);
  });

  it("assetPassesBeatMinimum rejects generic clip for government sentence", () => {
    const beatText = "The government controls zoning and housing policy.";
    const genericClip: MediaArchiveAsset = {
      id: 94,
      archiveId: 1,
      title: "Random street crowd",
      tags: ["people", "street", "city"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const capitolClip: MediaArchiveAsset = {
      ...genericClip,
      id: 95,
      title: "US Capitol building facade",
      tags: ["capitol", "government", "washington"],
    };
    expect(assetPassesBeatMinimum(genericClip, beatText, 70, 70)).toBe(false);
    expect(assetPassesBeatMinimum(capitolClip, beatText, 70, 70)).toBe(true);
  });

  it("assetPassesBeatMinimum rejects generic clip for NL urban planning sentence", () => {
    const beatText = "In the Netherlands, urban planning shapes every neighborhood.";
    const genericClip: MediaArchiveAsset = {
      id: 96,
      archiveId: 1,
      title: "Random street crowd",
      tags: ["people", "street", "city"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const planningClip: MediaArchiveAsset = {
      ...genericClip,
      id: 97,
      title: "Amsterdam bike lanes and tram",
      tags: ["amsterdam", "netherlands", "tram", "cycling", "infrastructure"],
    };
    expect(assetPassesBeatMinimum(genericClip, beatText, 70, 70)).toBe(false);
    expect(assetPassesBeatMinimum(planningClip, beatText, 70, 70)).toBe(true);
  });

  it("assetPassesBeatMinimum rejects protest clip for America geo stat beat", () => {
    const beatText = "In America, only 1% of trips are by bike.";
    const protestClip: MediaArchiveAsset = {
      id: 91,
      archiveId: 1,
      title: "Protest march Washington DC",
      tags: ["protest", "demonstration", "usa", "crowd"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const skylineClip: MediaArchiveAsset = {
      ...protestClip,
      id: 92,
      title: "New York skyline timelapse",
      tags: ["usa", "skyline", "city", "america"],
    };
    expect(assetPassesBeatMinimum(protestClip, beatText, 70, 70, undefined, "geography_urban")).toBe(false);
    expect(assetPassesBeatMinimum(skylineClip, beatText, 70, 70, undefined, "geography_urban")).toBe(true);
  });

  it("assetPassesBeatMinimum rejects generic clip for NL infrastructure sentence", () => {
    const beatText = "The Netherlands has world-class infrastructure for bikes and trains.";
    const genericClip: MediaArchiveAsset = {
      id: 93,
      archiveId: 1,
      title: "Man walking in park",
      tags: ["people", "park", "generic"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const infraClip: MediaArchiveAsset = {
      ...genericClip,
      id: 94,
      title: "Netherlands train railway infrastructure",
      tags: ["netherlands", "train", "railway", "infrastructure"],
    };
    expect(assetPassesBeatMinimum(genericClip, beatText, 70, 70, undefined, "geography_urban")).toBe(false);
    expect(assetPassesBeatMinimum(infraClip, beatText, 70, 70, undefined, "geography_urban")).toBe(true);
  });

  it("shouldPreferPexelsOverArchive when top archive is wrong country", () => {
    const beatText = "In the Netherlands, bike lanes are everywhere.";
    const charlotteClip: MediaArchiveAsset = {
      id: 80,
      archiveId: 1,
      title: "Charlotte skyline",
      tags: ["charlotte", "usa", "skyline"],
      mediaType: "video",
      mimeType: "video/mp4",
      storageUrl: "/x.mp4",
      isActive: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fileSizeBytes: 1,
      width: 1920,
      height: 1080,
      durationSec: 6,
      sourceUrl: null,
      sourceLabel: null,
    };
    const ranked: CuratedCandidatePick[] = [
      { asset: charlotteClip, archiveName: "Geografie", score: 65 },
    ];
    expect(shouldPreferPexelsOverArchive(beatText, ranked, "geography_urban")).toBe(true);
  });
});
