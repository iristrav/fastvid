import { describe, expect, it } from "vitest";
import {
  buildMediaSearchIntent,
  inferTopicKind,
  mergeAiRelevanceScores,
  rankMediaCandidates,
  scoreMediaCandidate,
  type MediaCandidate,
} from "./mediaResearchEngine";

describe("inferTopicKind", () => {
  it("detects person topics", () => {
    expect(inferTopicKind("Elon Musk spoke at the event.", "Elon Musk", false, false)).toBe("person");
    expect(inferTopicKind("Breaking news today.", "", false, true)).toBe("person");
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

  it("prefers Unsplash over Pexels when query matches beat", () => {
    const unsplash: MediaCandidate = {
      path: "/tmp/s1_b0_unsplash_titanic.mp4",
      query: "RMS Titanic ship",
      source: "unsplash",
      isVideo: false,
    };
    const pexels: MediaCandidate = {
      path: "/tmp/s1_b0_pexels_ocean.mp4",
      query: "ocean waves",
      source: "pexels",
      isVideo: true,
    };
    expect(scoreMediaCandidate(unsplash, titanicIntent)).toBeGreaterThan(
      scoreMediaCandidate(pexels, titanicIntent)
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
