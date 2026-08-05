import { describe, expect, it, vi } from "vitest";
import { ALL_SOURCE_ADAPTERS, europeanaAdapter, youtubeCcAdapter } from "./sourceAdapters";
import type { VisualIntent } from "./types";

vi.mock("../videoPipeline", () => ({
  fetchCuratedArchiveBeatClip: vi.fn().mockResolvedValue(null),
  fetchWikimediaImages: vi.fn().mockResolvedValue([]),
  fetchPexelsClips: vi.fn().mockResolvedValue([]),
  fetchPixabayClips: vi.fn().mockResolvedValue([]),
  fetchInternetArchiveClips: vi.fn().mockResolvedValue([]),
  fetchYouTubeCCClips: vi.fn().mockResolvedValue(["yt_clip_1.mp4"]),
  fetchEuropeanaVideos: vi.fn().mockResolvedValue([{ path: "europeana_clip_1.mp4" }]),
}));
vi.mock("../curatedMediaSourcing", () => ({
  fetchCuratedArchiveBeatClip: vi.fn().mockResolvedValue(null),
}));

const intent: VisualIntent = {
  beatId: "b0",
  spokenText: "Elon Musk announced Grok 5",
  visualSubject: "Elon Musk",
  visualAction: "speaking on stage",
  visualLocation: "conference hall",
  visualTime: "present day",
  historicalContext: "AI product launch",
  emotion: "confident",
  visualDescription: "Elon Musk on stage",
  primaryKeyword: "Elon Musk keynote",
  secondaryKeyword: "Elon Musk stage",
  negativeKeywords: [],
  secondaryVisualSubjects: [],
  objects: ["microphone"],
  brands: ["Grok"],
  companies: ["xAI"],
  people: ["Elon Musk"],
  countries: [],
  events: [],
  intentHash: "hash",
  cacheHit: false,
};

describe("Source Adapters — Phase 3 additions", () => {
  it("registers all 7 source adapters, including the two new ones", () => {
    const names = ALL_SOURCE_ADAPTERS.map((a) => a.name);
    expect(names).toEqual([
      "own_archive",
      "wikimedia",
      "pexels",
      "pixabay",
      "internet_archive",
      "youtube_cc",
      "europeana",
    ]);
  });

  it("youtubeCcAdapter searches using the top ranked queries and normalizes results", async () => {
    const { fetchYouTubeCCClips } = await import("../videoPipeline");
    const results = await youtubeCcAdapter.search(intent, { workDir: "/tmp", sceneIndex: 0 });

    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("youtube_cc");
    expect(results[0]!.localPath).toBe("yt_clip_1.mp4");

    const calledQueries = vi.mocked(fetchYouTubeCCClips).mock.calls[0]![0] as string[];
    expect(Array.isArray(calledQueries)).toBe(true);
    expect(calledQueries.length).toBeGreaterThan(1);
    expect(calledQueries).toContain("Elon Musk keynote");
  });

  it("europeanaAdapter searches using the top ranked queries and normalizes results", async () => {
    const results = await europeanaAdapter.search(intent, { workDir: "/tmp", sceneIndex: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("europeana");
    expect(results[0]!.localPath).toBe("europeana_clip_1.mp4");
  });

  it("adapters never throw — a failing fetch resolves to an empty array", async () => {
    const { fetchYouTubeCCClips } = await import("../videoPipeline");
    vi.mocked(fetchYouTubeCCClips).mockRejectedValueOnce(new Error("YouTube API quota exceeded"));

    const results = await youtubeCcAdapter.search(intent, { workDir: "/tmp", sceneIndex: 0 });
    expect(results).toEqual([]);
  });
});
