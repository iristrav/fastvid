import { describe, expect, it } from "vitest";
import { normalizeHistoricalEntities, toStringArray } from "./scriptEngine";

// Regression for the render-525 crash: `visual.historicalEntities.locations is not iterable`.
// The visual-plan JSON comes straight from groq; its historicalEntities fields are not
// shape-guaranteed. writeSceneNarration spreads them (`[...persons, ...locations, ...events]`),
// so a field that arrives as null / a bare string / a missing key threw "not iterable" and
// killed the entire script generation (video 525 -> failed, script MISSING). These helpers
// coerce every field to a clean string[] so the spread can never crash.

describe("toStringArray — coerces untrusted LLM values", () => {
  it("keeps a clean string array (trimming empties)", () => {
    expect(toStringArray(["Berlin", " ", "Munich", ""])).toEqual(["Berlin", "Munich"]);
  });
  it("wraps a bare string into a one-element array", () => {
    expect(toStringArray("Berlin, Germany")).toEqual(["Berlin, Germany"]);
  });
  it("drops non-string array members", () => {
    expect(toStringArray(["Berlin", 1940, null, { x: 1 }, "Munich"])).toEqual(["Berlin", "Munich"]);
  });
  it.each([null, undefined, 42, {}, true])("returns [] for the non-iterable %j", (v) => {
    expect(toStringArray(v)).toEqual([]);
  });
});

describe("normalizeHistoricalEntities — always yields spread-safe arrays", () => {
  it("fills every field for a completely missing object", () => {
    const he = normalizeHistoricalEntities(undefined);
    expect(he).toEqual({ persons: [], locations: [], events: [], objects: [], timePeriods: [] });
    // The exact operation that used to crash must now be safe.
    expect(() => [...he.persons, ...he.locations, ...he.events]).not.toThrow();
  });

  it("repairs the exact render-525 shape (locations as null, persons as a bare string)", () => {
    const he = normalizeHistoricalEntities({
      persons: "Adolf Hitler",
      locations: null,
      events: ["Fall of Berlin"],
    });
    expect(he.persons).toEqual(["Adolf Hitler"]);
    expect(he.locations).toEqual([]);
    expect(he.events).toEqual(["Fall of Berlin"]);
    expect([...he.persons, ...he.locations, ...he.events].filter(Boolean).join(", "))
      .toBe("Adolf Hitler, Fall of Berlin");
  });

  it("passes through a well-formed object unchanged", () => {
    const he = normalizeHistoricalEntities({
      persons: ["Eva Braun"],
      locations: ["Berlin, Germany"],
      events: ["marriage"],
      objects: ["bunker"],
      timePeriods: ["1945"],
    });
    expect(he).toEqual({
      persons: ["Eva Braun"],
      locations: ["Berlin, Germany"],
      events: ["marriage"],
      objects: ["bunker"],
      timePeriods: ["1945"],
    });
  });
});
