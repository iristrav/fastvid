import { describe, expect, it } from "vitest";
import { applyAutoFix, revertAutoFix } from "./autoFixApply";
import type { AutoFix } from "./types";
import { makeCaption, makeDecision, makeEDL } from "./testFixtures";

function fixture() {
  const decision = makeDecision({
    beatId: "b0",
    sceneIndex: 0,
    shot: { shotType: "wide", reason: "original shot reason" },
    camera: { movement: "camera_hold", intensity: 0, reason: "original camera reason" },
    transitionIn: { type: "cut", durationSec: 0, reason: "original transition reason" },
    captions: [makeCaption({ startSec: 1, endSec: 5 })],
  });
  return [makeEDL(0, [decision])];
}

describe("autoFixApply (Phase 6) — reversibility for every AutoFixType", () => {
  it("change_shot_type: applies then reverts to the exact original shot type", () => {
    const original = fixture();
    const fix: AutoFix = {
      type: "change_shot_type", sceneIndex: 0, beatId: "b0", description: "test",
      field: "shot.shotType", before: "wide", after: "close_up", reversible: true, reason: "avoid another wide shot",
    };
    const applied = applyAutoFix(original, fix);
    expect(applied[0]!.decisions[0]!.shot.shotType).toBe("close_up");

    const reverted = revertAutoFix(applied, fix);
    expect(reverted[0]!.decisions[0]!.shot.shotType).toBe("wide");
  });

  it("change_camera_movement: applies then reverts to the exact original movement", () => {
    const original = fixture();
    const fix: AutoFix = {
      type: "change_camera_movement", sceneIndex: 0, beatId: "b0", description: "test",
      field: "camera.movement", before: "camera_hold", after: "slow_push", reversible: true, reason: "test",
    };
    const applied = applyAutoFix(original, fix);
    expect(applied[0]!.decisions[0]!.camera.movement).toBe("slow_push");

    const reverted = revertAutoFix(applied, fix);
    expect(reverted[0]!.decisions[0]!.camera.movement).toBe("camera_hold");
  });

  it("change_transition: applies then reverts to the exact original transition type", () => {
    const original = fixture();
    const fix: AutoFix = {
      type: "change_transition", sceneIndex: 0, beatId: "b0", description: "test",
      field: "transitionIn.type", before: "cut", after: "whip", reversible: true, reason: "test",
    };
    const applied = applyAutoFix(original, fix);
    expect(applied[0]!.decisions[0]!.transitionIn.type).toBe("whip");

    const reverted = revertAutoFix(applied, fix);
    expect(reverted[0]!.decisions[0]!.transitionIn.type).toBe("cut");
  });

  it("reduce_text_duration: applies then reverts to the exact original caption duration", () => {
    const original = fixture();
    const originalDuration = original[0]!.decisions[0]!.captions[0]!.endSec - original[0]!.decisions[0]!.captions[0]!.startSec;
    const fix: AutoFix = {
      type: "reduce_text_duration", sceneIndex: 0, beatId: "b0", description: "test",
      field: "captions[].duration", before: originalDuration, after: originalDuration / 2, reversible: true, reason: "test",
    };
    const applied = applyAutoFix(original, fix);
    const appliedDuration = applied[0]!.decisions[0]!.captions[0]!.endSec - applied[0]!.decisions[0]!.captions[0]!.startSec;
    expect(appliedDuration).toBeCloseTo(originalDuration / 2, 5);

    const reverted = revertAutoFix(applied, fix);
    const revertedDuration = reverted[0]!.decisions[0]!.captions[0]!.endSec - reverted[0]!.decisions[0]!.captions[0]!.startSec;
    expect(revertedDuration).toBeCloseTo(originalDuration, 5);
  });

  it("only touches the beat matching sceneIndex+beatId, leaving every other beat untouched", () => {
    const decisionA = makeDecision({ beatId: "a", sceneIndex: 0, shot: { shotType: "wide", reason: "x" } });
    const decisionB = makeDecision({ beatId: "b", sceneIndex: 0, shot: { shotType: "medium", reason: "y" } });
    const edls = [makeEDL(0, [decisionA, decisionB])];
    const fix: AutoFix = {
      type: "change_shot_type", sceneIndex: 0, beatId: "a", description: "test",
      field: "shot.shotType", before: "wide", after: "close_up", reversible: true, reason: "test",
    };
    const applied = applyAutoFix(edls, fix);
    expect(applied[0]!.decisions[0]!.shot.shotType).toBe("close_up");
    expect(applied[0]!.decisions[1]!.shot.shotType).toBe("medium");
  });

  it("is a no-op when the fix's sceneIndex/beatId doesn't match anything", () => {
    const original = fixture();
    const fix: AutoFix = {
      type: "change_shot_type", sceneIndex: 5, beatId: "nonexistent", description: "test",
      field: "shot.shotType", before: "wide", after: "close_up", reversible: true, reason: "test",
    };
    const applied = applyAutoFix(original, fix);
    expect(applied[0]!.decisions[0]!.shot.shotType).toBe("wide");
  });
});
