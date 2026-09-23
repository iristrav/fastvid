/**
 * AN ADOPTED CLIP IS NOT LOST TO A MONTAGE — RONDE 632.
 *
 * ── One line, and everything the planner never saw ──────────────────────────────────────────
 *
 *     clipPaths: usingCompose ? composedForScene : canonicalForScene
 *
 * `composedForScene` is what the LEGACY compose montage used. `canonicalForScene` is what
 * retrieval ADOPTED. The moment compose produced a single clip, the cinematic planner read
 * compose's list and the adopted set became invisible to it.
 *
 * Render 600 adopted four YouTube clips — the first this pipeline has ever carried to
 * `status=ASSIGNED` on beat level:
 *
 *     o6bV1XdXMdc (s0b0)   6XnsYZxH2nI (s2b1)   -Mr4mbLZRbE (s2b1)   FJ3N_2r6R-o (s2b2)
 *
 * None of them reached the film. `[CinematicPipeline] decisions=4 clips=4`, all four
 * `fromArchive`. The editor did not prefer other pictures; it was handed four and planned four.
 *
 * ── The trap in the obvious fix, and where it really lay ───────────────────────────────────
 *
 * Reading `canonicalForScene` unconditionally looked wrong, and the reason was in the file's own
 * comment: "the composed list is more accurate: it has had unusable files filtered out of it".
 * So the first fix ran compose's own predicate (`usableSurvivorClips`) over the adopted clips.
 *
 * RONDE 636 removed that, because render 602 measured what it cost:
 *
 *     scene=0 canonicalCount=4 canonicalExcludedByCompose=4 canonicalAvailableToPlanner=0
 *     scene=1 canonicalCount=5 canonicalExcludedByCompose=5 canonicalAvailableToPlanner=0
 *     scene=2 canonicalCount=4 canonicalExcludedByCompose=4 canonicalAvailableToPlanner=0
 *     [CinematicPipeline] video=602 plan NOT stored code=CINEMATIC_NO_PLANNABLE_BEATS
 *
 * Thirteen of thirteen, every scene. A uniform total loss is never a judgement about content —
 * and the same render holds the proof of what it really was: compose delivered TWELVE clips from
 * those same files, with that same function. Compose's call kept 12; this one kept 0.
 *
 * Same function, same files, same render, a different moment. The predicate reads the filesystem,
 * and the planner's inputs are assembled after compose has consumed its intermediates.
 *
 * It was also a SECOND COPY of checks the planner already makes at the only moment they are
 * current — §10's placeholder refusal, `localOnlyIdentityFor`'s exists-and-has-bytes, the
 * rehydratability check, the duration check. Those are strictly better than the probe: a file
 * this render no longer holds but can re-fetch is kept and re-fetched, where the probe killed it.
 *
 * So this function assembles and does not judge.
 *
 * ── Why a longer list is safe ───────────────────────────────────────────────────────────────
 *
 * `pairClipsToBeats` keeps the FIRST clip per beat and skips every later one, and skips any clip
 * the adoption audit does not name. A longer list can only fill beats that were empty. Canonical
 * goes first so that where both sources speak for a beat, the clip the render adopted for it
 * wins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join, basename } from "path";
import { plannerClipsForScene, pairClipsToBeats } from "./cinematicPipelineInputs";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const INPUTS = readFileSync(join(__dirname, "cinematicPipelineInputs.ts"), "utf8");

const scene = (over: Partial<Parameters<typeof plannerClipsForScene>[0]>) =>
  plannerClipsForScene({
    canonical: [],
    composed: [],
    basenameOf: basename,
    ...over,
  });

/* ═══════════ §1 — an adopted clip survives a montage that did not use it ═══════════ */

describe("§1 — compose's selection no longer decides what the planner can see", () => {
  it("AN ADOPTED CLIP COMPOSE LEFT OUT REACHES THE PLANNER", () => {
    const source = scene({
      canonical: ["/w/yt_o6bV1XdXMdc.mp4", "/w/archive_57387.mp4"],
      composed: ["/w/archive_57387.mp4"],
    });
    expect(source.clipPaths).toContain("/w/yt_o6bV1XdXMdc.mp4");
    expect(source.canonicalAvailableToPlanner).toBe(2);
    expect(source.canonicalNotInCompose).toBe(1);
  });

  it("and render 600's whole scene 2 survives: two adopted YouTube clips, neither composed", () => {
    const source = scene({
      canonical: ["/w/yt_6XnsYZxH2nI.mp4", "/w/yt_-Mr4mbLZRbE.mp4", "/w/ia_fy3NVwcDD5g.mp4"],
      composed: ["/w/ia_fy3NVwcDD5g.mp4"],
    });
    expect(source.clipPaths).toEqual([
      "/w/yt_6XnsYZxH2nI.mp4",
      "/w/yt_-Mr4mbLZRbE.mp4",
      "/w/ia_fy3NVwcDD5g.mp4",
    ]);
  });

  it("the canonical set leads the list, so an adopted clip outranks compose on a shared beat", () => {
    const source = scene({
      canonical: ["/w/adopted.mp4"],
      composed: ["/w/compose_only.mp4"],
    });
    expect(source.clipPaths[0]).toBe("/w/adopted.mp4");
  });
});

/* ═══════════ §2 — render 602: nothing is filtered out here ═══════════ */

describe("§2 — the adopted set is assembled, not judged", () => {
  /**
   * RENDER 602 IS THIS SECTION'S WHOLE REASON, AND IT REPLACES THE OPPOSITE ASSERTION.
   *
   * What stood here required the mistimed probe: "A CLIP THE PREDICATE REFUSES DOES NOT REACH THE
   * PLANNER". The probe refused thirteen of thirteen adopted clips across three scenes and the
   * render stored no plan at all, while compose kept twelve of those same files with that same
   * function minutes earlier. The property was never wrong; running it here was.
   */
  it("EVERY ADOPTED CLIP REACHES THE PLANNER, WHATEVER COMPOSE DID WITH IT", () => {
    const source = scene({
      canonical: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4", "/w/d.mp4"],
      composed: ["/w/a.mp4"],
    });
    expect(source.canonicalAvailableToPlanner).toBe(4);
    expect(source.clipPaths).toHaveLength(4);
  });

  it("render 602's scene 2 would now reach the planner with all four", () => {
    const source = scene({
      canonical: [
        "/w/scene_2_b0_curated_a57797_still.mp4",
        "/w/scene_2_slot1_guaranteed.mp4",
        "/w/scene_2_slot2_guaranteed.mp4",
        "/w/scene_2_guaranteed_wiki_s103.mp4",
      ],
      composed: [
        "/w/scene_2_b0_curated_a57797_still.mp4",
        "/w/scene_2_slot1_guaranteed.mp4",
        "/w/scene_2_slot2_guaranteed.mp4",
        "/w/scene_2_guaranteed_wiki_s103.mp4",
      ],
    });
    expect(source.canonicalAvailableToPlanner).toBe(4);
    expect(source.composeOnly).toEqual([]);
  });

  it("A CARD THIS PIPELINE DREW IS STILL REFUSED — BY THE PLANNER, WHERE THE CHECK BELONGS", () => {
    /**
     * The placeholder refusal is §10's, in videoPipeline, applied to what the planner receives.
     * Removing the probe did not remove it, and this pins that it is still wired.
     */
    expect(PIPE).toContain("placeholdersRefusedFromTimeline");
    expect(PIPE).toContain("beatClipIsPlaceholder");
  });

  it("and this function holds no usability opinion of its own at all", () => {
    const fn = INPUTS.slice(
      INPUTS.indexOf("export function plannerClipsForScene"),
      INPUTS.indexOf("WHICH CLIP BELONGS TO WHICH BEAT")
    );
    for (const smell of [
      "usableOnly",
      "existsSync",
      "statSync",
      "isValidVideoFile",
      "isPipelineFallbackClip",
      "await",
    ]) {
      expect(fn).not.toContain(smell);
    }
  });
});

/* ═══════════ §3 — what the counts mean now ═══════════ */

describe("§3 — COMPOSE MISSING is reported and removes nothing", () => {
  it("ABSENCE FROM COMPOSE IS COUNTED, AND COSTS THE CLIP NOTHING", () => {
    const source = scene({
      canonical: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4"],
      composed: [],
    });
    expect(source.canonicalNotInCompose).toBe(3);
    expect(source.canonicalAvailableToPlanner).toBe(3);
    expect(source.clipPaths).toHaveLength(3);
  });

  it("the two counts move independently, so a render can read them apart", () => {
    const source = scene({
      canonical: ["/w/in_compose.mp4", "/w/not_in_compose.mp4"],
      composed: ["/w/in_compose.mp4", "/w/rescue_extra.mp4"],
    });
    expect(source.canonicalCount).toBe(2);
    expect(source.composeCount).toBe(2);
    expect(source.canonicalNotInCompose).toBe(1);
    expect(source.canonicalAvailableToPlanner).toBe(2);
  });

  it("nothing compose found is lost either — a compose-only file is carried, not dropped", () => {
    const source = scene({
      canonical: ["/w/adopted.mp4"],
      composed: ["/w/adopted.mp4", "/w/rescue_extra.mp4"],
    });
    expect(source.composeOnly).toEqual(["/w/rescue_extra.mp4"]);
    expect(source.clipPaths).toEqual(["/w/adopted.mp4", "/w/rescue_extra.mp4"]);
  });

  it("and a scene with neither source is empty rather than invented", () => {
    const source = scene({});
    expect(source.clipPaths).toEqual([]);
    expect(source.canonicalCount).toBe(0);
    expect(source.composeCount).toBe(0);
  });
});

/* ═══════════ §4 — a longer list cannot double-book a beat ═══════════ */

describe("§4 — the merge and pairClipsToBeats compose safely", () => {
  it("A COMPOSE ENTRY CANNOT TAKE A BEAT THE ADOPTED CLIP ALREADY HOLDS", () => {
    const source = scene({
      canonical: ["/w/adopted_b0.mp4"],
      composed: ["/w/compose_b0.mp4"],
    });
    const pairs = pairClipsToBeats({
      clipPaths: source.clipPaths,
      adoptions: [
        { beatIndex: 0, basename: "adopted_b0.mp4" },
        { beatIndex: 0, basename: "compose_b0.mp4" },
      ],
      beats: [{ index: 0 }],
      basenameOf: basename,
    });
    expect(pairs).toEqual(["/w/adopted_b0.mp4"]);
  });

  it("and a compose entry DOES fill a beat the adopted set left empty", () => {
    const source = scene({
      canonical: ["/w/adopted_b0.mp4"],
      composed: ["/w/compose_b1.mp4"],
    });
    const pairs = pairClipsToBeats({
      clipPaths: source.clipPaths,
      adoptions: [
        { beatIndex: 0, basename: "adopted_b0.mp4" },
        { beatIndex: 1, basename: "compose_b1.mp4" },
      ],
      beats: [{ index: 0 }, { index: 1 }],
      basenameOf: basename,
    });
    expect(pairs).toEqual(["/w/adopted_b0.mp4", "/w/compose_b1.mp4"]);
  });

  it("the render-600 shape end to end: four adopted YouTube beats keep their own pictures", () => {
    const source = scene({
      canonical: ["/w/yt_a.mp4", "/w/yt_b.mp4", "/w/yt_c.mp4", "/w/yt_d.mp4"],
      composed: ["/w/archive_only.mp4"],
    });
    const pairs = pairClipsToBeats({
      clipPaths: source.clipPaths,
      adoptions: [
        { beatIndex: 0, basename: "yt_a.mp4" },
        { beatIndex: 1, basename: "yt_b.mp4" },
        { beatIndex: 2, basename: "yt_c.mp4" },
        { beatIndex: 3, basename: "yt_d.mp4" },
      ],
      beats: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
      basenameOf: basename,
    });
    expect(pairs).toEqual(["/w/yt_a.mp4", "/w/yt_b.mp4", "/w/yt_c.mp4", "/w/yt_d.mp4"]);
  });
});

/* ═══════════ §5 — the wiring, and the line that is gone ═══════════ */

describe("§5 — the pipeline reads the merge, not one of two lists", () => {
  it("THE TERNARY THAT CHOSE COMPOSE OVER THE ADOPTED SET IS GONE", () => {
    expect(PIPE).not.toContain("usingCompose ? composedForScene : canonicalForScene");
  });

  it("and the planner is fed the merge", () => {
    expect(PIPE).toContain("clipPaths: plannerSource.clipPaths,");
    expect(PIPE).toContain("const plannerSource = plannerClipsForScene({");
  });

  it("THE MISTIMED PROBE IS GONE FROM THE PLANNER'S ASSEMBLY", () => {
    /**
     * Render 602: `usableOnly: (clips) => usableSurvivorClips(clips)` ran one stage too late and
     * refused every adopted clip in the render. `usableSurvivorClips` itself is untouched and
     * still runs where it always did — inside compose, on files compose is holding.
     */
    expect(PIPE).not.toContain("usableOnly:");
    expect(PIPE).toContain("usableSurvivorClips(sceneVisualResults[i]?.clips ?? [])");
  });

  it("and the assembly needs no await, so it sits with the rest of the scene", () => {
    const at = PIPE.indexOf("const plannerSource = plannerClipsForScene({");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, PIPE.indexOf("});", at))).not.toContain("await");
  });
});

/* ═══════════ §6 — the counts a render is read by ═══════════ */

describe("§6 — what the render says about the planner's input", () => {
  it("THE COUNTS THAT LET A RENDER CHECK THIS ARE ALL REPORTED", () => {
    const at = PIPE.indexOf("[CinematicPlannerSource] scene=");
    expect(at).toBeGreaterThan(-1);
    const line = PIPE.slice(at, at + 500);
    for (const field of [
      "canonicalCount=",
      "composeCount=",
      "canonicalNotInCompose=",
      "canonicalAvailableToPlanner=",
      "composeOnlyAdded=",
    ]) {
      expect(line).toContain(field);
    }
  });

  it("the counter that named an exclusion is gone with the exclusion", () => {
    expect(PIPE).not.toContain("canonicalExcludedByCompose");
    expect(PIPE).not.toContain("excluded=UNUSABLE_MEDIA");
  });

  it("and each beat says whether its adopted clip reached the planner", () => {
    for (const reason of ["CANONICAL_CLIP_AVAILABLE", "NO_CANONICAL_CLIP"]) {
      expect(PIPE).toContain(reason);
    }
    expect(PIPE).toContain("[CinematicPlannerBeat] scene=");
    /**
     * The third reason existed only for the probe and went with it. The prose still names it —
     * that is the record of what was removed — so the check is that nothing EMITS it: the reason
     * is one ternary with exactly two outcomes.
     */
    expect(PIPE).toContain(
      '`reason=${clipPath ? "CANONICAL_CLIP_AVAILABLE" : "NO_CANONICAL_CLIP"}`'
    );
    expect(PIPE).not.toContain('"CANONICAL_CLIP_EXCLUDED"');
  });
});

/* ═══════════ §7 — nothing was loosened to achieve this ═══════════ */

describe("§7 — the decisions stay with the code that was already making them", () => {
  it("THE PLANNER'S OWN CHECKS ARE STILL THE ONES THAT REFUSE A CLIP", () => {
    const INPUTS_ALL = INPUTS;
    for (const reason of ["NO_ADOPTED_CLIP", "NOT_REHYDRATABLE", "SCENE_TIME_EXHAUSTED", "NO_DURATION"]) {
      expect(INPUTS_ALL).toContain(reason);
    }
  });

  it("and compose's own filtered list is still what the divergence report compares against", () => {
    expect(PIPE).toContain("[CinematicSourceDivergence] scene=");
  });
});
