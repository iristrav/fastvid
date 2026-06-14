import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_TAGS,
  flattenArchiveAiMetadata,
  inferArchiveMediaMime,
  mergeArchiveTags,
  truncateArchiveSourceNote,
} from "./archiveAssetTagging";

describe("archiveAssetTagging", () => {
  it("mergeArchiveTags combines user and AI tags without duplicates", () => {
    const merged = mergeArchiveTags(["titanic", "dek"], ["Titanic", "passagiers", "1912"]);
    expect(merged).toContain("titanic");
    expect(merged).toContain("passagiers");
    expect(merged).toContain("1912");
    expect(merged.filter((t) => t === "titanic")).toHaveLength(1);
  });

  it("flattenArchiveAiMetadata merges all structured fields into tags", () => {
    const flat = flattenArchiveAiMetadata({
      title: "Berlin U-Bahn platform rush hour",
      description: "Commuters on a modern subway platform.",
      tags: ["berlin", "metro", "transit"],
      persons: ["commuters", "passengers"],
      locations: ["berlin", "germany", "u-bahn station"],
      objects: ["subway train", "platform", "signage"],
      actions: ["waiting", "boarding", "train arriving"],
      era: "modern day",
      setting: "indoor platform",
      sceneType: "transit",
      visualDetails: ["yellow safety line", "tiled walls", "digital display"],
      mood: "busy",
      camera: "wide static",
      colors: ["white", "yellow"],
    });
    expect(flat).not.toBeNull();
    expect(flat!.tags).toContain("berlin");
    expect(flat!.tags).toContain("u-bahn station");
    expect(flat!.tags).toContain("modern day");
    expect(flat!.tags).toContain("transit");
    expect(flat!.tags).toContain("train arriving");
    expect(flat!.tags.length).toBeGreaterThanOrEqual(12);
    expect(flat!.description).toMatch(/Setting:|Era:|Actions:/);
  });

  it("flattenArchiveAiMetadata captures WWII details when visible", () => {
    const flat = flattenArchiveAiMetadata({
      title: "Hitler speech at Nuremberg rally",
      description: "Crowd and podium at Nazi rally.",
      tags: ["hitler", "nazi", "rally"],
      persons: ["adolf hitler"],
      locations: ["nuremberg", "germany"],
      objects: ["podium", "swastika flags", "microphone"],
      actions: ["speech", "salute"],
      era: "1930s",
      setting: "outdoor stadium",
      sceneType: "speech",
      visualDetails: ["propaganda banners", "uniformed crowd"],
      mood: "propaganda",
      camera: "black and white archival",
      colors: ["black and white"],
    });
    expect(flat!.tags).toContain("hitler");
    expect(flat!.tags).toContain("nuremberg");
    expect(flat!.tags).toContain("propaganda");
    expect(flat!.tags).not.toContain("modern city");
  });

  it("respects ARCHIVE_MAX_TAGS cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => `tag${i}`);
    const merged = mergeArchiveTags([], many);
    expect(merged.length).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
  });

  it("inferArchiveMediaMime falls back to extension when type is empty", () => {
    expect(inferArchiveMediaMime("", "clip.MP4")).toBe("video/mp4");
    expect(inferArchiveMediaMime("", "photo.jpg")).toBe("image/jpeg");
  });

  it("truncateArchiveSourceNote caps at 512 chars", () => {
    const long = "a".repeat(600);
    expect(truncateArchiveSourceNote(long)?.length).toBe(512);
  });
});
