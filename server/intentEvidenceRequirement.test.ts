import { describe, it, expect } from "vitest";
import { intentMatchScore, type BeatVisualIntent } from "./beatVisualIntent";

/**
 * `evidenceRequirement` IS THE CLOSEST THING THIS CODEBASE HAS TO requiredElements, AND IT WAS
 * READ BY NOTHING THAT ORDERS CANDIDATES.
 *
 * The planner sets it to "hard" when it named entities the picture MUST contain. It was produced,
 * logged, and then ignored by every scorer — so a beat with a mandatory subject ranked its
 * candidates identically to a beat that asked for nothing at all.
 *
 * These tests hold the wiring in both directions: the requirement must bite where it was
 * declared, and must change nothing anywhere else.
 */

function intent(over: Partial<BeatVisualIntent> = {}): BeatVisualIntent {
  return {
    sceneIndex: 0,
    beatIndex: 0,
    subject: "berlin",
    action: [],
    event: ["street fighting"],
    location: ["berlin"],
    period: ["1945"],
    people: [],
    objects: [],
    evidenceRequirement: "soft",
    preferredShot: "",
    fallbackClass: "",
    narrativePurpose: "",
    forbidden: ["modern"],
    foldedTerms: [],
    ...over,
  };
}

describe("a hard evidence requirement penalises a candidate that answers none of it", () => {
  it("scores below zero on a hard beat when nothing matches", () => {
    const score = intentMatchScore(intent({ evidenceRequirement: "hard" }), "a bowl of fruit");
    expect(score).toBeLessThan(0);
  });

  it("leaves a soft beat at neutral, exactly as before", () => {
    expect(intentMatchScore(intent({ evidenceRequirement: "soft" }), "a bowl of fruit")).toBe(0);
  });

  it("leaves a beat that stated no requirement at neutral", () => {
    expect(intentMatchScore(intent({ evidenceRequirement: "none" }), "a bowl of fruit")).toBe(0);
  });
});

describe("the penalty cannot touch a candidate that is on target", () => {
  it("a hard beat's matching candidate keeps the score it earned", () => {
    const hard = intent({ evidenceRequirement: "hard" });
    const soft = intent({ evidenceRequirement: "soft" });
    const text = "berlin street fighting 1945";
    expect(intentMatchScore(hard, text)).toBe(intentMatchScore(soft, text));
    expect(intentMatchScore(hard, text)).toBeGreaterThan(0);
  });

  it("a single weak match is still better than nothing on a hard beat", () => {
    const hard = intent({ evidenceRequirement: "hard" });
    expect(intentMatchScore(hard, "1945 newsreel")).toBeGreaterThan(
      intentMatchScore(hard, "a bowl of fruit")
    );
  });

  it("a forbidden term still outweighs the requirement penalty", () => {
    /**
     * Ordering between the two negatives, asserted so a later change cannot quietly invert them:
     * naming something ruled out is a stronger complaint than answering nothing.
     */
    const hard = intent({ evidenceRequirement: "hard" });
    expect(intentMatchScore(hard, "modern")).toBeLessThan(
      intentMatchScore(hard, "a bowl of fruit")
    );
  });
});

describe("the scorer still only orders — it never admits or refuses", () => {
  it("returns a number for every input and throws on none", () => {
    expect(intentMatchScore(null, "anything")).toBe(0);
    expect(intentMatchScore(intent({ evidenceRequirement: "hard" }), undefined)).toBe(0);
    expect(intentMatchScore(intent({ evidenceRequirement: "hard" }), "")).toBe(0);
  });
});
