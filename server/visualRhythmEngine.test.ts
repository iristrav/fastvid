import { describe, expect, it } from "vitest";
import { buildRhythmProfile } from "./visualRhythmEngine";

describe("visualRhythmEngine — energy keyword broadening (Phase 9)", () => {
  it("classifies a business/tech dramatic beat as high energy, not medium", () => {
    const profile = buildRhythmProfile(["The company's stock price crashed after the scandal was exposed."]);
    expect(profile.beatEnergies[0]).toBe("high");
  });

  it("classifies a tech-breach beat as high energy", () => {
    const profile = buildRhythmProfile(["Hackers breached the database and the story went viral overnight."]);
    expect(profile.beatEnergies[0]).toBe("high");
  });

  it("classifies a settling/resolving beat as low energy, not medium", () => {
    const profile = buildRhythmProfile(["Eventually the two companies negotiated and the dispute was resolved."]);
    expect(profile.beatEnergies[0]).toBe("low");
  });

  it("still classifies the original war/history vocabulary correctly (no regression)", () => {
    const profile = buildRhythmProfile(["The army invaded at dawn and the city fell within hours."]);
    expect(profile.beatEnergies[0]).toBe("high");
  });

  it("still classifies genuinely neutral narration as medium", () => {
    const profile = buildRhythmProfile(["The committee meets every Tuesday to review the budget."]);
    expect(profile.beatEnergies[0]).toBe("medium");
  });
});
