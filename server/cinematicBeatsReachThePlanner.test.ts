/**
 * THE CINEMATIC PLANNER WAS HANDED ZERO BEATS ON EVERY PRODUCTION RENDER.
 *
 * ── What render 562 logged ──────────────────────────────────────────────────────────────────
 *
 *     [CinematicPipeline] inputs scenes=0 beats=0 planned=0 probed=0 trimmed=0 dropped=3
 *     [CinematicPipeline] dropped scene 0: no beat could be planned, the scene is not in the edit
 *     [CinematicPipeline] dropped scene 1: no beat could be planned, the scene is not in the edit
 *     [CinematicPipeline] dropped scene 2: no beat could be planned, the scene is not in the edit
 *     [CinematicPipeline] video=562 plan NOT stored code=CINEMATIC_NO_PLANNABLE_BEATS
 *       reason=no scene had a beat with both a voice window and a rehydratable clip
 *     [RenderJob] video=562 route=legacy_compose RENDER_FALLBACK_USED
 *
 * The flags were on. The render adopted ten clips. And the plan was empty.
 *
 * ── Reading the number that matters ─────────────────────────────────────────────────────────
 *
 * `beats=0`. That counter increments once per beat the adapter is HANDED, before any check runs,
 * so the adapter was handed none. Not one beat failed for want of a voice window or a rehydratable
 * identity — the stated reason described a comparison that never happened. Three scenes in, three
 * scene-level drops out, and nothing in between.
 *
 * ── Where they went ─────────────────────────────────────────────────────────────────────────
 *
 * They travelled on `sceneVisualResults[i].beats`, an OPTIONAL field on a record fourteen places
 * reassign. Several rebuild it from scratch — `sceneVisualResults[si] = { clips, beatDurations }` —
 * and each of those silently drops the beat list. Render 562's LAST write for all three scenes was
 * the cheapest of them:
 *
 *     [Pipeline] Scene 0: strict refill already attempted this render — guaranteed fill instead
 *     [Pipeline] Scene 1: strict refill already attempted this render — guaranteed fill instead
 *     [Pipeline] Scene 2: strict refill already attempted this render — guaranteed fill instead
 *
 * That branch of `refillSceneStrictVoiceMatch` returns `{ clips, beatDurations }` and returns
 * before the beats are resolved at all.
 *
 * ── What this cost ──────────────────────────────────────────────────────────────────────────
 *
 * Every downstream stage. No plan means no EDL, and no EDL means no graphics, no captions, no SFX
 * and no Remotion — none of which appear anywhere in that render's log. The whole cinematic half of
 * the product was dark for one missing field.
 *
 * ── The fix these tests protect ─────────────────────────────────────────────────────────────
 *
 * A scene's beats are a fact about its NARRATION, not about any one clip list, so they are recorded
 * once — in `applyVoiceAlignmentToBeats`, the one function every beat-resolving route calls — and
 * read from there. A rule fourteen assignment sites must remember is the seam that has already
 * failed three times in this file (R53, R62, R70: one caller each, zero for every other route).
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { buildCinematicSceneInputs, pairClipsToBeats } from "./cinematicPipelineInputs";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
/** Comments quote the defect; every claim below is about executable code. */
const CODE = PIPE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/* ═══════════════════════ the record nothing can rebuild away ═══════════════════════ */

describe("a scene's beats survive a clip-list rebuild", () => {
  /** Without the store there is nowhere for the beats to be that a rebuild does not reach. */
  it("the render keeps a beat record keyed by scene", () => {
    expect(CODE, "VisualDedupState has no per-scene beat record").toMatch(
      /sceneBeatsBySceneIndex:\s*Map<number,\s*SceneBeat\[\]>/
    );
    expect(CODE, "the beat record is never initialised").toContain(
      "sceneBeatsBySceneIndex: new Map()"
    );
  });

  /**
   * ONE writer. The whole point of the store is that it cannot be forgotten by a route, so a
   * second write site would mean a route is maintaining it by hand again.
   */
  it("exactly one place writes it, and it is the alignment function", () => {
    const writes = [...CODE.matchAll(/sceneBeatsBySceneIndex\.set\(/g)];
    expect(writes, "the beat record is written from more than one place").toHaveLength(1);

    const fn = CODE.indexOf("async function applyVoiceAlignmentToBeats(");
    expect(fn, "applyVoiceAlignmentToBeats has moved").toBeGreaterThan(-1);
    const body = CODE.slice(fn, CODE.indexOf("\n}", fn));
    expect(body, "the record is not written by the function every route calls").toContain(
      "sceneBeatsBySceneIndex.set("
    );
  });

  /**
   * BEFORE the early returns. Both of them fire for a scene whose beats came word-timed from the
   * TTS planner — beats it definitely has — and returning first would lose exactly those.
   */
  it("records the beats before it can decide alignment is unnecessary", () => {
    const fn = CODE.indexOf("async function applyVoiceAlignmentToBeats(");
    const body = CODE.slice(fn, CODE.indexOf("\n}", fn));
    const write = body.indexOf("sceneBeatsBySceneIndex.set(");
    const firstReturn = body.indexOf("return;");
    expect(firstReturn, "the early returns are gone — this test is asserting nothing").toBeGreaterThan(-1);
    expect(
      write,
      "the beats are recorded after an early return, so a word-timed scene records nothing"
    ).toBeLessThan(firstReturn);
  });

  /** Nothing may empty it mid-render: a scene's narration does not change because a clip did. */
  it("nothing clears or deletes the record", () => {
    for (const forbidden of ["sceneBeatsBySceneIndex.clear(", "sceneBeatsBySceneIndex.delete("]) {
      expect(CODE, `${forbidden} — a rebuild can erase the beats again`).not.toContain(forbidden);
    }
  });
});

/* ═══════════════════════ the planner reads the record ═══════════════════════ */

describe("the cinematic planner asks the render, not the clip list", () => {
  it("reads the beat record first and keeps the old read as a fallback", () => {
    const at = CODE.indexOf("planAndStoreCinematicTimeline({");
    expect(at, "the cinematic plan call has moved").toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 2500);
    expect(block, "the planner still takes its beats only from the clip list").toContain(
      "visualDedup.sceneBeatsBySceneIndex.get(scene.index)"
    );
    /** Keyed by the scene's own index, which is what the writer uses — not the array position. */
    expect(block, "the record is read by array position, not by scene index").not.toMatch(
      /sceneBeatsBySceneIndex\.get\(i\)/
    );
    expect(block, "the previous source was dropped rather than demoted").toContain(
      "sceneVisualResults[i]?.beats"
    );
  });

  /** The route that broke it must still be a rebuild — this round did not repair it by hand. */
  it("the branch that lost them is unchanged", () => {
    expect(
      CODE,
      "the 'strict refill already attempted' branch was altered; the fix is meant to make its " +
        "return shape irrelevant, not to patch one route"
    ).toContain("strict refill already attempted this render");
  });
});

/* ═══════════════════════ what the adapter does with what it is handed ═══════════════════════ */

const SCENE = { index: 0, text: "s", duration: 12, visualQuery: "", narration: "" } as never;

function sceneFacts(beatCount: number, clipFor: (b: number) => string | null) {
  return {
    scene: SCENE,
    beats: Array.from({ length: beatCount }, (_, index) => ({
      index,
      text: `beat ${index}`,
      searchQuery: "q",
      powerWord: "w",
      keywords: [],
      holdSec: 3,
      voiceStartSec: index * 3,
      voiceEndSec: index * 3 + 3,
    })),
    clips: Array.from({ length: beatCount }, (_, index) => {
      const localPath = clipFor(index);
      return localPath
        ? {
            facts: { localPath, durationSec: 4 },
            adoption: {
              provider: "internet_archive",
              providerAssetId: `ia-${index}`,
              archiveAssetId: null,
              sourceUrl: "https://archive.org/x",
              originalUrl: null,
              assetTitle: "t",
              query: "q",
              candidateId: `c${index}`,
              sourceInSec: null,
              sourceOutSec: null,
            },
          }
        : null;
    }),
  } as never;
}

describe("the adapter counts what it is handed", () => {
  /**
   * Render 562's shape exactly: scenes present, beats absent. The reason line blames a per-beat
   * comparison, and `beats=0` is the counter that shows it never ran.
   */
  it("an empty beat list produces beats=0 and a scene-level drop, not a per-beat one", () => {
    const built = buildCinematicSceneInputs({
      scenes: [{ scene: SCENE, beats: [], clips: [] } as never],
    });
    expect(built.stats.beats, "a beat was counted where none was handed over").toBe(0);
    expect(built.scenes).toHaveLength(0);
    expect(built.dropped).toEqual(["scene 0: no beat could be planned, the scene is not in the edit"]);
    expect(
      built.dropped.join(" "),
      "an empty scene reported a per-beat reason it never evaluated"
    ).not.toMatch(/voice window|rehydratable/);
  });

  /** And the same scene, once its beats arrive, plans. This is what 562 should have produced. */
  it("the same scene plans as soon as its beats arrive", () => {
    const built = buildCinematicSceneInputs({
      scenes: [sceneFacts(3, (b) => `/w/clip${b}.mp4`)],
    });
    expect(built.stats.beats).toBe(3);
    expect(built.stats.planned).toBe(3);
    expect(built.scenes).toHaveLength(1);
    expect(built.dropped).toEqual([]);
  });

  /** A beat with no clip is dropped and NAMED — the drop this round is not meant to hide. */
  it("still drops a beat that really has no clip, by name", () => {
    const built = buildCinematicSceneInputs({
      scenes: [sceneFacts(3, (b) => (b === 1 ? null : `/w/clip${b}.mp4`))],
    });
    expect(built.stats.beats).toBe(3);
    expect(built.stats.planned).toBe(2);
    expect(built.dropped).toContain("s0b1: no clip was adopted for this beat");
  });
});

/* ═══════════════════════ the reason line names the right failure ═══════════════════════ */

/**
 * "no scene had a beat with both a voice window and a rehydratable clip" was printed for a render
 * in which no beat was examined at all. It sent the investigation after voice windows and lineage
 * records; the cause was neither. The two failures need different sentences.
 */
describe("CINEMATIC_NO_PLANNABLE_BEATS says which of the two happened", () => {
  const PROD = fs.readFileSync(path.join(__dirname, "cinematicProduction.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("distinguishes 'no beats were handed over' from 'every beat was refused'", () => {
    const at = PROD.indexOf("CINEMATIC_PLAN_ERROR.NO_PLANNABLE_BEATS");
    expect(at, "the no-plannable-beats branch has moved").toBeGreaterThan(-1);
    const block = PROD.slice(Math.max(0, at - 1200), at + 300);
    expect(block, "the reason is still one sentence for two different failures").toContain(
      "built.stats.beats === 0"
    );
    expect(block, "the empty case still blames a per-beat check that never ran").toMatch(
      /no beats reached the planner/
    );
  });

  /** The per-beat sentence must survive for the case it actually describes. */
  it("keeps the per-beat reason for beats that really were refused", () => {
    expect(PROD).toMatch(/no beat had both a voice window and a rehydratable clip/);
  });
});

/* ═══════════════════════ which clip belongs to which beat ═══════════════════════ */

const base = (p: string) => p.split("/").pop() ?? p;

describe("clips are paired to beats by the adoption record", () => {
  /**
   * The compose list is in COMPOSE order and holds however many clips the scene ended up with.
   * Here beat 0 adopted two clips and beat 1 none, so position and beat disagree from index 1 on.
   */
  it("gives each beat the clip adopted for it, not the clip at its index", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4"],
      adoptions: [
        { beatIndex: 0, basename: "a.mp4" },
        { beatIndex: 0, basename: "b.mp4" },
        { beatIndex: 2, basename: "c.mp4" },
      ],
      beats: [{ index: 0 }, { index: 1 }, { index: 2 }],
      basenameOf: base,
    });
    expect(paired[0], "the beat's first adopted clip is not the one it plays").toBe("/w/a.mp4");
    expect(paired[1], "a beat that adopted nothing was handed another beat's picture").toBeNull();
    expect(paired[2], "the positional read survived: beat 2 got clip 2 by index").toBe("/w/c.mp4");
  });

  /** A clip the compose discarded is not in the list, so no beat may be given it. */
  it("never hands over a clip the compose did not use", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/kept.mp4"],
      adoptions: [
        { beatIndex: 0, basename: "kept.mp4" },
        { beatIndex: 1, basename: "discarded.mp4" },
      ],
      beats: [{ index: 0 }, { index: 1 }],
      basenameOf: base,
    });
    expect(paired).toEqual(["/w/kept.mp4", null]);
  });

  /** Two clips for one beat: the one the compose plays first, and only that one. */
  it("takes the first surviving clip per beat, in compose order", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/second.mp4", "/w/first.mp4"],
      adoptions: [
        { beatIndex: 0, basename: "first.mp4" },
        { beatIndex: 0, basename: "second.mp4" },
      ],
      beats: [{ index: 0 }, { index: 1 }],
      basenameOf: base,
    });
    expect(paired[0], "compose order was ignored in favour of adoption order").toBe("/w/second.mp4");
    expect(paired[1]).toBeNull();
  });

  /**
   * The all-or-nothing rule. A scene the audit knows nothing about keeps the behaviour it had
   * before this change, so no scene is made worse; a scene it knows something about is decided
   * entirely by it.
   */
  it("falls back to position only when the audit says nothing about the scene", () => {
    expect(
      pairClipsToBeats({
        clipPaths: ["/w/a.mp4", "/w/b.mp4"],
        adoptions: [],
        beats: [{ index: 0 }, { index: 1 }],
        basenameOf: base,
      })
    ).toEqual(["/w/a.mp4", "/w/b.mp4"]);
  });

  it("does not mix the two: one known beat does not make the others positional", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/a.mp4", "/w/b.mp4"],
      adoptions: [{ beatIndex: 1, basename: "a.mp4" }],
      beats: [{ index: 0 }, { index: 1 }],
      basenameOf: base,
    });
    expect(paired[0], "an unnamed beat fell back to position and took a named beat's clip").toBeNull();
    expect(paired[1]).toBe("/w/a.mp4");
  });

  /** More beats than clips must not throw or wrap around. */
  it("returns one entry per beat, always", () => {
    const paired = pairClipsToBeats({
      clipPaths: ["/w/a.mp4"],
      adoptions: [],
      beats: [{ index: 0 }, { index: 1 }, { index: 2 }],
      basenameOf: base,
    });
    expect(paired).toEqual(["/w/a.mp4", null, null]);
  });

  /** The caller must use it — a pure function nothing calls is the R160 failure repeated. */
  it("the pipeline calls it instead of indexing the compose list", () => {
    const at = CODE.indexOf("planAndStoreCinematicTimeline({");
    const block = CODE.slice(at, at + 3000);
    expect(block, "the planner does not use the pairing").toContain("pairClipsToBeats({");
    expect(block, "the planner still indexes the compose list by beat position").not.toMatch(
      /clipPaths\[beatIndex\]/
    );
  });
});
