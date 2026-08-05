import { describe, expect, it, vi } from "vitest";
import { splitScenes } from "./sceneSplitter";
import type { Scene } from "../types";

vi.mock("../../videoPipeline", () => ({
  parseScriptIntoScenes: vi.fn(),
}));

describe("Scene Splitter stage", () => {
  it("returns the scenes parsed by the underlying (semantic, non-sentence-count) splitter", async () => {
    const { parseScriptIntoScenes } = await import("../../videoPipeline");
    const scenes: Scene[] = [
      { index: 0, text: "Scene one.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 6 },
      { index: 1, text: "Scene two.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 7 },
    ];
    vi.mocked(parseScriptIntoScenes).mockResolvedValue(scenes);

    const result = await splitScenes({
      script: "## Scene one\nScene one.\n## Scene two\nScene two.",
      maxScenes: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scenes).toHaveLength(2);
    }
    expect(parseScriptIntoScenes).toHaveBeenCalledWith(
      "## Scene one\nScene one.\n## Scene two\nScene two.",
      2,
      undefined
    );
  });

  it("returns a structured error instead of throwing when parsing fails", async () => {
    const { parseScriptIntoScenes } = await import("../../videoPipeline");
    vi.mocked(parseScriptIntoScenes).mockRejectedValue(new Error("scene JSON schema mismatch"));

    const result = await splitScenes({ script: "broken", maxScenes: 3 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("scene JSON schema mismatch");
    }
  });
});
