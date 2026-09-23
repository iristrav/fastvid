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
  it("reads both sources, so an absent compose stage cannot empty the plan", () => {
    const src = pipeline();
    expect(src).toContain("const composedForScene = composedUsedClips[i] ?? [];");
    /**
     * The preference was first hoisted into two named values so the round that made the choice
     * MEASURABLE — [CinematicSourceDecision] and [CinematicSourceDivergence] — could report both
     * sides by name. RONDE 632 then acted on what they measured. Both values are still read; what
     * changed is that neither one is discarded.
     */
    expect(src).toContain("const canonicalForScene = sceneVisualResults[i]?.clips ?? [];");
    expect(src).toContain("const usingCompose = composedForScene.length > 0;");
    expect(src).toContain("clipPaths: plannerSource.clipPaths,");
  });

  /**
   * THIS TEST HAS NOW BEEN REWRITTEN TWICE, AND BOTH TIMES THE REASON SURVIVED THE MECHANISM.
   *
   * What stood here originally was "the composed list wins whenever it exists", with the reason:
   * compose's list "has had unusable files filtered out of it by the compose stage's own
   * existence/decodability check. The selected set has not. Preferring the weaker source would be
   * a quiet downgrade."
   *
   * RONDE 632 kept that reason and moved the mechanism: run compose's predicate directly over the
   * adopted set. RONDE 636 then measured that on render 602 — the predicate reads the filesystem,
   * it was running one stage after compose had consumed its intermediates, and it refused
   * THIRTEEN OF THIRTEEN adopted clips across three scenes while compose had kept twelve of those
   * same files minutes earlier. The render stored no plan at all.
   *
   * The reason still survives, and it is now served where it always could have been: the planner
   * makes these checks itself, at the only moment they are current. So what this asserts is that
   * the planner's own refusals are wired and that no second copy of them has grown back in the
   * assembly.
   */
  it("still lets nothing past that the planner's own checks reject", () => {
    const src = pipeline();
    const at = src.indexOf("const plannerSource = plannerClipsForScene({");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("});", at));
    // Both sources go in, named as they always were.
    expect(call).toContain("canonical: canonicalForScene,");
    expect(call).toContain("composed: composedForScene,");
    // And no usability opinion is formed here — that is the RONDE 636 correction.
    expect(call).not.toContain("usableOnly");
    // The planner's own refusals are still what removes a clip.
    expect(src).toContain("placeholdersRefusedFromTimeline");
    expect(src).toContain("beatClipIsPlaceholder");
    // And compose still runs the predicate where it holds the files.
    expect(src).toContain("usableSurvivorClips(sceneVisualResults[i]?.clips ?? [])");
  });

  /**
   * The same preference stage 5's critical review already makes. Two places choosing between the
   * same two sources by different rules is the seam this codebase keeps rediscovering.
   */
  it("uses the same preference the critical review already used", () => {
    /**
     * RENDER 574 made this stronger than the assertion that stood here.
     *
     * It pinned the critical review's INLINE copy of the preference — which was the third of four
     * hand-written copies, and the fourth reader (`buildEditorScenesFromPipeline`) had none at all,
     * so a scene that composed nothing reached the editor empty. There is one rule now, named
     * once, and every reader that can fall back reads it. That is what this test was protecting;
     * the literal was only where it happened to live.
     */
    const src = pipeline();
    expect(src).toContain("const clipsForScene = (i: number): string[] =>");
    expect(src).toContain("composedUsedClips[i] ?? []");
    expect(src).toContain("sceneVisualResults[i]?.clips ?? []");
    expect(src).toContain("const clipsToReview = clipsForScene(i);");
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
