/**
 * VIDEO 631 RE-RUN — A LATE CANDIDATE IS JUDGED; A PLANNED TEXT ANIMATION REACHES REMOTION.
 *
 * Render 631 on 360046e: 51 usable candidates, 9 looked at, 42 declined `beat_turn_over` — every
 * download that landed after its sentence's cap was never judged. Since a late FIT is placed
 * (`takeLateApprovedPicks`, a21ae12), the turn-over guard is no longer wired.
 *
 *   FIX 1   1–11  a candidate after the cap may be looked at, within the unchanged ceilings
 *   FIX 2         the planner's caption animation reaches the Remotion props unchanged
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { createBeatImageGateState, MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { checkBeatRelevance, createBeatRelevanceLedger } from "./beatVisualRelevance";
import { textAnimationForCaption } from "./edlToTimeline";
import { emptyTimeline, DEFAULT_TEXT_STYLE } from "./projectTimeline";
import { timelineToRemotionProps } from "./remotionProps";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const EDL = fs.readFileSync(path.join(__dirname, "edlToTimeline.ts"), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FIX 1 — a candidate that lands after the cap is judged, not declined", () => {
  it("1/2. before or after the cap the production gate has no turn-over hook: a late look is never declined BEAT_TURN_OVER", async () => {
    const { withSceneFetchTimeout } = await import("./videoPipeline");
    const state = createBeatImageGateState();
    expect(state.turnOver, "production state: no turn-over hook").toBeUndefined();
    expect(PIPE).not.toContain("state.beatImageGate.turnOver = sceneTurnIsOver;");
    let decline: string | undefined = "not run";
    await withSceneFetchTimeout(async () => {
      await wait(60); // the download lands after the cap
      const d = await checkBeatRelevance({
        clipPath: "/nonexistent/s0b0_late.mp4",
        contentKey: "youtube_cc:late",
        ctx: { sceneIndex: 0, beatIndex: 0, beatText: "Berlin, 1961. Concrete and barbed wire cleaved the city." },
        workDir: "/tmp",
        state,
        ledger: createBeatRelevanceLedger(),
        route: "adopt",
      });
      decline = d.declineCause;
    }, 20, "video search s0 b0").catch(() => null);
    await wait(100);
    expect(decline, "the late candidate reached the gate").not.toBe("not run");
    expect(decline).not.toBe("BEAT_TURN_OVER");
  }, 120_000);

  it("3. a late FIT for exactly this sentence is handed to the scene as approved (a21ae12 route)", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_0_b0_late_transformed.mp4";
    vp.noteLadderForBeat(dedup, 0, 0, 0, (async () => {
      await wait(10);
      vp.noteApprovedPickForBeat(dedup, 0, 0, vp.clipContentKey(clip));
      return clip;
    })());
    await wait(40);
    expect(await vp.takeLateApprovedPicks(dedup, 0, 0)).toEqual([{ beatIndex: 0, clip, approved: true }]);
  });

  it("4/5. a late MISMATCH or UNREVIEWED answer is never approved, so the scene never places it", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const mismatch = "/tmp/scene_0_b1_mismatch.mp4";
    const unreviewed = "/tmp/scene_0_b2_unreviewed.mp4";
    /** Neither was accepted as FIT, so neither key is ever recorded as approved. */
    vp.noteLadderForBeat(dedup, 0, 1, 0, Promise.resolve(mismatch));
    vp.noteLadderForBeat(dedup, 0, 2, 0, Promise.resolve(unreviewed));
    await wait(5);
    const late = await vp.takeLateApprovedPicks(dedup, 0, 0);
    expect(late.map((l) => l.approved)).toEqual([false, false]);
    /** Only FIT records an approval; the placement refuses anything unapproved. */
    expect(PIPE).toContain('if (beatEvidence === "FIT" && !requeuedAfterRefusal.has(p)) noteApprovedPickForBeat(');
    expect(PIPE).toContain("if (!late.approved) {");
  });

  it("6/7. the ceilings are unchanged: 4 judgements per beat in the image gate, 5 looks per sentence, 120 per render", async () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    const { maxRelevanceLooksPerBeat } = await import("./beatVisualRelevance");
    expect(maxRelevanceLooksPerBeat()).toBe(5);
  });

  it("8/10. no extra search: inside a capped (aborted) sentence a new fetch scope is still refused", async () => {
    const { withSceneFetchTimeout } = await import("./videoPipeline");
    let inner: string = "not run";
    await withSceneFetchTimeout(async () => {
      await wait(60);
      inner = await withSceneFetchTimeout(async () => "searched", 5_000, "late search").catch((e: Error) => `refused: ${e.message}`);
    }, 20, "video search s0 b3").catch(() => null);
    await wait(100);
    expect(inner).toMatch(/^refused/);
  }, 120_000);

  it("9. a sentence its pictures already cover is never given another one by a late answer (VIDEO 642: an uncovered rest of 3 s or more may be)", () => {
    expect(PIPE).toContain("const hasPicture = clipBeatIndices.includes(late.beatIndex);");
    expect(PIPE).toContain("if (hasPicture && left < BEAT_EXTRA_SHOT_MIN_SEC) {");
  });

  it("11. the sentence never waits for a late candidate; the a21ae12 route is unchanged", () => {
    const body = PIPE.slice(PIPE.indexOf("async function resolveBeatClipForBeat("), PIPE.indexOf("// ─── Unified beat-clip retrieval entry point"));
    expect(body).toContain("late = capped.late;");
    expect(body).toContain("return answer;");
    expect(body).toContain("noteLadderForBeat(dedup, sceneIndex, beat.index, approvedBefore, forScene);");
  });
});

describe("FIX 2 — the planner's caption animation reaches Remotion", () => {
  it("the mapping: slide → slide_up, scale, typewriter, fade, none kept; anything else is a fade", () => {
    expect(textAnimationForCaption("slide")).toBe("slide_up");
    expect(textAnimationForCaption("scale")).toBe("scale");
    expect(textAnimationForCaption("typewriter")).toBe("typewriter");
    expect(textAnimationForCaption("fade")).toBe("fade");
    expect(textAnimationForCaption("none")).toBe("none");
    expect(textAnimationForCaption("blur")).toBe("fade");
    expect(textAnimationForCaption(undefined)).toBe("fade");
  });

  it("the translation uses it (no more \"none\" or \"fade\" only)", () => {
    expect(EDL).toContain("animation: textAnimationForCaption(caption.animation),");
    expect(EDL).not.toContain('animation: caption.animation === "none" ? "none" : "fade",');
  });

  it("a text element carrying slide_up / scale / typewriter arrives in the Remotion props with that animation", () => {
    const timeline = emptyTimeline(1);
    const texts = (["slide", "scale", "typewriter", "fade", "none"] as const).map((a, i) => ({
      id: `t${i}`, text: `text ${i}`, start: i * 2, end: i * 2 + 1.5, style: DEFAULT_TEXT_STYLE,
      animation: textAnimationForCaption(a),
    }));
    const track = timeline.tracks.find((t) => t.kind === "TEXT");
    if (track && track.kind === "TEXT") track.texts.push(...texts);
    timeline.durationSec = 10;
    const props = timelineToRemotionProps({ timeline });
    expect(props.texts.map((t) => t.animation)).toEqual(["slide_up", "scale", "typewriter", "fade", "none"]);
  });
});
