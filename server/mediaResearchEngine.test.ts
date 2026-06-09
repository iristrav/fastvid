import { describe, expect, it } from "vitest";
import {
  buildHistoricalArchivalQueries,
  buildMediaSearchIntent,
  inferTopicKind,
  isHistoricalDocumentary,
  realFootageFirstEnabled,
  mergeAiRelevanceScores,
  partitionCandidatesForIntent,
  rankMediaCandidates,
  scoreMediaCandidate,
  type MediaCandidate,
} from "./mediaResearchEngine";

describe("inferTopicKind", () => {
  it("detects person topics", () => {
    expect(inferTopicKind("Elon Musk spoke at the event.", "Elon Musk", false, false)).toBe("person");
    expect(inferTopicKind("Breaking news today.", "", false, true)).toBe("person");
  });

  it("detects historical topics even when a name is mentioned in passing", () => {
    expect(
      inferTopicKind(
        "In 1912 the Titanic sank; James Cameron later made a film about it.",
        "James Cameron",
        false,
        false
      )
    ).toBe("historical");
  });

  it("detects historical topics", () => {
    expect(
      inferTopicKind("In 1912 vertrok de Titanic vanuit Southampton.", "", false, false)
    ).toBe("historical");
  });

  it("detects space topics", () => {
    expect(inferTopicKind("The rocket launched.", "", true, false)).toBe("space");
  });
});

describe("scoreMediaCandidate", () => {
  const titanicIntent = buildMediaSearchIntent({
    beatText: "In 1912 vertrok de Titanic vanuit Southampton.",
    searchQueries: ["Titanic Southampton 1912", "RMS Titanic"],
    keywords: ["titanic", "southampton", "1912"],
    primaryPerson: "",
    persons: [],
    powerWord: "Titanic",
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: false,
  });

  it("penalizes stock and stills below archival video for historical beats", () => {
    const archive: MediaCandidate = {
      path: "/tmp/s1_b0_archive_titanic.mp4",
      query: "RMS Titanic archival footage 1912",
      source: "internet_archive",
      isVideo: true,
    };
    const pexels: MediaCandidate = {
      path: "/tmp/s1_b0_pexels_ocean.mp4",
      query: "ocean waves",
      source: "pexels",
      isVideo: true,
    };
    const unsplash: MediaCandidate = {
      path: "/tmp/s1_b0_unsplash_titanic.mp4",
      query: "RMS Titanic ship",
      source: "unsplash",
      isVideo: false,
    };
    expect(scoreMediaCandidate(archive, titanicIntent)).toBeGreaterThan(
      scoreMediaCandidate(pexels, titanicIntent)
    );
    expect(scoreMediaCandidate(archive, titanicIntent)).toBeGreaterThan(
      scoreMediaCandidate(unsplash, titanicIntent)
    );
  });

  it("prefers Wikimedia video over generic Pexels for historical beats", () => {
    const wiki: MediaCandidate = {
      path: "/tmp/s1_b0_wikivid_titanic.mp4",
      query: "RMS Titanic Southampton",
      source: "wikimedia_video",
      isVideo: true,
    };
    const pexels: MediaCandidate = {
      path: "/tmp/s1_b0_pexels_ocean.mp4",
      query: "ocean waves",
      source: "pexels",
      isVideo: true,
    };
    expect(scoreMediaCandidate(wiki, titanicIntent)).toBeGreaterThan(
      scoreMediaCandidate(pexels, titanicIntent)
    );
  });

  it("ranks authentic Titanic footage above ocean b-roll", () => {
    const candidates: MediaCandidate[] = [
      {
        path: "/tmp/s1_b0_pexels_ocean.mp4",
        query: "ocean sunset",
        source: "pexels",
        isVideo: true,
      },
      {
        path: "/tmp/s1_b0_archive_titanic.mp4",
        query: "Titanic departure 1912",
        source: "internet_archive",
        isVideo: true,
      },
      {
        path: "/tmp/s1_b0_wiki_titanic.jpg.mp4",
        query: "RMS Titanic",
        source: "wikimedia_image",
        isVideo: false,
      },
    ];
    const ranked = rankMediaCandidates(candidates, titanicIntent);
    expect(ranked[0].source).toBe("internet_archive");
    expect(ranked.some((c) => c.source === "pexels")).toBe(true);
    const pexelsIdx = ranked.findIndex((c) => c.source === "pexels");
    const archiveIdx = ranked.findIndex((c) => c.source === "internet_archive");
    expect(archiveIdx).toBeLessThan(pexelsIdx);
  });
});

describe("mergeAiRelevanceScores", () => {
  it("boosts candidates the LLM scored higher", () => {
    const candidates: MediaCandidate[] = [
      { path: "/a.mp4", query: "Titanic", source: "internet_archive", isVideo: true, score: 100 },
      { path: "/b.mp4", query: "ocean", source: "pexels", isVideo: true, score: 100 },
    ];
    const aiScores = new Map([
      [0, 9],
      [1, 2],
    ]);
    const merged = mergeAiRelevanceScores(candidates, aiScores);
    expect(merged[0].score).toBeGreaterThan(merged[1].score!);
  });
});

describe("isHistoricalDocumentary", () => {
  it("detects Titanic from title and narration", () => {
    expect(
      isHistoricalDocumentary("The RMS Titanic in 1912", "The ship left Southampton in April 1912.")
    ).toBe(true);
  });
});

describe("buildMediaSearchIntent", () => {
  it("uses video title for historical topic when beat only mentions a filmmaker", () => {
    const intent = buildMediaSearchIntent({
      beatText: "James Cameron later directed a blockbuster about the disaster.",
      searchQueries: ["Titanic film"],
      keywords: ["titanic"],
      primaryPerson: "James Cameron",
      persons: ["James Cameron"],
      videoTitle: "The RMS Titanic in 1912",
      powerWord: "Titanic",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    expect(intent.topicKind).toBe("historical");
  });
});

describe("buildHistoricalArchivalQueries", () => {
  it("builds Titanic-specific archival queries", () => {
    const intent = buildMediaSearchIntent({
      beatText: "In 1912 vertrok de Titanic vanuit Southampton.",
      searchQueries: ["Titanic", "Southampton"],
      keywords: ["titanic"],
      primaryPerson: "",
      persons: [],
      powerWord: "Titanic",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const queries = buildHistoricalArchivalQueries(intent, intent.beatText);
    expect(queries.some((q) => /titanic/i.test(q) && /archival|1912|rms/i.test(q))).toBe(true);
  });
});

describe("realFootageFirstEnabled", () => {
  it("is on by default", () => {
    const prev = process.env.REAL_FOOTAGE_FIRST;
    delete process.env.REAL_FOOTAGE_FIRST;
    expect(realFootageFirstEnabled()).toBe(true);
    process.env.REAL_FOOTAGE_FIRST = prev;
  });
});

describe("partitionCandidatesForIntent", () => {
  it("puts stock video in stock fallback for historical topics", () => {
    const intent = buildMediaSearchIntent({
      beatText: "The Titanic sank in 1912.",
      searchQueries: ["Titanic"],
      keywords: ["titanic"],
      primaryPerson: "",
      persons: [],
      powerWord: "Titanic",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const ranked: MediaCandidate[] = [
      { path: "/a.mp4", query: "ocean", source: "pexels", isVideo: true, score: 200 },
      { path: "/b.mp4", query: "RMS Titanic archival", source: "internet_archive", isVideo: true, score: 150 },
    ];
    const { videoFirst, stockFallback } = partitionCandidatesForIntent(ranked, intent);
    expect(videoFirst[0].source).toBe("internet_archive");
    expect(videoFirst.some((c) => c.source === "pexels")).toBe(false);
    expect(stockFallback[0].source).toBe("pexels");
  });
});

describe("buildMediaSearchIntent", () => {
  it("deduplicates and caps search queries", () => {
    const intent = buildMediaSearchIntent({
      beatText: "Bitcoin reached a new high.",
      searchQueries: ["Bitcoin", "Bitcoin", "cryptocurrency market", "blockchain"],
      keywords: ["bitcoin"],
      primaryPerson: "",
      persons: [],
      powerWord: "Bitcoin",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    expect(intent.searchQueries).toEqual(["Bitcoin", "cryptocurrency market", "blockchain"]);
    expect(intent.topicKind).toBe("general");
  });
});
