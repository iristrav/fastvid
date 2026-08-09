import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  sweepUnadoptedSceneCandidates,
  createVisualDedupState,
  getPipelinePerfProfile,
} from "./videoPipeline";

// F3-04: workDir disk growth from adoptClip candidates that lost the ranking and were never
// cleaned up. Cleanup is deferred to a post-scene sweep (this function) instead of running
// inside adoptClip itself, because beats within a scene run concurrently and several fetchers
// name candidate files by scene+id only (not beat) — deleting a "losing" candidate immediately
// could remove a file a sibling beat, still mid-search, was about to adopt. This sweep is only
// ever called once a scene's beats have fully finished, so that race cannot occur — see the
// comment on sweepUnadoptedSceneCandidates in videoPipeline.ts.
describe("sweepUnadoptedSceneCandidates (F3-04)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-scene-sweep-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function touch(name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x");
    return p;
  }

  function freshDedup() {
    return createVisualDedupState(getPipelinePerfProfile("1"));
  }

  it("keeps the adopted clip and deletes the unadopted candidate from the same scene", () => {
    const dedup = freshDedup();
    const adopted = touch("scene_0_pexels_vid1.mp4");
    const loser = touch("scene_0_pexels_vid2.mp4");
    dedup.sceneCandidatePaths.set(0, new Set([adopted, loser]));
    dedup.usedPaths.add(adopted);

    sweepUnadoptedSceneCandidates(dedup, 0);

    expect(fs.existsSync(adopted)).toBe(true);
    expect(fs.existsSync(loser)).toBe(false);
  });

  it("does not touch a candidate recorded under a different scene index", () => {
    const dedup = freshDedup();
    const otherSceneCandidate = touch("scene_1_pexels_vid9.mp4");
    dedup.sceneCandidatePaths.set(1, new Set([otherSceneCandidate]));

    sweepUnadoptedSceneCandidates(dedup, 0);

    expect(fs.existsSync(otherSceneCandidate)).toBe(true);
  });

  it("does not delete a candidate that was adopted by a different beat in the same scene", () => {
    const dedup = freshDedup();
    const usedByOtherBeat = touch("scene_0_pexels_vid3.mp4");
    dedup.sceneCandidatePaths.set(0, new Set([usedByOtherBeat]));
    // Simulates a sibling beat in the same scene having adopted this exact candidate.
    dedup.usedPaths.add(usedByOtherBeat);

    sweepUnadoptedSceneCandidates(dedup, 0);

    expect(fs.existsSync(usedByOtherBeat)).toBe(true);
  });

  it("does not throw when a recorded candidate is already missing from disk", () => {
    const dedup = freshDedup();
    const alreadyGone = path.join(dir, "scene_0_pexels_vid4.mp4");
    dedup.sceneCandidatePaths.set(0, new Set([alreadyGone]));

    expect(() => sweepUnadoptedSceneCandidates(dedup, 0)).not.toThrow();
  });

  it("clears the per-scene entry after sweeping so a later attempt for the same scene starts fresh", () => {
    const dedup = freshDedup();
    const loser = touch("scene_0_pexels_vid5.mp4");
    dedup.sceneCandidatePaths.set(0, new Set([loser]));

    sweepUnadoptedSceneCandidates(dedup, 0);

    expect(dedup.sceneCandidatePaths.has(0)).toBe(false);
  });

  it("is a no-op when nothing was recorded for this scene", () => {
    const dedup = freshDedup();
    expect(() => sweepUnadoptedSceneCandidates(dedup, 5)).not.toThrow();
  });
});
