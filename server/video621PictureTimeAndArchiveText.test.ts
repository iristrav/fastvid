/**
 * VIDEO 621 — every chunk gets its share of the picture time, and the archive always checks for text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { chunkShareOfVisualTimeMs, visualDeadlineForVideoMs, PICTURE_SEC_PER_VIDEO_SEC } from "./videoPipeline";
import {
  __resetOverlayVerdictCacheForTest,
  archiveClipTextVerdict,
  cachedClipBakedEditTextVerdict,
  overlayChecksSpent,
} from "./archiveClipFilter";

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

describe("Video 621 — the picture time grows with the video", () => {
  it("a one-minute film keeps the time it had: 165 s for 58 s", () => {
    expect(visualDeadlineForVideoMs(165_000, 58)).toBe(165_300);
    expect(PICTURE_SEC_PER_VIDEO_SEC * 58).toBeCloseTo(165.3, 1);
  });

  it("render 621's 85 s narration gets 242 s instead of 165 s", () => {
    expect(Math.round(visualDeadlineForVideoMs(165_000, 85) / 1000)).toBe(242);
  });

  it("never less than the per-scene budget gave", () => {
    expect(visualDeadlineForVideoMs(2_200_000, 600)).toBe(2_200_000);
    expect(visualDeadlineForVideoMs(165_000, 0)).toBe(165_000);
  });
});

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

describe("Video 621 — a scene that finds nothing searches on the video's main subject only", () => {
  it("the main subject is the locked person when there is one", async () => {
    const { videoMainSubject } = await import("./mainSubject");
    expect(videoMainSubject("Elon Musk", { prompt: "Tesla", title: "t", sceneTexts: ["Tesla grew. Tesla fell."] })).toBe("Elon Musk");
  });

  it("otherwise the name the narration returns to in the most scenes — never a year, never a name said once", async () => {
    const { videoMainSubject } = await import("./mainSubject");
    expect(
      videoMainSubject("", {
        prompt: "the story of the Titanic",
        title: "Titanic",
        sceneTexts: [
          "In 1912 the Titanic left Southampton. The Titanic was the largest ship afloat.",
          "The Titanic struck an iceberg in 1912. Few lifeboats were ready.",
          "Survivors reached New York aboard the Carpathia.",
        ],
      })
    ).toBe("Titanic");
    expect(videoMainSubject(null, { prompt: "x", title: "x", sceneTexts: ["It happened in 1999. Nobody knew why."] })).toBeNull();
  });

  it("every empty scene is searched again on the main subject, with at least a minute, before it is left empty", () => {
    const src = read("server/videoPipeline.ts");
    const rescueAt = src.indexOf("VIDEO 621 — A SCENE THAT FOUND NOTHING SEARCHES ONCE MORE");
    const leftEmptyAt = src.indexOf("no picture found — the timeline holds the previous shot");
    expect(rescueAt).toBeGreaterThan(0);
    expect(rescueAt).toBeLessThan(leftEmptyAt);
    expect(src).toContain("Math.max(visualDeadlineAtMs - Date.now(), EMPTY_SCENE_RESCUE_MIN_MS)");
    expect(src).toContain("scenes[si]!, workDir, topicContext, visualDedup, undefined, audioPaths[si], mainSubject");
  });

  it("the beats keep their timing and recorded narration; the search and the picture editor get the main subject", () => {
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("for (const b of beats) (dedup.beatJudgeTextOverride ??= new Map()).set(`${scene.index}:${b.index}`, rescue);");
    expect(src).toContain("text: rescue,\n      searchQuery: rescue,\n      powerWord: rescue,\n      keywords: [rescue],");
    expect(src).toContain("visualDedup.beatJudgeTextOverride?.get(`${sceneIndex}:${beatIndex}`) ??\n      visualDedup.sceneBeatsBySceneIndex");
    expect(src).toContain("const beatText = judgedBeatText(sceneIndex, beatIndex);");
    expect(src).toContain("const text = judgedBeatText(sceneIndex, beatIndex);");
    /** The override is set after the beats are recorded, so the recorded array keeps the narration. */
    const recordAt = src.indexOf("await applyVoiceAlignmentToBeats(beats, sceneAudioPath, scene.duration, dedup, scene.index);\n  /**\n   * VIDEO 621");
    expect(recordAt).toBeGreaterThan(0);
  });
});
