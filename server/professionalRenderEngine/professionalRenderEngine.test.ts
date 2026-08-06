import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfessionalRenderEngineDisabledError, renderApprovedEDL } from "./professionalRenderEngine";
import type { ApprovedEDL, ExportRequest, RenderPlan } from "./types";
import type { ExportDependencies } from "./exportManager";

const ORIGINAL_FLAG = process.env.PROFESSIONAL_RENDER_ENGINE;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PROFESSIONAL_RENDER_ENGINE;
  else process.env.PROFESSIONAL_RENDER_ENGINE = ORIGINAL_FLAG;
});

function request(): ExportRequest {
  const approvedEDL = { videoId: "vid1", edls: [] } as unknown as ApprovedEDL;
  return { videoId: "vid1", approvedEDL, formats: ["16:9"], outputDir: "/tmp/exports" };
}

function deps(): ExportDependencies {
  return {
    resolveClipAsset: () => ({ inputLabel: "0:v", sourceDims: null }),
    resolveInputFiles: (_plan: RenderPlan) => [],
    executor: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  };
}

describe("Professional Render Engine top-level orchestrator (Phase 7)", () => {
  it("throws ProfessionalRenderEngineDisabledError when the feature flag is unset (default off)", async () => {
    delete process.env.PROFESSIONAL_RENDER_ENGINE;
    await expect(renderApprovedEDL(request(), deps())).rejects.toBeInstanceOf(ProfessionalRenderEngineDisabledError);
  });

  it("throws when the flag is explicitly false", async () => {
    process.env.PROFESSIONAL_RENDER_ENGINE = "false";
    await expect(renderApprovedEDL(request(), deps())).rejects.toBeInstanceOf(ProfessionalRenderEngineDisabledError);
  });

  it("delegates to exportVideo and returns a real ExportResult when the flag is enabled", async () => {
    process.env.PROFESSIONAL_RENDER_ENGINE = "true";
    const result = await renderApprovedEDL(request(), deps());
    expect(result.videoId).toBe("vid1");
    expect(result.allSucceeded).toBe(true);
    expect(result.formats).toHaveLength(1);
  });
});
