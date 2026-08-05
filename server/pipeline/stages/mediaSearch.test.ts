import { describe, expect, it, vi } from "vitest";
import { searchMedia } from "./mediaSearch";
import type { CuratedCandidatePick } from "../types";

vi.mock("../../curatedMediaSourcing", () => ({
  searchCuratedCandidatesForBeat: vi.fn(),
}));

describe("Media Search stage", () => {
  it("returns ranked candidates without performing any rendering/materialization", async () => {
    const { searchCuratedCandidatesForBeat } = await import("../../curatedMediaSourcing");
    const fakeCandidates = [
      { asset: { id: 1 }, archiveName: "Archive A", score: 9.5 },
      { asset: { id: 2 }, archiveName: "Archive A", score: 8.1 },
    ] as unknown as CuratedCandidatePick[];
    vi.mocked(searchCuratedCandidatesForBeat).mockResolvedValue(fakeCandidates);

    const result = await searchMedia({
      beat: { keywords: ["battle"], text: "The battle began.", index: 0 },
      scene: { text: "The battle began." },
      usedAssetIds: new Set(),
      usedStorageUrls: new Set(),
      videoTitle: "War Documentary",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.candidates).toHaveLength(2);
      expect(result.data.candidates[0]!.score).toBe(9.5);
    }
  });

  it("returns a structured error instead of throwing when search fails", async () => {
    const { searchCuratedCandidatesForBeat } = await import("../../curatedMediaSourcing");
    vi.mocked(searchCuratedCandidatesForBeat).mockRejectedValue(new Error("archive DB unreachable"));

    const result = await searchMedia({
      beat: { keywords: [], text: "x", index: 0 },
      scene: { text: "x" },
      usedAssetIds: new Set(),
      usedStorageUrls: new Set(),
    });

    expect(result.ok).toBe(false);
  });
});
