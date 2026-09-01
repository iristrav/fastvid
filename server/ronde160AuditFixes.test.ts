/**
 * R160 §20 — regression tests for the two wiring bugs the audit found.
 *
 * Both bugs had the same shape and it is the shape this whole verification round exists to catch:
 * a feature that is built, tested and correct, and that NOTHING on the live route calls. Neither
 * bug failed a test, because a timeline with no grade and no captions is a perfectly valid
 * timeline. It renders. It just renders without the thing somebody built.
 *
 * So these tests assert reachability, not correctness — the correctness is already covered
 * elsewhere. They fail if the connection is ever removed again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCinematicSceneInputs, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { generateEDL } from "./cinematicEditingEngine";
import { translateEdl } from "./edlToTimeline";
import { graphicIsRenderable } from "./graphicsVocabulary";
import { gradeChain } from "./timelineFilters";
import { captionTrack, videoTrack } from "./projectTimeline";
import type { Scene } from "./pipeline/types";

const ORIGINAL_ENGINE = process.env.CINEMATIC_EDITING_ENGINE;
const ORIGINAL_DIRECTOR = process.env.AI_DIRECTOR;

beforeEach(() => {
  process.env.CINEMATIC_EDITING_ENGINE = "true";
  process.env.AI_DIRECTOR = "true";
});
afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("CINEMATIC_EDITING_ENGINE", ORIGINAL_ENGINE);
  restore("AI_DIRECTOR", ORIGINAL_DIRECTOR);
});

/* ═══════════════════════ fixtures ═══════════════════════ */

function scene(index: number, text: string): Scene {
  return { index, text, visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 };
}

function sceneFacts(index: number, texts: string[]): SceneFacts {
  return {
    scene: scene(index, texts.join(" ")),
    beats: texts.map((t, i) => ({
      index: i, text: t, searchQuery: "apple park", powerWord: "Apple",
      holdSec: 4, voiceStartSec: i * 4, voiceEndSec: i * 4 + 4,
    })),
    clips: texts.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 },
      adoption: { provider: "wikimedia", providerAssetId: `${index}${i}`, sourceUrl: "https://x/y" },
    })),
  };
}

function planned() {
  const built = buildCinematicSceneInputs({
    scenes: [
      sceneFacts(0, ["Apple spent 3 billion dollars.", "The campus opened in Cupertino."]),
      sceneFacts(1, ["It just works, and that is the point.", "But then everything changed."]),
    ],
  });
  return runCinematicPipeline({ videoId: 1, scenes: built.scenes });
}

/* ═══════════════════════ BUG 1 — the grade never reached the timeline ═══════════════════════ */

describe("R160 BUG 1 — a cinematically planned video is GRADED", () => {
  /**
   * The bug: `translateEdl` never set `timeline.look`, so `gradeChain` returned null for every
   * clip and the whole of documentaryStyle's source-aware calibration — plus the eight looks added
   * in RONDE 153 — was unreachable from the cinematic route. Nothing failed; the video simply came
   * out ungraded.
   */
  it("carries a look, so the grade chain is not null", () => {
    const result = planned();
    expect(result.timeline.look).toBeDefined();
    expect(result.timeline.look!.grade).toBe("documentary");

    // The proof that matters: a real filter chain comes out the other end.
    const chain = gradeChain(result.timeline.look, "archive");
    expect(chain).not.toBeNull();
    expect(chain).toContain("eq=contrast=");
    expect(chain).toContain("vignette=angle=");
  });

  it("the grade is still SOURCE-AWARE on the cinematic route", () => {
    const look = planned().timeline.look;
    // Archive and stock must not grade identically — that is the whole point of the calibration.
    expect(gradeChain(look, "archive")).not.toBe(gradeChain(look, "stock"));
  });

  it("a caller can still ask for no grade at all", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, ["A beat."])] });
    const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes, look: { grade: "none" } });
    expect(result.timeline.look!.grade).toBe("none");
    expect(gradeChain(result.timeline.look, "archive")).toBeNull();
  });

  it("a caller can choose one of the RONDE 153 looks", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, ["A beat."])] });
    const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes, look: { grade: "cinematic" } });
    expect(gradeChain(result.timeline.look, "stock")).toContain("colorbalance=bs=0.06");
  });

  /**
   * `translateEdl` on its own still defaults to NO look, so every existing caller and the golden
   * render are unchanged. The default lives in the pipeline, where the decision belongs.
   */
  it("translateEdl still adds no look unless asked — the golden render is untouched", () => {
    const edl = generateEDL([
      {
        scene: scene(0, "A beat."),
        intent: {
          beatId: "b0", spokenText: "A beat.", visualSubject: "Apple", visualAction: "",
          visualLocation: "", visualTime: "", historicalContext: "", emotion: "",
          visualDescription: "", primaryKeyword: "Apple", secondaryKeyword: "",
          negativeKeywords: [], secondaryVisualSubjects: [], objects: [], brands: [],
          companies: [], countries: [], events: [], people: [], intentHash: "h", cacheHit: false,
        },
        bestCandidate: {
          candidateId: "c1", source: "wikimedia", assetType: "video", title: null,
          description: null, tags: [], thumbnail: null, localPath: "/tmp/a.mp4", remoteUrl: null,
          metadata: null, searchQuery: "", retrievalMethod: "search", fetchedAt: "2026-01-01",
          language: null, license: null, attribution: null, width: null, height: null,
          duration: null, mimeType: null, originalSource: null, downloadTimeMs: null,
          embeddingSimilarity: null, keywordScore: null, retrievalReasons: [],
          retrievalSources: [], clipSimilarity: null, clipModel: null, clipEmbeddingVersion: null,
          clipLatencyMs: null, editorialScore: null, motionLevel: null, rankingScore: null,
          rankingBreakdown: null,
        },
        beatVoiceStartSec: 0,
        beatVoiceDurationSec: 4,
      },
    ]);
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: edl.decisions.map((d) => ({
        decision: d, sceneOffsetSec: 0, identity: { provider: "wikimedia", providerAssetId: "1" },
      })),
    });
    expect(timeline.look).toBeUndefined();
  });
});

/* ═══════════════════════ BUG 2 — the captions track was always empty ═══════════════════════ */

describe("R160 BUG 2 — a cinematically planned video HAS narration captions", () => {
  /**
   * The bug: `planCaptions` could emit a `subtitle` carrying the beat's spoken text, behind an
   * `includeSubtitle` option defaulting to false that nothing ever passed. `trackForCaption` routes
   * only `subtitle` to CAPTIONS — so the captions track was always empty, and the entire RONDE 152
   * caption engine (word timing, karaoke, word-by-word, phrase mode, geometric collision layout)
   * had no input at all on the live route.
   */
  it("puts one caption per beat on the CAPTIONS track", () => {
    const result = planned();
    const captions = captionTrack(result.timeline);
    expect(captions.length).toBe(4);
  });

  it("the caption text is the NARRATION, not a card label", () => {
    const result = planned();
    const texts = captionTrack(result.timeline).map((c) => c.text);
    expect(texts[0]).toContain("3 billion dollars");
    expect(texts[3]).toContain("everything changed");
  });

  it("each caption spans its own beat, on the video's absolute clock", () => {
    const result = planned();
    const captions = [...captionTrack(result.timeline)].sort((a, b) => a.start - b.start);
    expect(captions.map((c) => [c.start, c.end])).toEqual([[0, 4], [4, 8], [8, 12], [12, 16]]);
  });

  it("captions line up with the clips they play over", () => {
    const result = planned();
    const clips = [...videoTrack(result.timeline)].sort((a, b) => a.timelineStart - b.timelineStart);
    const captions = [...captionTrack(result.timeline)].sort((a, b) => a.start - b.start);
    for (let i = 0; i < clips.length; i++) {
      expect(captions[i]!.start).toBeCloseTo(clips[i]!.timelineStart, 3);
    }
  });

  it("a caller can turn subtitles off", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, ["A beat."])] });
    const result = runCinematicPipeline({
      videoId: 1, scenes: built.scenes, includeSubtitles: false,
    });
    expect(captionTrack(result.timeline)).toHaveLength(0);
  });

  /** The generator's default is unchanged, so no existing caller starts emitting subtitles. */
  it("generateEDL still emits NO subtitle unless asked", () => {
    const input = {
      scene: scene(0, "A beat."),
      intent: {
        beatId: "b0", spokenText: "A beat about Apple.", visualSubject: "Apple", visualAction: "",
        visualLocation: "", visualTime: "", historicalContext: "", emotion: "",
        visualDescription: "", primaryKeyword: "Apple", secondaryKeyword: "",
        negativeKeywords: [], secondaryVisualSubjects: [], objects: [], brands: [],
        companies: [], countries: [], events: [], people: [], intentHash: "h", cacheHit: false,
      },
      bestCandidate: {
        candidateId: "c1", source: "wikimedia" as const, assetType: "video" as const, title: null,
        description: null, tags: [], thumbnail: null, localPath: "/tmp/a.mp4", remoteUrl: null,
        metadata: null, searchQuery: "", retrievalMethod: "search" as const, fetchedAt: "2026-01-01",
        language: null, license: null, attribution: null, width: null, height: null,
        duration: null, mimeType: null, originalSource: null, downloadTimeMs: null,
        embeddingSimilarity: null, keywordScore: null, retrievalReasons: [],
        retrievalSources: [], clipSimilarity: null, clipModel: null, clipEmbeddingVersion: null,
        clipLatencyMs: null, editorialScore: null, motionLevel: null, rankingScore: null,
        rankingBreakdown: null,
      },
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: 4,
    };
    const without = generateEDL([input]);
    expect(without.decisions[0]!.captions.some((c) => c.captionType === "subtitle")).toBe(false);

    const with_ = generateEDL([input], { includeSubtitles: true });
    expect(with_.decisions[0]!.captions.some((c) => c.captionType === "subtitle")).toBe(true);
  });
});

/* ═══════════════════════ §6 — timeline integrity, on the real chain ═══════════════════════ */

describe("R160 §6 — the whole timeline agrees with itself", () => {
  it("nothing sits outside the video's own duration", () => {
    const t = planned().timeline;
    for (const clip of videoTrack(t)) {
      expect(clip.timelineStart).toBeGreaterThanOrEqual(0);
      expect(clip.timelineEnd).toBeLessThanOrEqual(t.durationSec + 0.001);
    }
    for (const c of captionTrack(t)) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(t.durationSec + 0.001);
    }
  });

  it("no clip overlaps its neighbour", () => {
    const clips = [...videoTrack(planned().timeline)].sort((a, b) => a.timelineStart - b.timelineStart);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]!.timelineStart).toBeGreaterThanOrEqual(clips[i - 1]!.timelineEnd - 0.001);
    }
  });

  it("every element ends after it starts", () => {
    const t = planned().timeline;
    for (const clip of videoTrack(t)) expect(clip.timelineEnd).toBeGreaterThan(clip.timelineStart);
    for (const c of captionTrack(t)) expect(c.end).toBeGreaterThan(c.start);
  });

  it("the whole chain is deterministic, twice over", () => {
    const a = planned();
    const b = planned();
    const strip = (t: unknown) => {
      const { createdAt, ...rest } = t as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    expect(strip(b.timeline)).toBe(strip(a.timeline));
  });
});

/* ═══════════ BUG 3 — every planned motion graphic was reported undrawable ═══════════ */

/**
 * ── What the audit found ─────────────────────────────────────────────────────────────────────
 *
 * The planner names nine kinds of motion graphic. The renderer draws thirty-two. The two lists had
 * no name in common, and `edlToTimeline` asked a THIRD list — `GRAPHICS_WITH_A_LABEL`, hand-written
 * in that file when libass was the only way to draw anything — so every graphic the cinematic
 * engine ever planned came out of translation reported as "not drawn by this renderer".
 *
 * These tests run the REAL chain, from production-shaped scene facts through to the timeline, and
 * assert the graphics arrive in a state the renderer will actually draw. They are written against
 * the production entry point rather than against `rendererGraphicType`, because the bug was never
 * in a function — it was in which function was being called.
 */
describe("R160 BUG 3 — a planned motion graphic reaches the timeline drawable", () => {
  /** A scene whose stat callout and narration give the planner something real to draw. */
  function graphicScene(index: number, statCallout: string, texts: string[]): SceneFacts {
    const base = sceneFacts(index, texts);
    return { ...base, scene: { ...base.scene, statCallout } };
  }

  function withGraphics() {
    const built = buildCinematicSceneInputs({
      scenes: [
        graphicScene(0, "$5B", ["Apple spent 5 billion dollars on it.", "Work began in Berlin, Germany."]),
      ],
    });
    return runCinematicPipeline({ videoId: 1, scenes: built.scenes });
  }

  it("the planner really does emit motion graphics for this scene", () => {
    const planned = withGraphics().edl.decisions.flatMap((d) => d.motionGraphics);
    expect(planned.length).toBeGreaterThan(0);
    /** Named so the test fails loudly if the planner's vocabulary ever changes under it. */
    expect(planned.map((g) => g.graphicType)).toContain("statistic_counter");
    expect(planned.map((g) => g.graphicType)).toContain("map");
  });

  it("they arrive on the GRAPHICS track under a name the renderer draws", () => {
    const r = withGraphics();
    const track = r.timeline.tracks.find((t) => t.kind === "GRAPHICS");
    if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");
    expect(track.graphics.length).toBeGreaterThan(0);

    const undrawable = track.graphics.filter(
      (g) => !graphicIsRenderable(g.graphicType, g.data, g.label ?? null)
    );
    expect(
      undrawable.map((g) => g.graphicType),
      "graphics on the timeline the renderer cannot draw"
    ).toEqual([]);
  });

  it("a counter and a map both survive translation with their payload intact", () => {
    const r = withGraphics();
    const track = r.timeline.tracks.find((t) => t.kind === "GRAPHICS");
    if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");

    const counter = track.graphics.find((g) => g.graphicType === "counter");
    expect(counter, "the statistic counter was lost in translation").toBeTruthy();
    expect(counter!.data.toValue).toBe(5);

    const map = track.graphics.find((g) => g.graphicType === "map_point");
    expect(map, "the map was lost in translation").toBeTruthy();
    expect(typeof map!.data.normX).toBe("number");
    expect(typeof map!.data.normY).toBe("number");
  });

  /** §6 — a translated name must not erase what the planner asked for. */
  it("the document still records the name the planner used", () => {
    const r = withGraphics();
    const track = r.timeline.tracks.find((t) => t.kind === "GRAPHICS");
    if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");
    const map = track.graphics.find((g) => g.graphicType === "map_point")!;
    expect(map.reason).toContain('planned as "map"');
  });

  it("nothing drawable is reported as unsupported any more", () => {
    const r = withGraphics();
    const stillReported = r.unsupported.filter((u) => u.includes("motion graphic"));
    for (const line of stillReported) {
      /** Whatever remains must be one of the six that genuinely has no component. */
      expect(line).toMatch(/"(chart|timeline|arrow|comparison|highlight_box|animated_icon)"/);
    }
  });

  /**
   * The other direction, and the reason this is a repair rather than a loosening: a graphic the
   * renderer genuinely cannot draw must STILL be reported. Translating three names must not have
   * turned the report off.
   */
  it("a graphic with no component is still reported, with the planner's reason", () => {
    const { unsupported } = translateEdl({
      videoId: 1,
      inputs: [
        {
          decision: {
            beatId: "s0b0",
            sceneIndex: 0,
            clip: { candidateId: "c", startSec: 0, endSec: 4, trimStartSec: 0, trimEndSec: 4, reason: "r" },
            shot: { shotType: "medium", reason: "r" },
            camera: { movement: "static", intensity: 0, reason: "r" },
            transitionIn: { type: "cut", durationSec: 0, reason: "r" },
            captions: [],
            motionGraphics: [
              {
                graphicType: "comparison",
                data: { leftLabel: "before", rightLabel: "after", connector: "VS" },
                startSec: 0,
                durationSec: 2,
                reason: "the narration draws a comparison",
              },
            ],
            effects: [],
            sounds: [],
            pacing: { tone: "neutral", cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "r" },
          } as never,
          sceneOffsetSec: 0,
          identity: { provider: "wikimedia", providerAssetId: "1" },
        },
      ],
    });
    const line = unsupported.find((u) => u.includes("comparison"));
    expect(line, "a graphic with no component stopped being reported").toBeTruthy();
    expect(line).toContain("the narration draws a comparison");
  });
});
