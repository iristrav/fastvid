/**
 * THE GATE SHIPPED, AND ON THE NEXT RENDER IT WAS ASKED NOTHING.
 *
 *     [SubjectGate] asked=0 refused=0 plausible=0 declined=0 noProvider=0 cached=0
 *
 * Render 563, the first render after the metadata screen was added. Every counter zero — which
 * reads as "there was nothing for it to do", and there was: that render downloaded and adopted
 * footage nobody had looked at, which is the exact thing the gate was built to stop.
 *
 * ── Why it was silent ───────────────────────────────────────────────────────────────────────
 *
 * It was wired into the retrieval funnel's shortlist loop — the route the render-562 clip came in
 * on, and not the only route. `downloadAndTrimPoolCandidate` is also called directly by the
 * scene-pool path, which never passes that loop. So the check existed on one of the ways in.
 *
 * ── The seam, for the seventh time ──────────────────────────────────────────────────────────
 *
 * `recordClipAdopt` (R53). The still/moving counters (R62). The beat outcome audit (R70).
 * Failed-asset registration (R86). The source-length memo. The vision verdict counter. And this.
 * Every one is a rule that several call sites had to remember, remembered by one of them.
 *
 * The answer each time is the same and it is the one taken here: put the rule where the routes
 * meet. A candidate cannot be fetched without passing `downloadAndTrimPoolCandidate`, so the
 * screen goes there, and the beat's narration reaches it through an ambient scope — the pattern
 * already carrying search provenance, the render topic and the source-length memo.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  candidateSubjectKey,
  createCandidateSubjectGateState,
  screenCandidateBeforeDownload,
  withSubjectGateScope,
  type CandidateSubjectContext,
  type CandidateSubjectFacts,
  type SubjectGateScope,
} from "./candidateSubjectGate";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
/** Claims below are about executable code, not about the comments that quote the defect. */
const CODE = PIPE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/* ═══════════════════════ render 562's clip, as the search returned it ═══════════════════════ */

const BEAT = "Imagine a world where Adolf Hitler's 1944 ceasefire proposal had been accepted.";

const FACTS: CandidateSubjectFacts = {
  id: "internet_archive:white-lives-matter-montana-activism-in-butte-2",
  assetId: "white-lives-matter-montana-activism-in-butte-2",
  source: "internet_archive",
  title: "White Lives Matter Montana — activism in Butte",
  description: null,
  tags: [],
};

const CTX: CandidateSubjectContext = { beatText: BEAT, anchors: ["Adolf Hitler"] };

function scope(overrides: Partial<SubjectGateScope> = {}): SubjectGateScope {
  return {
    state: createCandidateSubjectGateState(),
    contextFor: () => CTX,
    ...overrides,
  };
}

/**
 * A refusal already in the judge's cache.
 *
 * This is the one way to exercise a REFUSAL without a provider: the cache is real behaviour — the
 * same asset judged once per beat, not once per download — and reading it is what the second of
 * two routes actually does. Nothing here simulates a model answer that was never given.
 */
function withCachedRefusal(s: SubjectGateScope): SubjectGateScope {
  s.state.seen.set(candidateSubjectKey(FACTS.id, BEAT), {
    verdict: "does_not_belong",
    allowed: false,
    reason: "modern political demonstration: does not belong under wartime narration",
    evaluated: true,
  });
  return s;
}

/* ═══════════════════════ the scope, and what it does without one ═══════════════════════ */

describe("the screen every download route passes through", () => {
  /** Outside a render nothing changes — no scope, no judgement, no counter moved. */
  it("allows and counts nothing when no scope is open", async () => {
    const decision = await screenCandidateBeforeDownload({
      facts: FACTS,
      sceneIndex: 0,
      beatIndex: 0,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.evaluated).toBe(false);
    expect(decision.reason).toContain("no subject-gate scope");
  });

  /**
   * A beat the render cannot place is a DECLINE, counted. `asked=0 declined=0` was how this whole
   * defect looked in the log: indistinguishable from a render with nothing to screen.
   */
  it("declines audibly when the beat cannot be placed", async () => {
    const s = scope({ contextFor: () => undefined });
    const decision = await withSubjectGateScope(s, () =>
      screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 1, beatIndex: 2 })
    );
    expect(decision.allowed, "an unplaceable beat must still let the render continue").toBe(true);
    expect(decision.reason).toContain("s1b2");
    expect(s.state.skipped, "the decline was not counted, so the log reads as idle").toBe(1);
  });

  /** The refusal reaches the caller as a refusal, not as an advisory. */
  it("refuses the candidate the gate was built for", async () => {
    const s = withCachedRefusal(scope());
    const decision = await withSubjectGateScope(s, () =>
      screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 0, beatIndex: 0 })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not belong");
  });

  /** And is recorded in the render's own reject audit, through the scope. */
  it("reports the refusal to the render, not to the download site", async () => {
    const onRefusal = vi.fn();
    const s = withCachedRefusal(scope({ onRefusal }));
    await withSubjectGateScope(s, () =>
      screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 3, beatIndex: 4 })
    );
    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onRefusal.mock.calls[0]![0]).toMatchObject({
      sceneIndex: 3,
      beatIndex: 4,
      facts: { assetId: FACTS.assetId },
    });
  });

  /** A candidate that passes is not reported as a refusal. */
  it("says nothing about a candidate it lets through", async () => {
    const onRefusal = vi.fn();
    const s = scope({ onRefusal });
    s.state.seen.set(candidateSubjectKey(FACTS.id, BEAT), {
      verdict: "plausible",
      allowed: true,
      reason: "could belong",
      evaluated: true,
    });
    const decision = await withSubjectGateScope(s, () =>
      screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 0, beatIndex: 0 })
    );
    expect(decision.allowed).toBe(true);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  /** Scopes do not leak between renders — one video's refusal cannot ban an asset for another. */
  it("does not outlive its own scope", async () => {
    const s = withCachedRefusal(scope());
    await withSubjectGateScope(s, () =>
      screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 0, beatIndex: 0 })
    );
    const after = await screenCandidateBeforeDownload({ facts: FACTS, sceneIndex: 0, beatIndex: 0 });
    expect(after.allowed, "a previous render's scope is still in force").toBe(true);
    expect(after.reason).toContain("no subject-gate scope");
  });
});

/* ═══════════════════════ it is at the download, not at a caller ═══════════════════════ */

describe("the check sits where the bytes are fetched", () => {
  /** The chokepoint: no route can reach a pool candidate's bytes without passing this. */
  it("downloadAndTrimPoolCandidate screens before anything else", () => {
    const at = CODE.indexOf("export async function downloadAndTrimPoolCandidate(");
    expect(at, "the download chokepoint has moved").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 3000);
    expect(body, "the pool route downloads without a subject screen again").toContain(
      "screenCandidateBeforeDownload({"
    );
    const screen = body.indexOf("screenCandidateBeforeDownload({");
    const refusal = body.indexOf("if (!subjectScreen.allowed)");
    expect(refusal, "the screen's answer is computed and ignored").toBeGreaterThan(screen);
    /** Before the filename is even built, so nothing is written for a refused candidate. */
    const firstWork = body.indexOf("const safeId =");
    expect(
      screen,
      "the screen runs after the download has already started preparing"
    ).toBeLessThan(firstWork);
  });

  /**
   * ONE expression of the decision. A second direct call to the judge is exactly how the funnel
   * and the pool route came to disagree about whether a candidate had been looked at.
   */
  it("nothing in the pipeline judges a candidate on its own", () => {
    expect(
      CODE,
      "a route calls judgeCandidateSubject directly again, bypassing the scope and the audit"
    ).not.toContain("judgeCandidateSubject(");
  });

  /** The funnel still screens early — but through the same door. */
  it("the funnel asks the same question, not its own", () => {
    const at = CODE.indexOf("const subjectVerdicts = await Promise.all(");
    expect(at, "the funnel's parallel pre-screen is gone").toBeGreaterThan(-1);
    const block = CODE.slice(at, at + 1200);
    expect(block).toContain("screenCandidateBeforeDownload({");
    /** Still in parallel — RONDE 5 FIX 6's budget finding applies to this loop too. */
    expect(block, "the pre-screen went sequential and will eat the beat budget").toContain(
      "toScore.map(async (candidate)"
    );
  });
});

/* ═══════════════════════ the render opens the scope, once ═══════════════════════ */

describe("the render's scope", () => {
  it("is opened for the whole render, beside the other render scopes", () => {
    expect(CODE, "no scope is ever opened, so the gate declines on every download").toContain(
      "withSubjectGateScope(subjectGateScope, () =>"
    );
    const at = CODE.indexOf("withSourceFloorMemo(sourceFloorMemo, () =>");
    const scopeAt = CODE.indexOf("withSubjectGateScope(subjectGateScope, () =>");
    expect(scopeAt, "the subject-gate scope is not part of the render's scope chain").toBeGreaterThan(at);
  });

  /**
   * The resolver reads the beat record every route writes — the same one that fixed `beats=0`.
   * Reading a clip list instead would put the gate back on one route's bookkeeping.
   */
  it("places a beat from the record every route writes", () => {
    const at = CODE.indexOf("subjectGateScope.contextFor = (sceneIndex, beatIndex) =>");
    expect(at, "the resolver is never installed").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 900);
    expect(body).toContain("visualDedup.sceneBeatsBySceneIndex.get(sceneIndex)");
    expect(body, "the resolver invents a narration when the beat is unknown").toContain(
      "return undefined"
    );
  });

  /** One state, so the summary line reports what the download sites actually did. */
  it("shares the counters the summary line prints", () => {
    expect(CODE).toContain("visualDedup.candidateSubjectGate = subjectGateScope.state;");
    expect(CODE).toContain("formatCandidateSubjectSummary(visualDedup.candidateSubjectGate)");
  });

  /** A refusal reaches the render's reject audit, which is where the funnel used to put it. */
  it("records a refusal in the render's clip reject audit", () => {
    const at = CODE.indexOf("subjectGateScope.onRefusal =");
    expect(at, "refusals are no longer audited").toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 500);
    expect(body).toContain("recordClipReject(");
    expect(body).toContain('"subject_gate"');
  });
});
