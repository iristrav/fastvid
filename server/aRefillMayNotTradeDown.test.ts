/**
 * A REFILL MAY NOT TRADE DOWN — RONDE 646.
 *
 * Render 603, scene 1: `2/10 clips — strict beat refill` at 20:29:44; at 20:43:11 the refill
 * replaced the scene and both real clips left it — `youtube_cc:yOPuuSeBfyo`, the render's only
 * YouTube clip, and `ww2:57364` — and every beat of scene 1 reached the planner as NO_ADOPTED_CLIP.
 *
 *   §1  the rule: a refill with less real footage than the scene it replaces is refused
 *   §2  both sites that replace a non-empty scene go through it
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { refillMayNotTradeDown } from "./videoPipeline";

const placeholder = (c: string) => c.includes("_fallback_");

describe("§1 — the rule", () => {
  it("RENDER 603: two real clips against placeholders — the scene keeps its own", () => {
    const before = { clips: ["scene_1_ytfu_0__pid_youtube_cc-45c7_transformed.mp4", "scene_1_b0_curated_a57364.mp4"] };
    const refill = { clips: ["scene_1_fallback_card_0.mp4", "scene_1_fallback_card_1.mp4", "scene_1_fallback_card_2.mp4"] };
    const v = refillMayNotTradeDown(before, refill, placeholder);
    expect(v.kept).toBe("previous");
    expect(v.result).toBe(before);
    expect(v.beforeUsable).toBe(2);
    expect(v.refillUsable).toBe(0);
  });

  it("a refill with MORE real footage still wins — the rebuild's judgement stands", () => {
    const before = { clips: ["a.mp4", "b.mp4"] };
    const refill = { clips: ["c.mp4", "d.mp4", "e.mp4"] };
    expect(refillMayNotTradeDown(before, refill, placeholder).kept).toBe("refill");
  });

  it("an equal amount is not a trade down — the refill wins", () => {
    const before = { clips: ["a.mp4", "b.mp4"] };
    const refill = { clips: ["c.mp4", "d.mp4", "x_fallback_.mp4"] };
    expect(refillMayNotTradeDown(before, refill, placeholder).kept).toBe("refill");
  });

  it("placeholders in the old scene are not footage it can lose", () => {
    const before = { clips: ["a_fallback_.mp4", "b_fallback_.mp4", "c.mp4"] };
    const refill = { clips: ["d.mp4"] };
    expect(refillMayNotTradeDown(before, refill, placeholder).kept).toBe("refill");
  });

  it("an empty scene can only gain", () => {
    expect(refillMayNotTradeDown({ clips: [] }, { clips: [] }, placeholder).kept).toBe("refill");
  });

  it("the real placeholder test is the pipeline's own", () => {
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("const verdict = refillMayNotTradeDown(before, refill, isPipelineFallbackClip);");
  });
});

describe("§2 — both sites that replace a non-empty scene", () => {
  const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("P5A: an under-filled scene's refill is judged against the scene", () => {
    const at = src.indexOf("clips — strict refill`);");
    expect(at).toBeGreaterThan(0);
    const next = src.slice(at, at + 400);
    expect(next).toContain("svr = applyRefillMayNotTradeDown(");
    expect(next).not.toMatch(/svr = await refillSceneStrictVoiceMatch/);
  });

  it("the chunk sweep: the same", () => {
    const at = src.indexOf("clips — strict beat refill`");
    expect(at).toBeGreaterThan(0);
    const next = src.slice(at, at + 600);
    expect(next).toContain("sceneVisualResults[si] = applyRefillMayNotTradeDown(");
    expect(next).toContain("prevSceneVisual_10,");
  });

  it("a refused refill's clips are released and explained, not stranded", () => {
    const at = src.indexOf("function applyRefillMayNotTradeDown(");
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toContain('noteSceneClipsResourced(dedup, refill, before, sceneIndex, "strict_voice_refill")');
    expect(body).toContain("KEPT_PREVIOUS");
  });

  it("no site replaces a scene that has real clips with an unjudged refill", () => {
    /** The two remaining direct calls run only when the scene holds no clips at all. */
    const direct = [...src.matchAll(/= await refillSceneStrictVoiceMatch\(/g)].map((m) => m.index ?? 0);
    expect(direct).toHaveLength(2);
    for (const at of direct) {
      /** The chunk sweep's check opens its `if` above a fast-stock branch, about 2.5k characters up. */
      const before = src.slice(Math.max(0, at - 3500), at);
      expect(before, `refill at ${at} is not behind an empty-scene check`).toMatch(
        /svr\.clips\.length === 0|\.clips\.length === 0\)/
      );
    }
  });
});
