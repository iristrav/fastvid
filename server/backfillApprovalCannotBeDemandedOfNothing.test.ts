/**
 * RENDER 592-B — A DEMAND NOTHING CAN MEET IS NOT A STANDARD.
 *
 * ── What scene 2 did ────────────────────────────────────────────────────────────────────────
 *
 *     [BeatRelevance] s2b0: refusing to push scene_2_slot0_guaranteed.mp4 —
 *         backfill needs an approval; nobody looked at this clip for s2b0
 *         (per-beat look ceiling reached (5))
 *     …forty-six times, over four files, for one sentence.
 *
 * Then `Scene 2 slot 0/100/200/300: text-overlay fallback OK`, and the render ended on
 * `Scene 2: 4 zinnen maar 0 voice/script-matchende clips — export geblokkeerd`, because the export
 * gate rejects exactly those fallbacks.
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────
 *
 * `beatClipRefusedByRelevanceGate` calls `ensureVerdictBeforeCompose` with `finalSay: true` — the
 * look that decides something — and discarded its return value. That function has seven outcomes,
 * and three of them (`no_scope`, `beat_unknown`, `no_narration`) say the look could not happen
 * because there is no sentence behind the slot. The route then asked the barrier for an approval,
 * was told nobody had looked, and refused the picture for the absence of the very look it had just
 * been told about.
 *
 * `adoptionGuardRefusesPush` has held the answer to this since RONDE 215, two hundred lines away,
 * with the reasoning written beside it: a requirement that cannot be met does not raise the
 * standard, it empties the film. One policy, one of the two places it is decided. The information
 * was in hand at the other and thrown away — the same defect class this codebase keeps paying for.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * The suspension is of the APPROVAL REQUIREMENT and nothing else. `no verdict` becomes `no
 * approval required`, never `approved`: a `does_not_fit` on record still refuses (D), a real
 * approval still takes the route it always took (E), an outcome that means the render simply
 * failed to obtain a verdict it could have asked for still refuses and says so distinctly (F), no
 * extra vision look is bought (G), and the export gate's own rule is untouched (H).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

import {
  adoptionGuardRefusesPush,
  beatClipRefusedByRelevanceGate,
  createVisualDedupState,
  isPipelineFallbackClip,
  formatBackfillApprovalSuspensions,
  type VisualDedupState,
} from "./videoPipeline";
import {
  beatRelevanceBeatKey,
  composeBarrierAllows,
  ensureVerdictBeforeCompose,
  maxComposePhaseJudgements,
  nothingToJudgeAgainst,
  withComposeJudgeScope,
  type BeatRelevanceDecision,
  type ComposeJudgeOutcome,
  type ComposeJudgeScope,
} from "./beatVisualRelevance";
import { createBeatImageGateState } from "./beatImageRelevanceGate";
import { withAdoptionIntent } from "./adoptionPolicy";

/** Scene 2 of render 592-B: the sentence, and one of the four files the backfill offered for it. */
const BEAT = "Kris Jenner turned a family name into a business empire.";
const CLIP = "/w/scene_2_slot0_guaranteed.mp4";
const SCENE = 2;
const BEAT_INDEX = 0;

/**
 * The perf profile the pipeline hands `createVisualDedupState`. Only the fields this state reads
 * at construction matter here; nothing in these tests touches a provider, a model or ffmpeg.
 */
const PERF = { fastStockMode: false } as unknown as Parameters<typeof createVisualDedupState>[0];

function dedupState(): VisualDedupState {
  return createVisualDedupState(PERF);
}

function scope(dedup: VisualDedupState, overrides: Partial<ComposeJudgeScope> = {}): ComposeJudgeScope {
  return {
    workDir: "/w",
    state: createBeatImageGateState(),
    ledger: dedup.beatRelevance,
    beatForClip: () => ({ sceneIndex: SCENE, beatIndex: BEAT_INDEX }),
    contextFor: (s, b) => ({ sceneIndex: s, beatIndex: b, beatText: BEAT }),
    isPlaceholder: () => false,
    budget: maxComposePhaseJudgements(),
    spent: 0,
    ...overrides,
  };
}

function verdict(
  v: BeatRelevanceDecision["verdict"],
  evaluated: boolean,
  reason: string
): BeatRelevanceDecision {
  return {
    verdict: v,
    allowed: v !== "does_not_fit",
    reprieved: false,
    cached: false,
    depicts: "",
    reason,
    route: "push",
    evaluated,
  };
}

/**
 * Write a ledger entry the way `record()` does — under the SAME keys, built with the same helper.
 *
 * Hand-spelling the `byBeat` key is how the first draft of this suite lied to itself: the barrier
 * then found no verdict of the beat's own, took a different branch, and wrote a different sentence
 * than production did. The key format belongs to `beatRelevanceBeatKey`, so it is asked for it.
 */
function recordForBeat(dedup: VisualDedupState, decision: BeatRelevanceDecision, clip = CLIP): void {
  const entry = { ctx: { sceneIndex: SCENE, beatIndex: BEAT_INDEX, beatText: BEAT }, decision };
  dedup.beatRelevance.byClipPath.set(clip, entry);
  dedup.beatRelevance.byBeat.set(beatRelevanceBeatKey(SCENE, BEAT_INDEX, "path", clip), entry);
}

/** The render's own shape: the ceiling was spent, so the recorded entry is a non-verdict. */
const CEILING = () => verdict("unknown", false, "per-beat look ceiling reached (5)");

/** Run the gate as the backfill does — `demand: "approval"`. */
const push = (dedup: VisualDedupState, s?: ComposeJudgeScope) =>
  s
    ? withComposeJudgeScope(s, () =>
        beatClipRefusedByRelevanceGate(dedup, CLIP, SCENE, BEAT_INDEX, "approval")
      )
    : beatClipRefusedByRelevanceGate(dedup, CLIP, SCENE, BEAT_INDEX, "approval");

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  const sink = (...a: unknown[]) => void lines.push(a.join(" "));
  warn = vi.spyOn(console, "warn").mockImplementation(sink);
  error = vi.spyOn(console, "error").mockImplementation(sink);
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

const said = (needle: string) => lines.filter((l) => l.includes(needle));

/* ═════════════════ A — no_scope ═════════════════ */

describe("A — no_scope: the render is judging outside a compose scope", () => {
  it("MEASURED: the backfill no longer refuses solely for a missing approval", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    /** No `withComposeJudgeScope`, so `ensureVerdictBeforeCompose` answers `no_scope`. */
    const refused = await push(dedup);
    expect(
      refused,
      "an approval was demanded although nothing could have produced one"
    ).toBe(false);
  });

  it("the suspension is counted and said out loud — never silent", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    await push(dedup);
    expect(dedup.backfillApprovalSuspended.get("no_scope")).toBe(1);
    expect(said("backfill approval requirement suspended: reason=no_scope")).toHaveLength(1);
  });

  /**
   * The whole claim, not a fragment of it. An earlier draft asserted only "NOT approved", and a
   * mutation that turned `this beat may not claim one` into `may claim one` survived it: the
   * sentence still contained the fragment while saying the opposite of what it means.
   */
  it("and it is not an approval: the line withdraws the claim in full", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    await push(dedup);
    const [line] = said("approval requirement suspended");
    expect(line).toContain("the picture is NOT approved");
    expect(line).toContain("this beat may not claim one");
    expect(line).not.toContain("this beat may claim one");
  });

  it("46 offers of the same clip produce ONE line, and 46 counted suspensions", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    for (let i = 0; i < 46; i++) await push(dedup);
    expect(
      said("backfill approval requirement suspended"),
      "render 592-B printed its refusal 46 times; the exemption must not do the same"
    ).toHaveLength(1);
    expect(dedup.backfillApprovalSuspended.get("no_scope")).toBe(46);
  });
});

/* ═════════════════ B — beat_unknown ═════════════════ */

describe("B — beat_unknown: the clip cannot be placed under any sentence", () => {
  it("MEASURED: the shared policy classifies it as nothing-to-judge-against", () => {
    expect(nothingToJudgeAgainst("beat_unknown")).toBe(true);
  });

  it("MEASURED: the outcome is real — a scope that cannot place the clip returns it", async () => {
    const dedup = dedupState();
    const s = scope(dedup, { beatForClip: () => undefined });
    const r = await withComposeJudgeScope(s, () =>
      ensureVerdictBeforeCompose({ clipPath: CLIP, contentKey: "file:1", route: "push", finalSay: true })
    );
    expect(r.outcome).toBe("beat_unknown");
  });

  /**
   * HONEST LIMIT, RECORDED RATHER THAN HIDDEN.
   *
   * The push route always supplies both indices, so `ensureVerdictBeforeCompose` resolves `at`
   * from them and this outcome cannot currently arrive there. The policy still has to cover it —
   * a later caller that omits an index would otherwise reach the defect this round removed — and
   * the two assertions above are what can be proven without inventing an unreachable path.
   */
  it("the gate reads the shared predicate, so beat_unknown is covered if it ever arrives", () => {
    expect(["no_scope", "beat_unknown", "no_narration"].every(
      (o) => nothingToJudgeAgainst(o as ComposeJudgeOutcome)
    )).toBe(true);
    expect((["judged", "already_judged", "budget_spent", "placeholder"] as ComposeJudgeOutcome[])
      .some(nothingToJudgeAgainst)).toBe(false);
  });
});

/* ═════════════════ C — no_narration ═════════════════ */

describe("C — no_narration: the slot has no sentence behind it", () => {
  it("MEASURED: the backfill no longer refuses solely for a missing approval", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    const s = scope(dedup, { contextFor: () => undefined });
    expect(await push(dedup, s)).toBe(false);
    expect(dedup.backfillApprovalSuspended.get("no_narration")).toBe(1);
  });
});

/* ═════════════════ D — does_not_fit STAYS A REFUSAL ═════════════════ */

describe("D — a real editorial refusal is never converted by this fix", () => {
  it("MEASURED: does_not_fit still refuses, even with no_scope on the last look", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, verdict("does_not_fit", true, "shows a modern office, not the 1990s"));
    expect(
      await push(dedup),
      "the suspension let a picture the editor refused through"
    ).toBe(true);
    expect(dedup.backfillApprovalSuspended.size).toBe(0);
  });

  it("MEASURED: does_not_fit still refuses under no_narration too", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, verdict("does_not_fit", true, "shows a modern office, not the 1990s"));
    const s = scope(dedup, { contextFor: () => undefined });
    expect(await push(dedup, s)).toBe(true);
    expect(dedup.backfillApprovalSuspended.size).toBe(0);
  });

  it("and no suspension line is printed for it", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, verdict("does_not_fit", true, "shows a modern office"));
    await push(dedup);
    expect(said("approval requirement suspended")).toHaveLength(0);
  });

  /**
   * THE INVARIANT THE SUSPENSION BRANCH RESTS ON, ASSERTED RATHER THAN ASSUMED.
   *
   * The branch re-asks the barrier under `no_refusal` and only allows the push when THAT allows
   * too, so a `does_not_fit` cannot travel through it. Today that second ask can never refuse —
   * `composeBarrierAllows` answers a `does_not_fit` with `refused on …` long before it reaches the
   * approval clause, so a refusal and an approval-refusal are mutually exclusive. That is exactly
   * why the safety net has to be checked here: the branch is unreachable only for as long as this
   * property of the barrier holds, and nothing else in the suite states it.
   */
  it("MEASURED: a does_not_fit never produces an approval-shaped refusal", () => {
    const dedup = dedupState();
    recordForBeat(dedup, verdict("does_not_fit", true, "shows a modern office"));
    const strict = composeBarrierAllows(
      dedup.beatRelevance, CLIP, "file:1", { sceneIndex: SCENE, beatIndex: BEAT_INDEX }, "approval"
    );
    const relaxed = composeBarrierAllows(
      dedup.beatRelevance, CLIP, "file:1", { sceneIndex: SCENE, beatIndex: BEAT_INDEX }, "no_refusal"
    );
    expect(strict.allow).toBe(false);
    expect(relaxed.allow, "the relaxed demand would let a refused picture through").toBe(false);
    expect(
      strict.reason.startsWith("backfill needs an approval"),
      "a refused picture is reported as merely unapproved, which is the branch's entry condition"
    ).toBe(false);
  });
});

/* ═════════════════ E — a real approval keeps its own route ═════════════════ */

describe("E — an approved picture takes the path it always took", () => {
  it("MEASURED: `fits` earned at this beat is allowed, with no suspension recorded", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, verdict("fits", true, "a 1990s family business interior"));
    expect(await push(dedup)).toBe(false);
    expect(
      dedup.backfillApprovalSuspended.size,
      "an approved picture must not travel through the exemption"
    ).toBe(0);
    expect(said("approval requirement suspended")).toHaveLength(0);
  });
});

/* ═════════════════ F — an unobtainable verdict is NOT a silent approval ═════════════════ */

describe("F — the render failing to judge is reported, not excused", () => {
  /**
   * `already_judged` over a recorded non-verdict, with a scope present and narration in place:
   * the look was askable and did not produce a verdict. Nothing about the picture, everything
   * about the render — and still a refusal.
   */
  it("MEASURED: the clip is still refused", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    dedup.beatRelevance.finalSayRetried.add(CLIP);
    expect(await push(dedup, scope(dedup))).toBe(true);
  });

  it("MEASURED: nothing is suspended and nothing is approved", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    dedup.beatRelevance.finalSayRetried.add(CLIP);
    await push(dedup, scope(dedup));
    expect(dedup.backfillApprovalSuspended.size).toBe(0);
  });

  it("MEASURED: it is named as the render's failure, once, beside the refusal", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    dedup.beatRelevance.finalSayRetried.add(CLIP);
    for (let i = 0; i < 10; i++) await push(dedup, scope(dedup));
    const diag = said("backfill verdict unavailable");
    expect(diag).toHaveLength(1);
    expect(diag[0]).toContain("reason=already_judged");
    expect(diag[0]).toContain("not the editor refusing");
  });
});

/* ═════════════════ G — the look budget is unchanged ═════════════════ */

describe("G — this fix buys no extra vision looks", () => {
  it("MEASURED: the compose scope's spend is untouched by a suspension", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    const s = scope(dedup, { contextFor: () => undefined });
    const before = s.spent;
    for (let i = 0; i < 5; i++) await push(dedup, s);
    expect(
      s.spent,
      "the suspension path asked the model something"
    ).toBe(before);
  });

  /**
   * The retry ledger is written by `ensureVerdictBeforeCompose` itself, before this gate sees an
   * answer — so the gate cannot and must not change it. The claim worth holding is that the gate
   * adds nothing of its own: pushing a clip costs exactly what asking about it already cost.
   *
   * Written as a comparison rather than an absolute, because the absolute would assert a retry
   * budget this round was told to leave exactly as it is.
   */
  it("MEASURED: the gate consumes no retry beyond the ask it already made", async () => {
    const baseline = dedupState();
    recordForBeat(baseline, CEILING());
    const bs = scope(baseline, { contextFor: () => undefined });
    await withComposeJudgeScope(bs, () =>
      ensureVerdictBeforeCompose({
        clipPath: CLIP, contentKey: "file:1", sceneIndex: SCENE, beatIndex: BEAT_INDEX,
        route: "push", finalSay: true,
      })
    );

    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    const s = scope(dedup, { contextFor: () => undefined });
    for (let i = 0; i < 5; i++) await push(dedup, s);

    expect(
      dedup.beatRelevance.finalSayRetried.size,
      "five pushes cost more retries than one ask"
    ).toBe(baseline.beatRelevance.finalSayRetried.size);
  });
});

/* ═════════════════ H — the export gate is untouched ═════════════════ */

describe("H — a pipeline fallback is still unusable", () => {
  it("MEASURED: a text-overlay fallback is still a pipeline fallback", () => {
    expect(isPipelineFallbackClip("/w/scene_2_slot0_text_fallback.mp4")).toBe(true);
  });

  it("MEASURED: the export gate's own filter still drops it", () => {
    const clips = [
      "/w/scene_2_slot0_text_fallback.mp4",
      "/w/scene_2_slot1_text_fallback.mp4",
    ];
    /** The export guard's rule, asserted against its own predicate rather than restated. */
    expect(clips.filter((c) => c && !isPipelineFallbackClip(c))).toHaveLength(0);
  });

  it("MEASURED: a suspension does not make a fallback usable", async () => {
    const FALLBACK = "/w/scene_2_slot0_text_fallback.mp4";
    const dedup = dedupState();
    recordForBeat(dedup, CEILING(), FALLBACK);
    await beatClipRefusedByRelevanceGate(dedup, FALLBACK, SCENE, BEAT_INDEX, "approval");
    expect(isPipelineFallbackClip(FALLBACK)).toBe(true);
  });
});

/* ═════════ the other reader of the same policy, asked the same question ═════════ */

describe("the adoption guard suspends on the same three outcomes — asked of the guard", () => {
  /**
   * RENDER 592-B: `r215GuardAsksForItself` asserted this by reading the guard's source for three
   * string literals. A mutation that leaves the call syntactically present while making its result
   * irrelevant — `if (false && nothingToJudgeAgainst(...))` — survives every such check, which is
   * precisely the failure mode the previous round was warned about. So it is asked of the guard.
   */
  it("MEASURED: with no narration behind the slot, the guard does not refuse for a missing verdict", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    const s = scope(dedup, { contextFor: () => undefined });
    const refused = await withComposeJudgeScope(s, () =>
      withAdoptionIntent("fallback", () =>
        adoptionGuardRefusesPush(dedup, CLIP, SCENE, BEAT_INDEX)
      )
    );
    expect(
      refused,
      "the guard demanded a verdict for a slot that has no sentence behind it"
    ).toBe(false);
  });

  it("MEASURED: and it says so, rather than passing the picture off as judged", async () => {
    const dedup = dedupState();
    recordForBeat(dedup, CEILING());
    const s = scope(dedup, { contextFor: () => undefined });
    await withComposeJudgeScope(s, () =>
      withAdoptionIntent("fallback", () =>
        adoptionGuardRefusesPush(dedup, CLIP, SCENE, BEAT_INDEX)
      )
    );
    expect(said("nothing to judge against")).not.toHaveLength(0);
    expect(said("suspended for this adoption, not waived for the render")).not.toHaveLength(0);
  });
});

/* ═════════════════ the report says the exemption's size ═════════════════ */

describe("the render says how often it suspended the requirement", () => {
  it("a render that never needed it prints nothing", () => {
    expect(formatBackfillApprovalSuspensions(new Map())).toBe("");
  });

  it("a render that needed it names the outcome and the count", () => {
    const line = formatBackfillApprovalSuspensions(
      new Map<ComposeJudgeOutcome, number>([["no_narration", 46], ["no_scope", 2]])
    );
    expect(line).toContain("approvalSuspended=48");
    expect(line).toContain("no_narration=46");
    expect(line).toContain("not approved");
  });

  it("the default state starts empty, so the count is this render's own", () => {
    expect(dedupState().backfillApprovalSuspended.size).toBe(0);
  });
});

/** The file under test, so a rename cannot quietly orphan this suite. */
it("the gate is reachable from the suite that guards it", () => {
  expect(typeof beatClipRefusedByRelevanceGate).toBe("function");
  expect(path.basename(CLIP)).toBe("scene_2_slot0_guaranteed.mp4");
});
