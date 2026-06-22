import { describe, expect, it } from "vitest";
import {
  buildInternetArchiveGeoQueries,
  isGeoDocumentaryContext,
} from "./geoDocumentarySources";

describe("geoDocumentarySources", () => {
  const title = "Why the Netherlands Is the Opposite of the U.S.";
  const beat = "In the Netherlands, bike lanes connect every neighborhood to the city center.";

  it("detects NL comparison documentary context", () => {
    expect(isGeoDocumentaryContext(beat, title)).toBe(true);
  });

  it("builds beat-anchored Internet Archive queries for Netherlands", () => {
    const qs = buildInternetArchiveGeoQueries(beat, title, 2);
    expect(qs.some((q) => /netherlands|amsterdam|dutch|cycling/i.test(q))).toBe(true);
    expect(qs.some((q) => /mediatype:movies|documentary/i.test(q))).toBe(true);
  });
});
