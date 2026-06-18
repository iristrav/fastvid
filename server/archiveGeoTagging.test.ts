import { describe, expect, it } from "vitest";
import {
  extractGeoSlugsFromVisionPayload,
  mergeGeoSlugsIntoArchiveTags,
} from "./archiveGeoTagging";

describe("archiveGeoTagging", () => {
  it("extracts Philadelphia from map labels", () => {
    const slugs = extractGeoSlugsFromVisionPayload({
      mapLabels: ["Philadelphia", "Pennsylvania", "Early streets"],
      title: "Historical map",
    });
    expect(slugs).toContain("philadelphia");
  });

  it("merges geo slugs ahead of generic tags", () => {
    const merged = mergeGeoSlugsIntoArchiveTags(
      ["urban planning", "historical map", "city street"],
      ["singapore"],
      6
    );
    expect(merged[0]).toBe("singapore");
    expect(merged.length).toBeLessThanOrEqual(6);
  });

  it("detects Kansas City from visible text", () => {
    const slugs = extractGeoSlugsFromVisionPayload({
      visibleTextOnScreen: ["Kansas City railroad map 1920"],
    });
    expect(slugs.some((s) => s.includes("kansas") || s.includes("city"))).toBe(true);
  });
});
