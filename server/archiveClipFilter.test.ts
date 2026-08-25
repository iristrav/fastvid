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

  // RONDE 26: the fixture used to be a nine-byte "fake-jpeg" string that is not a JPEG at all.
  // prepareImageForVision now refuses bytes it cannot identify as a vision-safe format instead of
  // shipping them to a model that answers 400, so the stub has to carry a real JPEG signature.
  // Only the fixture changed; every assertion below is the one it always made.
  const fakeJpeg = (): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-jpeg-body")]);

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
    const result = await fn(fakeJpeg(), "image/jpeg");
    expect(result).toBe(true);
  });

  it("Test 8 — small/non-dominant historical text: the model's false verdict is honored (not auto-rejected)", async () => {
    mockInvokeLLM(false);
    const { archiveClipHasBakedEditText: fn } = await import("./archiveClipFilter");
    const result = await fn(fakeJpeg(), "image/jpeg");
    expect(result).toBe(false);
  });

  /**
   * RONDE 66 REPLACES the F3-24 policy this test used to pin, at the user's explicit request to
   * get text out of the picture.
   *
   * F3-24's reasoning was sound as far as it went: a size threshold stops the filter from
   * throwing away archive footage over a small date label. But it also let through every burnt-in
   * subtitle, channel watermark and title card, and render 532 showed the cost — the filter fired
   * 3 times in 35 while the beat-image gate kept naming title cards in the same footage.
   *
   * The replacement keeps what F3-24 was protecting, on a better axis: text that was physically
   * in front of the camera (a newspaper, a street sign, a map, an inscription) is kept whatever
   * its size, and text added in post is refused whatever its size. The two assertions below are
   * the two halves of that, so neither can regress silently.
   */
  it("prompt asks where the text came from, and protects text that was really in the scene", async () => {
    const invokeLLMMock = mockInvokeLLM(false);
    const { archiveClipHasBakedEditText: fn } = await import("./archiveClipFilter");
    await fn(fakeJpeg(), "image/jpeg");

    expect(invokeLLMMock).toHaveBeenCalledTimes(1);
    const messages = invokeLLMMock.mock.calls[0]?.[0]?.messages as Array<{ content: unknown }>;
    const userContent = messages?.[1]?.content as Array<{ type: string; text?: string }>;
    const promptText = userContent?.find((c) => c.type === "text")?.text ?? "";

    // Rejection turns on origin, and size is explicitly ruled out as the test.
    expect(promptText).toMatch(/De vraag is NIET hoe groot de tekst is/);
    expect(promptText).toMatch(/ACHTERAF TOEGEVOEGD/);
    // An added subtitle is refused however small — the half F3-24 could not do.
    expect(promptText).toMatch(/ondertitels of captions, ook kleine/);
    // And what F3-24 existed to protect is still protected, on the new axis.
    expect(promptText).toMatch(/opgenomen werkelijkheid/);
    expect(promptText).toMatch(/historische kaart/);
    // The size rule itself is gone.
    expect(promptText).not.toMatch(/DOMINANTE/);
  });
});
