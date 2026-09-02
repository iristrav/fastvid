/**
 * RONDE 103 — one place decides whether a picture belongs under a line of narration.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * FastVid had two judges of visual relevance and neither of them was in charge.
 *
 *   · CLIP (evaluateClipVisionGate) ran on every route and could refuse a clip on content
 *     grounds. RONDE 58 measured what its content verdicts are worth on this material: on one
 *     beat about the Battle of Berlin it scored a white-lives-matter roadside sticker 0.2226 and
 *     a signed photograph of Adolf Hitler 0.2116. It is not weak here, it is inverted, and
 *     tightening its threshold deletes the right picture and keeps the wrong one.
 *
 *   · The vision model (judgeBeatImage) actually looks at the frame and understands the
 *     narration — but it was wired into two places out of the fifteen a clip can arrive from,
 *     so most of the timeline was assembled with nothing having looked at it.
 *
 * So the pipeline had a strong judge with almost no reach and a weak judge with total reach.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * The single content decider. Every route that puts a clip on a beat calls `checkBeatRelevance`,
 * and CLIP is demoted to what it is genuinely good at: ranking candidates before this runs, and
 * picking a start point inside a clip. CLIP may order the queue. It may not decide what is in it.
 *
 * Three things make that affordable and honest:
 *
 *   · verdicts are cached per (picture, narration) pair, not per picture — see `beatIdentityKey`;
 *   · a per-beat ceiling means a beat with forty candidates cannot spend the render's budget;
 *   · the ledger records what was decided for every clip path, so the barrier at compose time can
 *     ask "was this ever looked at, and what did it say" about a file it did not source itself.
 *
 * ── Fail-open, deliberately (RONDE 103 phase 16) ─────────────────────────────────────────────
 *
 * `unknown` adopts. A vision-model outage must not be able to empty a montage — a render with no
 * pictures is worse than a render with imperfect ones, and this gate is the only thing standing
 * between a provider's 429 and a grey card. But `unknown` is never RECORDED as `fits`: the
 * ledger, the logs and the render summary all keep it distinct, so a render whose verdicts were
 * mostly unobtainable says so instead of reporting a clean sheet.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  MAX_JUDGEMENTS_PER_BEAT,
  beatImageRelevanceGateEnabled,
  judgeBeatImage,
  judgementTally,
  type BeatImageGateState,
  type BeatImageVerdict,
  type BeatSubjectAnchors,
} from "./beatImageRelevanceGate";
import { extractFrameAtFraction } from "./localClipVision";
/**
 * RONDE 166 — the severity vocabulary, read from the kind this decision's own words already imply.
 *
 * visualMismatchFeedback imports nothing from this module (it is a pure reader of the gate's
 * prose), so the dependency runs one way and there is no cycle to manage.
 */
import {
  classifyMismatch,
  formatVisualFitDecision,
  mismatchSeverity,
  reprieveAllowedFor,
} from "./visualMismatchFeedback";
import { JUDGEMENT_FRAME_FRACTIONS } from "./beatSegmentChoice";

/**
 * Everything the judge needs to know about the beat a clip is being cut under.
 *
 * RONDE 103 phase 4: this is the typed beat context the pipeline passes around instead of the
 * bare `beatText` string it used to. The old shape could not survive a hand-off — a route that
 * received only the text could not name the beat it belonged to, so nothing downstream could tell
 * which narration a clip had been judged against, and `clips: string[]` at compose time had no way
 * back to any of it.
 */
export type BeatVisualContext = {
  sceneIndex: number;
  beatIndex: number;
  /** The line of narration this shot sits under. The judge's actual question. */
  beatText: string;
  /** The paragraph it belongs to — context for the judge, not a second question. */
  sceneText?: string;
  videoTitle?: string;
  /**
   * RONDE 175 §3 — the subject, years and places the pipeline verified for this beat.
   *
   * Passed to the judge so it does not have to infer them from prose. Deliberately NOT part of
   * `beatIdentityKey`: two clips judged against the same narration are the same question whether
   * or not the anchors were available, and letting them into the key would split the cache and
   * re-ask questions that were already answered.
   */
  anchors?: BeatSubjectAnchors;
};

/** What was decided about one clip on one beat. */
export type BeatRelevanceDecision = {
  verdict: BeatImageVerdict;
  /** Whether the caller may use this clip. `does_not_fit` is the only value that makes this false. */
  allowed: boolean;
  /**
   * RONDE 67 product decision, kept: a refused clip may still be used when every alternative was
   * refused too, because a real picture beats a grey card. When that happens this is true and the
   * verdict stays `does_not_fit` — a reprieve is a decision to overrule the judge, never a
   * decision to relabel what the judge said.
   */
  reprieved: boolean;
  /** True when the verdict came from the cache rather than a fresh look. */
  cached: boolean;
  /** What the model says is in the frame. Empty for `unknown`. */
  depicts: string;
  reason: string;
  /** Which route asked — `adopt`, `funnel`, `rescue`, `compose`, … Logged, never decisive. */
  route: string;
  /**
   * Did a model actually LOOK at this picture?
   *
   * ── Why `verdict: "unknown"` was not enough ──────────────────────────────────────────────
   *
   * `unknown` was recorded for two completely different events. A model looked and could not
   * decide — an ambiguous frame, an answer with no verdict in it. And the gate NEVER LOOKED: the
   * clip is a neutral placeholder, the gate is switched off, there is no narration to judge
   * against, the per-beat look ceiling was reached.
   *
   * `beatVisualStatus.verificationOf` documents that collapse in a comment and then returns
   * `unknown` for both, while its own vocabulary has carried a `never_asked` member since
   * RONDE 166 that nothing could ever produce. This field is what produces it.
   *
   * The two demand opposite readings. "Looked, unsure" is a fact about the PICTURE. "Never
   * looked" is a fact about this RENDER's budget and configuration, and a beat that ends without
   * an approved picture because nobody looked must never be reported as a beat whose picture was
   * examined and found wanting.
   */
  evaluated: boolean;
};

/**
 * RONDE 103 phase 3 — what identifies a beat for caching purposes.
 *
 * The obvious candidate is `beat.index`, and it is wrong twice over. It is scene-local, so
 * s0b2 and s3b2 collide; and it is positional, so re-planning a scene silently reassigns every
 * verdict in it to different narration.
 *
 * The identity that is actually correct falls out of what the judge is asked. `buildPrompt` in
 * ./beatImageRelevanceGate composes its question from the beat's text, the scene's text and the
 * documentary title — nothing else. Two beats that produce the same question deserve the same
 * answer, and two beats that produce different questions must not share one. So the identity IS
 * the question's inputs, normalised and hashed.
 *
 * The normalisation (lowercase, collapse whitespace, strip punctuation) is deliberate and narrow:
 * it makes a beat that was re-emitted with different spacing or a smart quote hash the same, and
 * it changes nothing about which narration the judge sees. The prompt truncates its inputs, so
 * the hash truncates on the same boundaries — otherwise two beats the model cannot tell apart
 * would still miss the cache and be paid for twice.
 */
export function beatIdentityKey(ctx: BeatVisualContext): string {
  const norm = (s: string | undefined, max: number): string =>
    (s ?? "")
      .slice(0, max)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Same slices buildPrompt() uses, so the hash and the question agree on what "the same beat" is.
  const parts = [norm(ctx.beatText, 300), norm(ctx.sceneText, 300), norm(ctx.videoTitle, 200)];
  if (!parts[0]) return "";
  return crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Stable label for one beat, used for the per-beat spend ceiling and in logs. */
export function beatSlotKey(ctx: BeatVisualContext): string {
  return `s${ctx.sceneIndex}b${ctx.beatIndex}`;
}

/**
 * Render-scoped memory of what this gate decided, and what it spent deciding it.
 *
 * Lives on VisualDedupState alongside BeatImageGateState so it is created and discarded with
 * exactly one render — two concurrent renders can neither read each other's verdicts nor spend
 * each other's budget.
 */
export type BeatRelevanceEntry = { ctx: BeatVisualContext; decision: BeatRelevanceDecision };

export type BeatRelevanceLedger = {
  /** clip path -> the decision that let it through, so a later stage can ask what was decided. */
  byClipPath: Map<string, BeatRelevanceEntry>;
  /**
   * The same entries under the clip's CONTENT identity.
   *
   * A clip is judged, then trimmed, then has a text overlay burned in, and each step writes a new
   * file — so the path the barrier sees at compose time is not the path the gate judged. Content
   * identity survives all of it for anything with a real provenance (a curated asset id, a
   * `__pid_` provider tag, a stock video id), which is every clip that came from a source. That
   * is what makes the barrier able to recognise a refused clip arriving under a new name — the
   * exact trick that used to get one into the finished file.
   */
  byContentKey: Map<string, BeatRelevanceEntry>;
  /** `beatSlotKey` -> judgements this beat has paid for. Bounds a beat with many candidates. */
  spendByBeat: Map<string, number>;
};

export function createBeatRelevanceLedger(): BeatRelevanceLedger {
  return { byClipPath: new Map(), byContentKey: new Map(), spendByBeat: new Map() };
}

/**
 * How many candidates ONE beat may pay to have looked at.
 *
 * Removing CLIP's content authority means many more candidates reach this gate than before, and
 * the render-wide ceiling alone does not protect against one greedy beat: scene 0 with forty
 * candidates would spend the whole budget and leave every later scene unexamined — which is
 * exactly the failure the `judgementsSkipped` counter was added to make visible. The per-beat
 * ceiling is what stops that being possible in the first place.
 */
export function maxRelevanceLooksPerBeat(): number {
  const raw = process.env.MAX_BEAT_RELEVANCE_LOOKS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_JUDGEMENTS_PER_BEAT + 1;
}

/** Frames sampled across a clip. Cleaned up on every exit path, including the failures. */
async function sampleFrames(
  clipPath: string,
  workDir: string,
  ctx: BeatVisualContext,
  tag: string
): Promise<string[]> {
  const out: string[] = [];
  for (let f = 0; f < JUDGEMENT_FRAME_FRACTIONS.length; f++) {
    const framePath = path.join(
      workDir,
      `bvr_${tag}_s${ctx.sceneIndex}b${ctx.beatIndex}_${f}.jpg`
    );
    const got = await extractFrameAtFraction(
      clipPath,
      framePath,
      JUDGEMENT_FRAME_FRACTIONS[f]!,
      8_000
    ).catch(() => false);
    if (got) out.push(framePath);
  }
  return out;
}

function discardFrames(framePaths: string[]): void {
  for (const p of framePaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* a frame that is already gone needs no cleaning up */
    }
  }
}

export type BeatRelevanceParams = {
  clipPath: string;
  /** Content identity of the clip — a renamed or re-trimmed copy shares it. */
  contentKey: string;
  ctx: BeatVisualContext;
  workDir: string;
  state: BeatImageGateState;
  ledger: BeatRelevanceLedger;
  /** Which route is asking. Logged so a bypass shows up as a route that never appears. */
  route: string;
  /**
   * RONDE 103 phase 7 — a neutral card is not a claim about the world.
   *
   * A colour fallback or a text overlay depicts nothing, so "does this belong under this
   * narration" has no answer to give and a vision call on it is money spent to learn nothing.
   * Real imagery — the guaranteed ladder's `topical` and `wikimedia` tiers included — is never
   * exempt.
   */
  placeholder?: boolean;
  /** Called with the delta in judgement spend, so per-beat audits stay attributable. */
  onSpend?: (spent: { judged: number; failed: number; skipped: number }) => void;
};

/**
 * The one content decision in the pipeline.
 *
 * Never throws. Returns `allowed: false` only on a definite `does_not_fit` that was not
 * reprieved; every other outcome — gate off, no narration, no frame, budget spent, model outage,
 * per-beat ceiling reached — returns `allowed: true` with the verdict that actually applies.
 */
export async function checkBeatRelevance(
  params: BeatRelevanceParams
): Promise<BeatRelevanceDecision> {
  const { clipPath, contentKey, ctx, workDir, state, ledger, route } = params;

  const record = (decision: BeatRelevanceDecision): BeatRelevanceDecision => {
    const entry: BeatRelevanceEntry = { ctx, decision };
    ledger.byClipPath.set(clipPath, entry);
    // A `file:`-family key is derived from the file's own size and name, so it does not survive a
    // rename and indexing it would be a lie. Everything else identifies the asset, not the file.
    if (contentKey && !contentKey.startsWith("file:")) ledger.byContentKey.set(contentKey, entry);
    return decision;
  };
  /**
   * A verdict-free pass. Every caller below is a case where the gate DID NOT LOOK, so `evaluated`
   * is false — see the field's note on `BeatRelevanceDecision`.
   */
  const pass = (verdict: BeatImageVerdict, reason: string, cached = false): BeatRelevanceDecision =>
    record({ verdict, allowed: true, reprieved: false, cached, depicts: "", reason, route, evaluated: false });

  if (params.placeholder) return pass("unknown", "neutral placeholder — nothing to judge");
  if (!beatImageRelevanceGateEnabled()) return pass("unknown", "gate disabled");
  if (!ctx.beatText?.trim()) return pass("unknown", "no narration to judge against");

  const slot = beatSlotKey(ctx);
  const spentOnBeat = ledger.spendByBeat.get(slot) ?? 0;
  const identity = beatIdentityKey(ctx);
  const cacheKey = `${contentKey}|${identity}`;
  // A cached verdict costs nothing, so the per-beat ceiling must not hide one. Checking the
  // ceiling first would make a beat that has already looked twice adopt a clip it KNOWS does not
  // fit — the budget exists to bound spending, not to launder verdicts already earned.
  const alreadyKnown = state.seen.get(cacheKey);
  if (!alreadyKnown && spentOnBeat >= maxRelevanceLooksPerBeat()) {
    state.judgementsSkipped++;
    return pass("unknown", `per-beat look ceiling reached (${spentOnBeat})`);
  }

  const framePaths = alreadyKnown ? [] : await sampleFrames(clipPath, workDir, ctx, route);
  const before = {
    attempts: state.judgementAttempts,
    failed: state.judgementsFailed,
    skipped: state.judgementsSkipped,
  };
  const judgement = await judgeBeatImage({
    framePaths,
    beatText: ctx.beatText,
    videoTitle: ctx.videoTitle,
    sceneText: ctx.sceneText,
    // RONDE 175 §3: what the pipeline already established this beat is about. Absent on a caller
    // that has none, in which case the prompt prints nothing rather than an empty placeholder.
    anchors: ctx.anchors,
    contentKey,
    beatIdentity: identity,
    state,
  });
  discardFrames(framePaths);

  const spent = {
    judged: state.judgementAttempts - before.attempts,
    failed: state.judgementsFailed - before.failed,
    skipped: state.judgementsSkipped - before.skipped,
  };
  if (spent.judged > 0) ledger.spendByBeat.set(slot, spentOnBeat + spent.judged);
  params.onSpend?.(spent);

  const decision: BeatRelevanceDecision = {
    verdict: judgement.verdict,
    allowed: judgement.verdict !== "does_not_fit",
    reprieved: false,
    cached: judgement.cached === true,
    depicts: judgement.depicts,
    reason: judgement.reason,
    route,
    /** The gate's own answer to "did a model look at this", carried rather than re-derived. */
    evaluated: judgement.evaluated,
  };
  console.log(
    `[BeatRelevance] ${slot} ${route} ${decision.verdict}` +
      ` clip=${path.basename(clipPath)} cached=${decision.cached}` +
      ` depicts="${decision.depicts}" reason="${decision.reason}"`
  );
  return record(decision);
}

/**
 * RONDE 104 — record a verdict that was earned outside `checkBeatRelevance`.
 *
 * There is exactly one such caller and it is deliberate: the YouTube pre-pool check judges a clip
 * before it belongs to any beat, so it cannot go through the normal path (there is no beat slot
 * to charge, and no per-beat ceiling that means anything). Its answers were therefore going only
 * to the log — which meant a YouTube clip refused there could arrive later by another route as a
 * path nothing had judged, and the compose barrier had to let it through.
 *
 * This does not make a decision and does not call the model. It writes down one that was already
 * made, so the refusal follows the ASSET rather than the file it happened to be in at the time.
 */
export function recordExternalRelevanceVerdict(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  contentKey: string,
  ctx: BeatVisualContext,
  /**
   * `evaluated` is optional and defaults to TRUE here, deliberately.
   *
   * Every caller of this recorder passes a verdict a model really produced — that is what
   * "earned outside checkBeatRelevance" means. A caller that has a decline to record must say so
   * explicitly, rather than a decline being the accidental default of an omitted field.
   */
  judgement: {
    verdict: BeatImageVerdict;
    depicts: string;
    reason: string;
    cached?: boolean;
    evaluated?: boolean;
  },
  route: string
): BeatRelevanceDecision {
  const decision: BeatRelevanceDecision = {
    verdict: judgement.verdict,
    allowed: judgement.verdict !== "does_not_fit",
    reprieved: false,
    cached: judgement.cached === true,
    depicts: judgement.depicts,
    reason: judgement.reason,
    route,
    /** See the parameter's note: an omitted flag means a real look, never a decline. */
    evaluated: judgement.evaluated !== false,
  };
  const entry: BeatRelevanceEntry = { ctx, decision };
  ledger.byClipPath.set(clipPath, entry);
  if (contentKey && !contentKey.startsWith("file:")) ledger.byContentKey.set(contentKey, entry);
  return decision;
}

/**
 * RONDE 103 phase 15 — overrule the judge, on the record.
 * RONDE 166 — and only for the refusals that decision was ever defensible for.
 *
 * The reprieve is a product decision (RONDE 67): when every alternative was refused too, an
 * imperfect picture beats a grey card. RONDE 103 fixed its bookkeeping — the clip used to enter
 * the montage with no trace that anything had objected. What neither round asked is HOW wrong the
 * refused picture was, and video 554 is what that costs: six beats shipped with a picture the gate
 * had refused, because "better than nothing" was applied to every refusal equally.
 *
 * It is not applied equally any more. `mismatchSeverity` reads the kind `classifyMismatch` already
 * derives from this very decision's own `depicts`/`reason` — no second judge, no second model call,
 * nothing asked that was not already answered. A refusal that is about the right thing and
 * imperfectly so may still be taken back; one that puts a different topic, a title card or a blank
 * frame on screen may not, at any price.
 *
 * THIS IS THE SINGLE CHOKE POINT. `composeBarrierAllows` below refuses every `does_not_fit` that
 * nobody reprieved, and `inheritBeatRelevance` carries that across every rename — so a refusal
 * this function declines to lift cannot be brought back by the funnel, the curated route, an
 * extension, a cross-beat reuse or a compose rescue. There is deliberately no second way in.
 *
 * Returns whether the reprieve was granted, so a caller that was about to adopt the clip can stop.
 */
export function reprieveBeatClip(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  why: string
): boolean {
  const entry = ledger.byClipPath.get(clipPath);
  if (!entry) return false;
  const kind = classifyMismatch({
    depicts: entry.decision.depicts,
    reason: entry.decision.reason,
  });
  const severity = mismatchSeverity(kind);
  const beatLabel = beatSlotKey(entry.ctx);
  const candidate = path.basename(clipPath);
  if (!reprieveAllowedFor(kind)) {
    console.warn(
      formatVisualFitDecision({
        beatLabel,
        candidate,
        verdict: entry.decision.verdict,
        severity,
        decision: "REJECTED",
        reason: `${kind.toLowerCase()}_may_not_be_reprieved`,
      })
    );
    return false;
  }
  entry.decision = { ...entry.decision, allowed: true, reprieved: true };
  console.log(
    formatVisualFitDecision({
      beatLabel,
      candidate,
      verdict: entry.decision.verdict,
      severity,
      decision: "REPRIEVED",
      reason: why,
      fallback: true,
    })
  );
  return true;
}

/**
 * RONDE 166 §7 — the line that says why the picture that IS on screen is on screen.
 *
 * A log that only prints problems cannot distinguish "this beat's picture was approved" from
 * "nobody ever looked at this beat's picture", and video 554 contained both. Returns null only
 * when the clip is genuinely unknown to the ledger, which the render summary already counts.
 */
export function formatAdoptedFitDecision(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  contentKey?: string
): string | null {
  const entry =
    ledger.byClipPath.get(clipPath) ??
    (contentKey ? ledger.byContentKey.get(contentKey) : undefined);
  if (!entry) return null;
  const d = entry.decision;
  const severity =
    d.verdict === "does_not_fit"
      ? mismatchSeverity(classifyMismatch({ depicts: d.depicts, reason: d.reason }))
      : "NONE";
  return formatVisualFitDecision({
    beatLabel: beatSlotKey(entry.ctx),
    candidate: path.basename(clipPath),
    verdict: d.verdict,
    severity,
    decision: "ADOPTED",
    reason: d.reprieved ? "reprieved_soft_mismatch" : d.verdict,
    fallback: d.reprieved,
  });
}

/**
 * RENDER 563 — THE MANIFEST REPORTED ANOTHER CLIP'S VERDICT.
 *
 * ── The contradiction ───────────────────────────────────────────────────────────────────────
 *
 *   [BeatRelevance] s0b1 gate:archive fits clip=scene_0_b1_curated_a57383.mp4
 *     depicts="Street scene with people in front of a building marked 'Apteka'…"
 *   [RenderAsset] scene=0 beat=1 file=scene_0_b1_curated_a57383.mp4 verdict=does_not_fit
 *
 * The same file, the same beat, two opposite verdicts in one render. The manifest's lookup was:
 *
 *     for (const { ctx, decision } of ledger.byClipPath.values())
 *       if (ctx.sceneIndex === r.sceneIndex && ctx.beatIndex === r.beatIndex) return decision;
 *
 * Matched on the BEAT and nothing else, and returned the first entry in insertion order — which,
 * on a beat that judged several candidates, is the first one looked at, usually a REJECTED one.
 * The clip the line names took no part in choosing the verdict the line prints.
 *
 * ── Why this one matters more than it looks ─────────────────────────────────────────────────
 *
 * It is wrong in both directions, and the other direction is the dangerous one: a beat that
 * refused a candidate and then adopted a good one reports `does_not_fit` (harmless noise), but a
 * beat that approved a candidate and then adopted a DIFFERENT one reports `fits` — an audit line
 * stating that a clip was examined and approved when nothing of the sort happened.
 *
 * `[RenderAsset]` exists to answer "did anybody check what is in the delivered file". An answer
 * assembled from a different clip's judgement cannot answer it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 * A verdict counts for a rendered asset only when it was earned by THIS clip, at THIS beat. The
 * clip is recognised by its path, by its content identity (which survives the trim and overlay
 * renames — see `byContentKey`), or by its filename. Anything else is `never_asked`, which is
 * exactly what it is: nobody looked at this picture under this narration.
 *
 * `beatClipSeverity` above already preferred the filename before falling back to the beat; the
 * manifest simply never used the clip at all.
 */
export function relevanceVerdictForRenderedAsset(
  ledger: BeatRelevanceLedger | undefined,
  asset: {
    localPath?: string;
    currentFilename?: string;
    contentKey?: string;
    sceneIndex: number;
    beatIndex: number;
  }
): { verdict: BeatImageVerdict; cached: boolean; reprieved: boolean; matchedBy: string } | null {
  if (!ledger) return null;

  /** The verdict must belong to this beat's narration — a verdict earned elsewhere is not one. */
  const onThisBeat = (entry: BeatRelevanceEntry | undefined): boolean =>
    Boolean(
      entry &&
        entry.ctx.sceneIndex === asset.sceneIndex &&
        entry.ctx.beatIndex === asset.beatIndex
    );

  const answer = (entry: BeatRelevanceEntry, matchedBy: string) => ({
    verdict: entry.decision.verdict,
    cached: entry.decision.cached,
    reprieved: entry.decision.reprieved,
    matchedBy,
  });

  const byPath = asset.localPath ? ledger.byClipPath.get(asset.localPath) : undefined;
  if (onThisBeat(byPath)) return answer(byPath!, "path");

  const byContent = asset.contentKey ? ledger.byContentKey.get(asset.contentKey) : undefined;
  if (onThisBeat(byContent)) return answer(byContent!, "content");

  const wanted = asset.currentFilename || (asset.localPath ? path.basename(asset.localPath) : "");
  if (wanted) {
    for (const [clipPath, entry] of ledger.byClipPath.entries()) {
      if (path.basename(clipPath) !== wanted) continue;
      if (!onThisBeat(entry)) continue;
      return answer(entry, "filename");
    }
  }
  return null;
}

/**
 * RONDE 166 — how wrong the picture on this beat was judged to be.
 *
 * Looked up by the adopted file's basename, the same handle the adopt audit records, falling back
 * to any decision on the beat. "NONE" when nothing was refused; the refusal's own words decide the
 * rest, through the same `classifyMismatch` the reprieve guard uses.
 */
export function beatClipSeverity(
  ledger: BeatRelevanceLedger | undefined,
  sceneIndex: number,
  beatIndex: number,
  basename: string
): string {
  if (!ledger) return "NONE";
  let onThisBeat: BeatRelevanceDecision | null = null;
  for (const [clipPath, { ctx, decision }] of ledger.byClipPath.entries()) {
    if (ctx.sceneIndex !== sceneIndex || ctx.beatIndex !== beatIndex) continue;
    if (basename && path.basename(clipPath) === basename) {
      onThisBeat = decision;
      break;
    }
    onThisBeat ??= decision;
  }
  if (!onThisBeat || onThisBeat.verdict !== "does_not_fit") return "NONE";
  return mismatchSeverity(
    classifyMismatch({ depicts: onThisBeat.depicts, reason: onThisBeat.reason })
  );
}

/**
 * Carry a decision across a rename.
 *
 * A clip is trimmed, has a text overlay burned in, or is transformed for fair use, and each step
 * writes a new file. Without this the barrier at compose time sees an unknown path and has to
 * fail open — which is how a refused clip used to reach the timeline under a new name.
 */
export function inheritBeatRelevance(
  ledger: BeatRelevanceLedger,
  fromClipPath: string,
  toClipPath: string
): void {
  if (fromClipPath === toClipPath) return;
  const entry = ledger.byClipPath.get(fromClipPath);
  if (entry) ledger.byClipPath.set(toClipPath, entry);
}

/**
 * Whether the compose barrier could recognise this clip at all.
 *
 * Reported rather than enforced. A route that builds its own file and hands it straight to
 * compose leaves the barrier nothing to check, and the honest thing to do about that is to say
 * how often it happens — a rising number is a route that has gone around the gate.
 */
export function barrierCoverage(ledger: BeatRelevanceLedger): {
  judgedPaths: number;
  judgedAssets: number;
} {
  return { judgedPaths: ledger.byClipPath.size, judgedAssets: ledger.byContentKey.size };
}

/** What the gate decided about this exact file, if it has seen it. */
export function lookupBeatRelevance(
  ledger: BeatRelevanceLedger,
  clipPath: string
): BeatRelevanceEntry | null {
  return ledger.byClipPath.get(clipPath) ?? null;
}


/**
 * RONDE 103 phase 17 — the last barrier before a clip is composed into a scene.
 *
 * Everything upstream is a route, and a route can be added. This is the one place every frame
 * that reaches the finished file must pass, so it asks the only question that cannot be answered
 * anywhere else: did anything object to this clip, and was that objection overruled on purpose?
 *
 * It refuses exactly one thing — a `does_not_fit` that nobody reprieved. It cannot judge a clip
 * it has never seen (compose is handed bare paths from rescue paths that build their own files)
 * and it does not pretend to: an unknown path passes and is counted, so "the barrier is being
 * bypassed" is a number in the render summary rather than a silence.
 */
export function composeBarrierAllows(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  /** Content identity of the file, so a refused clip cannot walk through under a new name. */
  contentKey?: string
): { allow: boolean; reason: string } {
  const entry =
    ledger.byClipPath.get(clipPath) ??
    (contentKey ? ledger.byContentKey.get(contentKey) : undefined);
  if (!entry) return { allow: true, reason: "never judged — no beat context at this path" };
  const d = entry.decision;
  if (d.verdict === "does_not_fit" && !d.reprieved) {
    return { allow: false, reason: `refused on ${beatSlotKey(entry.ctx)}: ${d.reason}` };
  }
  if (d.reprieved) return { allow: true, reason: "refused but reprieved deliberately" };
  return { allow: true, reason: d.verdict };
}

/** One line per render: what the content decider actually managed to decide. */
export function formatRelevanceSummary(
  state: BeatImageGateState,
  ledger: BeatRelevanceLedger
): string {
  let fits = 0;
  let refused = 0;
  let reprieved = 0;
  let unknown = 0;
  for (const { decision } of ledger.byClipPath.values()) {
    if (decision.reprieved) reprieved++;
    if (decision.verdict === "fits") fits++;
    else if (decision.verdict === "does_not_fit") refused++;
    else unknown++;
  }
  /**
   * RONDE 105: the gate's own counters, printed as a partition rather than as three numbers a
   * reader has to combine. `attempts` is the total, `answered` is what came back, and the line
   * says both — so "the model answered nothing" cannot read as "the model answered half".
   */
  const t = judgementTally(state);
  return (
    `[BeatRelevance] render summary — attempts=${t.attempts} answered=${t.answered} ` +
    `(fits=${t.fits} does_not_fit=${t.mismatch}) failed=${t.failed} ` +
    `never_asked=${t.skipped}${t.inconsistent ? " COUNTERS_INCONSISTENT" : ""} | ` +
    `clips: fits=${fits} does_not_fit=${refused} (reprieved=${reprieved}) unknown=${unknown}`
  );
}
