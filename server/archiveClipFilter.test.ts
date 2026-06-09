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
