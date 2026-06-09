import { describe, expect, it } from "vitest";
import {
  buildCuratedQueryTags,
  curatedAssetContentKey,
  curatedClipPathAssetId,
} from "./curatedMediaSourcing";

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

  it("curatedAssetContentKey is stable per asset id", () => {
    expect(curatedAssetContentKey(42)).toBe("curated:asset:42");
  });

  it("curatedClipPathAssetId parses asset id from output filename", () => {
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated_a17.mp4")).toBe(17);
    expect(curatedClipPathAssetId("/tmp/scene_0_b2_curated.mp4")).toBeNull();
  });
});
