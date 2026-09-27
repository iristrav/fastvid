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
import {
  pairClipsToBeats,
} from "./cinematicPipelineInputs";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const INPUTS = readFileSync(join(__dirname, "cinematicPipelineInputs.ts"), "utf8");

const scene = (over: Partial<Parameters<typeof plannerClipsForScene>[0]>) =>
  plannerClipsForScene({
    canonical: [],
    composed: [],
    basenameOf: basename,
    ...over,
  });

/* ═══════════ §2 — render 602: nothing is filtered out here ═══════════ */

describe("§2 — the adopted set is assembled, not judged", () => {

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

/* ═══════════ §5 — the wiring, and the line that is gone ═══════════ */

describe("§5 — the pipeline reads the merge, not one of two lists", () => {
  it("THE TERNARY THAT CHOSE COMPOSE OVER THE ADOPTED SET IS GONE", () => {
    expect(PIPE).not.toContain("usingCompose ? composedForScene : canonicalForScene");
  });
});

/* ═══════════ §6 — the counts a render is read by ═══════════ */

describe("§6 — what the render says about the planner's input", () => {

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
});
