import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  beatOutcomeKey,
  beatRecord,
  beatsWithPlacedRealFootage,
  createBeatOutcomeAudit,
  noteBeatAdopted,
  renderBeatFunnelReport,
  resolveBeatCoverage,
} from "./beatOutcomeAudit";
import { createRejectionRegistry } from "./rejectionRegistry";
import { judgeYoutubeRequirement } from "./deliveryGate";
import { youtubeFootageInTimeline } from "./youtubeFootageInFilm";
import type { TimelineVideoClip } from "./projectTimeline";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO } from "./youtubeSearchBudget";
import { MAX_STOCK_ATTEMPTS, MAX_STOCK_VIDEOS } from "./youtubeShotStock";
import { analyzeVideo, validVisualNeeds, type PlannerInput } from "./youtubeVideoSearchPlanner";

/**
 * VIDEO 641 — THE REPAIR ROUND AFTER THE FUNNEL AUDIT: B2, B3, B4, B5.
 *
 * Only the bugs the audit proved. Each section holds the fix and the line it must not cross.
 */

afterEach(() => vi.restoreAllMocks());
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const FINAL = { sceneReturned: true, final: true } as const;
const tick = () => new Promise((r) => setTimeout(r, 5));

/* ═══════════ B2 — an approval at the scene's end still reaches its sentence ═══════════ */

describe("B2 — a picture approved after the cap, at a scene with no time left, still reaches its sentence", () => {
  const picked = "/w/scene_1_ytfu_0m0_t2059d40__pid_youtube_cc-00366246f9a1b17d_transformed.mp4";

  const quiet = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    return warn;
  };

  it("641 s1b3: the running ladder is handed to the late placement at the scene's end (waitMs 0) → placed", async () => {
    const vp = await import("./videoPipeline");
    const warn = quiet();
    const dedup = {};
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    /** the scene's end, its time spent: nothing is waited for — but the ladder is handed over */
    expect(await vp.takeLateApprovedPicks(dedup, 1, 0, { sceneEnd: true })).toEqual([]);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(picked));
    expect(vp.lateApprovalPendingFor(dedup, 1, 3), "the scene's last check does not name it lost").toBe(true);
    const placer = vi.fn(async (_c: string, _b: number) => ({ hold: 4.3 }));
    vp.openLatePlacement(dedup, 1, placer);
    vp.markSceneClosed(dedup, 1);
    resolve(picked);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, FINAL)).toEqual([{ beatIndex: 3, clip: picked, hold: 4.3 }]);
    expect(placer).toHaveBeenCalledWith(picked, 3);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("APPROVED_NOT_PLACED"))).toBe(false);
  });

  it("before the fix (no scene end, waitMs 0): the ladder stays behind and the picture is lost — the 641 log", async () => {
    const vp = await import("./videoPipeline");
    quiet();
    const dedup = {};
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    expect(await vp.takeLateApprovedPicks(dedup, 1, 0)).toEqual([]);
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(picked));
    expect(vp.lateApprovalPendingFor(dedup, 1, 3)).toBe(false);
    const placer = vi.fn(async () => ({ hold: 4.3 }));
    vp.openLatePlacement(dedup, 1, placer);
    vp.markSceneClosed(dedup, 1);
    resolve(picked);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, FINAL)).toEqual([]);
    expect(placer).not.toHaveBeenCalled();
  });

  it("no duplicate placement: placed once; a second pass places nothing; a sentence with a picture is not given a second", async () => {
    const vp = await import("./videoPipeline");
    quiet();
    const dedup = {};
    let resolve!: (v: string | null) => void;
    vp.noteLadderForBeat(dedup, 1, 3, 0, new Promise<string | null>((r) => { resolve = r; }));
    await vp.takeLateApprovedPicks(dedup, 1, 0, { sceneEnd: true });
    /** the same scene end asked twice hands nothing over twice */
    await vp.takeLateApprovedPicks(dedup, 1, 0, { sceneEnd: true });
    vp.noteApprovedPickForBeat(dedup, 1, 3, vp.clipContentKey(picked));
    const placer = vi.fn(async (_c: string, _b: number) => ({ hold: 4.3 }));
    vp.openLatePlacement(dedup, 1, placer);
    vp.markSceneClosed(dedup, 1);
    resolve(picked);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, FINAL)).toHaveLength(1);
    expect(await vp.placeApprovedAfterSceneClosed(dedup, 1, FINAL)).toEqual([]);
    expect(placer).toHaveBeenCalledTimes(1);

    /** the sentence already has its picture in the film's result: the late approval is not placed on top */
    const other = {};
    let resolve2!: (v: string | null) => void;
    vp.noteLadderForBeat(other, 1, 3, 0, new Promise<string | null>((r) => { resolve2 = r; }));
    await vp.takeLateApprovedPicks(other, 1, 0, { sceneEnd: true });
    vp.noteApprovedPickForBeat(other, 1, 3, vp.clipContentKey(picked));
    const placer2 = vi.fn(async () => ({ hold: 4.3 }));
    vp.openLatePlacement(other, 1, placer2);
    vp.markSceneClosed(other, 1);
    resolve2(picked);
    await tick();
    expect(await vp.placeApprovedAfterSceneClosed(other, 1, { ...FINAL, hasPicture: (b) => b === 3 })).toEqual([]);
    expect(placer2).not.toHaveBeenCalled();
  });

  it("the scene passes its end to the handover, and its last check skips a sentence whose picture is on its way", () => {
    expect(PIPE).toContain("for (const late of await takeLateApprovedPicks(dedup, scene.index, waitMs, { sceneEnd })) {");
    expect(PIPE).toContain("if (lateApprovalPendingFor(dedup, scene.index, b.index)) continue;");
    expect(PIPE).toContain("if (waitMs > 0 || opts.sceneEnd) {");
  });
});

/* ═══════════ B3 — YouTube in the film: only what the viewer sees ═══════════ */

describe("B3 — youtubeFootageInTimeline counts only visible clips", () => {
  const yt = (id: string, start: number, end: number, opacity?: number): TimelineVideoClip =>
    ({
      id,
      timelineStart: start,
      timelineEnd: end,
      source: { provider: "youtube_cc", providerAssetId: "UJT6QkAriVQ" },
      previewSource: { kind: "none" },
      ...(opacity === undefined ? {} : { transform: { opacity } }),
    }) as unknown as TimelineVideoClip;
  const measure = (clips: TimelineVideoClip[]) => youtubeFootageInTimeline(clips, new Map(), "rendered_timeline");

  it("opacity 1 counts", () => {
    expect(measure([yt("a", 0, 4, 1)]).youtubeSec).toBe(4);
  });
  it("opacity 0 does not count", () => {
    const f = measure([yt("a_graphic1", 0, 4, 0)]);
    expect(f.youtubeSec).toBe(0);
    expect(f.clips).toEqual([]);
  });
  it("no opacity set counts", () => {
    expect(measure([yt("a", 0, 4)]).youtubeSec).toBe(4);
  });
  it("mixed timeline: only the visible seconds; the film's length still holds the card's time", () => {
    const f = measure([yt("a", 0, 4.56), yt("a_graphic1", 4.56, 18.24, 0), yt("b", 18.24, 26.84, 1)]);
    expect(f.youtubeSec).toBe(13.16);
    expect(f.directSec).toBe(13.16);
    expect(f.clips.map((c) => c.clipId)).toEqual(["a", "b"]);
    expect(f.filmSec).toBe(26.84);
  });

  it("consumer judgeYoutubeRequirement: unchanged code, now judges the seconds the viewer sees", () => {
    const f = measure([yt("a", 0, 4.56), yt("a_graphic1", 4.56, 57.27, 0)]);
    /** unset requirement (production default): never blocks */
    expect(judgeYoutubeRequirement(f, null)).toEqual({ ok: true });
    /** a deployment that requires 10 s: 4.56 s visible is below it — the hidden 52.71 s no longer pass for footage */
    expect(judgeYoutubeRequirement(f, 10)).toMatchObject({ ok: false, code: "YOUTUBE_FOOTAGE_BELOW_REQUIREMENT" });
    expect(judgeYoutubeRequirement(f, 4)).toEqual({ ok: true });
  });

  it("the pipeline's targeted-outcome lines read the same visible clips", () => {
    expect(PIPE).toContain("footage = youtubeFootageInTimeline(measured.clips, origins, measured.basis);");
    expect(PIPE).toContain("visibleFilm = footage.clips;");
  });
});

/* ═══════════ B4 — VisualCoverageFinal: REAL_ASSET only where a real clip was placed ═══════════ */

describe("B4 — coverage counts an adoption only where a real clip reached the sentence", () => {
  const adoptedRecord = () => {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 1, 3, "youtube_cc", "scene_1_ytfu_0m0.mp4");
    return { audit, rec: beatRecord(audit, 1, 3) };
  };
  const real = "/w/scene_1_ytfu_0m0_t2059d40__pid_youtube_cc-00366246f9a1b17d_transformed.mp4";

  it("adopted + placed → REAL_ASSET", () => {
    const { rec } = adoptedRecord();
    const placed = beatsWithPlacedRealFootage([{ path: real, sceneIndex: 1, beatIndex: 3 }]);
    expect(resolveBeatCoverage(rec, placed.has(beatOutcomeKey(1, 3)))).toBe("REAL_ASSET");
  });

  it("adopted + not placed → not REAL_ASSET (641 s1b2/s1b3)", () => {
    const { rec } = adoptedRecord();
    const placed = beatsWithPlacedRealFootage([{ path: real, sceneIndex: 1, beatIndex: 0 }]);
    expect(resolveBeatCoverage(rec, placed.has(beatOutcomeKey(1, 3)))).toBe("NO_VALID_ASSET");
    rec.placeholder = true;
    expect(resolveBeatCoverage(rec, false)).toBe("FALLBACK");
  });

  it("a card or a drawn background under the sentence → not REAL_ASSET", () => {
    const { rec } = adoptedRecord();
    for (const card of ["/w/scene_1_b3_fallback.mp4", "/w/scene_1_slot3_color_fallback.mp4", "/w/scene_1_genimg_b3__pid_stability-ab12.mp4"]) {
      const placed = beatsWithPlacedRealFootage([{ path: card, sceneIndex: 1, beatIndex: 3 }]);
      expect(placed.size, card).toBe(0);
      expect(resolveBeatCoverage(rec, placed.has(beatOutcomeKey(1, 3))), card).not.toBe("REAL_ASSET");
    }
  });

  it("a hidden clip → not REAL_ASSET", () => {
    const { rec } = adoptedRecord();
    const placed = beatsWithPlacedRealFootage([{ path: real, sceneIndex: 1, beatIndex: 3, hidden: true }]);
    expect(resolveBeatCoverage(rec, placed.has(beatOutcomeKey(1, 3)))).toBe("NO_VALID_ASSET");
  });

  it("unknown placement keeps the old reading — the VisionCoverage gate's input is unchanged", () => {
    const { rec } = adoptedRecord();
    expect(resolveBeatCoverage(rec)).toBe("REAL_ASSET");
    expect(PIPE).toContain("hasRealFootage: coverageHasRealFootage(resolveBeatCoverage(rec)),");
  });

  it("the report: the per-beat line, the COVERAGE roll-up and the ledger agree on placement", () => {
    const { audit } = adoptedRecord();
    noteBeatAdopted(audit, 0, 0, "youtube_cc", "scene_0_ytfu.mp4");
    const placed = beatsWithPlacedRealFootage([{ path: real, sceneIndex: 0, beatIndex: 0 }]);
    const lines = renderBeatFunnelReport(
      audit,
      [{ sceneIndex: 0, beatIndex: 0 }, { sceneIndex: 1, beatIndex: 3 }],
      createRejectionRegistry(),
      (s, b) => placed.has(beatOutcomeKey(s, b))
    );
    expect(lines.find((l) => l.includes("scene=0 beat=0 "))).toContain("coverage=REAL_ASSET");
    expect(lines.find((l) => l.includes("scene=1 beat=3 "))).toContain("coverage=NO_VALID_ASSET");
    expect(lines.find((l) => l.includes("COVERAGE"))).toContain("REAL_ASSET=1 ");
    expect(lines.find((l) => l.includes("[BeatLedger] beat=s1b3"))).toContain("coverage=NO_VALID_ASSET");
    /** the funnel's own count is untouched: adopted stays 2 */
    expect(lines.find((l) => l.includes("TOTAL beats="))).toContain("adopted=2");
  });

  it("the pipeline passes the scene results' placement to the report", () => {
    expect(PIPE).toContain("const placedReal = beatsWithPlacedRealFootage(");
    expect(PIPE).toContain("(sceneIndex, beatIndex) => placedReal.has(beatOutcomeKey(sceneIndex, beatIndex))");
  });
});

/* ═══════════ B5 — the Visual Needs validator enforces its own contract ═══════════ */

const SCRIPT_641: PlannerInput = {
  prompt: "Why the Kardashians are not as rich as they look",
  title: "The Kardashian Wealth Illusion",
  sceneTexts: [
    "Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think. " +
      "Their famous mansions dominate the headlines. Yet the numbers tell another story.",
    "Much of the Kardashian wealth is an illusion, with assets locked in real estate and ventures controlled by Kris Jenner. " +
      "Their wealth is a mirage shaped by media trends and unpredictable projections. Fame pays, but not forever.",
    "Finance analysts reveal that the Kardashians' income relies heavily on Kris Jenner and volatile social media monetization. " +
      "The Kardashians still spend like billionaires. " +
      "In the Calabasas corporate office, accountants lay out the stark reality: operational expenses are huge. " +
      "Kim Kardashian's hype creation keeps the public guessing.",
  ],
};

describe("B5 — Visual Needs: abstract ideas and generic scenery left out, names kept", () => {
  const analysis = analyzeVideo(SCRIPT_641);
  const at = (needle: string) => analysis.sentences.findIndex((s) => s.includes(needle));
  const valid = (subject: string, beats: number[], input = SCRIPT_641, a = analysis) =>
    validVisualNeeds([{ subject, beats }], a, input);

  it("641 replayed: the six needs become what a search can find", () => {
    const needs = validVisualNeeds(
      [
        { subject: "Kardashians", beats: [at("Despite"), at("Finance analysts"), at("still spend")] },
        { subject: "Kris Jenner", beats: [at("controlled by Kris Jenner"), at("Finance analysts")] },
        { subject: "Calabasas corporate office", beats: [at("Calabasas")] },
        { subject: "Finance analysts", beats: [at("Finance analysts")] },
        { subject: "Kim Kardashian hype creation", beats: [at("hype creation")] },
        { subject: "Accountants in office", beats: [at("Calabasas")] },
      ],
      analysis,
      SCRIPT_641
    );
    expect(needs.map((n) => n.subject)).toEqual(["Kardashians", "Kris Jenner", "Calabasas", "Kim Kardashian"]);
  });

  it("abstract: an idea is not a picture", () => {
    expect(valid("wealth illusion", [at("illusion")])).toEqual([]);
    expect(valid("media monetization", [at("Finance analysts")])).toEqual([]);
  });

  it("generic scenery under a sentence that names something to show is left out", () => {
    expect(valid("Accountants in office", [at("Calabasas")])).toEqual([]);
    expect(valid("Finance analysts", [at("Finance analysts")])).toEqual([]);
  });

  it("concrete: a filmable subject stays as it is", () => {
    expect(valid("famous mansions", [at("mansions")])).toEqual([{ subject: "famous mansions", beats: [at("mansions")] }]);
    expect(valid("Kris Jenner", [at("controlled by Kris Jenner")])).toEqual([{ subject: "Kris Jenner", beats: [at("controlled by Kris Jenner")] }]);
  });

  it("a proper name stays — SpaceX, and a name with what it is", () => {
    const input: PlannerInput = {
      prompt: "How SpaceX built Starship",
      title: "Starship",
      sceneTexts: ["The engineers at SpaceX tested the Starship rocket in Boca Chica. Accountants in the office counted every dollar."],
    };
    const a = analyzeVideo(input);
    const i = a.sentences.findIndex((s) => s.includes("Boca Chica"));
    const plain = a.sentences.findIndex((s) => s.includes("counted every dollar"));
    expect(valid("SpaceX", [i], input, a).map((n) => n.subject)).toEqual(["SpaceX"]);
    expect(valid("Starship rocket", [i], input, a).map((n) => n.subject)).toEqual(["Starship rocket"]);
    /** a role is not removed blindly: under a sentence that names nothing, the role IS the picture */
    expect(valid("Accountants in office", [plain], input, a).map((n) => n.subject)).toEqual(["Accountants in office"]);
  });

  it("budget, stock and the targeted searches are untouched: 4 searches, 6 stock videos, 9 attempts", () => {
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(4);
    expect(MAX_STOCK_VIDEOS).toBe(6);
    expect(MAX_STOCK_ATTEMPTS).toBe(9);
  });
});
