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
 */
import { describe, expect, it, vi } from "vitest";

import fs from "fs";
import path from "path";

import { computeScreenTimeShare, screenTimeFindings } from "./deliveredScreenTime";
import { repairOrder } from "./editorialReorder";
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
