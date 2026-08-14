import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { archiveClipHasBakedEditText, archiveClipOverlayFilterEnabled } from "./archiveClipFilter";

describe("archiveClipFilter", () => {
  const origForge = process.env.BUILT_IN_FORGE_API_KEY;
  const origFilter = process.env.ENABLE_ARCHIVE_OVERLAY_FILTER;
  const origAiTags = process.env.ENABLE_ARCHIVE_AI_TAGS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (origForge === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = origForge;
    if (origFilter === undefined) delete process.env.ENABLE_ARCHIVE_OVERLAY_FILTER;
    else process.env.ENABLE_ARCHIVE_OVERLAY_FILTER = origFilter;
    if (origAiTags === undefined) delete process.env.ENABLE_ARCHIVE_AI_TAGS;
    else process.env.ENABLE_ARCHIVE_AI_TAGS = origAiTags;
  });

  it("archiveClipOverlayFilterEnabled is false without API key", () => {
    delete process.env.BUILT_IN_FORGE_API_KEY;
    expect(archiveClipOverlayFilterEnabled()).toBe(false);
  });

  it("archiveClipHasBakedEditText skips check when filter disabled", async () => {
    process.env.ENABLE_ARCHIVE_OVERLAY_FILTER = "false";
    const result = await archiveClipHasBakedEditText(Buffer.from("fake"), "image/jpeg");
    expect(result).toBe(false);
  });
});

// F3-24: the overlay-check prompt used to tell the VLM that ANY on-screen subtitle/caption or
// historical text is never a rejection reason, regardless of size — which is why footage with
// large, dominant, irrelevant foreign-language subtitles (e.g. French text covering a real part
// of the frame) passed uncontested. The prompt now requires the text to be DOMINANT (a
// significant portion of the frame, pulling attention from the footage itself) before
// hasBakedEditText may be true, while still explicitly protecting small/marginal historical
// text, labels, and lower thirds from being auto-rejected. These tests exercise the real
// archiveClipHasBakedEditText()/detectOnScreenTextInImages() wiring with invokeLLM mocked (no
// real VLM call available in this sandbox) — proving (a) the boolean result still flows through
// end to end for both outcomes, and (b) the actual prompt text sent to the model carries the new
// dominance qualifier and still protects small text, so a future edit can't silently regress
// either half of this behavior.
describe("archiveClipFilter — F3-24 dominant vs. small baked-in text", () => {
  const origForge = process.env.BUILT_IN_FORGE_API_KEY;
  const origFilter = process.env.ENABLE_ARCHIVE_OVERLAY_FILTER;

  beforeEach(() => {
    vi.resetModules();
    process.env.BUILT_IN_FORGE_API_KEY = "test-forge-key";
    delete process.env.ENABLE_ARCHIVE_OVERLAY_FILTER;
  });

  afterEach(() => {
    if (origForge === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = origForge;
    if (origFilter === undefined) delete process.env.ENABLE_ARCHIVE_OVERLAY_FILTER;
    else process.env.ENABLE_ARCHIVE_OVERLAY_FILTER = origFilter;
    vi.restoreAllMocks();
    vi.doUnmock("./_core/llm");
  });

  function mockInvokeLLM(hasBakedEditText: boolean) {
    const invokeLLMMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ hasBakedEditText }) } }],
    });
    vi.doMock("./_core/llm", () => ({ invokeLLM: invokeLLMMock }));
    return invokeLLMMock;
  }

  it("Test 7 — dominant baked-in subtitles: the model's true verdict is honored (candidate downgraded/rejected)", async () => {
    mockInvokeLLM(true);
    const { archiveClipHasBakedEditText: fn } = await import("./archiveClipFilter");
    const result = await fn(Buffer.from("fake-jpeg"), "image/jpeg");
    expect(result).toBe(true);
  });

  it("Test 8 — small/non-dominant historical text: the model's false verdict is honored (not auto-rejected)", async () => {
    mockInvokeLLM(false);
    const { archiveClipHasBakedEditText: fn } = await import("./archiveClipFilter");
    const result = await fn(Buffer.from("fake-jpeg"), "image/jpeg");
    expect(result).toBe(false);
  });

  it("prompt sent to the model requires DOMINANCE before rejecting, and still explicitly protects small/marginal text", async () => {
    const invokeLLMMock = mockInvokeLLM(false);
    const { archiveClipHasBakedEditText: fn } = await import("./archiveClipFilter");
    await fn(Buffer.from("fake-jpeg"), "image/jpeg");

    expect(invokeLLMMock).toHaveBeenCalledTimes(1);
    const messages = invokeLLMMock.mock.calls[0]?.[0]?.messages as Array<{ content: unknown }>;
    const userContent = messages?.[1]?.content as Array<{ type: string; text?: string }>;
    const promptText = userContent?.find((c) => c.type === "text")?.text ?? "";

    // Rejection now requires dominance, not mere presence of text.
    expect(promptText).toMatch(/DOMINANTE/);
    // Small/marginal text is still explicitly protected from auto-rejection.
    expect(promptText).toMatch(/niet-dominante ondertitels/);
    expect(promptText).toMatch(/klein deel van het beeld/);
  });
});
