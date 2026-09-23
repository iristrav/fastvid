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
 * ── The trap in the obvious fix ─────────────────────────────────────────────────────────────
 *
 * Reading `canonicalForScene` unconditionally is wrong, and the reason is in the file's own
 * comment: "the composed list is more accurate: it has had unusable files filtered out of it".
 * Compose drops files that are missing, empty, not valid video, or cards this pipeline drew.
 * Flipping the ternary hands those straight back to the planner — the "accept worse pictures"
 * trade this codebase refuses everywhere else.
 *
 * ── The distinction the fix rests on ────────────────────────────────────────────────────────
 *
 *     compose REJECTED this file   → not usable media    → it stays out
 *     compose is MISSING this file → compose selected    → it goes to the planner
 *
 * Those were never the same fact. Only the first may remove an adopted clip, and it is
 * established by running compose's OWN predicate, not by asking whether compose's output happens
 * to mention the file.
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

/** A usability predicate that refuses exactly the files it is told to refuse, and nothing else. */
const refusing = (rejected: readonly string[]) => async (clips: readonly string[]) =>
  clips.filter((c) => !rejected.includes(c));
/** The healthy case: compose's predicate passes everything it is given. */
const acceptsAll = async (clips: readonly string[]) => [...clips];

const scene = (over: Partial<Parameters<typeof plannerClipsForScene>[0]>) =>
  plannerClipsForScene({
    canonical: [],
    composed: [],
    usableOnly: acceptsAll,
    basenameOf: basename,
    ...over,
  });

/* ═══════════ §1 — an adopted clip survives a montage that did not use it ═══════════ */

describe("§1 — compose's selection no longer decides what the planner can see", () => {
  it("AN ADOPTED CLIP COMPOSE LEFT OUT REACHES THE PLANNER", async () => {
    const source = await scene({
      canonical: ["/w/yt_o6bV1XdXMdc.mp4", "/w/archive_57387.mp4"],
      composed: ["/w/archive_57387.mp4"],
    });
    expect(source.clipPaths).toContain("/w/yt_o6bV1XdXMdc.mp4");
    expect(source.canonicalAvailableToPlanner).toBe(2);
    expect(source.canonicalExcludedByCompose).toBe(0);
  });

  it("and render 600's whole scene 2 survives: two adopted YouTube clips, neither composed", async () => {
    const source = await scene({
      canonical: ["/w/yt_6XnsYZxH2nI.mp4", "/w/yt_-Mr4mbLZRbE.mp4", "/w/ia_fy3NVwcDD5g.mp4"],
      composed: ["/w/ia_fy3NVwcDD5g.mp4"],
    });
    expect(source.clipPaths).toEqual([
      "/w/yt_6XnsYZxH2nI.mp4",
      "/w/yt_-Mr4mbLZRbE.mp4",
      "/w/ia_fy3NVwcDD5g.mp4",
    ]);
  });

  it("the canonical set leads the list, so an adopted clip outranks compose on a shared beat", async () => {
    const source = await scene({
      canonical: ["/w/adopted.mp4"],
      composed: ["/w/compose_only.mp4"],
    });
    expect(source.clipPaths[0]).toBe("/w/adopted.mp4");
  });
});

/* ═══════════ §2 — a real rejection still removes a clip ═══════════ */

describe("§2 — compose's usability predicate is still obeyed", () => {
  it("A CLIP THE PREDICATE REFUSES DOES NOT REACH THE PLANNER", async () => {
    const source = await scene({
      canonical: ["/w/good.mp4", "/w/zero_bytes.mp4"],
      composed: ["/w/good.mp4"],
      usableOnly: refusing(["/w/zero_bytes.mp4"]),
    });
    expect(source.clipPaths).toEqual(["/w/good.mp4"]);
    expect(source.canonicalExcludedByCompose).toBe(1);
    expect(source.excluded).toEqual(["/w/zero_bytes.mp4"]);
  });

  it("and it cannot come back in through compose's list under the same name", async () => {
    const source = await scene({
      canonical: ["/w/zero_bytes.mp4"],
      composed: ["/w/zero_bytes.mp4"],
      usableOnly: refusing(["/w/zero_bytes.mp4"]),
    });
    expect(source.clipPaths).toEqual([]);
    expect(source.composeOnly).toEqual([]);
  });

  it("a card this pipeline drew is refused by the same predicate compose applies", async () => {
    const source = await scene({
      canonical: ["/w/scene_0_slot101_guaranteed.mp4", "/w/real.mp4"],
      usableOnly: refusing(["/w/scene_0_slot101_guaranteed.mp4"]),
    });
    expect(source.clipPaths).toEqual(["/w/real.mp4"]);
  });
});

/* ═══════════ §3 — the two facts are not the same fact ═══════════ */

describe("§3 — COMPOSE MISSING is not a rejection", () => {
  it("ABSENCE FROM COMPOSE COUNTS AS NO EXCLUSION AT ALL", async () => {
    const source = await scene({
      canonical: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4"],
      composed: [],
    });
    expect(source.canonicalExcludedByCompose).toBe(0);
    expect(source.canonicalAvailableToPlanner).toBe(3);
    expect(source.clipPaths).toHaveLength(3);
  });

  it("only the predicate's verdict is counted as an exclusion, never the diff against compose", async () => {
    const source = await scene({
      canonical: ["/w/missing_from_compose.mp4", "/w/broken.mp4"],
      composed: ["/w/something_else.mp4"],
      usableOnly: refusing(["/w/broken.mp4"]),
    });
    expect(source.excluded).toEqual(["/w/broken.mp4"]);
    expect(source.canonicalExcludedByCompose).toBe(1);
    expect(source.clipPaths).toContain("/w/missing_from_compose.mp4");
  });

  it("nothing compose found is lost either — a compose-only file is carried, not dropped", async () => {
    const source = await scene({
      canonical: ["/w/adopted.mp4"],
      composed: ["/w/adopted.mp4", "/w/rescue_extra.mp4"],
    });
    expect(source.composeOnly).toEqual(["/w/rescue_extra.mp4"]);
    expect(source.clipPaths).toEqual(["/w/adopted.mp4", "/w/rescue_extra.mp4"]);
  });

  it("and a scene with neither source is empty rather than invented", async () => {
    const source = await scene({});
    expect(source.clipPaths).toEqual([]);
    expect(source.canonicalCount).toBe(0);
    expect(source.composeCount).toBe(0);
  });
});

/* ═══════════ §4 — a longer list cannot double-book a beat ═══════════ */

describe("§4 — the merge and pairClipsToBeats compose safely", () => {
  it("A COMPOSE ENTRY CANNOT TAKE A BEAT THE ADOPTED CLIP ALREADY HOLDS", async () => {
    const source = await scene({
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

  it("and a compose entry DOES fill a beat the adopted set left empty", async () => {
    const source = await scene({
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

  it("the render-600 shape end to end: four adopted YouTube beats keep their own pictures", async () => {
    const source = await scene({
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
  });

  it("production runs compose's REAL predicate, not a restatement of it", () => {
    expect(PIPE).toContain("usableOnly: (clips) => usableSurvivorClips(clips),");
  });

  it("the merge is built where it can await, ahead of the synchronous scene assembly", () => {
    const built = PIPE.indexOf("plannerSourceByScene.set(scene.index, source);");
    const used = PIPE.indexOf("plannerSourceByScene.get(scene.index)");
    expect(built).toBeGreaterThan(-1);
    expect(used).toBeGreaterThan(built);
  });
});

/* ═══════════ §6 — an exclusion is never silent ═══════════ */

describe("§6 — what the render says about a clip that did not make it", () => {
  it("THE COUNTS THAT LET A RENDER CHECK THIS ARE ALL REPORTED", () => {
    const at = PIPE.indexOf("[CinematicPlannerSource] scene=");
    expect(at).toBeGreaterThan(-1);
    const line = PIPE.slice(at, at + 500);
    for (const field of [
      "canonicalCount=",
      "composeCount=",
      "canonicalExcludedByCompose=",
      "canonicalAvailableToPlanner=",
      "composeOnlyAdded=",
    ]) {
      expect(line).toContain(field);
    }
  });

  it("each excluded adopted clip is named with its provider and its reason", () => {
    expect(PIPE).toContain("excluded=UNUSABLE_MEDIA file=");
    expect(PIPE).toContain("for (const p of source.excluded.slice(0, 10)) {");
  });

  it("and the beat reasons say which of the three things happened", () => {
    for (const reason of [
      "CANONICAL_CLIP_AVAILABLE",
      "CANONICAL_CLIP_EXCLUDED",
      "NO_CANONICAL_CLIP",
    ]) {
      expect(PIPE).toContain(reason);
    }
    expect(PIPE).toContain("[CinematicPlannerBeat] scene=");
  });
});

/* ═══════════ §7 — nothing was loosened to achieve this ═══════════ */

describe("§7 — the fix removes a loss, it does not admit anything new", () => {
  it("THE ONLY EXCLUSION IS THE PREDICATE'S, AND IT IS INJECTED, NOT REIMPLEMENTED", () => {
    const fn = INPUTS.slice(
      INPUTS.indexOf("export async function plannerClipsForScene"),
      INPUTS.indexOf("WHICH CLIP BELONGS TO WHICH BEAT")
    );
    expect(fn).toContain("await params.usableOnly(canonical)");
    /* No second opinion about usability lives in here: no stat, no size test, no name rule. */
    for (const smell of ["existsSync", "statSync", "isValidVideoFile", "isPipelineFallbackClip"]) {
      expect(fn).not.toContain(smell);
    }
  });

  it("and compose's own filtered list is still what the divergence report compares against", () => {
    expect(PIPE).toContain("[CinematicSourceDivergence] scene=");
  });
});
