/**
 * VIDEO 663, ROUND 3 — "Pak ze allemaal aan": what still kept the film from looking professional.
 *
 *   1  a picture that shows the opposite of the line (night under "relentless sun", clear skies
 *      under "shrouded in rain", Santa Monica under a line about Brussels) is never approved;
 *   3  a YouTube moment with no archive copy has its shot changes measured on the render's own file;
 *   4  no bars: no planned letterbox, an off-shape source filled with itself, flat bands of any colour
 *      baked into a source cut off, a corner logo pushed out of the frame, a © watermark refused;
 *   5  a length revision never leaves a sentence with words cut out of its middle;
 *   6  one line per film says what a viewer sees (`[ViewerReport]`).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { abstractLineRule, acceptableRule, conditionClashRule, settleSituationQuestion } from "./beatImageRelevanceGate";
import { planVisualEffects } from "./cinematicEditingEngine/effectsPlanner";
import { uniformBandCrop, BAND_SCAN_H, BAND_SCAN_W } from "./embeddedBarsCrop";
import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { buildScriptLengthRefinePrompt, restoreClippedSentences } from "./scriptWriter";
import { LOGO_PUNCH_IN_SCALE, logoPunchIn, shapeIsNotTheFrames } from "./timelineRenderer";
import { formatViewerReport, viewerReport } from "./viewerReport";
import { conditionClash } from "./visibleConditions";
import { withoutContradictedSentences } from "./youtubePreviewSheet";
import { youtubeSourceFactsFor } from "./youtubeShotCuts";
import { limitYoutubeShots } from "./youtubeShotLimit";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-663c-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* ═══════════ 1 — a picture that shows the opposite of the line ═══════════ */

const SUN = "Los Angeles basks under relentless sun, inviting beachgoers year-round.";
const RAIN = "Brussels is often shrouded in rain, its streets a sea of umbrellas.";

describe("1 — a picture that contradicts the line is never approved", () => {
  it("what a viewer sees at once: day or night, sun or rain, summer or snow", () => {
    expect(conditionClash(SUN, "A night scene on a Los Angeles street with graffiti-covered shutters and pedestrians.")).toMatch(/daylight vs "night"/);
    expect(conditionClash(RAIN, "Historic buildings in Brussels, Belgium during twilight with clear skies.")).toMatch(/rain or grey skies vs "clear skies"/);
    expect(conditionClash("Snow blanketed the city that winter.", "Sunbathers on a crowded beach.")).toMatch(/snow/);
    /** no condition in the line, or none against it in the frame: nothing to say */
    expect(conditionClash("The port moved more containers than ever.", "Cranes at night over a port.")).toBeNull();
    expect(conditionClash(SUN, "Sunlit palm trees along a boulevard.")).toBeNull();
    /** a frame that shows both (sunset into night) is not a contradiction */
    expect(conditionClash(SUN, "The sun sets and night falls over the beach.")).toBeNull();
  });

  it("render 72's s1b2: refused — even the model's own 'fits' — and no later rule promotes it", () => {
    const said = { verdict: "does_not_fit" as const, depicts: "A night scene on a Los Angeles street with graffiti-covered shutters and pedestrians.", reason: "The frames show a night scene in Los Angeles, which doesn't match the narration" };
    const settled = settleSituationQuestion(said as never, { subject_matches: true, situation_matches: false }, { evidenceRequirement: "soft", wantsSpecificPicture: false } as never, SUN);
    expect(settled.verdict).toBe("does_not_fit");
    expect(settled.reason).toMatch(/^contradicts the line: daylight vs "night"/);
    /** a fit the model gave is refused too */
    expect(conditionClashRule({ ...said, verdict: "fits" as const }, SUN).verdict).toBe("does_not_fit");
    /** and the two promotions stand back */
    const refused = conditionClashRule(said, SUN);
    expect(abstractLineRule(refused, { subject_matches: true, situation_matches: false }, { evidenceRequirement: "soft", wantsSpecificPicture: false } as never, SUN)).toBe(refused);
    expect(acceptableRule(refused, { subject_matches: true, situation_matches: false })).toBe(refused);
  });

  it("the YouTube sheet: a frame is not approved for a sentence it contradicts or places elsewhere", () => {
    const sentences = [SUN, RAIN, "The city never sleeps."];
    const { picks, removed } = withoutContradictedSentences(
      [
        { sec: 10, sentences: [0, 2], depicts: "A night street with neon signs" },
        { sec: 40, sentences: [1], depicts: "Santa Monica Pier at sunset" },
        { sec: 70, sentences: [1], depicts: "Rainy square in Brussels with umbrellas" },
      ],
      sentences
    );
    expect(picks).toEqual([
      { sec: 10, sentences: [2], depicts: "A night street with neon signs" },
      { sec: 70, sentences: [1], depicts: "Rainy square in Brussels with umbrellas" },
    ]);
    expect(removed).toHaveLength(2);
    expect(removed.join("\n")).toMatch(/@10s not for sentence 0: contradicts the line/);
    expect(removed.join("\n")).toMatch(/@40s not for sentence 1: wrong place \(los angeles, the line says brussels\)/);
  });
});

/* ═══════════ 3 — a YouTube moment with no archive copy, measured on its own file ═══════════ */

describe("3 — shot changes of a moment with no archive copy are measured on the render's file", () => {
  const identity = { provider: "youtube_cc", providerAssetId: "OIfjoyu1k6E", providerWindow: { inSec: 100, outSec: 110 } };

  it("no archive row: the local moment file is measured, in its own seconds", async () => {
    const local = path.join(dir, "moment.mp4");
    fs.writeFileSync(local, "x");
    const facts = await youtubeSourceFactsFor(identity, {
      getAsset: async () => null,
      fetchAsset: async () => false,
      detect: async () => ({ durationSec: 10, cutsSec: [6] }),
      save: async () => undefined,
      localFile: () => local,
      log: () => undefined,
    });
    expect(facts).toEqual({ sourceDurationSec: 10, cutsSec: [6], measured: true, fileStartSec: 100 });
    /** without a file to measure: unknown, as before */
    const unknown = await youtubeSourceFactsFor(identity, {
      getAsset: async () => null, fetchAsset: async () => false, detect: async () => ({ durationSec: 10, cutsSec: [] }), save: async () => undefined, log: () => undefined,
    });
    expect(unknown).toEqual({ sourceDurationSec: 0, cutsSec: [], measured: false });
  });

  it("the pieces are planned inside one shot of the file and written back in the video's seconds", () => {
    const clip: TimelineVideoClip = {
      id: "vc_d2fe49d8fe", kind: "video", source: identity, sourceIn: 100.5, sourceOut: 108.5,
      timelineStart: 20, timelineEnd: 28, sceneIndex: 1, beatIndex: 3,
    } as TimelineVideoClip;
    const out = limitYoutubeShots({ clips: [clip], youtube: new Map([[clip.id, { sourceDurationSec: 10, cutsSec: [], measured: true, fileStartSec: 100 }]]) });
    expect(out.clips.length).toBe(2);
    expect(out.clips[0]!.sourceIn).toBeCloseTo(100.5, 3);
    for (const p of out.clips) {
      expect(p.sourceIn!).toBeGreaterThanOrEqual(100);
      expect(p.sourceOut!).toBeLessThanOrEqual(110.001);
      expect(p.holdAtSourceOut).toBeUndefined();
    }
    expect(out.notes.join("\n")).not.toMatch(/KEPT_UNCUT/);
  });

  it("production hands the render's own file; two windows of one video are asked apart", () => {
    expect(SRC("videoPipeline.ts")).toContain("pickLocalFileByIdentity([...localFilesByBeat.values()].flat(), { source: id, sourceIn: id.providerWindow?.inSec })");
    expect(SRC("cinematicProduction.ts")).toContain('${window ? `@${window.inSec}-${window.outSec}` : ""}');
  });
});

/* ═══════════ 4 — no bars, no logos ═══════════ */

describe("4 — no bars, no logos", () => {
  it("the planner never paints a letterbox", () => {
    const shot = { shotType: "establishing", durationSec: 5 } as never;
    const candidate = { candidateId: "c", provider: "youtube_cc", searchText: "city skyline" } as never;
    const effects = planVisualEffects(shot, candidate, { tone: "dramatic" } as never);
    expect(effects.some((e) => e.effectType === "letterbox")).toBe(false);
  });

  it("a source that is not the frame's shape is filled with itself, not with bars", () => {
    const fmt = { widthPx: 1920, heightPx: 1080 };
    expect(shapeIsNotTheFrames({ w: 640, h: 480 }, fmt)).toBe(true); // 4:3 archive
    expect(shapeIsNotTheFrames({ w: 1080, h: 1080 }, fmt)).toBe(true); // square photo
    expect(shapeIsNotTheFrames({ w: 1280, h: 720 }, fmt)).toBe(false);
    expect(shapeIsNotTheFrames({ w: 854, h: 480 }, fmt)).toBe(false);
    expect(shapeIsNotTheFrames(null, fmt)).toBe(false);
    expect(SRC("timelineRenderer.ts")).toContain("buildVideoFilter(unbranded, fmt, dur, look, { portraitSource: portraitSource || offShape, darkSource })");
  });

  it("render 72's archive 61523: flat bands of any colour on opposite edges are found; a clear sky is not a band", () => {
    const W = BAND_SCAN_W;
    const H = BAND_SCAN_H;
    const frame = (seed: number, paint: (x: number, y: number) => [number, number, number] | null) => {
      const b = Buffer.alloc(W * H * 3);
      let r = seed;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          r = (r * 1103515245 + 12345) & 0x7fffffff;
          const c = paint(x, y) ?? [r % 256, (r >> 8) % 256, (r >> 16) % 256];
          b.set(c, (y * W + x) * 3);
        }
      }
      return b;
    };
    /** black pillars left and right, a purple band on top only */
    const framed = (seed: number) => frame(seed, (x, y) => (x < 8 || x >= W - 8 ? [0, 0, 0] : y < 4 ? [90, 30, 120] : null));
    expect(uniformBandCrop([framed(1), framed(2), framed(3)])).toEqual({ top: 0, bottom: 0, left: 8, right: 8 });
    /** a purple letterbox top AND bottom */
    const lb = (seed: number) => frame(seed, (_x, y) => (y < 4 || y >= H - 4 ? [90, 30, 120] : null));
    expect(uniformBandCrop([lb(1), lb(2), lb(3)])).toMatchObject({ top: 4, bottom: 4 });
    /** a clear blue sky at the top only is picture */
    const sky = (seed: number) => frame(seed, (_x, y) => (y < 10 ? [110, 160, 220] : null));
    expect(uniformBandCrop([sky(1), sky(2), sky(3)])).toBeNull();
    /** a whole flat frame is not a framed picture */
    const flat = () => frame(1, () => [40, 40, 40]);
    expect(uniformBandCrop([flat(), flat()])).toBeNull();
  });

  it("a corner logo the text check let through is pushed out of the frame; an editor's framing is kept", () => {
    const c = { kind: "video" as const, source: { provider: "youtube_cc", textCheck: "overlay" as const } };
    expect(logoPunchIn(c).transform).toEqual({ scale: LOGO_PUNCH_IN_SCALE });
    expect(logoPunchIn({ ...c, source: { ...c.source, textCheck: "clean" as const } })).toEqual({ ...c, source: { ...c.source, textCheck: "clean" } });
    const framed = { ...c, transform: { scale: 1.3 } };
    expect(logoPunchIn(framed)).toBe(framed);
  });

  it("a © or website watermark — render 72's '©CaliforniaThroughMyLens.com' — is refusing text, not a corner logo", () => {
    const filter = SRC("archiveClipFilter.ts");
    expect(filter).toContain("een copyright-vermelding (©) of een website-adres als watermerk, ook klein en ook in een");
    expect(filter).toContain("alleen een klein zender- of kanaallogo zonder © of website-adres in een hoek");
  });
});

/* ═══════════ 5 — no sentence with words cut out of its middle ═══════════ */

describe("5 — a length revision never leaves a clipped sentence", () => {
  it("render 72: 'This isn't just about landscapes clash of cultures' is put back whole", () => {
    const draft = "## Two cities\nThis isn't just about landscapes; it's a clash of cultures. Brussels runs on rain.";
    const revised = "## Two cities\nThis isn't just about landscapes clash of cultures. Brussels runs on rain.";
    const r = restoreClippedSentences(draft, revised);
    expect(r.restored).toEqual([{ was: "This isn't just about landscapes clash of cultures.", now: "This isn't just about landscapes; it's a clash of cultures." }]);
    expect(r.script).toContain("This isn't just about landscapes; it's a clash of cultures.");
  });

  it("a sentence cut at its end, rewritten, or dropped whole is left as the revision wrote it", () => {
    const draft = "Prices rose sharply in 2026 across Europe. Families felt it first.";
    expect(restoreClippedSentences(draft, "Prices rose sharply in 2026. Families felt it first.").restored).toEqual([]);
    expect(restoreClippedSentences(draft, "Europe paid more in 2026. Families felt it first.").restored).toEqual([]);
    expect(restoreClippedSentences(draft, "Families felt it first.").restored).toEqual([]);
  });

  it("the writer is told so, and the revision is repaired before it is weighed", () => {
    const prompt = buildScriptLengthRefinePrompt("x", { minWords: 100, maxWords: 120, targetWords: 110, targetSpokenSec: 60 } as never, 160, "topic");
    expect(prompt).toContain("never delete words from inside a sentence and leave the rest");
    expect(SRC("scriptEngine.ts")).toContain("const repaired = restoreClippedSentences(markdownScript, cleanedRevision.script);");
  });
});

/* ═══════════ 6 — one line per film: what a viewer sees ═══════════ */

const film = (clips: Array<Partial<TimelineVideoClip> & { id: string; timelineStart: number; timelineEnd: number }>): ProjectTimeline => {
  const t = emptyTimeline(663);
  t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
  const v = t.tracks.find((x) => x.kind === "VIDEO");
  if (v?.kind === "VIDEO") {
    v.clips.push(
      ...clips.map((c) => ({ kind: "video", source: { provider: "pexels", providerAssetId: c.id, contentApproval: "judge_fit" }, sourceIn: 0, ...c }) as TimelineVideoClip)
    );
  }
  return t;
};

describe("6 — the viewer report", () => {
  it("a clean film is PROFESSIONAL", () => {
    const t = film([{ id: "a", timelineStart: 0, timelineEnd: 5 }, { id: "b", timelineStart: 5, timelineEnd: 10 }]);
    const r = viewerReport(t, [{ clipId: "a", sec: 0.1 }]);
    expect(r.professional).toBe(true);
    expect(formatViewerReport(663, r)).toMatch(/verdict=PROFESSIONAL$/);
  });

  it("names every problem a viewer would see", () => {
    const t = film([
      { id: "held", timelineStart: 0, timelineEnd: 8 },
      { id: "again", timelineStart: 8, timelineEnd: 12, source: { provider: "pexels", providerAssetId: "held", contentApproval: "judge_fit" } },
      { id: "field", timelineStart: 12, timelineEnd: 16, source: { provider: "synthetic_placeholder" } },
      { id: "guess", timelineStart: 16, timelineEnd: 20, source: { provider: "pexels", providerAssetId: "g", contentApproval: "unverified" } },
    ]);
    const g = t.tracks.find((x) => x.kind === "GRAPHICS");
    if (g?.kind === "GRAPHICS") g.graphics.push({ id: "lt", graphicType: "lower_third", label: "Otto von Bismarck", start: 1, end: 4 });
    const r = viewerReport(t, [{ clipId: "held", sec: 3 }]);
    expect(r.stillSec).toBe(3);
    expect(r.repeatedSec).toBeGreaterThan(0);
    expect(r.fallbackScenes).toBe(1);
    expect(r.longTexts).toEqual(["Otto von Bismarck"]);
    expect(r.unapproved).toEqual(["guess"]);
    expect(r.professional).toBe(false);
    expect(formatViewerReport(663, r)).toMatch(/verdict=NOT_YET — 3\.0s held frame \(15%\); 1 fallback scene\(s\), 4\.0s; .*footage shown twice; 1 text\(s\) over 2 words; 1 picture\(s\) not approved/);
  });

  it("every render job prints it, from the timeline it rendered and the renderer's held frames", () => {
    expect(SRC("renderJobWorker.ts")).toContain("console.log(formatViewerReport(job.videoId, viewerReport(timelineRendered, rendered.heldFrames ?? [])));");
    expect(SRC("timelineRenderer.ts")).toContain("if (stillSec > 0.04) heldFrames.push({ clipId: clip.id, sec: stillSec });");
  });
});
