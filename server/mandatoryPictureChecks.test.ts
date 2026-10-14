/**
 * FIX 1+2 (14 October) — every picture that reaches the film has passed both mandatory checks: the
 * picture editor's verdict for THIS sentence, and the on-screen-text check. Render 658 placed six
 * pictures nobody had looked at, while 64 of its 120 looks were left.
 *
 * No model and no network here: the checks are asked through injected functions, and the pipeline's
 * own readers are fed from the render's ledgers.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import { beatRelevanceBeatKey, createBeatRelevanceLedger, type BeatVisualContext } from "./beatVisualRelevance";
import { deliveryGate, pictureCheckMissing, type DeliveryClipFact } from "./deliveryGate";
import {
  contentCheckFromDecision,
  runMandatoryChecks,
  textCheckFromVerdict,
  type ContentCheck,
  type MandatoryCheckIo,
  type TextCheck,
} from "./mandatoryPictureChecks";
import type { SentenceCoverageReport } from "./sentenceCoverage";
import {
  clipContentKey,
  coverRestOfSentences,
  enforceMandatoryChecks,
  noteApprovedKeyForBeat,
  noteTextCheck,
  recordedContentForSentence,
  textCheckForClip,
  type CoverRestIo,
} from "./videoPipeline";

const SRC = (s: string) => fs.readFileSync(path.join(__dirname, s), "utf8");

/** An io whose every ask is counted, so a test can say exactly which calls a decision cost. */
function io(over: {
  content?: ContentCheck;
  text?: TextCheck | null;
  judge?: ContentCheck | (() => Promise<ContentCheck>);
  checkText?: TextCheck | (() => Promise<TextCheck>);
}) {
  const calls = { judge: 0, text: 0 };
  const value: MandatoryCheckIo = {
    recordedContent: () => over.content ?? "not_judged",
    recordedText: () => (over.text === undefined ? null : over.text),
    judgeContent: async () => {
      calls.judge++;
      return typeof over.judge === "function" ? over.judge() : over.judge ?? "not_judged";
    },
    checkText: async () => {
      calls.text++;
      return typeof over.checkText === "function" ? over.checkText() : over.checkText ?? "unchecked";
    },
  };
  return { io: value, calls };
}

function refuseOnLedger(ledger: ReturnType<typeof createBeatRelevanceLedger>, clipPath: string, c: BeatVisualContext, verdict = "does_not_fit", extra: object = {}) {
  const entry = {
    ctx: c,
    decision: { verdict, allowed: verdict !== "does_not_fit", reprieved: false, cached: false, depicts: "", reason: "test", evaluated: true, ...extra },
  } as never;
  ledger.byBeat.set(beatRelevanceBeatKey(c.sceneIndex, c.beatIndex, "path", clipPath), entry);
  ledger.byClipPath.set(clipPath, entry);
}

describe("1. an unjudged emergency picture is judged first", () => {
  it("no verdict on record → the picture editor is asked once, and a fit passes", async () => {
    const { io: x, calls } = io({ text: "clean", judge: "fit" });
    const out = await runMandatoryChecks(x);
    expect(out).toMatchObject({ pass: true, content: "fit", text: "clean", askedContent: true, askedText: false });
    expect(calls).toEqual({ judge: 1, text: 0 });
  });

  it("an acceptable verdict passes too — the existing rule, unchanged", async () => {
    expect((await runMandatoryChecks(io({ text: "clean", judge: "acceptable" }).io)).pass).toBe(true);
  });

  it("the emergency rung of 653 now goes through both checks before it places", () => {
    const pipe = SRC("videoPipeline.ts");
    const rung = pipe.slice(pipe.indexOf("export async function placeGenericMovingFallbacks("), pipe.indexOf("/** VIDEO 658 — the log name of a sentence's last seconds"));
    expect(rung).toContain("const unjudged = await firstCheckedFallback(");
    expect(rung).toContain("(p) => check(scene, beat, p, UNJUDGED_FOOTAGE_FALLBACK)");
    expect(rung).not.toContain("pickUnjudgedFallback(dedup, si, beat.index)");
  });
});

describe("2. a picture refused for its sentence is not placed", () => {
  it("a refusal on record fails for free: no text check, no look", async () => {
    const { io: x, calls } = io({ content: "refused" });
    const out = await runMandatoryChecks(x);
    expect(out.pass).toBe(false);
    expect(calls).toEqual({ judge: 0, text: 0 });
  });

  it("a fresh refusal fails", async () => {
    expect((await runMandatoryChecks(io({ text: "clean", judge: "refused" }).io)).pass).toBe(false);
  });

  it("a reprieved refusal is still a refusal, and 'could not tell' is not a yes", () => {
    expect(contentCheckFromDecision({ verdict: "does_not_fit", evaluated: true })).toBe("refused");
    expect(contentCheckFromDecision({ verdict: "unknown", evaluated: true })).toBe("refused");
  });

  it("655's rung (a refused picture reprieved as the last resort) no longer places anything", () => {
    const pipe = SRC("videoPipeline.ts");
    const rung = pipe.slice(pipe.indexOf("export async function placeGenericMovingFallbacks("), pipe.indexOf("/** VIDEO 658 — the log name of a sentence's last seconds"));
    expect(rung).not.toContain("reprieveAsLastResort(");
    expect(rung).toContain("a refused picture is never placed");
  });
});

describe("3. no valid verdict, no placement", () => {
  it("the picture editor could not look (budget, outage, clock) → fail", async () => {
    expect((await runMandatoryChecks(io({ text: "clean", judge: "not_judged" }).io)).pass).toBe(false);
  });

  it("the look throws → fail, never a silent pass", async () => {
    const out = await runMandatoryChecks(io({ text: "clean", judge: () => Promise.reject(new Error("timeout")) }).io);
    expect(out).toMatchObject({ pass: false, content: "not_judged" });
  });

  it("a decline is not_judged, never a fit", () => {
    expect(contentCheckFromDecision({ verdict: "fits", evaluated: false })).toBe("not_judged");
    expect(contentCheckFromDecision(null)).toBe("not_judged");
  });
});

describe("4. a picture without a text verdict gets one first", () => {
  it("text unknown → the text check runs before the look", async () => {
    const order: string[] = [];
    const out = await runMandatoryChecks({
      recordedContent: () => "not_judged",
      recordedText: () => null,
      checkText: async () => (order.push("text"), "clean"),
      judgeContent: async () => (order.push("judge"), "fit"),
    });
    expect(out.pass).toBe(true);
    expect(order).toEqual(["text", "judge"]);
  });
});

describe("5. text that IS the picture is not placed", () => {
  it("fills_picture fails, and no look is paid for", async () => {
    const { io: x, calls } = io({ checkText: "fills_picture", judge: "fit" });
    const out = await runMandatoryChecks(x);
    expect(out).toMatchObject({ pass: false, text: "fills_picture" });
    expect(calls.judge).toBe(0);
  });

  it("an overlay over real footage goes on to the picture editor, as before", async () => {
    const out = await runMandatoryChecks(io({ checkText: "overlay", judge: "fit" }).io);
    expect(out).toMatchObject({ pass: true, text: "overlay" });
  });

  it("the detector's answers map to the existing rules", () => {
    expect(textCheckFromVerdict({ decision: "REJECT", evaluated: true, textKind: "fills_picture" })).toBe("fills_picture");
    expect(textCheckFromVerdict({ decision: "REJECT", evaluated: true, textKind: "overlay" })).toBe("overlay");
    expect(textCheckFromVerdict({ decision: "REJECT", evaluated: true })).toBe("overlay");
    expect(textCheckFromVerdict({ decision: "ACCEPT", evaluated: true })).toBe("clean");
  });
});

describe("6. a failed or unavailable text check is never a silent pass", () => {
  it("not asked (budget, outage) → unchecked → fail, and no look is paid for", async () => {
    expect(textCheckFromVerdict({ decision: "ACCEPT", evaluated: false })).toBe("unchecked");
    expect(textCheckFromVerdict(null)).toBe("unchecked");
    const { io: x, calls } = io({ checkText: "unchecked", judge: "fit" });
    expect(await runMandatoryChecks(x)).toMatchObject({ pass: false, text: "unchecked" });
    expect(calls.judge).toBe(0);
  });

  it("the text check throws → fail", async () => {
    expect((await runMandatoryChecks(io({ checkText: () => Promise.reject(new Error("429")), judge: "fit" }).io)).pass).toBe(false);
  });

  it("an unanswered text check is not remembered as clean", () => {
    const dedup = {};
    noteTextCheck(dedup, "pexels:1", "unchecked");
    expect(textCheckForClip(dedup, "pexels:1")).toBeNull();
    noteTextCheck(dedup, "pexels:1", "clean");
    expect(textCheckForClip(dedup, "pexels:1")).toBe("clean");
  });
});

describe("7. a valid recorded answer is reused, without a second call", () => {
  it("both on record → pass with zero calls", async () => {
    const { io: x, calls } = io({ content: "fit", text: "clean" });
    expect(await runMandatoryChecks(x)).toMatchObject({ pass: true, askedContent: false, askedText: false });
    expect(calls).toEqual({ judge: 0, text: 0 });
  });

  it("the normal route's text verdict is written where the mandatory check reads it", () => {
    const pipe = SRC("videoPipeline.ts");
    expect(pipe).toContain("noteTextCheck(dedup, contentKey, textCheckFromVerdict(text));");
  });
});

describe("8. a verdict for another sentence is not an approval for this one", () => {
  it("the ledger is read per sentence", () => {
    const ledger = createBeatRelevanceLedger();
    const clip = "/w/scene_2_ytfu_t100d40__pid_youtube_cc-0123456789abcdef.mp4";
    refuseOnLedger(ledger, clip, { sceneIndex: 2, beatIndex: 0, beatText: "A line." }, "fits");
    const dedup = { beatRelevance: ledger };
    expect(recordedContentForSentence(dedup as never, 2, 0, clip, clipContentKey(clip))).toBe("fit");
    expect(recordedContentForSentence(dedup as never, 2, 1, clip, clipContentKey(clip))).toBe("not_judged");
  });

  it("an approval key filed under another sentence does not count", () => {
    const dedup = { beatRelevance: createBeatRelevanceLedger() };
    const clip = "/w/scene_1_b0_x__pid_pexels-00000000000000aa.mp4";
    noteApprovedKeyForBeat(dedup, 1, 0, clipContentKey(clip));
    expect(recordedContentForSentence(dedup as never, 1, 0, clip, clipContentKey(clip))).toBe("fit");
    expect(recordedContentForSentence(dedup as never, 1, 2, clip, clipContentKey(clip))).toBe("not_judged");
  });
});

describe("9. generated pictures go through both checks too", () => {
  it("a generated picture is checked before it stands under its sentence; nothing overrules a refusal", () => {
    const pipe = SRC("videoPipeline.ts");
    const gen = pipe.slice(pipe.indexOf("export async function generateMissingBeatImages("), pipe.indexOf("export const UNJUDGED_FOOTAGE_FALLBACK"));
    expect(gen).toContain("checkPictureForSentence(dedup, scene, beat, clip, workDir, videoTitle, GENERATED_IMAGE_FALLBACK)");
    expect(pipe).not.toContain("keepGeneratedForSentence");
  });

  it("at delivery, an AI-generated clip without a text check blocks the film", () => {
    expect(pictureCheckMissing({ isPlaceholder: false, contentApproval: "judge_fit", textCheck: "unchecked" })).toMatch(/no passed text check/);
  });
});

/* ── the delivery gate ── */

const clipFact = (over: Partial<DeliveryClipFact>): DeliveryClipFact => ({
  clipId: "vc_1",
  archiveAssetId: 1,
  provider: "youtube_cc",
  resolved: true,
  fromArchive: true,
  isPlaceholder: false,
  contentApproval: "judge_fit",
  textCheck: "clean",
  ...over,
});

const gate = (clips: DeliveryClipFact[], enforce: boolean, coverage?: SentenceCoverageReport) =>
  deliveryGate({ videoId: 1, route: "cinematic_timeline", timelineExists: true, clips, delivered: null, assetsOnly: true, enforcePictureChecks: enforce, ...(coverage ? { sentenceCoverage: coverage } : {}) });

describe("10. the delivery gate blocks every clip that misses a mandatory check", () => {
  it("both checks on every clip → delivered", () => {
    expect(gate([clipFact({}), clipFact({ clipId: "vc_2", contentApproval: "judge_acceptable", textCheck: "overlay" })], true).allow).toBe(true);
  });

  it.each([
    ["unverified", "clean"],
    ["generic_footage", "clean"],
    [undefined, "clean"],
    ["judge_fit", "unchecked"],
    ["judge_fit", "fills_picture"],
    ["judge_fit", undefined],
  ])("contentApproval=%s textCheck=%s → blocked", (contentApproval, textCheck) => {
    const v = gate([clipFact({ contentApproval: contentApproval ?? null, textCheck: textCheck ?? null })], true);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.failures.map((f) => f.code)).toContain("PICTURE_NOT_CHECKED");
  });

  it("a sentence with no checked picture blocks the film, named", () => {
    const coverage = {
      basis: "timeline", total: 1, covered: 0, partial: 0, uncovered: 1, unknown: 0, stretchedClips: 0, cardIntervals: [], plannedCardSec: 0,
      proven: false, timing: "exact", problems: [],
      sentences: [{
        key: "s0b1", sceneIndex: 0, beatIndex: 1, text: "The oceans remained unexplored.", startSec: 0, endSec: 4, spokenSec: 4,
        timingBasis: "measured", status: "uncovered", coveredSec: 0, approvedFootageSec: 0, acceptableFootageSec: 0, aiGeneratedSec: 0,
        genericFootageSec: 0, syntheticPlaceholderSec: 0, contentGraphicSec: 0, unverifiedSec: 0, otherSentenceSec: 0, stretchedSec: 0,
        cardSec: 0, emptySec: 4, kinds: ["none"], reasons: ["nothing on screen"],
      }],
    } as unknown as SentenceCoverageReport;
    const v = gate([clipFact({})], true, coverage);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.failures.find((f) => f.code === "SENTENCE_WITHOUT_CHECKED_PICTURE")?.detail).toContain("s0b1");
  });

  it("a render the owner asked for from the editor is the owner's choice: not blocked on these marks", () => {
    expect(gate([clipFact({ contentApproval: null, textCheck: null })], false).allow).toBe(true);
  });

  it("the worker enforces it for every film the pipeline queued, from the timeline's own marks", () => {
    const worker = SRC("renderJobWorker.ts");
    expect(worker).toContain("enforcePictureChecks: job.requestedByUserId == null,");
    expect(worker).toContain("contentApproval: clip.source.contentApproval ?? null,");
    expect(worker).toContain("textCheck: clip.source.textCheck ?? null,");
    expect(SRC("videoPipeline.ts")).toContain('textCheck: textCheckForClip(visualDedup, clipContentKey(clipPath)) ?? ("unchecked" as const),');
  });
});

/* ── the routes, run ── */

describe("the safety net takes out what fails and keeps what passed", () => {
  it("a refused clip leaves (no call), a fully recorded clip stays (no call)", async () => {
    const ledger = createBeatRelevanceLedger();
    const good = "/w/scene_0_b0_a__pid_pexels-00000000000000a1.mp4";
    const bad = "/w/scene_0_b0_b__pid_serpapi-00000000000000b2.mp4";
    const dedup = {
      beatRelevance: ledger,
      sceneBeatsBySceneIndex: new Map([[0, [{ index: 0, text: "A line.", holdSec: 6 }]]]),
      archiveAssetsCache: new Map(),
    } as never as Parameters<typeof enforceMandatoryChecks>[2];
    noteApprovedKeyForBeat(dedup, 0, 0, clipContentKey(good));
    noteTextCheck(dedup, clipContentKey(good), "clean");
    refuseOnLedger(ledger, bad, { sceneIndex: 0, beatIndex: 0, beatText: "A line." });
    const vr = { clips: [good, bad], beatDurations: [3, 3], clipBeatIndices: [0, 0] };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await enforceMandatoryChecks([{ index: 0, text: "A line." } as never], [vr], dedup, "/w", "Film", "test");
    log.mockRestore();
    warn.mockRestore();
    expect(out).toEqual({ checked: 2, removed: 1 });
    expect(vr).toEqual({ clips: [good], beatDurations: [3], clipBeatIndices: [0] });
  });
});

describe("the picture behind a short shot is checked like every other", () => {
  const run = async (check: CoverRestIo["check"], generic: CoverRestIo["genericClip"] = async () => null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix12-rest-"));
    const own = path.join(dir, "scene_0_ytfu_0m1_t1000d40__pid_youtube_cc-aaaaaaaaaaaaaaaa.mp4");
    const next = path.join(dir, "scene_0_ytfu_0m2_t1040d38__pid_youtube_cc-aaaaaaaaaaaaaaaa.mp4");
    for (const f of [own, next]) fs.writeFileSync(f, "x");
    const beat = { index: 1, text: "A line.", holdSec: 8 };
    const vr = { clips: [own], beatDurations: [4], clipBeatIndices: [1], beats: [beat] };
    const dedup = {
      sceneBeatsBySceneIndex: new Map([[0, [beat]]]),
      beatCandidateCalls: new Map([["0:1", [{ paths: [own, next], beatText: beat.text, sourceQuery: "", opts: {} }]]]),
      beatRelevance: createBeatRelevanceLedger(),
      usedPaths: new Set<string>(),
      usedContentKeys: new Set<string>(),
      usedCuratedAssetIds: new Set<number>(),
      usedCuratedStorageUrls: new Set<string>(),
      refusedAssetsThisRender: new Set<string>(),
    };
    const ioX: CoverRestIo = { checks: { valid: async () => true, durationSec: async () => 4, black: async () => false }, check, genericClip: generic };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await coverRestOfSentences([{ index: 0, text: "" } as never], [vr as never], dedup as never, dir, ioX);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    return { vr, own, next };
  };

  it("passes both checks → placed behind the shot", async () => {
    const { vr, own, next } = await run(async () => true);
    expect(vr.clips).toEqual([own, next]);
  });

  it("fails a check → not placed; a generic clip that fails is not placed either", async () => {
    const asked: string[] = [];
    const { vr, own } = await run(async (_s, _b, p) => (asked.push(path.basename(p)), false), async () => ({ path: "/w/generic.mp4", durationSec: 6 }));
    expect(vr.clips).toEqual([own]);
    expect(asked).toContain("generic.mp4");
  });
});
