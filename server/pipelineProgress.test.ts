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

  it("maps assembly and effects to coarse stages", () => {
    expect(resolvePipelineDisplayStage("Clips achter elkaar plakken (ruwe montage)...", 50).label).toBe(
      "Montage editten"
    );
    expect(resolvePipelineDisplayStage("Effecten, overgangen en tekst toevoegen... (6/15)", 74).label).toBe(
      "Effecten toevoegen"
    );
  });

  it("maps script and voiceover phases", () => {
    expect(resolvePipelineDisplayStage("🔍 Researching topic...", 5).label).toBe("Script schrijven");
    expect(resolvePipelineDisplayStage("Volledige voiceover in ElevenLabs (één script)...", 35).label).toBe(
      "Voiceover genereren"
    );
  });
});
