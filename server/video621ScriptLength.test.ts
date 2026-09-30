/**
 * VIDEO 621 — a one-minute script of 167 words (budget 126–154) was shipped as it was: the length
 * step only ever expanded. It now trims too, and keeps a revision only when it is closer to target.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: vi.fn(),
}));

import { invokeLLM } from "./_core/llm";
import { runScriptEngineV2 } from "./scriptEngine";
import { getScriptLengthBudget } from "./scriptWriter";

const systemOf = (call: unknown) =>
  (call as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "system")?.content ?? "";
const userOf = (call: unknown) =>
  (call as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "user")?.content ?? "";

const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

function mockEngine(trimmedScript: (budget: ReturnType<typeof getScriptLengthBudget>) => string, asked: string[]) {
  const budget = getScriptLengthBudget("1");
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
      return { choices: [{ message: { content: "Test Hook Title\nA specific fact opens this story with real stakes." } }] } as never;
    }
    /** Every body scene far too long, as in render 621. */
    if (user.includes("SPOKEN NARRATION only")) {
      return { choices: [{ message: { content: words(90, "long") } }] } as never;
    }
    if (user.startsWith("TRIM ") || user.startsWith("EXPAND ")) {
      asked.push(user.split(" ")[0]!);
      return { choices: [{ message: { content: trimmedScript(budget) } }] } as never;
    }
    if (system.includes("senior YouTube video editor")) {
      return {
        choices: [{ message: { content: JSON.stringify({
          storyStructure: 8, retention: 8, emotionalArc: 8, visualRichness: 8, historicalAccuracy: 8, sceneFlow: 8, weaknesses: [],
        }) } }],
      } as never;
    }
    throw new Error(`Unexpected invokeLLM call: ${system.slice(0, 60)}`);
  });
  return budget;
}

describe("Video 621 — a script that is too long is trimmed", () => {
  beforeEach(() => {
    vi.mocked(invokeLLM).mockReset();
  });

  it("asks for a TRIM and ships the trimmed script when it is closer to the target", async () => {
    const asked: string[] = [];
    const budget = mockEngine((b) => `# Test Topic\n\n## Scene\n\nTest Topic ${words(b.targetWords - 2, "short")}`, asked);
    const out = await runScriptEngineV2("Test Topic", "documentary", budget);
    expect(asked).toEqual(["TRIM"]);
    expect(out.markdownScript).toContain("short0");
    expect(out.markdownScript).not.toContain("long0");
  }, 20000);

  it("keeps the draft when the revision is no closer to the target", async () => {
    const asked: string[] = [];
    const budget = mockEngine(() => `# Test Topic\n\n## Scene\n\nTest Topic ${words(600, "longer")}`, asked);
    const out = await runScriptEngineV2("Test Topic", "documentary", budget);
    expect(asked).toEqual(["TRIM"]);
    expect(out.markdownScript).toContain("long0");
    expect(out.markdownScript).not.toContain("longer0");
  }, 20000);
});
