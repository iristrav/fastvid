import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_TAGS,
  applySharedAiToClipFields,
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
    // RONDE 30: this asserted the literal "berlin metro transit". Tags are capped to two words
    // now (capTagToTwoWords), and the place tags are hoisted ahead of the AI-supplied ones, so
    // the real output is ["germany", "berlin", "subway platform", "commuters waiting"]. Pinning
    // one exact string tested the fixture, not the rule; these assert what the selection is
    // actually meant to guarantee.
    for (const tag of flat!.tags) {
      expect(tag.split(" ").length, `tag "${tag}" should be at most two words`).toBeLessThanOrEqual(2);
    }
    // Place comes through — it is the strongest search signal for archive matching.
    expect(flat!.tags).toContain("germany");
    expect(flat!.tags).toContain("berlin");
    // And at least one descriptive tag survives alongside the places, so the asset is findable
    // by what is visible in it and not only by where it was shot.
    expect(flat!.tags.some((t) => !["germany", "berlin"].includes(t))).toBe(true);
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

  it("replaceTags mode stores only AI tags (max 4)", () => {
    const fields = applySharedAiToClipFields({
      baseTitle: "Old title",
      userTags: ["old1", "old2", "old3", "old4", "old5"],
      sourceNote: null,
      ai: {
        title: "Amsterdam cyclists on canal",
        description: "Bikes on a canal bridge.",
        tags: ["amsterdam canal bikes", "cyclists rain", "netherlands urban", "bike lane"],
      },
      replaceTags: true,
    });
    expect(fields.tags).toHaveLength(4);
    expect(fields.tags).not.toContain("old1");
    expect(fields.tags[0]).toBe("amsterdam canal bikes");
  });

  it("never truncates merged tags — losing a tag is worse than keeping extras", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const merged = mergeArchiveTags([], many);
    expect(merged.length).toBe(20);
  });

  it("keeps user tags first and never drops them behind AI tags", () => {
    const userTags = ["winston churchill", "d-day landing"];
    const aiTags = ["world war 2", "normandy beach"];
    const merged = mergeArchiveTags(userTags, aiTags);
    expect(merged).toContain("winston churchill");
    expect(merged).toContain("d-day landing");
    expect(merged.indexOf("winston churchill")).toBeLessThan(merged.indexOf("world war 2"));
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
