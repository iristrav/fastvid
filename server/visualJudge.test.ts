/**
 * ONE ROUTE — the VisualJudge is the one content decision.
 *
 *     search → TechnicalMediaGate → ranking → VisualJudge → adoptClip → push → timeline
 *
 * The behaviour cases feed real inputs in and read the verdicts that come out. The last block is
 * structural on purpose: "nobody else decides" is a property of the code base, and the only way to
 * hold it is to look for a second decider wherever one could be written.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => ({ fn: vi.fn() }));
const overlay = vi.hoisted(() => ({
  budgeted: vi.fn(),
  archive: vi.fn(),
  unmemoised: vi.fn(),
}));
vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: invoke.fn,
}));
vi.mock("./archiveClipFilter", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prepareImageForVision: async (buf: Buffer) => ({ buffer: buf, mimeType: "image/jpeg" }),
  imageMimeToDataUrl: () => "data:image/jpeg;base64,AA",
  cachedClipBakedEditTextVerdict: overlay.budgeted,
  archiveClipTextVerdict: overlay.archive,
  archiveClipBakedEditTextVerdict: overlay.unmemoised,
}));
/** The real extractor shells out to ffmpeg; here it writes the frame the judge will read. */
vi.mock("./localClipVision", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  extractFrameAtFraction: async (_clip: string, out: string) => {
    fs.writeFileSync(out, "frame");
    return true;
  },
}));

import { judgeArchiveAsset, judgeAtPush, judgeCandidateMetadata, judgeFootageTitle, judgeFootageType, judgeOnScreenText, judgePicture, judgeStockResult, reprieveBeatClip, type CandidateJudgeInput } from "./visualJudge";
import { createBeatImageGateState } from "./beatImageRelevanceGate";
import { createBeatRelevanceLedger, type BeatVisualContext } from "./beatVisualRelevance";
import { __resetVerdictStoreForTests } from "./beatRelevanceVerdictStore";
import { mergeVisualIntentsIntoMetadata, withRenderVisualPlan } from "./scriptVisualKeywords";
import { directorSceneToIntent } from "./visualDirector";
import { ADOPT_MIN_FILE_BYTES, technicalFileRefusal, technicalMediaRefusal } from "./technicalMediaGate";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-judge-"));
const CLIP = path.join(dir, "clip.mp4");
fs.writeFileSync(CLIP, "video");

const LINE = "Soviet artillery closed on the Reichstag in the last days of April 1945.";
const BEAT: BeatVisualContext = {
  sceneIndex: 1,
  beatIndex: 2,
  beatText: LINE,
  sceneText: "The battle for the city centre.",
  videoTitle: "The Fall of Berlin",
};

function answers(belongs: boolean, depicts = "a thing"): void {
  invoke.fn.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ depicts, belongs, reason: "why" }) } }],
  });
}

/** The text of the last prompt the picture model was sent. */
function lastPrompt(): string {
  const call = invoke.fn.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
  const user = call.messages.at(-1)!.content as Array<{ type: string; text?: string }>;
  return user.find((p) => p.type === "text")!.text!;
}

beforeEach(() => {
  invoke.fn.mockReset();
  overlay.budgeted.mockReset();
  overlay.archive.mockReset();
  overlay.unmemoised.mockReset();
  __resetVerdictStoreForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/* ═══════════ 1. metadata: what is written about a candidate ═══════════ */

describe("VisualJudge — a candidate judged on what is written about it", () => {
  const base = (over: Partial<CandidateJudgeInput> = {}): CandidateJudgeInput => ({
    path: "/w/scene_1_b2_clip.mp4",
    sourceQuery: "soviet artillery berlin 1945",
    beatText: LINE,
    videoTitle: "The Fall of Berlin",
    requireBeatMatch: false,
    scriptAnchored: false,
    entityRules: [],
    signals: { beatMatch: 2, queryInBeat: true, providerTitleSharesNothing: false },
    where: "s1b2",
    ...over,
  });

  it("an ordinary candidate is accepted, with full confidence — the rules are deterministic", () => {
    const v = judgeCandidateMetadata(base());
    expect(v).toMatchObject({ decision: "ACCEPT", stage: "metadata", confidence: 1 });
  });

  it("a miniature, a render or a diorama is refused under its old reason", () => {
    expect(judgeCandidateMetadata(base({ sourceQuery: "miniature diorama tank" })).reason).toBe("rejected_stock");
  });

  it("a person video's wildlife B-roll is refused AND NAMED — it used to vanish without a reason", () => {
    const v = judgeCandidateMetadata(
      base({ personTopic: true, primaryPerson: "Kylie Jenner", sourceQuery: "flamingos lake", beatText: "Kylie Jenner grew up in Calabasas." })
    );
    expect(v.decision).toBe("REJECT");
    expect(v.reason).toBe("person_topic_off_topic_visual");
  });

  it("a sentence that names a person needs independent evidence the person is shown", () => {
    const rule = {
      id: "person:kris jenner",
      kind: "person" as const,
      fullName: "Kris Jenner",
      mentionRe: /kris jenner/i,
      clipMustMatchRe: /(?<![\p{L}\p{N}])(?:kris|jenner)(?![\p{L}\p{N}])/iu,
      stockQueries: ["Kris Jenner"],
      youtubeQueries: ["Kris Jenner"],
    };
    const without = judgeCandidateMetadata(base({ entityRules: [rule], sourceQuery: "kris jenner interview" }));
    expect(without.reason).toBe("entity_evidence");
    const withEvidence = judgeCandidateMetadata(
      base({ entityRules: [rule], meta: { providerText: { title: "Kris Jenner on the red carpet" } } })
    );
    expect(withEvidence.decision).toBe("ACCEPT");
  });

  it("the strict anchoring rules apply, and the script-image route is exempt from them only", () => {
    const loose = { beatMatch: 0, queryInBeat: false, providerTitleSharesNothing: false };
    expect(judgeCandidateMetadata(base({ requireBeatMatch: true, signals: loose })).reason).toBe("no_beat_match");
    expect(judgeCandidateMetadata(base({ scriptAnchored: true, signals: loose })).reason).toBe("not_script_anchored");
    expect(judgeCandidateMetadata(base({ requireBeatMatch: true, scriptImageFallback: true, signals: loose })).decision).toBe("ACCEPT");
    // …and the script-image route still faces the rest: a diorama is a diorama on every route.
    expect(judgeCandidateMetadata(base({ scriptImageFallback: true, sourceQuery: "diorama" })).decision).toBe("REJECT");
  });

  it("a provider title that shares nothing with the sentence is flagged, never refused (RONDE 114)", () => {
    const v = judgeCandidateMetadata(
      base({
        meta: { providerText: { title: "Bundesarchiv Bild 183-S33882" } },
        signals: { beatMatch: 2, queryInBeat: true, providerTitleSharesNothing: true },
      })
    );
    expect(v.decision).toBe("ACCEPT");
  });

  it("a stock search result is judged on its slug and tags before anything is downloaded", () => {
    expect(judgeStockResult({ slug: "https://pexels.com/video/toy-rocket-diorama-123" }).decision).toBe("REJECT");
    expect(judgeStockResult({ tags: "cartoon, animation" }).decision).toBe("REJECT");
    expect(judgeStockResult({ slug: "https://pexels.com/video/berlin-street-1945-9" }).decision).toBe("ACCEPT");
  });

  it("a YouTube result: the title genre and the thumbnail's footage type", () => {
    expect(judgeFootageType("real_footage").decision).toBe("ACCEPT");
    expect(judgeFootageType("archival_footage").decision).toBe("ACCEPT");
    expect(judgeFootageType("commentary")).toMatchObject({ decision: "REJECT", reason: "footage type commentary" });
    expect(judgeFootageTitle("Hitler reacts to losing Minecraft (parody)").decision).toBe("REJECT");
    expect(judgeFootageTitle("The Battle of Berlin 1945 — archive film").decision).toBe("ACCEPT");
  });
});

/* ═══════════ 2. the own archive: the matcher's candidates ═══════════ */

describe("VisualJudge — an own-archive asset, before it is prepared", () => {
  const asset = (tags: string[], title = "clip") => ({ title, tags, mediaType: "video" as const, mixKind: null });

  it("a non-documentary asset is refused whatever the switches say", () => {
    const v = judgeArchiveAsset({ asset: asset(["cartoon", "animation"]), beatText: LINE, score: 80, topScore: 80 });
    expect(v).toMatchObject({ decision: "REJECT", reason: "non_documentary_tags", stage: "metadata" });
  });
});

/* ═══════════ 3. someone else's text on screen ═══════════ */

describe("VisualJudge — on-screen text: one question, three ways of paying for it", () => {
  it("a render's candidate is memoised and counted against the render's budget", async () => {
    overlay.budgeted.mockResolvedValueOnce({ verdict: "has_text", reason: "a news chyron" });
    const v = await judgeOnScreenText({ path: CLIP, mimeType: "video/mp4", memoKey: "k", budget: 12 });
    expect(overlay.budgeted).toHaveBeenCalledWith(CLIP, "video/mp4", "k", 12);
    expect(v).toMatchObject({ decision: "REJECT", reason: "a news chyron", stage: "on_screen_text", evaluated: true });
  });

  it("the archive's own door is memoised and never on a render's budget", async () => {
    overlay.archive.mockResolvedValueOnce({ verdict: "clean" });
    const v = await judgeOnScreenText({ path: CLIP, mimeType: "video/mp4", memoKey: "k" });
    expect(overlay.archive).toHaveBeenCalledWith(CLIP, "video/mp4", "k");
    expect(overlay.budgeted).not.toHaveBeenCalled();
    expect(v).toMatchObject({ decision: "ACCEPT", evaluated: true });
  });

  it("nobody looked is an ACCEPT that cannot be written down as clean (RONDE 222)", async () => {
    overlay.unmemoised.mockResolvedValueOnce({ verdict: "not_asked", reason: "budget spent" });
    const v = await judgeOnScreenText({ path: CLIP, mimeType: "video/mp4" });
    expect(v).toMatchObject({ decision: "ACCEPT", evaluated: false, confidence: 0, notAskedReason: "budget spent" });
  });
});

/* ═══════════ 4. the picture, with the VisualIntent ═══════════ */

describe("VisualJudge — the picture model sees the VisualIntent plan", () => {
  const plan = mergeVisualIntentsIntoMetadata({}, [
    directorSceneToIntent({
      source_sentence_index: 0,
      spoken_text: LINE,
      visual_description: "Soviet artillery firing across a ruined Berlin street toward the Reichstag.",
      camera_shot: "wide shot",
      emotion: "grim",
      search_query: "soviet artillery berlin 1945",
    }),
  ]);
  const ask = () =>
    judgePicture({
      clipPath: CLIP,
      contentKey: "archive:991",
      ctx: BEAT,
      workDir: dir,
      state: createBeatImageGateState(),
      ledger: createBeatRelevanceLedger(),
      route: "test",
    });

  it("a planned line: the plan's description is NOT in the prompt (video 635: the model took it as the requirement)", async () => {
    answers(true, "artillery in a ruined street");
    const { verdict } = await withRenderVisualPlan(plan, ask);
    expect(verdict).toMatchObject({ decision: "ACCEPT", stage: "picture", evaluated: true });
    const prompt = lastPrompt();
    expect(prompt).not.toContain("Soviet artillery firing across a ruined Berlin street toward the Reichstag.");
    expect(prompt).not.toContain("visual plan for this line");
  });

  it("an unplanned line gets no plan line, and the model still decides", async () => {
    answers(false, "a modern parking garage");
    const { verdict, decision } = await ask();
    expect(lastPrompt()).not.toContain("visual plan for this line");
    expect(decision.verdict).toBe("does_not_fit");
    expect(verdict).toMatchObject({ decision: "REJECT", stage: "picture" });
  });
});

/* ═══════════ 5. at the push: one reader ═══════════ */

describe("VisualJudge — at the push the one answer is read once", () => {
  const judged = async (belongs: boolean) => {
    const ledger = createBeatRelevanceLedger();
    answers(belongs);
    await judgePicture({
      clipPath: CLIP,
      contentKey: "archive:5",
      ctx: BEAT,
      workDir: dir,
      state: createBeatImageGateState(),
      ledger,
      route: "test",
    });
    return ledger;
  };
  const at = { sceneIndex: BEAT.sceneIndex, beatIndex: BEAT.beatIndex };

  it("a refusal nobody reprieved is turned away by the barrier", async () => {
    const ledger = await judged(false);
    const v = judgeAtPush({ barrier: [ledger, CLIP, "archive:5", at], route: null });
    expect(v).toMatchObject({ decision: "REJECT", by: "barrier" });
  });

  it("no refusal can be overruled (RONDE 200): a reprieve is declined and the barrier still refuses", async () => {
    const ledger = await judged(false);
    expect(reprieveBeatClip(ledger, CLIP, "every alternative failed too")).toBe(false);
    expect(judgeAtPush({ barrier: [ledger, CLIP, "archive:5", at], route: null }).decision).toBe("REJECT");
  });

  it("an approved picture still faces the route rule: a route claiming real footage needs eligibility", async () => {
    const ledger = await judged(true);
    const refused = judgeAtPush({
      barrier: [ledger, CLIP, "archive:5", at],
      route: { source: "archive", eligible: false, vision: "APPROVED", visionAvailable: true },
    });
    expect(refused).toMatchObject({ decision: "REJECT", by: "route" });
    expect(refused.code).toBeTruthy();
    const allowed = judgeAtPush({
      barrier: [ledger, CLIP, "archive:5", at],
      route: { source: "archive", eligible: true, vision: "APPROVED", visionAvailable: true },
    });
    expect(allowed).toMatchObject({ decision: "ACCEPT", by: "route" });
  });
});

/* ═══════════ 6. the TechnicalMediaGate: the file, never the content ═══════════ */

describe("TechnicalMediaGate — can this FILE be used at all?", () => {
  it("missing and truncated files are refused before anything is spawned", () => {
    expect(technicalFileRefusal(path.join(dir, "nope.mp4"))).toBe("file_missing");
    const small = path.join(dir, "small.mp4");
    fs.writeFileSync(small, Buffer.alloc(1000));
    expect(technicalFileRefusal(small)).toBe("below_size_floor_1000_bytes");
    const big = path.join(dir, "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(ADOPT_MIN_FILE_BYTES));
    expect(technicalFileRefusal(big)).toBeNull();
  });

  it("the probed checks run cheapest first and stop at the first refusal", async () => {
    const order: string[] = [];
    const probes = {
      isValidVideo: async () => (order.push("valid"), true),
      isPipelineFallback: () => (order.push("fallback"), false),
      isMostlyBlack: async () => (order.push("black"), true),
    };
    expect(await technicalMediaRefusal("/x.mp4", probes)).toBe("mostly_black");
    expect(order).toEqual(["valid", "fallback", "black"]);
    order.length = 0;
    expect(await technicalMediaRefusal("/x.mp4", { ...probes, isValidVideo: async () => (order.push("valid"), false) })).toBe(
      "not_a_valid_video"
    );
    expect(order).toEqual(["valid"]);
  });
});

/* ═══════════ 7. nobody else decides ═══════════ */

describe("ONE ROUTE — no second content decider exists", () => {
  const SERVER = __dirname;
  const production = fs
    .readdirSync(SERVER)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(SERVER, f), "utf8") }));
  /** The picture model, its ledger, the on-screen-text detector and the route policy: the judge's own parts. */
  const INTERNAL = new Set([
    "visualJudge.ts",
    "beatVisualRelevance.ts",
    "beatImageRelevanceGate.ts",
    "adoptionPolicy.ts",
    "archiveClipFilter.ts",
  ]);

  it("the deciders are only CALLED inside the VisualJudge and its own parts", () => {
    const deciders = [
      "checkBeatRelevance",
      "judgeBeatImage",
      "composeBarrierAllows",
      "adoptionGuardVerdict",
      "cachedClipBakedEditTextVerdict",
      "archiveClipTextVerdict",
      "archiveClipBakedEditTextVerdict",
      "isRejectedStockClip",
      "isOffTopicVisualForPersonTopic",
      "clipSatisfiesRealEntities",
      "judgeDocumentaryBeatGate",
      "youtubeTitleIsNotFootage",
      "hasBlockedStockTags",
    ];
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const { file, src } of production) {
      if (INTERNAL.has(file)) continue;
      const code = strip(src);
      for (const d of deciders) {
        expect(new RegExp(`\\b${d}\\(`).test(code), `${file} decides on content itself via ${d}`).toBe(false);
      }
    }
  });

  it("the replaced deciders are gone, not kept beside the new owner", () => {
    const gone = [
      "assetPassesBeatMinimum",
      "archiveAssetRejectedForBeat",
      "isArchiveGeoBlockedForBeat",
      "relevanceGateRefusesClip",
      "adoptionGuardRefusesPush",
      "clipPassesDocumentaryBeatGate",
      "clipPassesGeoUrbanBeatGate",
      "clipPassesVidrushOpeningGate",
      "isRejectedPexelsVideo",
      "formatBackfillApprovalSuspensions",
      "backfillRefusedWithoutApproval",
    ];
    for (const { file, src } of production) {
      for (const name of gone) expect(src.includes(name), `${file} still carries ${name}`).toBe(false);
    }
  });

  it("adoptClip decides nothing about content itself — it asks the gate and the judge", () => {
    const PIPE = fs.readFileSync(path.join(SERVER, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("async function adoptClip(");
    const body = PIPE.slice(at, PIPE.indexOf("\nfunction slotHasNoBeatBehindIt(", at));
    expect(body).toContain("technicalFileRefusal(p)");
    expect(body).toContain("await technicalMediaRefusal(p, MEDIA_PROBES)");
    expect(body).toContain("judgeCandidateMetadata({");
    expect(body).toContain("judgeOnScreenText({");
    for (const reason of ["stock_without_person", "documentary_beat_gate", "entity_evidence", "no_beat_match", "person_not_named", "rejected_stock", "ai_generated"]) {
      expect(body.includes(`"${reason}"`), `adoptClip refuses "${reason}" by itself again`).toBe(false);
    }
  });

  it("the push has ONE reader of the verdict, and it asks for the look itself", () => {
    const PIPE = fs.readFileSync(path.join(SERVER, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("export async function visualJudgeRefusesPush(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.match(/ensureVerdictBeforeCompose\(/g)?.length).toBe(1);
    expect(body.match(/judgeAtPush\(/g)?.length).toBe(1);
  });
});
