import { describe, expect, it } from "vitest";
import { inferArchiveMediaMime, mergeArchiveTags, truncateArchiveSourceNote } from "./archiveAssetTagging";

describe("archiveAssetTagging", () => {
  it("mergeArchiveTags combines user and AI tags without duplicates", () => {
    const merged = mergeArchiveTags(["titanic", "dek"], ["Titanic", "passagiers", "1912"]);
    expect(merged).toContain("titanic");
    expect(merged).toContain("passagiers");
    expect(merged).toContain("1912");
    expect(merged.filter((t) => t === "titanic")).toHaveLength(1);
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
