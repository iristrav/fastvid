import { describe, expect, it } from "vitest";
import {
  formatGenerationDuration,
  progressStepWithElapsed,
  resolvePipelineDisplayStage,
} from "@shared/pipelineProgress";

describe("resolvePipelineDisplayStage", () => {
  it("maps beat-level visual progress to Beelden zoeken", () => {
    expect(resolvePipelineDisplayStage("Scene 2/15: beat 1/4...", 46).label).toBe(
      "Beelden zoeken"
    );
    expect(
      resolvePipelineDisplayStage(
        "Fetching visuals (scene 4/15, 2 done, tick 3)...",
        48
      ).key
    ).toBe("visuals");
  });

  it("maps compose and export to Video afronden", () => {
    expect(resolvePipelineDisplayStage("Video samenstellen (beelden + voice)...", 50).label).toBe(
      "Video afronden"
    );
    expect(resolvePipelineDisplayStage("Alle scenes samenvoegen + muziek...", 80).label).toBe(
      "Video afronden"
    );
  });

  it("maps script and voiceover phases", () => {
    expect(resolvePipelineDisplayStage("🔍 Researching topic...", 5).label).toBe("Script schrijven");
    expect(resolvePipelineDisplayStage("Volledige voiceover in ElevenLabs (één script)...", 35).label).toBe(
      "Voiceover genereren"
    );
  });
});

describe("formatGenerationDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatGenerationDuration(0)).toBe("0s");
    expect(formatGenerationDuration(42)).toBe("42s");
    expect(formatGenerationDuration(65)).toBe("1m 05s");
    expect(formatGenerationDuration(222)).toBe("3m 42s");
  });
});

describe("progressStepWithElapsed", () => {
  it("appends elapsed duration to the label", () => {
    const startedAt = Date.now() - 90_000;
    expect(progressStepWithElapsed("Beelden zoeken", startedAt)).toBe("Beelden zoeken · 1m 30s");
  });
});
