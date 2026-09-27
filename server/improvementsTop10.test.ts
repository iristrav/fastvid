import { describe, expect, it } from "vitest";
import { extractGeoSlugsFromVisionPayload } from "./archiveGeoTagging";

describe("archiveGeo metadata retag", () => {
  it("extracts philadelphia from map labels in source note", () => {
    const slugs = extractGeoSlugsFromVisionPayload({
      title: "US city map",
      description: "Map labels: Philadelphia, Pennsylvania | Geo: philadelphia",
      mapLabels: ["Philadelphia", "Pennsylvania"],
    });
    expect(slugs.some((s) => s.includes("philadelphia"))).toBe(true);
  });
});
