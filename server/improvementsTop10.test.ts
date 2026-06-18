import { describe, expect, it } from "vitest";
import { lookupGeoCoord, coordsForGeoSlugs } from "./worldGeoCoords";
import { titleSuggestsEuropeana, buildEuropeanaBeatQueries } from "./europeanaGeo";
import { extractGeoSlugsFromVisionPayload } from "./archiveGeoTagging";

describe("worldGeoCoords", () => {
  it("resolves singapore and amsterdam", () => {
    expect(lookupGeoCoord("singapore")?.lat).toBeCloseTo(1.35, 1);
    expect(lookupGeoCoord("amsterdam")?.lon).toBeCloseTo(4.9, 0);
  });

  it("coordsForGeoSlugs picks first known place", () => {
    const c = coordsForGeoSlugs(["unknown", "berlin"]);
    expect(c?.lat).toBeCloseTo(52.52, 1);
  });
});

describe("europeanaGeo", () => {
  it("detects EU comparison titles", () => {
    expect(titleSuggestsEuropeana("Netherlands vs United States urban planning")).toBe(true);
    expect(titleSuggestsEuropeana("Singapore smart city")).toBe(false);
  });

  it("builds europeana queries from title geo", () => {
    const q = buildEuropeanaBeatQueries("Amsterdam cycle lanes", "Netherlands vs US");
    expect(q.some((x) => /amsterdam|netherlands/i.test(x))).toBe(true);
  });
});

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
