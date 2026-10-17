/**
 * VIDEO 663, ROUND 5 — what render 73's own logs showed that no earlier round had touched.
 *
 *   1  search queries: a mood word and a cut-off subject made the query check refuse whole queries
 *      ("vibrancy medium shot los angeles", "city broll los"), logged up to 31 times each
 *   2  an approval after its scene closed, for a sentence that already had its picture, said so
 *   3  only effects a renderer draws are planned (no dust, particles, lens flare)
 *   4  a reorder answer that misses or doubles a clip is repaired, not thrown away
 *   5  YouTube is many videos, not "one source dominating"
 *   6  an archive fetch stopped from outside says so, not "ffmpeg exit null: <banner>"
 *   7  what the local test film showed: a chapter starts where the scene changes (one EDL holds the
 *      film), YouTube is modern footage, a short file never gives its time to a still shot, a dissolve
 *      that would end on a held frame is a cut, places for transitions and maps (Brussels was missing,
 *      "Spanish plaza" is not Spain), never the same country's map twice in a row
 */
import { describe, expect, it, vi } from "vitest";

import fs from "fs";
import path from "path";

import { computeScreenTimeShare, screenTimeFindings } from "./deliveredScreenTime";
import { repairOrder } from "./editorialReorder";
import { engineSourceFor } from "./cinematicPipelineInputs";
import { worldPlaceIn } from "./cinematicEditingEngine/edlGenerator";
import { giveHeldSecondsToNeighbours, SLOW_SHOT_MAX_SEC } from "./noHeldFrames";
import { directOnScreenText, MAP_SAME_PLACE } from "./onScreenTextDirector";
import { emptyTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { directorSearchQueries, withoutTerms } from "./scriptVisualKeywords";
import { directorSceneToIntent } from "./visualDirector";

const LA = "Los Angeles sprawls across endless freeways, a city built for cars.";

describe("1 — a query loses only the word nobody can prove, never the whole query", () => {
  it("the director's own queries carry no mood word and keep the subject whole", () => {
    const intent = directorSceneToIntent({
      spoken_text: LA,
      visual_description: "Los Angeles freeway interchange at dusk, traffic streaming",
      search_query: "los angeles freeway interchange",
      camera_shot: "medium shot",
      emotion: "vibrancy",
    } as never);
    expect(intent.secondary_keyword).toBe("medium shot los angeles freeway interchange");
    expect(intent.fallback_keyword).toBe("los angeles freeway broll");
    expect(`${intent.secondary_keyword} ${intent.fallback_keyword}`).not.toMatch(/vibrancy|\bcity broll los\b/);
  });

  it("render 73's refused query: 'vibrancy' goes, 'medium shot los angeles' is searched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const q = directorSearchQueries({
      sentence: LA,
      visual_intent: "freeways",
      visual_description: "Freeways at dusk",
      search_query: "los angeles freeways",
      primary_keyword: "los angeles freeways",
      /** the old template: mood + shot + subject — the mood word is in neither the sentence nor the plan */
      secondary_keyword: "vibrancy medium shot los angeles",
      fallback_keyword: "los angeles freeways broll",
      scene_type: "city",
      priority_subject: "los angeles",
    });
    expect(q).toContain("medium shot los angeles");
    expect(q.some((x) => x.includes("vibrancy"))).toBe(false);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[SearchQueryRepaired]") && l.includes('kept="medium shot los angeles"'))).toBe(true);
    warn.mockRestore();
    log.mockRestore();
  });

  it("what is left must still name something; production words alone are not a query", () => {
    expect(withoutTerms("neutral medium shot city skyline", ["neutral"])).toBe("medium shot city skyline");
    expect(withoutTerms("vibrancy medium shot", ["vibrancy"])).toBe("");
    expect(withoutTerms("dynamic culture clashes", [])).toBe("dynamic culture clashes");
    expect(withoutTerms("traditions clash rooted", ["traditions clash"])).toBe("");
  });

  it("the same refusal is logged once per sentence, not every time the plan is read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const intent = {
      sentence: "The council met in silence.",
      visual_intent: "council",
      visual_description: "A council chamber",
      search_query: "council chamber",
      primary_keyword: "council chamber",
      secondary_keyword: "frustration aerial tokyo",
      fallback_keyword: "council chamber broll",
      scene_type: "government",
      priority_subject: "council",
    };
    for (let i = 0; i < 5; i++) directorSearchQueries(intent);
    const refusals = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('query="frustration aerial tokyo"'));
    expect(refusals.length).toBe(1);
    warn.mockRestore();
  });
});

describe("2 — a late approval for a sentence that already has its picture is named as such", () => {
  it("the final pass reads the scene's result before calling it a loss", async () => {
    const vp = await import("./videoPipeline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dedup = {};
    vp.openLatePlacement(dedup, 0, async () => ({ hold: 3 }));
    vp.markSceneClosed(dedup, 0);
    /** approved after the close, with no ladder of the scene carrying it (render 73's s0b1) */
    vp.noteApprovedPickForBeat(dedup, 0, 1, "youtube_cc:late-picture");
    await vp.placeApprovedAfterSceneClosed(dedup, 0, { sceneReturned: true, final: true, hasPicture: (b) => b === 1 });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("APPROVED_NOT_PLACED"));
    expect(lines).toEqual(["[APPROVED_NOT_PLACED] s0b1 reason=approved after scene closed — not placed: the sentence already has its picture"]);
    warn.mockRestore();
  });
});

describe("3 — only effects a renderer draws are planned", () => {
  it("the planner names no dust, particles or lens flare", () => {
    const src = fs.readFileSync(path.join(__dirname, "cinematicEditingEngine", "effectsPlanner.ts"), "utf8");
    expect(src).not.toMatch(/effect\("(dust|particles|lens_flare)"/);
  });
});

describe("4 — a reorder answer is repaired, never a clip dropped or doubled", () => {
  it("render 73's [0,2,1,3] for five clips, and a doubled answer for nine", () => {
    expect(repairOrder([0, 2, 1, 3], 5)).toEqual([0, 2, 1, 3, 4]);
    expect(repairOrder([2, 3, 0, 8, 4, 5, 6], 9)).toEqual([2, 3, 0, 1, 8, 4, 5, 6, 7]);
    expect(repairOrder([1, 1, 0], 3)).toEqual([1, 2, 0]); // 2 goes back after 1, the clip it followed
    expect(repairOrder([], 3)).toEqual([0, 1, 2]);
    for (const r of [repairOrder([0, 2, 1, 3], 5), repairOrder([2, 3, 0, 8, 4, 5, 6], 9)]) {
      expect([...r].sort((a, b) => a - b)).toEqual(r.map((_, i) => i));
    }
  });
});

describe("5 — YouTube is many videos, not one source", () => {
  it("render 73's 71% YouTube from twelve videos is no warning; one video filling the film still is", () => {
    const c = (source: string, key: string, sec: number) => ({ path: `/w/${key}.mp4`, source, contentKey: key, durationSec: sec });
    const clips = Array.from({ length: 12 }, (_, i) => c("youtube", `yt:${i}`, 5.2));
    const share = computeScreenTimeShare([...clips, c("pexels", "px:1", 25)]);
    expect(screenTimeFindings(share).map((f) => f.code)).not.toContain("ONE_SOURCE_DOMINATES");
    const one = computeScreenTimeShare([c("youtube", "yt:x", 50), c("pexels", "px:1", 10)]);
    expect(screenTimeFindings(one).map((f) => f.code)).toContain("ONE_CLIP_DOMINATES");
  });
});

describe("6 — an archive fetch stopped from outside is named as that", () => {
  it("no more 'ffmpeg exit null' with ffmpeg's banner as the reason", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("ffmpeg was stopped (${signal ?? \"signal\"}) before the segment was read");
  });
});

describe("7 — what the local test film showed", () => {
  it("YouTube is modern footage, also from our own archive: never the planner's archival branch", () => {
    expect(engineSourceFor("youtube", 61525)).toBe("youtube_cc");
    expect(engineSourceFor("youtube_cc", 61525)).toBe("youtube_cc");
    expect(engineSourceFor("internet_archive", 1)).not.toBe("youtube_cc");
  });

  it("the place a sentence is about, for a transition: whole names, no nationality adjective", () => {
    expect(worldPlaceIn("Los Angeles stretches across a wide basin in 2024.")).toBe("Los Angeles");
    expect(worldPlaceIn("Brussels grew up on the banks of the Senne in 979.")).toBe("Brussels, Belgium");
    expect(worldPlaceIn("Belgium became an independent kingdom in 1830.")).toBe("Brussels, Belgium");
    expect(worldPlaceIn("Downtown towers rise above the old Spanish plaza.")).toBe("");
    expect(worldPlaceIn("Its freeways carry ten million cars.")).toBe("");
  });

  it("a chapter starts where the scene changes, inside one EDL for the whole film", () => {
    const src = fs.readFileSync(path.join(__dirname, "cinematicEditingEngine", "edlGenerator.ts"), "utf8");
    expect(src).toContain("const chapterStart = i > 0 && inputs[i - 1]!.scene.index !== input.scene.index;");
  });

  it("a short file never hands its time to a shot that stands still past the slow-shot limit", () => {
    const c = (id: string, start: number, end: number, extra: Partial<TimelineVideoClip> = {}) =>
      ({ id, kind: "video", source: { provider: "pexels", providerAssetId: id }, sourceIn: 0, timelineStart: start, timelineEnd: end, transitionIn: "hard_cut", transitionOut: "hard_cut", ...extra }) as TimelineVideoClip;
    const moving = c("m", 0, 5);
    const short = c("s", 5, 10);
    const still = c("t", 10, 13);
    const files: Record<string, number> = { m: 20, s: 2, t: 20 };
    giveHeldSecondsToNeighbours([moving, short, still], (x) => files[x.id]!, (x) => x.id === "t");
    /** the still shot grows only to the limit (3 → 3.5 s); the moving shot before takes the other 2.5 s */
    expect(still.timelineEnd - still.timelineStart).toBeCloseTo(SLOW_SHOT_MAX_SEC, 2);
    expect(moving.timelineEnd).toBeCloseTo(7.5, 2);
  });

  it("a dissolve into a shot with no pre-roll and too few seconds of its own becomes a cut", () => {
    const src = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");
    expect(src).toContain("[TransitionCut] clip=");
    expect(src.indexOf("[TransitionCut]")).toBeLessThan(src.indexOf("for (const [i, clip] of clips.entries()) {"));
  });

  it("never a map of the same country twice in a row", () => {
    const t = emptyTimeline(1, { widthPx: 1280, heightPx: 720, fps: 25 });
    t.durationSec = 30;
    const map = (id: string, start: number, label: string, iso3: string): TimelineGraphic =>
      ({ id, graphicType: "map_point", label, start, end: start + 4.5, data: { locationName: label, lon: 4.35, lat: 50.85, iso3 } }) as TimelineGraphic;
    for (const tr of t.tracks) if (tr.kind === "GRAPHICS") tr.graphics.push(map("bxl", 15, "Brussels, Belgium", "BEL"), map("be", 20, "Belgium", "BEL"), map("la", 2, "Los Angeles", "USA"));
    directOnScreenText(t);
    const g = Object.fromEntries(t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : [])).map((x) => [x.id, x]));
    expect(g.la!.disabled).toBeFalsy();
    expect(g.bxl!.disabled).toBeFalsy();
    expect(g.be).toMatchObject({ disabled: true, disabledReason: MAP_SAME_PLACE });
  });

  it("a place name the map has just shown gives way, so the year beside it stays", () => {
    const t = emptyTimeline(1, { widthPx: 1280, heightPx: 720, fps: 25 });
    t.durationSec = 60;
    for (const tr of t.tracks) {
      if (tr.kind === "GRAPHICS") {
        tr.graphics.push(
          { id: "bxl", graphicType: "map_point", label: "Brussels, Belgium", start: 15, end: 19.5, data: { locationName: "Brussels", lon: 4.35, lat: 50.85, iso3: "BEL" } } as TimelineGraphic,
          { id: "year", graphicType: "date_card", label: "1830", start: 20, end: 23, data: {} } as TimelineGraphic
        );
      }
      if (tr.kind === "TEXT") tr.texts.push({ id: "be", text: "Belgium", start: 20, end: 23 } as never);
    }
    directOnScreenText(t);
    const texts = t.tracks.flatMap((x) => (x.kind === "TEXT" ? x.texts : []));
    const gfx = t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : []));
    expect(texts.find((x) => x.id === "be")!.disabled).toBe(true);
    expect(gfx.find((x) => x.id === "year")!.disabled).toBeFalsy();
  });
});
