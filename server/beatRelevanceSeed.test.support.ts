/**
 * SEEDING A RELEVANCE LEDGER, FOR TESTS.
 *
 * ── Why this is no longer production code ───────────────────────────────────────────────────
 *
 * RONDE 104 added this to `beatVisualRelevance` for one production caller: the YouTube pre-pool
 * screening judged a clip before it belonged to any beat, so its verdict could not go through
 * `checkBeatRelevance` — there was no beat slot to charge and no per-beat ceiling that meant
 * anything. Writing it down here kept the refusal following the ASSET rather than the file.
 *
 * That screening is gone — see youtubeIsJudgedWhereItIsUsed.test.ts. YouTube is judged once, by
 * the beat gate, on the sentence it will run under, so nothing in production earns a verdict
 * outside `checkBeatRelevance` any more.
 *
 * `ronde120MetricsHaveWriters` caught the consequence immediately and put the choice plainly:
 * "give it a caller, or delete it". Neither was right on its own. A `record*` export in a
 * measurement module with no production caller is exactly the lie that guard exists to catch, and
 * silencing the guard would have been worse than the dead code. But eight test files use this to
 * put a verdict into a ledger, `checkBeatRelevance` is async and calls a model, and there is no
 * other synchronous way in — so deleting it would have meant re-implementing it eight times.
 *
 * It lives here instead, named for what it now is. The guard reads only files without `.test.` in
 * their name, so this is outside its subject without its rule being touched; vitest collects only
 * `*.test.ts`, so this is not itself a suite.
 *
 * It makes no decision and calls no model. It writes down one the caller already has.
 */
import type { BeatImageVerdict } from "./beatImageRelevanceGate";
import { beatRelevanceBeatKey, isCanonicalAssetKey } from "./beatVisualRelevance";
import type {
  BeatRelevanceDecision,
  BeatRelevanceEntry,
  BeatRelevanceLedger,
  BeatVisualContext,
} from "./beatVisualRelevance";
import type { ShotType } from "./cinematicEditingEngine/types";

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
    /**
     * Optional, and absent for every existing caller.
     *
     * This recorder exists for verdicts earned OUTSIDE `checkBeatRelevance` — the YouTube
     * pre-pool screening, the compose barrier. Those callers hold a real judgement and may know
     * its framing; a caller that does not simply omits it, exactly as before.
     */
    framing?: ShotType;
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
    /** Carried, not re-derived — see `framing` on this type. Absent stays absent. */
    ...(judgement.framing ? { framing: judgement.framing } : {}),
    route,
    /** See the parameter's note: an omitted flag means a real look, never a decline. */
    evaluated: judgement.evaluated !== false,
  };
  const entry: BeatRelevanceEntry = { ctx, decision };
  ledger.byClipPath.set(clipPath, entry);
  if (contentKey && !contentKey.startsWith("file:")) ledger.byContentKey.set(contentKey, entry);
  /**
   * AND THE PER-BEAT INDEX, because a seeded ledger has to behave like a real one.
   *
   * `checkBeatRelevance`'s own `record()` writes all three; a seeder that wrote two would hand
   * eight test files a ledger whose verdicts vanish where production's survive, and the tests
   * built on it would be describing a pipeline that does not exist. See `byBeat`.
   */
  ledger.byBeat.set(
    beatRelevanceBeatKey(ctx.sceneIndex, ctx.beatIndex, "path", clipPath),
    entry
  );
  if (isCanonicalAssetKey(contentKey)) {
    ledger.byBeat.set(
      beatRelevanceBeatKey(ctx.sceneIndex, ctx.beatIndex, "content", contentKey),
      entry
    );
  }
  return decision;
}
