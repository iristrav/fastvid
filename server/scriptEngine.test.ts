import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: vi.fn(),
}));

import { invokeLLM } from "./_core/llm";
import {
  runScriptEngineV2,
  scriptQualityThreshold,
  SCRIPT_QUALITY_THRESHOLD_DEFAULT,
  MAX_QUALITY_REGENERATION_ATTEMPTS,
} from "./scriptEngine";
import { getScriptLengthBudget } from "./scriptWriter";

function systemOf(call: unknown): string {
  const messages = (call as { messages: { role: string; content: string }[] }).messages;
  return messages.find((m) => m.role === "system")?.content ?? "";
}
function userOf(call: unknown): string {
  const messages = (call as { messages: { role: string; content: string }[] }).messages;
  return messages.find((m) => m.role === "user")?.content ?? "";
}

describe("scriptQualityThreshold (Phase 10)", () => {
  const prev = process.env.SCRIPT_QUALITY_THRESHOLD;
  beforeEach(() => {
    if (prev === undefined) delete process.env.SCRIPT_QUALITY_THRESHOLD;
    else process.env.SCRIPT_QUALITY_THRESHOLD = prev;
  });

  it("defaults to SCRIPT_QUALITY_THRESHOLD_DEFAULT when unset", () => {
    delete process.env.SCRIPT_QUALITY_THRESHOLD;
    expect(scriptQualityThreshold()).toBe(SCRIPT_QUALITY_THRESHOLD_DEFAULT);
  });

  it("reads a valid override from the environment", () => {
    process.env.SCRIPT_QUALITY_THRESHOLD = "8";
    expect(scriptQualityThreshold()).toBe(8);
  });

  it("falls back to the default for invalid/out-of-range values", () => {
    process.env.SCRIPT_QUALITY_THRESHOLD = "not-a-number";
    expect(scriptQualityThreshold()).toBe(SCRIPT_QUALITY_THRESHOLD_DEFAULT);
    process.env.SCRIPT_QUALITY_THRESHOLD = "0";
    expect(scriptQualityThreshold()).toBe(SCRIPT_QUALITY_THRESHOLD_DEFAULT);
    process.env.SCRIPT_QUALITY_THRESHOLD = "15";
    expect(scriptQualityThreshold()).toBe(SCRIPT_QUALITY_THRESHOLD_DEFAULT);
  });
});

describe("runScriptEngineV2 quality-gate regeneration loop (Phase 10)", () => {
  const budget = getScriptLengthBudget("1");

  beforeEach(() => {
    vi.mocked(invokeLLM).mockReset();
    delete process.env.SCRIPT_QUALITY_THRESHOLD;
  });

  it("regenerates narration when the first draft fails the quality gate, and ships the higher-scoring attempt", async () => {
    let qualityCallCount = 0;
    const bodyNarrationCalls: string[] = [];

    vi.mocked(invokeLLM).mockImplementation(async (args) => {
      const system = systemOf(args);
      const user = userOf(args);

      // Story architecture / scene planner / visual planner: return unparseable
      // content so each stage falls through to its own deterministic fallback —
      // keeps this test focused on the regeneration loop, not story generation.
      if (
        system.includes("master documentary storyteller") ||
        system.includes("documentary scene architect") ||
        system.includes("documentary footage researcher")
      ) {
        return { choices: [{ message: { content: "not valid json" } }] } as never;
      }

      // Hook writer
      if (user.includes("Write a KILLER hook")) {
        return {
          choices: [{ message: { content: "Test Hook Title\nA specific shocking fact opens this story with real stakes for the viewer right now." } }],
        } as never;
      }

      // Scene narration writer (body scenes)
      if (user.includes("SPOKEN NARRATION only")) {
        const attempt = system.includes("REVISION NOTE") ? "revision" : "draft";
        bodyNarrationCalls.push(attempt);
        const words = Array.from({ length: 55 }, (_, i) => `${attempt}word${i}`).join(" ");
        return { choices: [{ message: { content: words } }] } as never;
      }

      // Quality review
      if (system.includes("senior YouTube video editor")) {
        qualityCallCount += 1;
        if (qualityCallCount === 1) {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  storyStructure: 4, retention: 4, emotionalArc: 4,
                  visualRichness: 4, historicalAccuracy: 4, sceneFlow: 4,
                  weaknesses: ["too generic", "weak retention"],
                }),
              },
            }],
          } as never;
        }
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                storyStructure: 8, retention: 8, emotionalArc: 8,
                visualRichness: 8, historicalAccuracy: 8, sceneFlow: 8,
                weaknesses: [],
              }),
            },
          }],
        } as never;
      }

      throw new Error(`Unexpected invokeLLM call in test: system="${system.slice(0, 60)}"`);
    });

    const output = await runScriptEngineV2("Test Topic", "documentary", budget);

    // Quality review ran exactly twice: draft failed (4/10), revision passed (8/10).
    expect(qualityCallCount).toBe(2);
    // Narration was written once per body scene per attempt (draft, then revision).
    expect(bodyNarrationCalls.filter((a) => a === "draft").length).toBeGreaterThan(0);
    expect(bodyNarrationCalls.filter((a) => a === "revision").length).toBeGreaterThan(0);
    expect(bodyNarrationCalls.filter((a) => a === "draft").length).toBe(
      bodyNarrationCalls.filter((a) => a === "revision").length
    );

    // The shipped script is the higher-scoring (revised) attempt.
    expect(output.quality.overall).toBe(8);
    expect(output.quality.passesThreshold).toBe(true);
    expect(output.markdownScript).toContain("revisionword0");
    expect(output.markdownScript).not.toContain("draftword0");
  }, 20000);

  it("stops after MAX_QUALITY_REGENERATION_ATTEMPTS+1 attempts and ships the best-scoring one even if none pass", async () => {
    let qualityCallCount = 0;

    vi.mocked(invokeLLM).mockImplementation(async (args) => {
      const system = systemOf(args);
      const user = userOf(args);

      if (
        system.includes("master documentary storyteller") ||
        system.includes("documentary scene architect") ||
        system.includes("documentary footage researcher")
      ) {
        return { choices: [{ message: { content: "not valid json" } }] } as never;
      }

      if (user.includes("Write a KILLER hook")) {
        return {
          choices: [{ message: { content: "Test Hook Title\nA specific shocking fact opens this story with real stakes for the viewer right now." } }],
        } as never;
      }

      if (user.includes("SPOKEN NARRATION only")) {
        qualityCallCount += 0; // no-op, narration calls tracked separately below
        const words = Array.from({ length: 55 }, (_, i) => `word${i}`).join(" ");
        return { choices: [{ message: { content: words } }] } as never;
      }

      if (system.includes("senior YouTube video editor")) {
        qualityCallCount += 1;
        // Every attempt scores progressively but never clears the 6.5 default threshold.
        const score = 3 + qualityCallCount * 0.5;
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                storyStructure: score, retention: score, emotionalArc: score,
                visualRichness: score, historicalAccuracy: score, sceneFlow: score,
                weaknesses: [`weakness at attempt ${qualityCallCount}`],
              }),
            },
          }],
        } as never;
      }

      throw new Error(`Unexpected invokeLLM call in test: system="${system.slice(0, 60)}"`);
    });

    const output = await runScriptEngineV2("Test Topic", "documentary", budget);

    // Exactly MAX_QUALITY_REGENERATION_ATTEMPTS + 1 quality-review calls — the loop is bounded.
    expect(qualityCallCount).toBe(MAX_QUALITY_REGENERATION_ATTEMPTS + 1);
    // Never passed, but still shipped the best (last/highest) scoring attempt.
    expect(output.quality.passesThreshold).toBe(false);
    expect(output.quality.overall).toBeCloseTo(3 + qualityCallCount * 0.5, 5);
  }, 20000);
});
