import { afterEach, describe, expect, it } from "vitest";
import {
  aiDirectorStageEnabled,
  cinematicEditingEngineStageEnabled,
  editorialReviewEngineStageEnabled,
  newEnginePipelineActive,
  professionalRenderEngineStageEnabled,
  validateStageFlags,
  visualIntelligenceEngineStageEnabled,
} from "./newEngineFlags";

const FLAG_VARS = [
  "PIPELINE_STAGE_VISUAL_INTELLIGENCE",
  "PIPELINE_STAGE_AI_DIRECTOR",
  "PIPELINE_STAGE_CINEMATIC_EDITING",
  "PIPELINE_STAGE_EDITORIAL_REVIEW",
  "PIPELINE_STAGE_PROFESSIONAL_RENDER",
  "VISUAL_MATCHING_V2_PIPELINE",
  "AI_DIRECTOR",
  "CINEMATIC_EDITING_ENGINE",
  "EDITORIAL_REVIEW_ENGINE_V2",
  "PROFESSIONAL_RENDER_ENGINE",
];
const ORIGINAL: Record<string, string | undefined> = {};
for (const v of FLAG_VARS) ORIGINAL[v] = process.env[v];

afterEach(() => {
  for (const v of FLAG_VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v];
  }
});

function clearAll() {
  for (const v of FLAG_VARS) delete process.env[v];
}

describe("Phase 8 new-engine flags", () => {
  it("every stage defaults off when nothing is set", () => {
    clearAll();
    expect(visualIntelligenceEngineStageEnabled()).toBe(false);
    expect(aiDirectorStageEnabled()).toBe(false);
    expect(cinematicEditingEngineStageEnabled()).toBe(false);
    expect(editorialReviewEngineStageEnabled()).toBe(false);
    expect(professionalRenderEngineStageEnabled()).toBe(false);
    expect(newEnginePipelineActive()).toBe(false);
  });

  it("a stage requires BOTH its own module flag and its PIPELINE_STAGE_* flag", () => {
    clearAll();
    process.env.PIPELINE_STAGE_CINEMATIC_EDITING = "true";
    expect(cinematicEditingEngineStageEnabled()).toBe(false); // CINEMATIC_EDITING_ENGINE still unset

    process.env.CINEMATIC_EDITING_ENGINE = "true";
    expect(cinematicEditingEngineStageEnabled()).toBe(true);
  });

  it("setting only the module flag without the orchestrator flag keeps the stage off", () => {
    clearAll();
    process.env.CINEMATIC_EDITING_ENGINE = "true";
    expect(cinematicEditingEngineStageEnabled()).toBe(false);
  });

  describe("validateStageFlags", () => {
    it("no issues when everything is off", () => {
      clearAll();
      expect(validateStageFlags()).toEqual([]);
    });

    it("flags editorial review enabled without cinematic editing", () => {
      clearAll();
      process.env.PIPELINE_STAGE_EDITORIAL_REVIEW = "true";
      process.env.EDITORIAL_REVIEW_ENGINE_V2 = "true";
      const issues = validateStageFlags();
      expect(issues).toContainEqual({ stage: "editorial_review", missingPrerequisite: "cinematic_editing" });
    });

    it("flags professional render enabled without editorial review or cinematic editing", () => {
      clearAll();
      process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER = "true";
      process.env.PROFESSIONAL_RENDER_ENGINE = "true";
      const issues = validateStageFlags();
      expect(issues).toContainEqual({ stage: "professional_render", missingPrerequisite: "editorial_review" });
      expect(issues).toContainEqual({ stage: "professional_render", missingPrerequisite: "cinematic_editing" });
    });

    it("no issues for a fully coherent full-chain configuration", () => {
      clearAll();
      process.env.PIPELINE_STAGE_CINEMATIC_EDITING = "true";
      process.env.CINEMATIC_EDITING_ENGINE = "true";
      process.env.PIPELINE_STAGE_EDITORIAL_REVIEW = "true";
      process.env.EDITORIAL_REVIEW_ENGINE_V2 = "true";
      process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER = "true";
      process.env.PROFESSIONAL_RENDER_ENGINE = "true";
      expect(validateStageFlags()).toEqual([]);
    });
  });

  describe("newEnginePipelineActive", () => {
    it("is true only when the full chain is coherent and enabled", () => {
      clearAll();
      process.env.PIPELINE_STAGE_CINEMATIC_EDITING = "true";
      process.env.CINEMATIC_EDITING_ENGINE = "true";
      process.env.PIPELINE_STAGE_EDITORIAL_REVIEW = "true";
      process.env.EDITORIAL_REVIEW_ENGINE_V2 = "true";
      process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER = "true";
      process.env.PROFESSIONAL_RENDER_ENGINE = "true";
      expect(newEnginePipelineActive()).toBe(true);
    });

    it("is false when the chain is enabled but incoherent (missing prerequisite)", () => {
      clearAll();
      process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER = "true";
      process.env.PROFESSIONAL_RENDER_ENGINE = "true";
      expect(newEnginePipelineActive()).toBe(false);
    });

    it("is independent of the visual intelligence and AI director stage flags", () => {
      clearAll();
      process.env.PIPELINE_STAGE_CINEMATIC_EDITING = "true";
      process.env.CINEMATIC_EDITING_ENGINE = "true";
      process.env.PIPELINE_STAGE_EDITORIAL_REVIEW = "true";
      process.env.EDITORIAL_REVIEW_ENGINE_V2 = "true";
      process.env.PIPELINE_STAGE_PROFESSIONAL_RENDER = "true";
      process.env.PROFESSIONAL_RENDER_ENGINE = "true";
      // Visual intelligence and AI director both stay off — the chain still runs, just using
      // the legacy-candidate adapter and no director guidance.
      expect(visualIntelligenceEngineStageEnabled()).toBe(false);
      expect(aiDirectorStageEnabled()).toBe(false);
      expect(newEnginePipelineActive()).toBe(true);
    });
  });
});
