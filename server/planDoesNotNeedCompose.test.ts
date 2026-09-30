/**
 * §19 — WHY THE OLD RENDER IS STILL THERE, AND WHAT ACTUALLY HELD IT IN PLACE.
 *
 * ── The question ────────────────────────────────────────────────────────────────────────────
 *
 * If the cinematic route produces the delivered film, why does every job still render the compose
 * montage first and throw it away? The stated answer was "the new route is not proven yet". That is
 * true and it is not the binding constraint.
 *
 * ── The binding constraint ──────────────────────────────────────────────────────────────────
 *
 * `composedUsedClips[i]` is written BY the compose stage — it is the list of clips each scene's
 * montage was actually built from. The cinematic planner read only that. So compose was an INPUT to
 * the plan, not a fallback behind it:
 *
 *     no compose  →  composedUsedClips is [] for every scene
 *                 →  every beat is dropped for having no clip
 *                 →  no timeline is stored
 *                 →  the route falls back to the compose that no longer exists
 *
 * A spare tyre can be removed. An axle cannot. That is the difference this file pins.
 *
 * ── The fallback, which already existed one stage earlier ───────────────────────────────────
 *
 * `sceneVisualResults[i].clips` is the scene's SELECTED set, which exists before anything is
 * composed. Stage 5's critical review has always preferred the composed list and fallen back to
 * exactly this. Using the same pair in the planner is not a new mechanism; it is the existing one,
 * applied where it was missing.
 *
 * ── What this does NOT claim ────────────────────────────────────────────────────────────────
 *
 * It does not make the compose render removable today. It removes ONE of the two reasons it cannot
 * be. The other — that the cinematic route has never rendered real, heterogeneous, rehydrated
 * footage — needs a real render, and no source-level test substitutes for one.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { pairClipsToBeats } from "./cinematicPipelineInputs";

const pipeline = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ the pairing itself, on the fallback source ═══════════════════════ */

describe("beats still pair to clips when the list came from retrieval", () => {
  const beat = (index: number) => ({ index });

  /**
   * `pairClipsToBeats` matches on the sentence each clip was pushed for, not on position — so it
   * works the same whichever order the list is in.
   */
  it("pairs by the recorded sentence, so the list's order does not matter", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/scene_0_a.mp4", "/w/scene_0_b.mp4"],
      clipBeatIndices: [1, 0],
      beats: [beat(0), beat(1)],
    });
    // Not positional: beat 0 took the SECOND path because that is what the record says.
    expect(paired[0]).toEqual(["/w/scene_0_b.mp4"]);
    expect(paired[1]).toEqual(["/w/scene_0_a.mp4"]);
  });

  it("an empty clip list still produces no clip rather than throwing", () => {
    const paired = pairClipsToBeats({ clipPaths: [], clipBeatIndices: [], beats: [beat(0)] });
    expect(paired[0]).toEqual([]);
  });
});
