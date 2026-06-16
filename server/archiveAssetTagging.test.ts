import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_TAGS,
  flattenArchiveAiMetadata,
  inferArchiveMediaMime,
  mergeArchiveTags,
  selectHighQualityArchiveTags,
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

  it("selectHighQualityArchiveTags returns at most 4 specific tags", () => {
    const tags = selectHighQualityArchiveTags({
      title: "Berlin U-Bahn platform rush hour",
      tags: ["berlin metro transit", "subway platform", "commuters waiting", "germany transit"],
      persons: ["commuters"],
      countries: ["germany"],
      cities: ["berlin"],
      actions: ["waiting"],
      objects: ["subway train"],
    });
    expect(tags.length).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(tags).not.toContain("person");
    expect(tags).not.toContain("city");
  });

  it("flattenArchiveAiMetadata stores at most 4 tags with rich description", () => {
    const flat = flattenArchiveAiMetadata({
      title: "Berlin U-Bahn platform rush hour",
      description: "Commuters on a modern subway platform.",
      tags: ["berlin metro transit", "subway platform berlin", "commuters waiting", "germany transit"],
      persons: ["commuters"],
      countries: ["germany"],
      cities: ["berlin"],
      events: [],
      locations: ["u-bahn station"],
      objects: ["subway train"],
      actions: ["waiting"],
      era: "modern day",
      setting: "indoor platform",
      sceneType: "transit",
    });
    expect(flat).not.toBeNull();
    expect(flat!.tags.length).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
    expect(flat!.tags).toContain("berlin metro transit");
    expect(flat!.description).toMatch(/Countries:|Cities:|Setting:|Era:/);
  });

  it("flattenArchiveAiMetadata prioritizes named persons countries cities and events", () => {
    const flat = flattenArchiveAiMetadata({
      title: "Adolf Hitler speech at Nuremberg rally",
      description: "Hitler addresses crowd at Nazi party rally.",
      tags: ["hitler nuremberg speech", "nazi rally germany", "propaganda stadium", "1930s germany"],
      persons: ["adolf hitler"],
      countries: ["germany"],
      cities: ["nuremberg"],
      events: ["nuremberg rally"],
      actions: ["speech"],
      era: "1930s",
      sceneType: "speech",
    });
    expect(flat!.tags.length).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
    expect(flat!.tags.some((t) => t.includes("hitler") || t.includes("nuremberg"))).toBe(true);
    expect(flat!.description).toMatch(/Events:|Countries:|Cities:/);
    expect(flat!.tags).not.toContain("modern city");
  });

  it("flattenArchiveAiMetadata derives title from tags when title missing", () => {
    const flat = flattenArchiveAiMetadata({
      title: "",
      description: "Crowd at a rally.",
      tags: ["nuremberg rally germany", "hitler speech stadium", "1930s propaganda", "germany nuremberg"],
      persons: ["adolf hitler"],
      countries: ["germany"],
      cities: ["nuremberg"],
    });
    expect(flat).not.toBeNull();
    expect(flat!.title.length).toBeGreaterThan(3);
    expect(flat!.tags.length).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
  });

  it("respects ARCHIVE_MAX_TAGS cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const merged = mergeArchiveTags([], many);
    expect(merged.length).toBe(ARCHIVE_MAX_TAGS);
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
