/**
 * VIDEO 621 — every chunk gets its share of the picture time, and the archive always checks for text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { chunkShareOfVisualTimeMs } from "./videoPipeline";
import {
  __resetOverlayVerdictCacheForTest,
  archiveClipTextVerdict,
  cachedClipBakedEditTextVerdict,
  overlayChecksSpent,
} from "./archiveClipFilter";

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

describe("Video 621 — the picture time is shared between the chunks", () => {
  it("render 621: the first chunk (2 of 3 scenes) no longer takes all 165 s", () => {
    expect(chunkShareOfVisualTimeMs(165_000, 2, 3)).toBe(110_000);
  });

  it("the last chunk gets everything that is left, including what earlier chunks did not use", () => {
    expect(chunkShareOfVisualTimeMs(90_000, 1, 1)).toBe(90_000);
    expect(chunkShareOfVisualTimeMs(90_000, 3, 3)).toBe(90_000);
  });

  it("a middle chunk gets its part of what is left", () => {
    expect(chunkShareOfVisualTimeMs(120_000, 2, 6)).toBe(40_000);
  });

  it("no time left is no time", () => {
    expect(chunkShareOfVisualTimeMs(0, 1, 3)).toBe(0);
    expect(chunkShareOfVisualTimeMs(-5_000, 1, 1)).toBe(0);
  });

  it("the chunk scope is capped at its share, counted over the scenes not yet searched", () => {
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("chunkShareOfVisualTimeMs(visualTimeLeftMs, chunkScenes.length, scenes.length - chunk.start)");
  });
});

describe("Video 621 — the archive's text check is never skipped for a render's budget", () => {
  beforeEach(() => __resetOverlayVerdictCacheForTest());

  it("a render past its budget is not asked — the archive's own check still goes to the detector", async () => {
    const tmp = path.join(__dirname, "__v621_not_a_video.bin");
    fs.writeFileSync(tmp, "x");
    try {
      const render = await cachedClipBakedEditTextVerdict(tmp, "application/octet-stream", "k-render", 0);
      expect(render.reason).toMatch(/overlay budget was spent/);
      const archive = await archiveClipTextVerdict(tmp, "application/octet-stream", "k-archive");
      expect(archive.reason ?? "").not.toMatch(/budget/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("the archive's check does not count against the render's budget", async () => {
    const before = overlayChecksSpent();
    await archiveClipTextVerdict("/nowhere.bin", "application/octet-stream", "k1");
    await archiveClipTextVerdict("/nowhere.bin", "application/octet-stream", "k2");
    expect(overlayChecksSpent()).toBe(before);
  });

  it("ingestion and the shot sweep use the archive's own check", () => {
    expect(read("server/archiveIngestion.ts")).toContain("await archiveClipTextVerdict(localPath, metadata.mimeType, overlayKey)");
    expect(read("server/archiveIngestion.ts")).not.toContain("cachedClipBakedEditTextVerdict(");
    expect(read("server/archiveShotPieces.ts")).toContain("filter.archiveClipTextVerdict(piecePath");
  });
});
