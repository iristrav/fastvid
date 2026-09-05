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

  it("phase 7 — a neutral placeholder is not sent to the model at all", async () => {
    const d = await ask({ placeholder: true });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("placeholder");
    expect(invoke.fn).not.toHaveBeenCalled();
    // ...and it does not burn a decline counter either: nothing was declined, nothing was asked.
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

describe("RONDE 103 phase 15 — a reprieve overrules the judge, on the record", () => {
  it("keeps the verdict and marks the override separately", async () => {
    answers(false);
    await ask();
    reprieveBeatClip(ledger, CLIP, "nothing else passed");
    const entry = ledger.byClipPath.get(CLIP)!;
    expect(entry.decision.verdict).toBe("does_not_fit");
    expect(entry.decision.reprieved).toBe(true);
    expect(entry.decision.allowed).toBe(true);
  });

  it("a reprieved clip is reported as reprieved, never folded into the pass count", async () => {
    answers(false);
    await ask();
    reprieveBeatClip(ledger, CLIP, "nothing else passed");
    const line = formatRelevanceSummary(state, ledger);
    expect(line).toContain("does_not_fit=1");
    expect(line).toContain("(reprieved=1)");
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

  it("lets a deliberate reprieve through, and says that is what it is", async () => {
    answers(false);
    await ask();
    reprieveBeatClip(ledger, CLIP, "nothing else passed");
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
    expect(SRC.match(/recordClipReject\([^)]*"vision_gate"/g) ?? []).toHaveLength(0);
    for (const site of ["CLIP would have rejected", "CLIP ranks"]) {
      expect(SRC).toContain(site);
    }
  });

  it("every judgement in the pipeline goes through the central gate", () => {
    /**
     * `judgeBeatImage` is the vision model. Calling it directly is how the three copies of this
     * gate came to exist and drift. Exactly one direct caller remains — the YouTube pre-pool
     * check, which runs before a clip is in any beat's pool and is documented as such — and
     * everything else asks through checkBeatRelevance.
     */
    const direct = SRC.split("\n").filter(
      (l) => l.includes("judgeBeatImage({") && !/^\s*(\/\/|\*)/.test(l)
    );
    expect(direct).toHaveLength(1);
    const ytIdx = SRC.indexOf("async function youtubeClipPassesImageGate(");
    expect(SRC.indexOf("judgeBeatImage({", ytIdx)).toBeGreaterThan(ytIdx);
    /**
     * The routes reach the decider through `judgeBeatClipRelevance`, which records the gate's
     * spend AND its verdict and then calls `checkBeatRelevance`. Counting the wrapper is counting
     * the same routes; counting the raw call would now find only the wrapper's own.
     */
    expect(SRC.split("judgeBeatClipRelevance(").length - 1).toBeGreaterThanOrEqual(4);
    expect(
      SRC.split("await checkBeatRelevance({").length - 1,
      "a route reaches the gate without going through the recorder"
    ).toBe(1);
  });

  it("the chokepoint every adopt/rescue route funnels through IS the gate", () => {
    /**
     * beatClipPassesVisionGate is where the baked-text and off-topic-protest checks were put, for
     * the stated reason that "every rescue and adoption route funnels through here, so one hook
     * covers them all". RONDE 101 found the LLM gate was NOT there — it had one caller. It is now.
     */
    const idx = SRC.indexOf("async function beatClipPassesVisionGate(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, SRC.indexOf("\n/**\n * RONDE 103 phase 4", idx));
    expect(body).toContain("const relevance = await judgeBeatClipRelevance(dedup, scene.index, beat.index, {");
    expect(body).toContain("if (!relevance.allowed) {");
    // And it is reached from the routes, not from one of them.
    const callers = SRC.split("beatClipPassesVisionGate(").length - 1;
    expect(callers).toBeGreaterThanOrEqual(12);
  });

  it("the guaranteed ladder's REAL rungs are judged and its cards are not", () => {
    const idx = SRC.indexOf("export async function generateGuaranteedBeatClip(");
    const body = SRC.slice(idx, SRC.indexOf("async function generateGuaranteedBeatClipInner(", idx));
    /**
     * RENDER 563 — the beat index moved, the rule did not.
     *
     * This asserted `slotIndex` as the beat to file under, and eight render logs showed what that
     * cost: 49 `real_footage_never_judged` lines on this ladder's own `rescue_archive` rung. The
     * ladder DID judge; it filed the answer under the fetch slot while the adoption beside it was
     * recorded under the real beat, so the lookup by (scene, beat) found nothing.
     *
     * What this test protects — the real rungs are judged, the cards are not — is unchanged, so
     * the assertion follows the fix rather than being relaxed. `verdictFiledUnderTheBeat.test.ts`
     * pins the beat index itself.
     */
    expect(body).toContain(
      "await judgeBeatClipRelevance(relevance.dedup, sceneIndex, verdictBeatIndex, {"
    );
    expect(body, "the slot is being filed as the beat again").toContain(
      "const verdictBeatIndex = relevance.beatIndex ?? slotIndex;"
    );
    expect(body).toContain("placeholder: isPlaceholderGuaranteedTier(tier.tier)");
    // isPlaceholderGuaranteedTier is what draws the line, and it draws it where phase 7 says.
    expect(SRC).toContain('return tier !== "topical" && tier !== "wikimedia";');
  });

  it("the barrier is on the widest chokepoint, and the routes hand it the ledger", () => {
    const idx = SRC.indexOf("async function montageClipPassesComposeGate(");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 2600);
    expect(body).toContain("composeBarrierAllows(relevance, clipPath, clipContentKey(clipPath))");
    expect(body).toContain("[ComposeBarrier]");
    /**
     * Every call site passes a ledger — including the four inside compose, which reach it through
     * ComposeSceneOptions.dedup. That was RONDE 102's stop condition #2: compose was handed bare
     * paths and there was no way back to a beat from any of them.
     *
     * The first entry is the definition itself; an intermediate helper that forwards its own
     * `relevance` parameter counts, because its own callers are checked by the same rule.
     */
    const calls = SRC.split("montageClipPassesComposeGate(").slice(2);
    const withoutLedger = calls.filter(
      (c) => !/\brelevance\b|beatRelevance/.test(c.slice(0, c.indexOf(")") + 1))
    );
    expect(withoutLedger).toHaveLength(0);
    expect(calls.length).toBeGreaterThanOrEqual(17);
    // ...and the one forwarding helper really does receive it from every one of its own callers.
    const fwd = SRC.split("composeReadySceneClips(").slice(2);
    expect(fwd.every((c) => c.slice(0, c.indexOf(");")).includes("beatRelevance"))).toBe(true);
  });

  it("the text overlay carries the decision across the file it writes", () => {
    const idx = SRC.indexOf("async function applyVideoBeatTextOverlay(");
    expect(idx).toBeGreaterThan(-1);
    /**
     * Bounded by the function's own end rather than a byte count. RONDE 94 documented the lineage
     * link inside `carry` and a fixed +2400 window stopped reaching the return below it — a green
     * test turning red on a change that did not touch the rule. Same correction RONDE 167 made to
     * ronde142's extension block, for the same reason.
     */
    const body = SRC.slice(idx, SRC.indexOf("\n}\n", idx));
    expect(body).toContain("inheritBeatRelevance(relevance, clipPath, out)");
    expect(body).toContain("return carry(await burnFacelessTextOnVideoClip(");
    // Every call site hands it the ledger, so no route loses its verdict at the rename.
    const calls = SRC.split("applyVideoBeatTextOverlay(").slice(2);
    expect(calls.every((c) => c.slice(0, c.indexOf(");")).includes("beatRelevance"))).toBe(true);
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
      "generateGuaranteedBeatClip(",
      "ensureBeatVisualFilled(",
      "fillBeatVisual(",
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
    expect(examined).toBeGreaterThanOrEqual(20);
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
    expect(closures.length).toBeGreaterThanOrEqual(4);
    for (const c of closures) {
      expect(c.slice(0, 700)).toContain("beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index, beatIndex)");
    }
    // And it refuses only a refusal — an unjudged clip still passes, or the routes that build
    // their own files would empty every montage.
    const idx = SRC.indexOf("function beatClipRefusedByRelevanceGate(");
    const body = SRC.slice(idx, SRC.indexOf("\n}", idx));
    /**
     * The content key is now computed once and reused, because the refusal is also RECORDED and
     * both the barrier and the ledger must be asked about the same asset. The property this pinned
     * is unchanged — the barrier is consulted with the clip's own content key — so it is asserted
     * on the value rather than on one spelling of the expression, and the reuse is asserted too:
     * a second, separately-derived key here would let the gate refuse one asset while the ledger
     * ended another.
     */
    expect(body).toContain("const contentKey = clipContentKey(clipPath);");
    expect(body).toContain("composeBarrierAllows(dedup.beatRelevance, clipPath, contentKey)");
    expect(body).toContain("if (barrier.allow) return false;");
    /**
     * And a refusal leaves an ending on the ledger. Before this, both refusals in every
     * `pushSceneClip` warned to the console and returned — so a clip turned away here never
     * entered the scene's clip list, which is the only list `noteSceneClipsResourced` walks, and
     * nothing downstream could ever explain it. That is the `reachedAssigned=true
     * outcome=DROPPED_WITHOUT_EVENT` the render audit reports.
     */
    expect(body).toContain("recordRejection(clipPath, barrier.reason, contentKey)");
    expect(
      body.indexOf("recordRejection"),
      "the gate returns its refusal before recording it"
    ).toBeLessThan(body.lastIndexOf("return true;"));
  });

  it("SECOND AUDIT — the last-resort clip is judged like any other real picture", () => {
    /**
     * fetchLastResortRealClip has five return paths and only two of them (its own adoptClip
     * calls) were gated: an own-archive hit, a YouTube hit and a topical hit reached the timeline
     * with nothing having looked at them. It is not an `adopt*` function, which is exactly why a
     * name-based sweep missed it and a behaviour-based one did not.
     */
    const idx = SRC.indexOf("const lastResortFits =");
    expect(idx).toBeGreaterThan(-1);
    const block = SRC.slice(idx, idx + 700);
    expect(block).toContain("beatClipPassesVisionGate(");
    expect(block).toContain('"last_resort"');
    /**
     * RONDE 94 wrapped this push in `withAdoptionIntent("stock", ...)` and the condition became a
     * multi-line one, so the anchor moved to the push itself. The rule is unchanged and still
     * checked below: the vision gate is asked BEFORE the clip is pushed, never after.
     */
    expect(block).toContain("pushClip(lastResort!, holdSec)");
    expect(block).toContain('withAdoptionIntent("stock"');
    expect(idx).toBeLessThan(SRC.indexOf("pushClip(lastResort!, holdSec)"));
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
