import { describe, expect, it } from "vitest";
import {
  formatGenerationDuration,
  progressStepWithElapsed,
  resolvePipelineDisplayStage,
  estimateRemainingGenerationSec,
  formatRemainingGenerationLabel,
} from "@shared/pipelineProgress";

describe("resolvePipelineDisplayStage", () => {
  it("maps beat-level visual progress to Finding visuals", () => {
    expect(resolvePipelineDisplayStage("Scene 2/15: beat 1/4...", 46).label).toBe(
      "Finding visuals"
    );
    expect(
      resolvePipelineDisplayStage(
        "Fetching visuals (scene 4/15, 2 done, tick 3)...",
        48
      ).key
    ).toBe("visuals");
  });

  it("maps compose and export to Finishing video", () => {
    expect(resolvePipelineDisplayStage("Video samenstellen (beelden + voice)...", 50).label).toBe(
      "Finishing video"
    );
    expect(resolvePipelineDisplayStage("Assembling video (visuals + voice)...", 61).label).toBe(
      "Finishing video"
    );
    expect(resolvePipelineDisplayStage("Alle scenes samenvoegen + muziek...", 80).label).toBe(
      "Finishing video"
    );
  });

  it("maps script and voiceover phases", () => {
    expect(resolvePipelineDisplayStage("🔍 Researching topic...", 5).label).toBe("Writing script");
    expect(resolvePipelineDisplayStage("Volledige voiceover in ElevenLabs (één script)...", 35).label).toBe(
      "Generating voiceover"
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

describe("estimateRemainingGenerationSec", () => {
  it("returns null when progress is too early", () => {
    expect(estimateRemainingGenerationSec(1, 5, 3600)).toBeNull();
  });

  it("estimates from percent and caps by max window", () => {
    expect(estimateRemainingGenerationSec(50, 600, 3600)).toBe(600);
    expect(estimateRemainingGenerationSec(50, 3500, 3600)).toBe(100);
  });

  it("formats remaining label", () => {
    expect(formatRemainingGenerationLabel(null)).toBe("Estimating time left…");
    expect(formatRemainingGenerationLabel(0)).toBe("Almost done…");
    expect(formatRemainingGenerationLabel(125)).toBe("~2m 05s left");
  });
});

describe("progressStepWithElapsed", () => {
  it("appends elapsed duration to the label", () => {
    const startedAt = Date.now() - 90_000;
    expect(progressStepWithElapsed("Finding visuals", startedAt)).toBe("Finding visuals · 1m 30s");
  });
});
