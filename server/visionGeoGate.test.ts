import { describe, expect, it } from "vitest";
import { visionDetectedGeoConflict } from "./visionGeoGate";

describe("visionGeoGate", () => {
  it("rejects Philadelphia map on Singapore title beat", () => {
    const r = visionDetectedGeoConflict(
      {
        detectedPlaces: ["philadelphia", "united states"],
        showsMap: true,
        mapLabels: ["Philadelphia", "Pennsylvania"],
        wrongSubject: false,
      },
      "The MRT metro system ties the city together efficiently.",
      "Why Singapore Is a Model for Urban Living",
      null
    );
    expect(r.conflict).toBe(true);
  });

  it("accepts Singapore skyline on Singapore beat", () => {
    const r = visionDetectedGeoConflict(
      {
        detectedPlaces: ["singapore", "marina bay"],
        showsMap: false,
        mapLabels: [],
        wrongSubject: false,
      },
      "Marina Bay is more than just a skyline.",
      "Why Singapore Is a Model for Urban Living",
      null
    );
    expect(r.conflict).toBe(false);
  });

  it("rejects US map on NL segment lock in comparison title", () => {
    const r = visionDetectedGeoConflict(
      {
        detectedPlaces: ["philadelphia"],
        showsMap: true,
        mapLabels: ["Philadelphia streets"],
        wrongSubject: false,
      },
      "These contrasting design philosophies reveal urban secrets.",
      "Why the Netherlands Is the Opposite of the U.S.",
      "nl"
    );
    expect(r.conflict).toBe(true);
  });
});
