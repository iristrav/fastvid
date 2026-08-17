import { describe, expect, it } from "vitest";
import {
  buildHistoricalArchivalQueries,
  buildMediaSearchIntent,
  extractBeatVisualTargets,
  extractEventCue,
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

  it("prefers Internet Archive over YouTube for historical beats", () => {
    const youtube: MediaCandidate = {
      path: "/tmp/s1_b0_ytcc_titanic.mp4",
      query: "RMS Titanic departure 1912 documentary",
      source: "youtube_cc",
      isVideo: true,
    };
    const archive: MediaCandidate = {
      path: "/tmp/s1_b0_archive_titanic.mp4",
      query: "Titanic departure 1912",
      source: "internet_archive",
      isVideo: true,
    };
    const ranked = rankMediaCandidates([youtube, archive], titanicIntent);
    expect(ranked[0].source).toBe("internet_archive");
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

  // Visual-selection quality upgrade — point 2 (multi-query search) + regression: this function
  // used to hardcode Titanic-only phrasing ("RMS ${anchor}", "${anchor} sinking", "${anchor}
  // ship") onto every historical topic, so a Hitler beat literally produced "RMS Hitler" /
  // "Hitler sinking" queries. It now derives phrasing from the beat's actual visual targets.
  it("produces multiple distinct, topic-appropriate query variants for a non-Titanic historical beat (regression for the RMS/sinking/ship bug)", () => {
    const intent = buildMediaSearchIntent({
      beatText: "On April 30, 1945, Hitler and Eva Braun committed suicide inside the Führerbunker in Berlin.",
      searchQueries: ["Hitler death bunker"],
      keywords: ["hitler", "bunker", "berlin"],
      primaryPerson: "",
      persons: ["Hitler"],
      powerWord: "Hitler",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const queries = buildHistoricalArchivalQueries(intent, intent.beatText);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.some((q) => /rms hitler/i.test(q))).toBe(false);
    expect(queries.some((q) => /hitler sinking/i.test(q))).toBe(false);
    expect(queries.some((q) => /hitler ship/i.test(q))).toBe(false);
    expect(queries.some((q) => /archival/i.test(q))).toBe(true);
    expect(queries.some((q) => /1945/.test(q))).toBe(true);
  });
});

describe("extractBeatVisualTargets — point 1 (multiple concrete visual targets per beat)", () => {
  it("extracts several typed targets (person, location, event, historical_context) from one beat", () => {
    const intent = buildMediaSearchIntent({
      beatText: "On April 30, 1945, Hitler and Eva Braun committed suicide inside the Führerbunker in Berlin.",
      searchQueries: ["Hitler death bunker"],
      keywords: ["hitler"],
      primaryPerson: "Hitler",
      persons: ["Hitler"],
      powerWord: "Hitler",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const targets = extractBeatVisualTargets(intent.beatText, intent, intent.videoTitle);
    expect(targets.length).toBeGreaterThan(1);
    const types = new Set(targets.map((t) => t.type));
    expect(types.has("person")).toBe(true);
    expect(types.has("location") || types.has("event") || types.has("historical_context")).toBe(true);
    // No duplicate target text.
    const texts = targets.map((t) => t.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("a plain beat with no person/location/event still yields at least one abstract/archival fallback target, never an empty list", () => {
    const intent = buildMediaSearchIntent({
      beatText: "quiet countryside",
      searchQueries: ["quiet countryside"],
      keywords: [],
      primaryPerson: "",
      persons: [],
      powerWord: "",
      personTopicLock: false,
      spaceTopic: false,
      muskTopic: false,
    });
    const targets = extractBeatVisualTargets(intent.beatText, intent, intent.videoTitle);
    expect(targets.length).toBeGreaterThan(0);
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

// FASTVID — NEXT-LEVEL VISUAL SELECTION & RANKING (point 4: event/action matching)
describe("extractEventCue", () => {
  it("finds the beat's underlying documentary event verb, reusing the same vocabulary as extractBeatVisualTargets/extractEventPhrase", () => {
    expect(extractEventCue("Hitler and Eva Braun married shortly before their deaths.")).toMatch(/marri/);
    expect(extractEventCue("The Titanic sank in the early hours of April 15, 1912.")).toMatch(/sank|sink/);
  });

  it("returns null when the beat doesn't center on a recognizable action — never invents a cue", () => {
    expect(extractEventCue("A quiet countryside scene at dawn.")).toBeNull();
  });
});
