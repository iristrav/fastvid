import { describe, expect, it } from "vitest";
import { resolvePipelineDisplayStage } from "@shared/pipelineProgress";

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
