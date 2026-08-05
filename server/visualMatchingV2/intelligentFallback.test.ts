import { describe, expect, it } from "vitest";
import { buildEntityFallbackIntents, reliesOnSpecificEntity } from "./intelligentFallback";
import type { VisualIntent } from "./types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "The startup Nimbus AI raised a new funding round",
    visualSubject: "Nimbus AI",
    visualAction: "working",
    visualLocation: "office",
    visualTime: "present day",
    historicalContext: "",
    emotion: "optimistic",
    visualDescription: "Nimbus AI team working",
    primaryKeyword: "Nimbus AI",
    secondaryKeyword: "Nimbus AI office",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: ["Nimbus AI"],
    people: [],
    countries: [],
    events: [],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

describe("Intelligent entity-to-category fallback (Phase 3)", () => {
  it("recognizes a beat that hinges on a specific company/brand/object entity", () => {
    expect(reliesOnSpecificEntity(makeIntent())).toBe(true);
    expect(reliesOnSpecificEntity(makeIntent({ companies: [], brands: [], objects: ["laptop"] }))).toBe(true);
  });

  it("does not treat a generic beat (no named company/brand/object) as entity-specific", () => {
    expect(reliesOnSpecificEntity(makeIntent({ companies: [], brands: [], objects: [] }))).toBe(false);
  });

  it("builds generic, on-topic fallback categories (office/servers/employees/etc) instead of random stock", () => {
    const fallbacks = buildEntityFallbackIntents(makeIntent());
    const categories = fallbacks.map((f) => f.primaryKeyword);

    expect(categories).toEqual(
      expect.arrayContaining(["office", "servers", "employees", "conference", "technology"])
    );
    // Every fallback intent still carries the beat's own action/emotion — not a blind swap.
    for (const fb of fallbacks) {
      expect(fb.visualAction).toBe("working");
      expect(fb.emotion).toBe("optimistic");
    }
  });

  it("returns no fallback intents for a beat with no specific entity to fall back from", () => {
    expect(buildEntityFallbackIntents(makeIntent({ companies: [], brands: [], objects: [] }))).toEqual([]);
  });
});
