import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { intentAcceptsGeneralFootage, type BeatVisualIntent } from "./beatVisualIntent";
import { maxRelevanceLooksPerBeat } from "./beatVisualRelevance";
import { JUDGE_BASE_SCALE, JUDGE_MS_PER_LOOK } from "./judgeBudget";
import { judgeCandidateMetadata, type CandidateJudgeInput } from "./visualJudge";
import { youtubeMomentsPerVideo } from "./youtubeMoments";

/**
 * VIDEO 645 — THREE TARGETED FIXES, FROM THE FORENSIC FUNNEL AUDIT.
 *
 *   F1  the picture editor's budget: base 55 s → 82.5 s, 7.5 s per look (judgeBudget.ts) — 645's
 *       s2b0 FIT arrived 79 s in and was "approved after scene closed".
 *   F2  `entity_evidence` defers to the picture editor when the sentence's intent accepts general
 *       footage — 645's s1b1 lost eight Tesla-factory moments to that gate before any look.
 *   F3  one extra round, per render, for targeted stock left "ready, not offered" after a last look
 *       without a fit — 645's s1b0 got a card while the GM video searched for it sat on disk.
 */

type VP = typeof import("./videoPipeline");
type BVRM = typeof import("./beatVisualRelevance");
let vp: VP;
let bvr: BVRM;
let dir: string;
beforeAll(async () => {
  vp = await import("./videoPipeline");
  bvr = await import("./beatVisualRelevance");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-645-fixes-"));
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const PIPE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════════ F1 — the budget, on every judge path ═══════════════════════════ */

describe("F1 — the picture editor's budget", () => {
  it("the constants: 30 s per look and a base scaled by 1.5 (195 s from 10 s + 120 s) — VIDEO 647", () => {
    expect(JUDGE_MS_PER_LOOK).toBe(30_000);
    expect(JUDGE_BASE_SCALE).toBe(1.5);
    expect(Math.round((10_000 + 180_000) * JUDGE_BASE_SCALE)).toBe(285_000);
  });

  it("one budget object, built with the scaled base and the default per-look grant, is handed to the last looks AND the extra-shot fill", () => {
    const src = PIPE();
    const build = src.slice(src.indexOf("const judgeBaseMs = Math.round((FINAL_REVIEW_WINDOW_MS + FINAL_LOOK_TURN_MS) * JUDGE_BASE_SCALE);"), src.indexOf("await runFinalReadyYoutubeStage(visualDedup"));
    expect(build.length).toBeGreaterThan(0);
    expect(build).toContain("const judgeBudget = createJudgeBudget({");
    expect(build).toContain("baseMs: judgeBaseMs,");
    /** no second per-look figure anywhere: the module's JUDGE_MS_PER_LOOK is the only one */
    expect(build).not.toContain("perLookMs");
    /** the ceiling never falls below the scaled base */
    expect(build).toContain("judgeBaseMs\n      ),");
    const stage = src.slice(src.indexOf("await runFinalReadyYoutubeStage(visualDedup"), src.indexOf("await runFinalBeatFillStage(visualDedup"));
    expect(stage).toContain("{ budget: judgeBudget }");
    expect(src).toContain("await runFinalBeatFillStage(visualDedup, allSentences, judgeBudget, {");
  });

  it("a late approval is lost only when the film is already assembled — the budget is the single clock that decides when that is", () => {
    const src = PIPE();
    const look = src.slice(src.indexOf("export async function finalReadyYoutubeLook("), src.indexOf("export async function runFinalReadyYoutubeStage("));
    expect(look).toContain("if (assembledScenesByRender.get(dedup)?.has(sceneIndex)) {");
    expect(look).toContain("approved after the film was assembled — not placed");
    const stage = src.slice(src.indexOf("export async function runFinalReadyYoutubeStage("), src.indexOf("export function formatFinalLookTally("));
    /** the stage waits for its looks until the budget's own deadline, read again on every turn */
    expect(stage).toContain("const still = await finalLooksWithin(dedup, finalLooks, budget ?? limits.looksMs ?? FINAL_LOOK_TURN_MS);");
    expect(src).toContain("else await settledWithinJudgeBudget(looks.map((l) => l.run), ms);");
  });
});

/* ═══════════════════════════ F2 — entity_evidence defers to the picture editor ═══════════════════════════ */

describe("F2 — entity_evidence when the intent accepts general footage", () => {
  const intent = (over: Partial<Record<"evidenceRequirement", BeatVisualIntent["evidenceRequirement"]>> & { acceptable?: string[] }): BeatVisualIntent =>
    ({
      evidenceRequirement: over.evidenceRequirement ?? "soft",
      mediaForm: { preferred: ["PERSON"], acceptable: over.acceptable ?? ["PERSON", "REAL_FOOTAGE", "PHOTO", "B_ROLL"] },
    }) as unknown as BeatVisualIntent;

  it("intentAcceptsGeneralFootage: soft + footage acceptable → true; hard → false; footage not acceptable → false; no intent → false", () => {
    expect(intentAcceptsGeneralFootage(intent({}))).toBe(true);
    expect(intentAcceptsGeneralFootage(intent({ acceptable: ["PERSON", "B_ROLL"] }))).toBe(true);
    expect(intentAcceptsGeneralFootage(intent({ evidenceRequirement: "none" }))).toBe(true);
    expect(intentAcceptsGeneralFootage(intent({ evidenceRequirement: "hard" }))).toBe(false);
    expect(intentAcceptsGeneralFootage(intent({ acceptable: ["PERSON", "PHOTO"] }))).toBe(false);
    expect(intentAcceptsGeneralFootage(null)).toBe(false);
    expect(intentAcceptsGeneralFootage(undefined)).toBe(false);
  });

  describe("the gate itself", () => {
    /** s2b1 of 637 / the shape of 645's s1b1: a sentence that names a person; the render reads him as a person. */
    const SENTENCE = "Was it all Elon Musk's doing?";
    const TED = { id: "zIwLWfaAg-8", title: "Elon Musk: The future we're building -- and boring | TED" };
    let cache: ReturnType<VP["createSourcingCache"]>;
    let factoryMoment: string;
    let tedMoment: string;
    beforeEach(() => {
      vp.setRenderPeopleReadingForTests(["Elon Musk"]);
      cache = vp.createSourcingCache(645);
      vp.putCachedProviderAsset(cache, "youtube_cc", TED.id, { providerText: { title: TED.title } });
      vp.putCachedProviderAsset(cache, "youtube_cc", "mr9kK0_7x08", { providerText: { title: "Tesla Factory Tour" } });
      const moment = (videoId: string, startSec: number) =>
        vp.tagPathWithProviderAsset(`/w/scene_1_ytfu_1m0_${vp.youtubeFragmentFileTag(startSec, 4)}.mp4`, "youtube_cc", videoId);
      factoryMoment = moment("mr9kK0_7x08", 489.79);
      tedMoment = moment(TED.id, 411.42);
    });
    afterEach(() => vp.setRenderPeopleReadingForTests(null));

    const input = (p: string, over: Partial<CandidateJudgeInput> = {}): CandidateJudgeInput => {
      const providerText = cache.assets.get(vp.providerTextCacheKey(p))?.providerText;
      return {
        path: p,
        sourceQuery: "tesla factory",
        beatText: SENTENCE,
        videoTitle: "How Tesla Rewrote the Rules",
        meta: providerText ? { providerText } : undefined,
        requireBeatMatch: false,
        scriptAnchored: true,
        entityRules: vp.extractBeatRealEntities(SENTENCE),
        signals: { beatMatch: 1, queryInBeat: true, providerTitleSharesNothing: false },
        where: "s1b1",
        provider: "youtube_cc",
        ...over,
      };
    };

    it("the sentence names a person and the factory title is no evidence of him", () => {
      const rules = vp.extractBeatRealEntities(SENTENCE);
      expect(rules.some((r) => r.kind === "person")).toBe(true);
      expect(judgeCandidateMetadata(input(factoryMoment)).reason).toBe("entity_evidence");
    });

    it("UNCHANGED — without the intent's permission the factory moment is refused for entity_evidence, as before", () => {
      const v = judgeCandidateMetadata(input(factoryMoment));
      expect(v.decision).toBe("REJECT");
      expect(v.reason).toBe("entity_evidence");
      const explicit = judgeCandidateMetadata(input(factoryMoment, { generalFootageAcceptable: false }));
      expect(explicit.reason).toBe("entity_evidence");
    });

    it("645 — with the intent accepting general footage the factory moment is NOT refused here: it goes on to the picture editor, approved by nobody yet", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const v = judgeCandidateMetadata(input(factoryMoment, { generalFootageAcceptable: true }));
      expect(v.reason).not.toBe("entity_evidence");
      expect(v.decision).toBe("ACCEPT");
      expect(v.stage).toBe("metadata");
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("flagged, not refused; the picture decides");
    });

    it("a real person match keeps its requirements: with evidence the moment passes with or without the permission", () => {
      expect(judgeCandidateMetadata(input(tedMoment)).decision).toBe("ACCEPT");
      expect(judgeCandidateMetadata(input(tedMoment, { generalFootageAcceptable: true })).decision).toBe("ACCEPT");
    });

    it("the permission loosens nothing else: an AI-generated file and a blocked category are refused exactly as before", () => {
      const ai = judgeCandidateMetadata(input("/w/scene_1_b1_ai_fallback.mp4", { generalFootageAcceptable: true, meta: undefined }));
      expect(ai.reason).toBe("ai_generated");
      const miniature = judgeCandidateMetadata(
        input("/w/scene_1_b1_pex_miniature_toy_rocket_12345.mp4", { generalFootageAcceptable: true, meta: undefined, sourceQuery: "toy rocket miniature" })
      );
      expect(miniature.decision).toBe("REJECT");
      expect(miniature.reason).not.toBe("entity_evidence");
    });

    it("the pipeline hands the gate the intent's answer, read from the same intent record the ranking uses", () => {
      const src = PIPE();
      const call = src.slice(src.indexOf("const judgedOnMetadata = judgeCandidateMetadata({"), src.indexOf('if (judgedOnMetadata.decision === "REJECT" && refuse(judgedOnMetadata.reason)) continue;'));
      expect(call).toContain("generalFootageAcceptable: intentAcceptsGeneralFootage(_intent),");
      expect(src).toContain("const _intent = ensureBeatVisualIntent(dedup.beatIntent, {");
    });
  });
});

/* ═══════════════════════════ F3 — one extra round for targeted stock left unoffered ═══════════════════════════ */

describe("F3 — targeted stock left 'ready, not offered' gets one extra round after a last look without a fit", () => {
  const video = (file: string, seconds: number): string => {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  const sentence = (index: number, text: string) => ({ index, text, holdSec: 3.5, keywords: [] as string[], searchQuery: "", powerWord: "" });
  function dedupFor(sentences: Array<{ sceneIndex: number; beats: ReturnType<typeof sentence>[] }>) {
    return {
      lateYoutubeCandidates: [] as string[],
      beatRelevance: bvr.createBeatRelevanceLedger(),
      beatImageGate: { judgementAttempts: 0 },
      visionReviewPool: { beats: new Map() },
      usedContentKeys: new Set<string>(),
      sourcingCache: vp.createSourcingCache(645),
      sceneBeatsBySceneIndex: new Map(sentences.map((s) => [s.sceneIndex, s.beats])),
    };
  }
  type D = ReturnType<typeof dedupFor>;
  /** A fake hash per video id, so a moment's file name carries its video. */
  const hashOf = (id: string) => Buffer.from(id.padEnd(8, "_")).toString("hex").slice(0, 16).padEnd(16, "0");
  const videoOfPath = (ids: string[], p: string) => ids.find((id) => path.basename(p).includes(`__pid_youtube_cc-${hashOf(id)}`)) ?? null;
  const cap = Math.max(1, Math.ceil(maxRelevanceLooksPerBeat() / youtubeMomentsPerVideo()));

  /** The late stock of the test: every id has one 4 s shot already cut; `moments` records what it is asked for. */
  function lateStockOf(ids: string[], opts: { serves: (id: string, beatIndex: number) => boolean; targeted: (id: string) => boolean }) {
    const momentCalls: string[][] = [];
    let n = 0;
    return {
      momentCalls,
      videoIds: ids,
      serves: (id: string, _s: number, beat: { index: number }) => opts.serves(id, beat.index),
      targeted: opts.targeted,
      moments: async (beat: { index: number }, sceneIndex: number, wanted: string[]) => {
        momentCalls.push([...wanted]);
        return wanted.map((id) => video(path.join(dir, `scene_${sceneIndex}_ytfu_late${beat.index}m${n++}_t${100 + n}d40__pid_youtube_cc-${hashOf(id)}.mp4`), 4));
      },
    };
  }
  /** The picture editor of the test: a fit for moments of `fits` only; every verdict recorded like the real one. */
  function editor(d: D, ids: string[], fits: string | null) {
    return vi.fn(async (beat: { index: number }, sceneIndex: number, paths: string[]) => {
      for (const p of paths) {
        d.beatImageGate.judgementAttempts++;
        const ok = fits != null && videoOfPath(ids, p) === fits;
        d.beatRelevance.byBeat.set(bvr.beatRelevanceBeatKey(sceneIndex, beat.index, "path", p), { decision: { verdict: ok ? "fits" : "does_not_fit", evaluated: true } } as never);
        if (ok) {
          vp.noteApprovedPickForBeat(d, sceneIndex, beat.index, vp.clipContentKey(p));
          return p;
        }
      }
      return null;
    });
  }
  const results = (clipBeats: number[]) => [{ clips: [] as string[], beatDurations: [] as number[], clipBeatIndices: clipBeats }];
  const pool = (n: number) => Array.from({ length: n }, (_, i) => `pool${i}`);

  it("645 replayed: the sentence's slots are full of pool videos, the targeted video is left over; after 'no fit' it is handed once and the editor approves it", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const ids = [...pool(cap), "gmTarget"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "The Detroit Auto Show was a cathedral for giants like Ford and General Motors.")] }]);
    const stock = lateStockOf(ids, { serves: () => true, targeted: (id) => id === "gmTarget" });
    const look = editor(d, ids, "gmTarget");
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 20_000 }, stock);
    /** the first assignment left the targeted video without room … */
    expect(logs.some((l) => l === "[LateStock] video=gmTarget not assigned — every open sentence already holds what its looks can judge")).toBe(true);
    expect(stock.momentCalls[0]).toEqual(pool(cap));
    /** … the first look saw only the pool moments and found no fit … */
    expect(look).toHaveBeenCalledTimes(2);
    const first = look.mock.calls[0]![2] as string[];
    expect(first.every((p) => videoOfPath(ids, p) !== "gmTarget")).toBe(true);
    /** … then the one extra round handed it the targeted video, and the editor approved it */
    expect(stock.momentCalls[1]).toEqual(["gmTarget"]);
    const second = look.mock.calls[1]![2] as string[];
    expect(second.some((p) => videoOfPath(ids, p) === "gmTarget")).toBe(true);
    expect(logs.some((l) => l.startsWith("[LateStock] s0b0 extra round — targeted stock left unoffered") && l.includes("gmTarget") && l.includes("once per render"))).toBe(true);
    expect(vp.approvedPicksForBeat(d as never, 0, 0)).toBe(1);
  });

  it("a leftover that was NOT targeted is not re-offered: no extra round", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ids = [...pool(cap), "generic"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence without a picture.")] }]);
    const stock = lateStockOf(ids, { serves: () => true, targeted: () => false });
    const look = editor(d, ids, "generic");
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(look).toHaveBeenCalledTimes(1);
    expect(stock.momentCalls).toEqual([pool(cap)]);
  });

  it("a first look that finds a fit asks for nothing more", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ids = [...pool(cap), "gmTarget"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "A sentence without a picture.")] }]);
    const stock = lateStockOf(ids, { serves: () => true, targeted: (id) => id === "gmTarget" });
    const look = editor(d, ids, "pool0");
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(look).toHaveBeenCalledTimes(1);
    expect(stock.momentCalls).toEqual([pool(cap)]);
  });

  it("once per render: two sentences without a fit, two targeted leftovers serving both — exactly one extra round runs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const ids = [...pool(cap * 2), "gmA", "gmB"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "First sentence."), sentence(1, "Second sentence.")] }]);
    const stock = lateStockOf(ids, { serves: () => true, targeted: (id) => id.startsWith("gm") });
    const look = editor(d, ids, null);
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 30_000 }, stock);
    expect(logs.filter((l) => l.includes("extra round — targeted stock left unoffered")).length).toBe(1);
    /** two first looks (one per sentence) and one extra look */
    expect(look).toHaveBeenCalledTimes(3);
    expect(stock.momentCalls.length).toBe(3);
    const extra = stock.momentCalls[2]!;
    expect(extra.every((id) => id.startsWith("gm"))).toBe(true);
    expect(extra.length).toBeLessThanOrEqual(cap);
  });

  it("the targeted video only goes to a sentence it serves", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ids = [...pool(cap), "gmTarget"];
    const d = dedupFor([{ sceneIndex: 0, beats: [sentence(0, "First sentence.")] }]);
    /** the pool videos serve the sentence; the targeted one was searched for another, closed sentence */
    const stock = lateStockOf(ids, { serves: (id, beatIndex) => (id === "gmTarget" ? beatIndex === 7 : true), targeted: (id) => id === "gmTarget" });
    const look = editor(d, ids, "gmTarget");
    await vp.runFinalReadyYoutubeStage(d as never, [{ index: 0 }], results([]), look, { windowMs: 50, looksMs: 20_000 }, stock);
    expect(look).toHaveBeenCalledTimes(1);
    expect(stock.momentCalls).toEqual([pool(cap)]);
  });

  it("pinned: the extra round runs inside the stage's own guards — once per render, only after a first look without a fit, within the budget, through the same look", () => {
    const src = PIPE();
    const stage = src.slice(src.indexOf("export async function runFinalReadyYoutubeStage("), src.indexOf("export function formatFinalLookTally("));
    expect(stage).toContain("let extraRoundUsed = false;");
    expect(stage).toContain("if (extraRoundUsed || !lateStock || targetedLeftOver.length === 0 || stageOver || budget?.stopped()) return null;");
    expect(stage).toContain("if (budget && budget.leftMs() <= 0) return null;");
    expect(stage).toContain('if (why === "no_room" && lateStock.targeted?.(id) === true) targetedLeftOver.push(id);');
    expect(stage).toContain("const extra = first == null ? await extraTargetedStockRound(sceneIndex, beatIndex, beat) : first;");
    /** the same moment taker (claims a video for one sentence, skips seconds in the film) and the same look */
    expect(stage).toContain("const moments = await lateStock.moments(beat, sceneIndex, ids);");
    /** three callers of the one look: the first look, the extra targeted round, the second-section round (video645SecondSection.test.ts) */
    expect((stage.match(/finalReadyYoutubeLook\(dedup, sceneIndex, beatIndex, \(ready\) => look\(beat, sceneIndex, ready\), undefined, inventory\?\.\(beat, sceneIndex\)\);/g) ?? []).length).toBe(3);
    /** no search and no download anywhere in the stage */
    expect(stage).not.toMatch(/fetchYouTubeCCClips|downloadYouTubeCCClip|searchYoutube/);
  });
});
