/**
 * RONDE 103 — one decider, one barrier, and no way round either.
 *
 * RONDE 101 proved how a demonstrably wrong picture reached a finished video despite two gates
 * being in place. Three root causes, each with line numbers:
 *
 *   RC-1  the LLM gate was not where the CLIP gate was. CLIP covered all routes; the LLM gate had
 *         ONE caller, and twelve adopt/rescue routes reached neither.
 *   RC-2  every LLM failure adopted, and the failures that cost nothing (budget spent, no frame)
 *         did not even increment a counter — so the render summary reported a clean sheet for a
 *         render that had stopped looking.
 *   RC-3  there was no final barrier. composeSceneVideoInner had zero relevance checks.
 *
 * This file is about whether those three are actually closed, and it deliberately mixes two kinds
 * of test: behavioural ones that run the gate, and structural ones that read the pipeline. The
 * structural ones matter because RC-1 is a wiring defect — a gate can be perfect and still be
 * bypassed, and no behavioural test of the gate can see that.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { createBeatImageGateState, type BeatImageGateState } from "./beatImageRelevanceGate";
import {
  barrierCoverage,
  beatIdentityKey,
  checkBeatRelevance,
  composeBarrierAllows,
  createBeatRelevanceLedger,
  formatRelevanceSummary,
  inheritBeatRelevance,
  maxRelevanceLooksPerBeat,
  reprieveBeatClip,
  type BeatRelevanceLedger,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { __resetVerdictStoreForTests } from "./beatRelevanceVerdictStore";
import {  } from "./videoPipeline";

const invoke = vi.hoisted(() => ({ fn: vi.fn() }));
// RONDE 115: the gate now asks llm.ts whether a throw was a PRE-FLIGHT refusal (no key,
// every provider cooled down, budget spent) rather than a provider failure. The real
// predicate is used, not a stub — these tests are about provider failures and must keep
// landing in `failed`, which is exactly what the real predicate says about them.
vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: invoke.fn,
}));
vi.mock("./archiveClipFilter", () => ({
  prepareImageForVision: async (buf: Buffer) => ({ buffer: buf, mimeType: "image/jpeg" }),
  imageMimeToDataUrl: () => "data:image/jpeg;base64,AA",
}));
/** The real extractor shells out to ffmpeg; here it just writes the file the gate will read. */
vi.mock("./localClipVision", () => ({
  extractFrameAtFraction: async (_clip: string, out: string) => {
    fs.writeFileSync(out, "frame");
    return true;
  },
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r103-gate-"));
const CLIP = path.join(dir, "clip.mp4");
fs.writeFileSync(CLIP, "video");

const BEAT: BeatVisualContext = {
  sceneIndex: 2,
  beatIndex: 4,
  beatText: "Soviet artillery closed on the Reichstag in the last days of April 1945.",
  sceneText: "The battle for the city centre.",
  videoTitle: "The Fall of Berlin",
};

function answers(belongs: boolean, depicts = "a thing"): void {
  invoke.fn.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ depicts, belongs, reason: "why" }) } }],
  });
}

let state: BeatImageGateState;
let ledger: BeatRelevanceLedger;

beforeEach(() => {
  invoke.fn.mockReset();
  /**
   * RONDE 104: the durable verdict store keeps a process-level cache in front of the database,
   * and it is deliberately NOT render-scoped — a verdict about a (picture, narration) pair is the
   * same fact whoever asks. That is the feature, and it means these suites must clear it between
   * tests, or one test's answer silently answers the next test's question.
   */
  __resetVerdictStoreForTests();
  state = createBeatImageGateState();
  ledger = createBeatRelevanceLedger();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function ask(
  over: Partial<Parameters<typeof checkBeatRelevance>[0]> = {}
): ReturnType<typeof checkBeatRelevance> {
  return checkBeatRelevance({
    clipPath: CLIP,
    contentKey: "archive:77",
    ctx: BEAT,
    workDir: dir,
    state,
    ledger,
    route: "test",
    ...over,
  });
}

/* ═══════════ the decision itself ═══════════ */

describe("RONDE 103 — what the central gate decides", () => {
  it("a definite refusal is the ONLY thing that costs a clip its place", async () => {
    answers(false);
    const d = await ask();
    expect(d.verdict).toBe("does_not_fit");
    expect(d.allowed).toBe(false);
  });

  it("an acceptance is allowed and recorded as `fits`", async () => {
    answers(true);
    const d = await ask();
    expect(d.verdict).toBe("fits");
    expect(d.allowed).toBe(true);
  });

  it("RC-2 — a model outage adopts, but is never recorded as `fits`", async () => {
    invoke.fn.mockRejectedValueOnce(new Error("Gemini API error 429"));
    const d = await ask();
    expect(d.allowed).toBe(true);
    expect(d.verdict).toBe("unknown");
    expect(state.judgementsFailed).toBe(1);
    // The distinction RONDE 67 asked for and RONDE 103 keeps: "said no" vs "could not look".
    // SUPERSEDED BY RONDE 119: the counter this label names is `judgementsFailed`, which now
    // means only what it says — a provider answered and the judgement itself failed. Provider
    // exhaustion (Groq's spent day, an out-of-capacity chain) moved to `never_asked`, so calling
    // this one "unavailable" pointed at the wrong number.
    expect(formatRelevanceSummary(state, ledger)).toContain("failed=1");
    expect(formatRelevanceSummary(state, ledger)).toContain("fits=0");
  });

  it("RC-2 — a decline is COUNTED, not silent", async () => {
    // Budget spent: the gate never asks, and before RONDE 103 nothing recorded that it hadn't.
    const spent = createBeatImageGateState();
    spent.judgementAttempts = 10_000;
    const d = await ask({ state: spent });
    expect(d.allowed).toBe(true);
    expect(d.verdict).toBe("unknown");
    expect(spent.judgementsSkipped).toBeGreaterThan(0);
    expect(invoke.fn).not.toHaveBeenCalled();
  });

  /**
   * RONDE 199 reversed phase 7's answer, deliberately.
   *
   * Phase 7 exempted a card from the model on the argument that it depicts nothing. That is true
   * of a colour field and false of a map, a chart or a title card, all of which travel under the
   * same flag and can be plainly wrong about the narration under them. The owner's rule is that
   * every picture is looked at. The hazard phase 7 existed for — a refused card being thrown away,
   * leaving the beat empty — is handled where it belongs: the refusal is REPRIEVED, so the answer
   * is recorded and the card stays.
   */
  it("phase 7 reversed — a card IS judged, and a refusal on one is kept", async () => {
    const d = await ask({ placeholder: true });
    expect(invoke.fn, "the card was never put to the model").toHaveBeenCalled();
    expect(d.allowed, "a card must never be taken away by its own verdict").toBe(true);
    expect(state.judgementsSkipped).toBe(0);
  });

  it("a beat with no narration has no question to ask", async () => {
    const d = await ask({ ctx: { ...BEAT, beatText: "  " } });
    expect(d.allowed).toBe(true);
    expect(invoke.fn).not.toHaveBeenCalled();
  });
});

/* ═══════════ the per-beat ceiling ═══════════ */

describe("RONDE 103 — one beat cannot spend the render's budget", () => {
  it("stops paying for new looks after the per-beat ceiling", async () => {
    const ceiling = maxRelevanceLooksPerBeat();
    expect(ceiling).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < ceiling + 3; i++) answers(false);
    for (let i = 0; i < ceiling + 3; i++) {
      await ask({ contentKey: `archive:${i}`, clipPath: path.join(dir, `c${i}.mp4`) });
    }
    expect(state.judgementAttempts).toBe(ceiling);
    expect(state.judgementsSkipped).toBeGreaterThan(0);
  });

  it("a DIFFERENT beat gets its own allowance", async () => {
    const ceiling = maxRelevanceLooksPerBeat();
    for (let i = 0; i < ceiling * 2; i++) answers(false);
    for (let i = 0; i < ceiling; i++) {
      await ask({ contentKey: `a:${i}`, clipPath: path.join(dir, `a${i}.mp4`) });
    }
    const other = { ...BEAT, sceneIndex: 5, beatIndex: 0, beatText: "A different sentence entirely." };
    const d = await ask({ ctx: other, contentKey: "b:0", clipPath: path.join(dir, "b0.mp4") });
    expect(d.verdict).toBe("does_not_fit");
  });

  it("a verdict already earned is honoured past the ceiling — the budget bounds spending, not truth", async () => {
    /**
     * Checking the ceiling before the cache would make a beat that has looked twice adopt a clip
     * it KNOWS does not fit. A cached verdict costs nothing; refusing to read it buys nothing and
     * launders a refusal into an adoption.
     */
    const ceiling = maxRelevanceLooksPerBeat();
    answers(false);
    await ask({ contentKey: "known", clipPath: path.join(dir, "known.mp4") });
    for (let i = 0; i < ceiling; i++) answers(false);
    for (let i = 0; i < ceiling; i++) {
      await ask({ contentKey: `x:${i}`, clipPath: path.join(dir, `x${i}.mp4`) });
    }
    const again = await ask({ contentKey: "known", clipPath: path.join(dir, "known.mp4") });
    expect(again.verdict).toBe("does_not_fit");
    expect(again.allowed).toBe(false);
    expect(again.cached).toBe(true);
  });
});

/* ═══════════ the reprieve ═══════════ */

/**
 * RONDE 200 — PHASE 15 REVERSED BY THE OWNER'S RULE.
 *
 * Phase 15 did not decide that a refusal may be overruled; RONDE 67 did, and phase 15 made the
 * override honest — the verdict stayed `does_not_fit` so a render could be asked how many of its
 * shots went in over the editor's objection, and answer. That bookkeeping is exactly what makes
 * this reversal cheap: the override was already a separate, recorded thing rather than a relabel.
 *
 * The rule now is "er mag nooit een beeld in de video die er niet bij past", so the answer to that
 * question is zero, by construction. The attempt is still classified and still logged, so a render
 * can say how many beats lost a picture to this rule — which is the number to look at if videos
 * start arriving with more empty beats.
 */
describe("RONDE 200 — the override is refused, and the refusal is on the record", () => {
  it("the verdict stands and nothing is marked as allowed", async () => {
    answers(false);
    await ask();
    expect(reprieveBeatClip(ledger, CLIP, "nothing else passed")).toBe(false);
    const entry = ledger.byClipPath.get(CLIP)!;
    expect(entry.decision.verdict).toBe("does_not_fit");
    expect(entry.decision.reprieved).toBe(false);
    expect(entry.decision.allowed).toBe(false);
  });

  it("the declined attempt is announced, naming the kind that could not be lifted", async () => {
    answers(false);
    await ask();
    const seen: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((l) => void seen.push(String(l)));
    try {
      reprieveBeatClip(ledger, CLIP, "nothing else passed");
    } finally {
      spy.mockRestore();
    }
    expect(seen.join("\n")).toContain("_may_not_be_reprieved");
  });

  it("the summary still keeps a refusal out of the pass count", async () => {
    answers(false);
    await ask();
    reprieveBeatClip(ledger, CLIP, "nothing else passed");
    const line = formatRelevanceSummary(state, ledger);
    expect(line).toContain("does_not_fit=1");
    expect(line).toContain("(reprieved=0)");
    expect(line).toContain("fits=0");
  });
});

/* ═══════════ the barrier (RC-3) ═══════════ */

describe("RONDE 103 phase 17 — the barrier at compose", () => {
  it("blocks a refusal nobody reprieved", async () => {
    answers(false);
    await ask();
    const b = composeBarrierAllows(ledger, CLIP);
    expect(b.allow).toBe(false);
    expect(b.reason).toContain("s2b4");
  });

  /**
   * RONDE 200: the barrier's reprieve branch is kept and is still reachable — the last-rung colour
   * card uses it, because refusing the only thing between a beat and an empty slot leaves no
   * frames at all rather than a better picture. Real footage can no longer reach it.
   */
  it("lets a deliberate reprieve through, and says that is what it is", async () => {
    answers(false);
    await ask();
    const entry = ledger.byClipPath.get(CLIP)!;
    entry.decision = { ...entry.decision, allowed: true, reprieved: true };
    const b = composeBarrierAllows(ledger, CLIP);
    expect(b.allow).toBe(true);
    expect(b.reason).toContain("reprieved");
  });

  it("recognises a refused clip arriving under a NEW NAME", async () => {
    /**
     * The trick that used to work: judge `clip.mp4`, trim it, burn a text overlay in, and hand
     * `clip_text.mp4` to compose — a path the barrier had never seen. Content identity survives
     * all of that for anything with real provenance.
     */
    answers(false);
    await ask();
    const renamed = path.join(dir, "clip_scene2_b4_text.mp4");
    expect(composeBarrierAllows(ledger, renamed).allow).toBe(true); // path alone: unknown
    expect(composeBarrierAllows(ledger, renamed, "archive:77").allow).toBe(false);
  });

  it("carries a decision across an explicit rename for clips with no stable identity", async () => {
    answers(false);
    await ask({ contentKey: "file:1234:clip.mp4" });
    const renamed = path.join(dir, "clip_text.mp4");
    expect(composeBarrierAllows(ledger, renamed, "file:9999:clip_text.mp4").allow).toBe(true);
    inheritBeatRelevance(ledger, CLIP, renamed);
    expect(composeBarrierAllows(ledger, renamed).allow).toBe(false);
  });

  it("a `file:` key is NOT indexed by content — it cannot survive a rename and must not claim to", async () => {
    answers(false);
    await ask({ contentKey: "file:1234:clip.mp4" });
    expect(ledger.byContentKey.size).toBe(0);
    expect(ledger.byClipPath.size).toBe(1);
  });

  it("passes a clip it has never seen, and that gap is a number rather than a silence", () => {
    const b = composeBarrierAllows(ledger, path.join(dir, "never-judged.mp4"));
    expect(b.allow).toBe(true);
    expect(b.reason).toContain("never judged");
    expect(barrierCoverage(ledger)).toEqual({ judgedPaths: 0, judgedAssets: 0 });
  });
});

/* ═══════════ the wiring (RC-1) — structural ═══════════ */

describe("RONDE 103 phase 18 — no route goes round the decider", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("there is exactly ONE content decider, and CLIP is not it", () => {
    /**
     * RONDE 101's RC-1 in one assertion. `evaluateClipVisionGate` still runs at three sites — its
     * score ranks candidates and lands on the lineage record — but not one of them may turn a
     * CLIP verdict into a rejection. RONDE 58 measured why: on the same beat it scored a
     * white-lives-matter sticker 0.2226 and a signed photograph of Hitler 0.2116.
     */
    expect(SRC.match(/registerRejection\([^)]*"vision_gate"/g) ?? []).toHaveLength(0);
    for (const site of ["CLIP would have rejected", "CLIP ranks"]) {
      expect(SRC).toContain(site);
    }
  });

  it("every judgement in the pipeline goes through the central gate", () => {
    /**
     * `judgeBeatImage` is the vision model. Calling it directly is how the three copies of this
     * gate came to exist and drift.
     *
     * This used to allow exactly ONE exception — the YouTube pre-pool check, which judged a clip
     * before it belonged to any beat. That screening is gone (see
     * youtubeIsJudgedWhereItIsUsed.test.ts), so the rule this test is named for now holds without
     * exception: NO route goes round the decider. The assertion is tightened from one to zero
     * rather than relaxed.
     */
    const direct = SRC.split("\n").filter(
      (l) => l.includes("judgeBeatImage({") && !/^\s*(\/\/|\*)/.test(l)
    );
    expect(direct).toHaveLength(0);
    /**
     * The routes reach the decider through `judgeBeatClipRelevance`, which records the gate's
     * spend AND its verdict and then calls `checkBeatRelevance`. Counting the wrapper is counting
     * the same routes; counting the raw call would now find only the wrapper's own.
     */
    /** The scene pool and funnel routes left when the three candidate systems became one. */
    /** RONDE 656 — the motion-graphic still route went too: the declaration plus one call. */
    expect(SRC.split("judgeBeatClipRelevance(").length - 1).toBeGreaterThanOrEqual(2);
    /** ONE ROUTE: the recorder asks through the VisualJudge, which is the only caller of the ledger's look. */
    expect(SRC, "a route reaches the gate without going through the recorder").not.toContain("checkBeatRelevance(");
    expect(SRC.split("await judgePicture({").length - 1).toBe(1);
  });

  it("PHASE 18 — the structural sweep: EVERY function that can put a clip on a beat reaches a gate", () => {
    /**
     * The proof RONDE 103 phase 18 asks for, and the reason a list is not one.
     *
     * This does not enumerate routes. It finds every top-level function in the pipeline whose
     * body can put a clip on a beat — it pushes one, or records an adoption — and requires each
     * to reach the content decider by some path: directly, through an adopt* helper, through the
     * guaranteed ladder, through fillBeatVisual/ensureBeatVisualFilled, or through one of the two
     * barriers. A route added tomorrow appears here on its own; nobody has to remember to list it.
     *
     * RONDE 101 ran this shape by hand and found twelve routes reaching neither gate. Two more
     * turned up in this round's own second audit — fetchLastResortRealClip's un-adoptClip'd
     * return paths, and the four pushSceneClip closures.
     */
    const lines = SRC.split("\n");
    const starts = new Map<number, string>();
    lines.forEach((l, i) => {
      const m = /^(?:export )?(?:async )?function (\w+)/.exec(l);
      if (m) starts.set(i, m[1]!);
    });
    const idx = [...starts.keys()].sort((a, b) => a - b);
    const GATES = [
      "beatClipPassesVisionGate(",
      "checkBeatRelevance(",
      /** The recorder wrapping the gate: reaching it IS reaching the decider. */
      "judgeBeatClipRelevance(",
      "adoptClip(",
      "beatClipRefusedByRelevanceGate(",
      "montageClipPassesComposeGate(",
    ];
    const ungated: string[] = [];
    let examined = 0;
    idx.forEach((start, k) => {
      const end = idx[k + 1] ?? lines.length;
      const body = lines.slice(start, end).join("\n");
      if (!/\bpushClip\(|\bpushSceneClip\(|recordClipAdopt\(/.test(body)) return;
      examined++;
      const reaches = GATES.some((g) => body.includes(g)) || /\badopt[A-Z]\w*\(/.test(body);
      if (!reaches) ungated.push(starts.get(start)!);
    });
    /** Two placing functions remain; the others were the deleted curated-only, rescue and fill routes. */
    expect(examined).toBeGreaterThanOrEqual(1);
    expect(ungated, `routes that can place a clip with no path to the gate: ${ungated.join(", ")}`)
      .toEqual([]);
  });

  it("SECOND AUDIT — the acceptance point itself refuses what the gate refused", () => {
    /**
     * Found by the sweep, and it is the reason the sweep exists. Every named adopt/rescue route
     * reaches the gate — but "every route on my list" is not a proof about routes not on it. The
     * four pushSceneClip closures are the narrowest place at which a clip actually becomes a
     * beat's clip, so the refusal is enforced there too: a route added later cannot push a clip
     * this render has already refused, whatever it did or did not call on the way.
     */
    const closures = SRC.split("const pushSceneClip = async (").slice(1);
    /** One push closure is left — `pushSceneClip` in the per-beat ladder; the others were in the deleted curated-only, recovery, backfill and coverage routes. */
    expect(closures.length).toBeGreaterThanOrEqual(1);
    for (const c of closures) {
      const head = c.slice(0, 1200);
      const call = head.match(/beatClipRefusedByRelevanceGate\(dedup, clipPath, scene\.index, beatIndex\)/);
      expect(call, "a pushSceneClip closure no longer asks the gate about its own beat").toBeTruthy();
    }
    // And it refuses only a refusal — an unjudged clip still passes, or the routes that build
    // their own files would empty every montage.
    /**
     * ARCHIVE-FIRST ROUND — `beatClipRefusedByRelevanceGate` became a two-part answer.
     *
     * The exported function now asks the editorial question first and the archive question second;
     * the editorial gate's own body moved, unchanged, into `relevanceGateRefusesClip`. This claim
     * is about that body, so it is read there. Nothing about what the gate decides changed.
     */
    const idx = SRC.indexOf("export async function visualJudgeRefusesPush(");
    const body = SRC.slice(idx, SRC.indexOf("\n}", idx));
    /**
     * ONE ROUTE — the barrier is the VisualJudge's push verdict now. The property is unchanged: it
     * is consulted with the clip's own, once-computed content key and about the beat the clip is
     * being placed at, and a refusal leaves an ending on the ledger before the push returns.
     */
    expect(body).toContain("const contentKey = clipContentKey(clipPath);");
    const flat = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    expect(flat).toContain("barrier: [dedup.beatRelevance, clipPath, contentKey, beatIndex != null ? { sceneIndex, beatIndex } : undefined]");
    expect(body).toContain('if (verdict.decision === "ACCEPT") {');
    expect(body).toContain("registerRejection(dedup.rejections, sceneIndex, beatIndex, clipPath, why, undefined, {");
    expect(
      body.indexOf("registerRejection"),
      "the gate returns its refusal before recording it"
    ).toBeLessThan(body.lastIndexOf("return true;"));
  });

  it("the render summary reports declines, so a render that stopped looking says so", () => {
    // RONDE 105 renamed the counters into a partition; the rule — a decline is counted and named
    // separately from a failure — is unchanged and now reads off the tally.
    expect(SRC).toContain("never_asked=${t.skipped}");
    expect(SRC).toContain("formatRelevanceSummary(g, visualDedup.beatRelevance)");
    expect(SRC).toContain("beeldgate is ${t.skipped} keer niet eens bevraagd");
  });
});

/* ═══════════ same clip, different beats — end to end ═══════════ */

describe("RONDE 103 phase 21 — the white-lives-matter regression", () => {
  it("a clip approved on one beat is re-examined on the next, and can be refused there", async () => {
    /**
     * Render 532, reconstructed. A white-lives-matter roadside clip went under narration about
     * the Battle of Berlin. Two things had to be true for that: CLIP scored it ABOVE a genuine
     * Hitler photograph, and the verdict cache was keyed on the picture alone so one beat's
     * approval covered the rest. Both are gone; this is what that looks like from the outside.
     */
    answers(true, "a roadside sticker reading white lives matter");
    const first = await ask({
      ctx: { sceneIndex: 0, beatIndex: 0, beatText: "Montana's back roads carry their own politics." },
      contentKey: "archive:wlm",
    });
    expect(first.allowed).toBe(true);

    answers(false, "a roadside sticker reading white lives matter");
    const second = await ask({
      ctx: {
        sceneIndex: 2,
        beatIndex: 1,
        beatText: "Soviet artillery closed on the Reichstag in the last days of April 1945.",
      },
      contentKey: "archive:wlm",
      clipPath: path.join(dir, "wlm.mp4"),
    });
    expect(second.verdict).toBe("does_not_fit");
    expect(second.allowed).toBe(false);
    expect(invoke.fn).toHaveBeenCalledTimes(2);

    // And the barrier at compose would stop it even if a route ignored the decision.
    expect(composeBarrierAllows(ledger, path.join(dir, "wlm.mp4")).allow).toBe(false);
  });

  it("beat identity is what makes the second look happen", () => {
    const berlin = beatIdentityKey({
      sceneIndex: 2, beatIndex: 1,
      beatText: "Soviet artillery closed on the Reichstag in the last days of April 1945.",
    });
    const montana = beatIdentityKey({
      sceneIndex: 0, beatIndex: 0,
      beatText: "Montana's back roads carry their own politics.",
    });
    expect(berlin).not.toBe(montana);
    expect(berlin).toBeTruthy();
  });
});
