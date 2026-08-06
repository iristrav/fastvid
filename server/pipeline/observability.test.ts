import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetStageMetricsForTests,
  getStageMetricRecords,
  getStageMetricsSummary,
  instrumentStage,
  newCorrelationId,
} from "./observability";

beforeEach(() => {
  _resetStageMetricsForTests();
});

describe("Observability (Phase 8)", () => {
  describe("newCorrelationId", () => {
    it("returns a distinct id on every call", () => {
      const a = newCorrelationId();
      const b = newCorrelationId();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThan(0);
    });
  });

  describe("instrumentStage", () => {
    it("returns the wrapped function's value on success", async () => {
      const result = await instrumentStage("corr1", "new", "cinematic_editing", async () => ({ value: 42 }));
      expect(result).toBe(42);
    });

    it("records a success metric with duration, warnings, retryCount, and outputSummary", async () => {
      await instrumentStage("corr1", "new", "cinematic_editing", async () => ({
        value: "ok",
        warnings: ["low confidence candidate"],
        retryCount: 1,
        outputSummary: "3 beats planned",
      }));
      const [record] = getStageMetricRecords();
      expect(record!.correlationId).toBe("corr1");
      expect(record!.pipelineVariant).toBe("new");
      expect(record!.pipelineStage).toBe("cinematic_editing");
      expect(record!.outcome).toBe("success");
      expect(record!.retryCount).toBe(1);
      expect(record!.warnings).toEqual(["low confidence candidate"]);
      expect(record!.outputSummary).toBe("3 beats planned");
      expect(record!.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof record!.cpuUserMs).toBe("number");
      expect(typeof record!.memoryDeltaBytes).toBe("number");
    });

    it("re-throws the original error after recording a failure metric", async () => {
      await expect(
        instrumentStage("corr2", "new", "professional_render", async () => {
          throw new Error("encode failed");
        })
      ).rejects.toThrow("encode failed");

      const [record] = getStageMetricRecords();
      expect(record!.outcome).toBe("failure");
      expect(record!.errorMessage).toBe("encode failed");
      expect(record!.retryCount).toBe(0);
    });

    it("converts a non-Error throw into a string errorMessage", async () => {
      await expect(
        instrumentStage("corr3", "legacy", "render_composer", async () => {
          throw "plain string failure";
        })
      ).rejects.toBe("plain string failure");

      const [record] = getStageMetricRecords();
      expect(record!.errorMessage).toBe("plain string failure");
    });

    it("defaults warnings/retryCount when the stage doesn't provide them", async () => {
      await instrumentStage("corr4", "legacy", "effects_planner", async () => ({ value: null }));
      const [record] = getStageMetricRecords();
      expect(record!.warnings).toEqual([]);
      expect(record!.retryCount).toBe(0);
      expect(record!.outputSummary).toBeUndefined();
    });
  });

  describe("getStageMetricsSummary", () => {
    it("returns an empty array when nothing has been recorded", () => {
      expect(getStageMetricsSummary()).toEqual([]);
    });

    it("aggregates success rate, failure rate, and retry rate correctly per (stage, variant)", async () => {
      await instrumentStage("c1", "new", "professional_render", async () => ({ value: 1 }));
      await instrumentStage("c2", "new", "professional_render", async () => ({ value: 1, retryCount: 2 }));
      await expect(
        instrumentStage("c3", "new", "professional_render", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow();

      const [summary] = getStageMetricsSummary("professional_render");
      expect(summary!.sampleCount).toBe(3);
      expect(summary!.successRate).toBeCloseTo(2 / 3, 5);
      expect(summary!.failureRate).toBeCloseTo(1 / 3, 5);
      expect(summary!.retryRate).toBeCloseTo(1 / 3, 5);
      expect(summary!.avgRetryCount).toBeCloseTo(2 / 3, 5);
    });

    it("keeps legacy and new variants of the same stage as separate summary rows", async () => {
      await instrumentStage("c1", "legacy", "render_composer", async () => ({ value: 1 }));
      await instrumentStage("c2", "new", "professional_render", async () => ({ value: 1 }));

      const legacySummary = getStageMetricsSummary("render_composer");
      const newSummary = getStageMetricsSummary("professional_render");
      expect(legacySummary).toHaveLength(1);
      expect(legacySummary[0]!.pipelineVariant).toBe("legacy");
      expect(newSummary).toHaveLength(1);
      expect(newSummary[0]!.pipelineVariant).toBe("new");
    });

    it("summarizes every stage when no filter is passed", async () => {
      await instrumentStage("c1", "legacy", "media_search", async () => ({ value: 1 }));
      await instrumentStage("c2", "new", "visual_intelligence", async () => ({ value: 1 }));
      const all = getStageMetricsSummary();
      expect(all.map((s) => s.pipelineStage).sort()).toEqual(["media_search", "visual_intelligence"]);
    });
  });
});
