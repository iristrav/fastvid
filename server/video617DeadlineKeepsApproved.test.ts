/**
 * Video 617 — the visual deadline no longer throws away a picture a scene had already approved.
 *
 * Scene 0 ran 169.6 s against a 165 s deadline. Its first beat had pushed an approved archive clip
 * (#58020, "push fits") at 20:23:36; the scene returned 4.6 s after the deadline, its whole result
 * was dropped, the scene counted as empty, and the render stopped on "no picture for any of its
 * beats" (10108). What a still-running scene has already pushed is now kept; the beats it had not
 * reached stay gaps.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { sceneClipsKeptAtDeadline } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Video 617. a scene still running at the visual deadline keeps what it already approved", () => {
  it("the approved clips, their holds and their sentences are kept, in order", () => {
    const kept = sceneClipsKeptAtDeadline({
      clips: ["/w/scene_0_b0_curated_a58020.mp4", "/w/scene_0_b1_curated_a58027.mp4"],
      beatDurations: [5.2, 4.1],
      clipBeatIndices: [0, 1],
    });
    expect(kept).toEqual({
      clips: ["/w/scene_0_b0_curated_a58020.mp4", "/w/scene_0_b1_curated_a58027.mp4"],
      beatDurations: [5.2, 4.1],
      clipBeatIndices: [0, 1],
    });
  });

  /** VIDEO 626 — a clip whose sentence is unknown would be placed by position; it is placed nowhere. */
  it("a clip with no recorded sentence is not kept", () => {
    const kept = sceneClipsKeptAtDeadline({
      clips: ["/w/scene_0_b0_curated_a58020.mp4", "/w/scene_0_b1_curated_a58027.mp4"],
      beatDurations: [5.2, 4.1],
      clipBeatIndices: [0],
    });
    expect(kept.clips).toEqual(["/w/scene_0_b0_curated_a58020.mp4"]);
  });

  it("it is a copy: what the scene pushes after the deadline does not reach the result", () => {
    const soFar = { clips: ["/w/scene_0_b0_curated_a58020.mp4"], beatDurations: [5.2], clipBeatIndices: [0] };
    const kept = sceneClipsKeptAtDeadline(soFar);
    soFar.clips.push("/w/scene_0_b3_late.mp4");
    soFar.beatDurations.push(3);
    soFar.clipBeatIndices.push(3);
    expect(kept.clips).toEqual(["/w/scene_0_b0_curated_a58020.mp4"]);
    expect(kept.beatDurations).toEqual([5.2]);
  });

  it("a pipeline fallback is left out, as the scene's own return leaves it out; its hold goes with it", () => {
    const kept = sceneClipsKeptAtDeadline({
      clips: ["/w/scene_0_b0_curated_a58020.mp4", "", "/w/scene_0_b2_curated_a58049.mp4"],
      beatDurations: [5.2, 1, 4],
      clipBeatIndices: [0, 1, 2],
    });
    expect(kept.clips).toEqual(["/w/scene_0_b0_curated_a58020.mp4", "/w/scene_0_b2_curated_a58049.mp4"]);
    expect(kept.beatDurations).toEqual([5.2, 4]);
    expect(kept.clipBeatIndices).toEqual([0, 2]);
  });

  it("a scene that never started, or approved nothing, is still empty — a gap as before", () => {
    const empty = { clips: [], beatDurations: [], clipBeatIndices: [] };
    expect(sceneClipsKeptAtDeadline(undefined)).toEqual(empty);
    expect(sceneClipsKeptAtDeadline({ clips: [], beatDurations: [], clipBeatIndices: [] })).toEqual(empty);
  });

  it("wiring: the scene registers its own lists; the deadline reads a copy of them; a late return still writes nothing", () => {
    const inner = PIPE.slice(PIPE.indexOf("async function fetchSceneVisualsInner("));
    expect(inner).toMatch(
      /const clips: string\[\] = \[\];\s*const beatDurations: number\[\] = \[\];[\s\S]{0,200}const clipBeatIndices: number\[\] = \[\];\s*\(dedup\.sceneClipsSoFar \?\?= new Map\(\)\)\.set\(scene\.index, \{ clips, beatDurations, clipBeatIndices \}\);/
    );
    expect(PIPE).toContain("const kept = sceneClipsKeptAtDeadline(visualDedup.sceneClipsSoFar?.get(scenes[si]!.index));");
    /** The kept clips fill the slot first; an unfinished scene with nothing approved is still a gap. */
    expect(PIPE).toMatch(/sceneVisualResults\[si\] \?\?= kept;\s*\}\s*\}\s*sceneVisualResults\[si\] \?\?= \{ clips: \[\], beatDurations: \[\] \};/);
    /** Unchanged: a scene returning after the deadline writes nothing itself. */
    expect(PIPE).toContain("if (chunkClosed) return result;");
    /** Unchanged: a scene with no picture at all still stops the export. */
    expect(PIPE).toContain("no picture was found for any of its beats — export geblokkeerd");
  });

  it("only the scene's own push adds to those lists — after the relevance gate and the adoption guard", () => {
    const at = PIPE.indexOf("const pushSceneClip = async (clipPath: string, holdSec: number, beatIndex: number)");
    const body = PIPE.slice(at, PIPE.indexOf("clips.push(clipPath);", at));
    expect(body).toContain("if (await beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)) return false;");
    expect((PIPE.match(/^\s*clips\.push\(clipPath\);/gm) ?? []).length).toBe(1);
  });
});
