/**
 * COMPOSE DID NOT WAIT FOR AN ANSWER.
 *
 * ── One clip, in render 564's own timestamps ────────────────────────────────────────────────
 *
 *     17:55:44  Compose Scene 1 started
 *     17:56:18  scene_1_b0_curated_a57670.mp4 is in scene 1's montage
 *     17:58:29  [BeatRelevance] s0b2005 does_not_fit — "A modern restaurant interior…"
 *     17:58:36  [ComposeBarrier] s1 clip 0: BLOCKED scene_1_b0_curated_a57670.mp4
 *     18:01:20  stage=FINAL_VIDEO  clip=scene_1_b0_curated_a57670.mp4
 *
 * At 17:56:18 the entire render held EIGHT verdicts and not one was about that clip. The barrier
 * returned its "never judged — no beat context at this path" pass, the scene was built, and the
 * refusal arrived two minutes and eleven seconds later — for a scene that already existed.
 *
 * The audit then reported `INVARIANT_BROKEN … the compose barrier was bypassed`, which sent the
 * investigation after a bypass that never happened. The barrier ran. A barrier over a ledger can
 * only turn away what somebody already judged.
 *
 * ── The two hazards this had to avoid ───────────────────────────────────────────────────────
 *
 * Asking at compose time is the fix, and done carelessly it makes things worse in two ways.
 *
 * A CARD IS NOT A PICTURE. A colour fallback depicts nothing, so a vision model asked whether it
 * belongs under a line of narration says no — and the barrier would then refuse the only thing
 * standing between that beat and an empty slot. Judging a card actively empties beats.
 *
 * AND THE SPEND IS AT THE WORST MOMENT. Compose runs behind the global vision lock while ffmpeg
 * is working, and render 564 was already at 78% of its time budget. The render-wide ceiling is
 * sized for the retrieval phase; this route gets a stop of its own.
 *
 * Everything else fails open, as the whole gate does: no scope, no beat, no narration, budget
 * spent — the clip is left as it was and the barrier's own answer stands.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createBeatRelevanceLedger,
  ensureVerdictBeforeCompose,
  maxComposePhaseJudgements,
  withComposeJudgeScope,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
  type ComposeJudgeScope,
} from "./beatVisualRelevance";
import { createBeatImageGateState } from "./beatImageRelevanceGate";

const BEAT = "Hitler spent his final days in the Führerbunker beneath the Reich Chancellery.";
/** The clip render 564 put into scene 1 with nothing having looked at it. */
const CLIP = "/w/scene_1_b0_curated_a57670.mp4";

function decision(verdict: BeatRelevanceDecision["verdict"]): BeatRelevanceDecision {
  return {
    verdict,
    allowed: verdict !== "does_not_fit",
    reprieved: false,
    cached: false,
    depicts: "",
    reason: "",
    route: "archive",
    evaluated: true,
  };
}

function scope(overrides: Partial<ComposeJudgeScope> = {}): ComposeJudgeScope {
  return {
    workDir: "/w",
    state: createBeatImageGateState(),
    ledger: createBeatRelevanceLedger(),
    beatForClip: () => ({ sceneIndex: 1, beatIndex: 0 }),
    contextFor: () => ({ sceneIndex: 1, beatIndex: 0, beatText: BEAT }),
    isPlaceholder: () => false,
    budget: maxComposePhaseJudgements(),
    spent: 0,
    ...overrides,
  };
}

const ask = (s: ComposeJudgeScope, clipPath = CLIP, contentKey = "archive:57670") =>
  withComposeJudgeScope(s, () => ensureVerdictBeforeCompose({ clipPath, contentKey }));

/**
 * The gate is switched off for these, so `checkBeatRelevance` takes its "gate disabled" path.
 * That is a REAL path — it records an entry and asks no provider — which is what lets the
 * plumbing be tested end to end without simulating a model answer.
 */
const saved = process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
afterEach(() => {
  if (saved === undefined) delete process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE;
  else process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = saved;
});

/* ═══════════════════════ a clip that was already judged costs nothing ═══════════════════════ */

describe("the question is only asked when there is no answer", () => {
  it("says nothing outside a render", async () => {
    expect((await ensureVerdictBeforeCompose({ clipPath: CLIP, contentKey: "archive:57670" })).outcome)
      .toBe("no_scope");
  });

  it("leaves a clip that already has a verdict alone", async () => {
    const s = scope();
    s.ledger.byClipPath.set(CLIP, {
      ctx: { sceneIndex: 1, beatIndex: 0, beatText: BEAT },
      decision: decision("fits"),
    });
    const r = await ask(s);
    expect(r.outcome).toBe("already_judged");
    expect(s.spent, "a judged clip spent budget anyway").toBe(0);
  });

  /**
   * The renamed copy. A clip is judged, trimmed, then has an overlay burned in, and each step
   * writes a new file — content identity is what survives that, and the barrier below relies on
   * the same lookup.
   */
  it("recognises the same asset under a new filename", async () => {
    const s = scope();
    s.ledger.byContentKey.set("archive:57670", {
      ctx: { sceneIndex: 1, beatIndex: 0, beatText: BEAT },
      decision: decision("does_not_fit"),
    });
    expect((await ask(s, "/w/scene_2_b4_curated_a57670.mp4")).outcome).toBe("already_judged");
  });

  /**
   * A `file:` key is derived from the file's own size and name, so it identifies a FILE and not an
   * asset. The ledger refuses to index one; this must not use one to claim a match either.
   */
  it("does not treat a file-shaped key as an asset identity", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const s = scope();
    s.ledger.byContentKey.set("file:123:other.mp4", {
      ctx: { sceneIndex: 1, beatIndex: 0, beatText: BEAT },
      decision: decision("does_not_fit"),
    });
    expect((await ask(s, CLIP, "file:123:other.mp4")).outcome).not.toBe("already_judged");
  });
});

/* ═══════════════════════ what it does when it cannot ask ═══════════════════════ */

describe("every way of not knowing leaves the clip as it was", () => {
  it("names a clip it cannot place on a beat", async () => {
    expect((await ask(scope({ beatForClip: () => undefined }))).outcome).toBe("beat_unknown");
  });

  it("names a beat with no narration to judge against", async () => {
    expect((await ask(scope({ contextFor: () => undefined }))).outcome).toBe("no_narration");
  });

  /** The caller's own beat wins over the reverse lookup — the push route knows it exactly. */
  it("uses the beat the caller supplies", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const seen: Array<[number, number]> = [];
    const s = scope({
      beatForClip: () => {
        throw new Error("the reverse lookup was used when the caller knew the beat");
      },
      contextFor: (sceneIndex, beatIndex) => {
        seen.push([sceneIndex, beatIndex]);
        return { sceneIndex, beatIndex, beatText: BEAT };
      },
    });
    await withComposeJudgeScope(s, () =>
      ensureVerdictBeforeCompose({
        clipPath: CLIP,
        contentKey: "archive:57670",
        sceneIndex: 2,
        beatIndex: 5,
      })
    );
    expect(seen).toEqual([[2, 5]]);
  });
});

/* ═══════════════════════ a card is registered, never judged ═══════════════════════ */

describe("a colour card is not put in front of a picture editor", () => {
  /**
   * THE HAZARD. A grey rectangle belongs under no narration, so judging one earns a refusal, and
   * the barrier would then throw away the only thing keeping that beat from being empty.
   */
  it("marks a placeholder exempt instead of judging it", async () => {
    const s = scope({ isPlaceholder: () => true });
    const r = await ask(s, "/w/scene_1_slot2_guaranteed.mp4");
    expect(r.outcome).toBe("placeholder");
    expect(s.spent, "a card was charged to the compose budget").toBe(0);
  });

  /** It is still WRITTEN DOWN — "deliberately not judged" and "nobody looked" are different. */
  it("records the card so the beat does not read as unexamined", async () => {
    const s = scope({ isPlaceholder: () => true });
    await ask(s, "/w/scene_1_slot2_guaranteed.mp4");
    const entry = s.ledger.byClipPath.get("/w/scene_1_slot2_guaranteed.mp4");
    expect(entry, "the card left no trace, so the beat reads as never looked at").toBeDefined();
    expect(entry!.decision.evaluated, "a card must not read as a real look").toBe(false);
  });
});

/* ═══════════════════════ the spend is bounded ═══════════════════════ */

describe("the compose phase cannot spend without a stop", () => {
  it("stops asking once its own budget is gone", async () => {
    const s = scope({ budget: 0 });
    expect((await ask(s)).outcome).toBe("budget_spent");
    expect(s.spent).toBe(0);
  });

  it("charges one judgement per clip it asks about", async () => {
    process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE = "false";
    const s = scope({ budget: 2 });
    await ask(s, "/w/a.mp4", "archive:1");
    await ask(s, "/w/b.mp4", "archive:2");
    expect(s.spent).toBe(2);
    expect((await ask(s, "/w/c.mp4", "archive:3")).outcome).toBe("budget_spent");
  });

  /** A default that a video's clip count fits inside, and an override that refuses nonsense. */
  it("has a bounded, overridable default", () => {
    const prev = process.env.MAX_COMPOSE_PHASE_JUDGEMENTS;
    try {
      delete process.env.MAX_COMPOSE_PHASE_JUDGEMENTS;
      expect(maxComposePhaseJudgements()).toBe(24);
      process.env.MAX_COMPOSE_PHASE_JUDGEMENTS = "6";
      expect(maxComposePhaseJudgements()).toBe(6);
      process.env.MAX_COMPOSE_PHASE_JUDGEMENTS = "-3";
      expect(maxComposePhaseJudgements(), "a nonsense override silently disabled the stop").toBe(24);
      process.env.MAX_COMPOSE_PHASE_JUDGEMENTS = "9999";
      expect(maxComposePhaseJudgements()).toBe(24);
    } finally {
      if (prev === undefined) delete process.env.MAX_COMPOSE_PHASE_JUDGEMENTS;
      else process.env.MAX_COMPOSE_PHASE_JUDGEMENTS = prev;
    }
  });
});

/* ═══════════════════════ where it is wired ═══════════════════════ */

describe("both gates ask, and the diagnostic does not", () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  /** The push route knows its beat, so it hands it over rather than going through the audit. */
  it("the push gate asks before the barrier decides", () => {
    const at = CODE.indexOf("async function beatClipRefusedByRelevanceGate(");
    expect(at, "the push gate has moved or is no longer async").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 1200);
    const ask = body.indexOf("ensureVerdictBeforeCompose({");
    const decide = body.indexOf("composeBarrierAllows(");
    expect(ask, "the push route no longer asks for a missing verdict").toBeGreaterThan(-1);
    expect(ask, "it asks after the barrier has already decided").toBeLessThan(decide);
    expect(body, "the beat it knows is not passed on").toContain("beatIndex,");
  });

  /** And every one of its callers awaits it — a dropped await would gate on a Promise. */
  it("every push call site awaits the gate", () => {
    const awaited = [...CODE.matchAll(/await beatClipRefusedByRelevanceGate\(/g)].length;
    const total = [...CODE.matchAll(/[^n] beatClipRefusedByRelevanceGate\(/g)].length;
    expect(awaited, "the push gate's call sites have moved").toBeGreaterThanOrEqual(5);
    expect(total, "a call site gates on a Promise, which is always truthy").toBe(awaited);
  });

  it("the compose chokepoint asks before the barrier decides", () => {
    const at = CODE.indexOf("async function montageClipPassesComposeGate(");
    const body = CODE.slice(at, at + 2500);
    const ask = body.indexOf("ensureVerdictBeforeCompose({");
    const decide = body.indexOf("composeBarrierAllows(relevance");
    expect(ask, "the widest chokepoint no longer asks").toBeGreaterThan(-1);
    expect(ask).toBeLessThan(decide);
  });

  /**
   * The extension site reads state to LABEL an outcome — its own comment says "it reads state
   * rather than doing work". Making it judge would turn a diagnostic into a spend, on a route
   * whose common case is deliberately reusing footage already on the timeline.
   */
  it("the extension diagnostic still only reads", () => {
    const at = CODE.indexOf("const barrier = composeBarrierAllows(\n            dedup.beatRelevance, extended");
    expect(at, "the extension diagnostic has moved").toBeGreaterThan(-1);
    const before = CODE.slice(Math.max(0, at - 1500), at);
    expect(
      before,
      "the extension diagnostic now buys a verdict; it exists to label an outcome, not to gate"
    ).not.toContain("ensureVerdictBeforeCompose(");
  });

  /** The render opens the scope and installs every resolver it needs. */
  it("the render fills in the scope", () => {
    expect(CODE).toContain("withComposeJudgeScope(composeJudgeScope, () =>");
    for (const resolver of [
      "composeJudgeScope.workDir = workDir;",
      "composeJudgeScope.state = visualDedup.beatImageGate;",
      "composeJudgeScope.ledger = visualDedup.beatRelevance;",
      "composeJudgeScope.beatForClip =",
      "composeJudgeScope.contextFor =",
      "composeJudgeScope.isPlaceholder =",
    ]) {
      expect(CODE, `${resolver} is gone — the gate cannot do its job`).toContain(resolver);
    }
  });

  /** One context builder for every judging route, so two routes cannot disagree about a beat. */
  it("uses the same beat context every other route uses", () => {
    const at = CODE.indexOf("composeJudgeScope.contextFor =");
    expect(CODE.slice(at, at + 400)).toContain("beatVisualContext(");
  });

  /* ───────── the audit is told what was actually delivered ───────── */

  /**
   * A MUTATION ESCAPED HERE.
   *
   * `formatVisualFitAudit` now takes the set of clips the concat actually took, and its own tests
   * cover every branch of that. Removing the argument at the PIPELINE's call site broke none of
   * them — they test the function, and the function was still right. The audit would simply have
   * gone back to reporting "delivery not checked" on every render, which is the same class of gap
   * this whole round is about: a rule that is correct in one place and not reached from the other.
   */
  it("the render tells the audit which clips were delivered", () => {
    expect(CODE, "the audit is called without the delivered set again").toContain(
      "beatClipSeverity(visualDedup.beatRelevance, sceneIndex, beatIndex, basename),\n          deliveredBasenames"
    );
  });

  /**
   * Built from the FINAL_VIDEO EVENTS, not from the records.
   *
   * One lineage record can be re-pointed across several copies of an asset — render 564 had one
   * covering five filenames across three scenes — so `record.currentFilename` is not evidence of
   * which copy reached the file. The event carries the path `markFinalVideo` was handed.
   */
  it("reads delivery from the events, not from a record's current filename", () => {
    const at = CODE.indexOf("const deliveredBasenames = new Set(");
    expect(at, "the delivered set is gone").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 400);
    expect(body).toContain('e.stage === "FINAL_VIDEO"');
    expect(body).toContain("e.currentPath");
    expect(
      body,
      "delivery is read from the record's mutable filename, which one asset's copies overwrite"
    ).not.toContain("currentFilename");
  });
});
