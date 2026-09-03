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

describe("the cinematic plan can be built without the compose stage", () => {
  it("prefers what compose actually used, and falls back to what retrieval selected", () => {
    const src = pipeline();
    expect(src).toContain("const composedForScene = composedUsedClips[i] ?? [];");
    expect(src).toContain(
      "clipPaths: composedForScene.length > 0 ? composedForScene : sceneVisualResults[i]?.clips ?? [],"
    );
  });

  /**
   * The composed list wins whenever it exists, and that is deliberate rather than incidental: it has
   * had unusable files filtered out of it by the compose stage's own existence/decodability check.
   * The selected set has not. Preferring the weaker source would be a quiet downgrade.
   */
  it("does not prefer the selected set over the composed one", () => {
    const src = pipeline();
    const at = src.indexOf("const composedForScene = composedUsedClips[i] ?? [];");
    const line = src.slice(at, src.indexOf("adoptions:", at));
    // The composed list is the FIRST branch of the conditional, not the fallback.
    expect(line.indexOf("composedForScene.length > 0 ? composedForScene")).toBeGreaterThan(-1);
  });

  /**
   * The same preference stage 5's critical review already makes. Two places choosing between the
   * same two sources by different rules is the seam this codebase keeps rediscovering.
   */
  it("uses the same preference the critical review already used", () => {
    const src = pipeline();
    expect(src).toContain(
      "composedUsedClips[i]!.length > 0 ? composedUsedClips[i]! : (vr.clips ?? [])"
    );
  });

  it("records why the compose render cannot simply be deleted", () => {
    const src = pipeline();
    expect(src).toContain("THE PLANNER MUST NOT NEED COMPOSE TO HAVE RUN");
    expect(src).toContain("A spare tyre can be removed; an axle cannot.");
  });
});

/* ═══════════════════════ the pairing itself, on the fallback source ═══════════════════════ */

describe("beats still pair to clips when the list came from retrieval", () => {
  const beat = (index: number) => ({ index });

  /**
   * `pairClipsToBeats` matches on the adoption record, not on position — so it works the same
   * whichever of the two lists it is handed, as long as those clips were adopted. That is the
   * property that makes the fallback safe rather than merely non-empty.
   */
  it("pairs by adoption record, so either source works", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/scene_0_a.mp4", "/w/scene_0_b.mp4"],
      // The record keys on the BASENAME — that is what survives a clip being moved or re-tagged.
      adoptions: [
        { beatIndex: 0, basename: "scene_0_b.mp4" },
        { beatIndex: 1, basename: "scene_0_a.mp4" },
      ],
      beats: [beat(0), beat(1)],
      basenameOf: (p: string) => path.basename(p),
    });
    // Not positional: beat 0 took the SECOND path because that is what the record says.
    expect(paired[0]).toBe("/w/scene_0_b.mp4");
    expect(paired[1]).toBe("/w/scene_0_a.mp4");
  });

  it("an empty clip list still produces no clip rather than throwing", () => {
    const paired = pairClipsToBeats({
      clipPaths: [],
      adoptions: [],
      beats: [beat(0)],
      basenameOf: (p: string) => path.basename(p),
    });
    expect(paired[0] ?? null).toBeNull();
  });
});
