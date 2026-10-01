/**
 * ONE ROUTE — the RenderReport has one writer, and it writes the keys every video already has.
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { storeRenderReport } from "./renderReport";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("storeRenderReport is the only writer of the stored report", () => {
  it("writes the keys old videos were stored under, and the budget only when there is one", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const merge = async (_id: number, patch: Record<string, unknown>) => {
      writes.push(patch);
    };
    const base = {
      qualityReport: { score: 1 },
      pipelineStepTiming: {},
      pipelineReport: { videoId: 7, startedAt: "t", sections: {}, truncated: {} },
      pipelineGlance: {},
    };
    await storeRenderReport(7, base, merge);
    await storeRenderReport(7, { ...base, renderBudget: { ok: true } }, merge);
    expect(Object.keys(writes[0]!).sort()).toEqual(
      ["pipelineGlance", "pipelineReport", "pipelineStepTiming", "qualityReport"]
    );
    expect(writes[1]!.renderBudget).toEqual({ ok: true });
  });

  it("the pipeline stores the report through it, both times, and nowhere else", () => {
    expect(PIPE.match(/await storeRenderReport\(videoId, \{/g)).toHaveLength(2);
    expect(PIPE).not.toMatch(/mergeVideoMetadata\(videoId, \{\s*qualityReport/);
  });

  it("the post-render editorial review — an LLM call whose table nothing read — is gone", () => {
    for (const f of ["editorialReviewEngine.ts", "editorialReviewStore.ts", "renderQualityReport.ts"]) {
      expect(existsSync(path.join(__dirname, f)), f).toBe(false);
    }
    expect(PIPE).not.toContain("runEditorialReview");
  });
});
