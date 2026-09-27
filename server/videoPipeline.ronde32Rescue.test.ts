import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// RONDE 32 — the three proven rescue defects from the forensic audit of render 529.
//
// L1  the compose rescue handed composeSceneVideo ONLY its own clips, and composeSceneVideo
//     treats that argument as the complete set — so every winner the scene had already selected
//     silently disappeared. Worse, withSceneFetchTimeout rejects the caller without cancelling
//     the work, so the compose that "failed" had in fact finished writing a complete file six
//     seconds later, which the rescue then overwrote (scene 1: five real clips → one).
// L2  every rescue slot passed a FRESH exclusion set to fetchCuratedArchiveBeatClip and nothing
//     ever called markCuratedAssetUsed, so all twelve of scene 1's slots got curated asset
//     #55988 and the compose-time content dedup threw eleven of them away.
// L3  the rescue loop never passed beatText, so generateGuaranteedBeatClip's escalation ladder
//     collapsed to the single video-wide topic query ("Adolf Hitler") for every slot.
//
// A note on scope: the rescue blocks themselves live inside _runVideoPipelineInner, which needs
// a database, an LLM and a TTS provider to reach. These tests therefore cover the extracted
// decision helpers and generateGuaranteedBeatClip behaviourally, and add one structural guard
// (TEST A/F) over the two rescue call sites — deliberately, because the audit's central finding
// was that the same defect existed in two places and fixing one would leave the other.

const REPO_PIPELINE = path.join(__dirname, "videoPipeline.ts");

/** Real, decodable mp4 of an exact duration — ffprobe must be able to measure it. */
function writeTestVideo(filePath: string, durationSec: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", `color=c=black:s=320x240:r=25`,
      "-t", durationSec.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
      filePath,
    ],
    { stdio: "ignore" }
  );
}

describe("RONDE 32 — FIX B: a rescue batch never collects the same curated asset twice", () => {
  let dir: string;
  const prepared: string[] = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r32-fixb-"));
    // Three curated assets, ranked 55988 > 55989 > 55990, each a real decodable clip so
    // generateGuaranteedBeatClip's own isValidVideoFile() check passes on them.
    for (const id of [55988, 55989, 55990]) {
      const p = path.join(dir, `scene_0_b0_curated_a${id}.mp4`);
      writeTestVideo(p, 3);
      prepared.push(p);
    }
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("./curatedMediaSourcing");
  });

  it("shares one exclusion set across slots AND marks each pick, so slots get different assets", async () => {
    vi.resetModules();
    const fetchSpy = vi.fn();

    vi.doMock("./curatedMediaSourcing", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./curatedMediaSourcing")>();
      return {
        ...actual,
        // Stands in for the real ranker: always hands back its highest-scoring asset that the
        // caller has not already excluded. This is exactly the semantic the real function has —
        // it READS usedAssetIds while ranking and never writes to it.
        fetchCuratedArchiveBeatClip: fetchSpy.mockImplementation(
          async (
            _beat: unknown,
            _scene: unknown,
            _workDir: string,
            _sceneIndex: number,
            _holdSec: number,
            usedAssetIds: Set<number>
          ) => prepared.find((p) => !usedAssetIds.has(Number(p.match(/_a(\d+)\.mp4$/)![1]))) ?? null
        ),
      };
    });

    const { generateGuaranteedBeatClip } = await import("./videoPipeline");

    const rescueUsedAssetIds = new Set<number>();
    const rescueUsedStorageUrls = new Set<string>();
    const picked: string[] = [];
    for (let slot = 0; slot < 3; slot++) {
      picked.push(
        await generateGuaranteedBeatClip(
          0,
          slot,
          3,
          dir,
          `beat ${slot} in the Berlin bunker in 1945`,
          rescueUsedAssetIds,
          rescueUsedStorageUrls
        )
      );
    }

    // The whole point: three slots, three DIFFERENT assets. Before the fix all three were 55988.
    expect(new Set(picked).size).toBe(3);
    expect(picked.map((p) => Number(p.match(/_a(\d+)\.mp4$/)![1]))).toEqual([55988, 55989, 55990]);

    // markCuratedAssetUsed must actually have written to the caller's set — a shared set that
    // stays empty is indistinguishable from no fix at all.
    expect(rescueUsedAssetIds.has(55988)).toBe(true);
    expect(rescueUsedAssetIds.has(55989)).toBe(true);
    expect(rescueUsedAssetIds.has(55990)).toBe(true);

    // And the SAME instance has to reach the sourcing call, not a per-slot copy of it.
    for (const call of fetchSpy.mock.calls) {
      expect(call[5]).toBe(rescueUsedAssetIds);
      expect(call[6]).toBe(rescueUsedStorageUrls);
    }
  }, 120_000);

  it("keeps the old behaviour for callers that pass no sets (fresh exclusion per call)", async () => {
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.doMock("./curatedMediaSourcing", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./curatedMediaSourcing")>();
      return {
        ...actual,
        fetchCuratedArchiveBeatClip: fetchSpy.mockImplementation(
          async (
            _beat: unknown,
            _scene: unknown,
            _workDir: string,
            _sceneIndex: number,
            _holdSec: number,
            usedAssetIds: Set<number>
          ) => prepared.find((p) => !usedAssetIds.has(Number(p.match(/_a(\d+)\.mp4$/)![1]))) ?? null
        ),
      };
    });

    const { generateGuaranteedBeatClip } = await import("./videoPipeline");
    const a = await generateGuaranteedBeatClip(0, 0, 3, dir, "beat in the Berlin bunker in 1945");
    const b = await generateGuaranteedBeatClip(0, 1, 3, dir, "beat in the Berlin bunker in 1945");
    // No shared state passed -> both calls start from an empty exclusion, exactly as before.
    expect(a).toBe(b);
  }, 120_000);
});

describe("RONDE 32 — FIX A/F: both rescue paths top up the winners instead of replacing them", () => {
  const src = () => fs.readFileSync(REPO_PIPELINE, "utf8");

  it("neither rescue path passes a bare rescueClips array as the complete clip set", () => {
    // composeSceneVideo(scene, clips, ...) treats `clips` as the COMPLETE set — it opens with
    // clips.filter(...). Passing only the rescue clips is what erased scene 1's five winners.
    expect(src()).not.toMatch(/composeSceneVideo\(\s*\n?\s*scene,\s*rescueClips,/);
  });
});
