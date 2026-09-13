import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  composeBarrierAllows,
  createBeatRelevanceLedger,
  beatRelevanceBeatKey,
} from "./beatVisualRelevance";

/**
 * A BACKFILL PLACES A PICTURE UNDER A SENTENCE NOBODY CHOSE IT FOR. IT NEEDS A YES.
 *
 * ── What render 579 delivered ───────────────────────────────────────────────────────────────
 *
 * The editor was shown ww2 material and refused all of it, and the render printed an ERROR saying
 * so in as many words:
 *
 *     [ProviderFunnel] provider=ww2 judged=43 fits=0 refused=39 unclear=4 reprieved=0 accepted=0%
 *     [ProviderFunnel] ww2 supplied 43 judged clips and NOT ONE was accepted
 *                      — the queries sent to this source are finding the wrong material
 *     ww2   judged= 18 accepted= 0 refused= 18 ( 0%)  mostly=UNRELATED
 *
 * Two of them were in the delivered film anyway, for 8.9s of a 56.9s documentary about Kylie
 * Jenner:
 *
 *     [VisualFunnel] ww2 retrieved=0 eligible=89 ranked=0 selected=0 adopted=2 composed=2 finalVideo=2
 *     [RenderAsset] provider=ww2 providerAssetId=57502 scene=1 beat=1 verdict=unknown route=backfill
 *     [RenderAsset] provider=ww2 providerAssetId=57526 scene=1 beat=2 verdict=unknown route=backfill
 *     [ScreenTime] total=56.9s wikimedia=29.5s/52% UNVERIFIED=13.5s/24% ww2=8.9s/16%
 *
 * `ranked=0 selected=0` with `adopted=2`: they never entered the funnel at all. The compose
 * backfill took them straight out of the operator's own archive by asset id — `retrieved=0` because
 * there was never a query — and the barrier let them through, because its last line returned
 * `allow: true` for every verdict that was not an explicit `does_not_fit`. `unknown` is not a no.
 *
 * ── What this changes, and the one thing it deliberately does not ───────────────────────────
 *
 * Only the two closures that feed `backfillArchiveMontageFromPool` ask for an approval. Every other
 * caller keeps the default and therefore keeps exactly the behaviour it had, because "a vision
 * outage must never be able to empty a montage" is older than this rule and is not being weakened:
 * on the last rung the consequence of an outage is a held frame instead of unrelated archive
 * footage, which is a fault a viewer reads as a fault rather than as an editorial choice.
 */

const FITS = { verdict: "fits" as const, allowed: true, reprieved: false, cached: false, depicts: "", reason: "", route: "push", evaluated: true };
const UNKNOWN = { ...FITS, verdict: "unknown" as const, reason: "the frame is ambiguous" };
const REFUSED = { ...FITS, verdict: "does_not_fit" as const, allowed: false, reason: "wartime footage under a fashion line" };

/** A ledger holding one verdict about one clip at one beat — the shape the barrier reads. */
function ledgerWith(
  decision: typeof FITS | typeof UNKNOWN | typeof REFUSED,
  opts: { sceneIndex: number; beatIndex: number; clipPath: string; contentKey: string; reprieved?: boolean }
) {
  const ledger = createBeatRelevanceLedger();
  const d = { ...decision, reprieved: opts.reprieved ?? false };
  const entry = {
    decision: d,
    ctx: { sceneIndex: opts.sceneIndex, beatIndex: opts.beatIndex, clipPath: opts.clipPath },
  } as never;
  ledger.byClipPath.set(opts.clipPath, entry);
  ledger.byContentKey.set(opts.contentKey, entry);
  /**
   * The real key builder, never a hand-written string. An earlier draft of this file invented the
   * format and every "approved at this beat" lookup missed — which read as the fix refusing an
   * approval it should honour. A fixture that fabricates the index it is testing against can only
   * ever prove something about the fixture.
   */
  ledger.byBeat.set(
    beatRelevanceBeatKey(opts.sceneIndex, opts.beatIndex, "path", opts.clipPath),
    entry
  );
  ledger.byBeat.set(
    beatRelevanceBeatKey(opts.sceneIndex, opts.beatIndex, "content", opts.contentKey),
    entry
  );
  return ledger;
}

const CLIP = "/w/scene_1_b101_curated_a57502.mp4";
const KEY = "content:57502";
const S1B1 = { sceneIndex: 1, beatIndex: 1 };

describe("the backfill demand refuses what render 579 shipped", () => {
  it("AN UNKNOWN VERDICT NO LONGER FILLS A BEAT", () => {
    /** Asset 57502, exactly as it reached the film: judged, `unknown`, placed at s1b1. */
    const ledger = ledgerWith(UNKNOWN, { ...S1B1, clipPath: CLIP, contentKey: KEY });
    const lenient = composeBarrierAllows(ledger, CLIP, KEY, S1B1);
    const strict = composeBarrierAllows(ledger, CLIP, KEY, S1B1, "approval");

    expect(lenient.allow, "the old behaviour must be preserved for every other route").toBe(true);
    expect(strict.allow, "this is the clip that put WW2 footage in a Kylie Jenner video").toBe(false);
    expect(strict.reason).toContain("backfill needs an approval");
    expect(strict.reason).toContain("unknown");
  });

  it("and neither does a clip nobody ever judged", () => {
    const empty = createBeatRelevanceLedger();
    expect(composeBarrierAllows(empty, CLIP, KEY, S1B1).allow).toBe(true);
    const strict = composeBarrierAllows(empty, CLIP, KEY, S1B1, "approval");
    expect(strict.allow).toBe(false);
    expect(strict.reason).toContain("never judged");
    expect(strict.reason).toContain("s1b1");
  });

  it("AN APPROVAL EARNED AT ANOTHER BEAT IS NOT AN APPROVAL FOR THIS ONE", () => {
    /**
     * The crux. A backfill fills a sentence the clip was never chosen for, so a `fits` earned under
     * different narration says nothing about this placement. It is the same asymmetry the `beat`
     * parameter was added to fix, read from the other side: there, one beat's NO must not decide
     * for every beat; here, one beat's YES must not either.
     */
    const ledger = ledgerWith(FITS, { sceneIndex: 0, beatIndex: 4, clipPath: CLIP, contentKey: KEY });
    const strict = composeBarrierAllows(ledger, CLIP, KEY, S1B1, "approval");
    expect(strict.allow).toBe(false);
    expect(strict.reason).toContain("s1b1");
    expect(strict.reason).toContain("s0b4");
  });

  it("but a yes for THIS beat still composes", () => {
    const ledger = ledgerWith(FITS, { ...S1B1, clipPath: CLIP, contentKey: KEY });
    expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1, "approval").allow).toBe(true);
  });
});

describe("what the stricter demand does not touch", () => {
  it("A DELIBERATE REPRIEVE SURVIVES IT", () => {
    /**
     * RONDE 200's `reprieveAllowedFor` is a decision to overrule the judge on purpose and on the
     * record. That is a positive act about this picture, not the absence of one — which is the only
     * thing "approval" exists to require. Refusing a reprieve here would quietly delete a rule this
     * project decided on for its own reasons.
     */
    const ledger = ledgerWith(REFUSED, { ...S1B1, clipPath: CLIP, contentKey: KEY, reprieved: true });
    expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1).allow).toBe(true);
    expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1, "approval").allow).toBe(true);
  });

  it("a refusal is still a refusal under both demands", () => {
    const ledger = ledgerWith(REFUSED, { ...S1B1, clipPath: CLIP, contentKey: KEY });
    expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1).allow).toBe(false);
    expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1, "approval").allow).toBe(false);
  });

  it("THE DEFAULT IS THE OLD BEHAVIOUR, EXACTLY", () => {
    /**
     * Three production callers and ten test callers pass no demand at all. If the default ever
     * flipped, the fail-open principle would be gone everywhere at once and this file's own
     * reasoning for why that is safe would no longer hold.
     */
    for (const d of [UNKNOWN, FITS]) {
      const ledger = ledgerWith(d, { ...S1B1, clipPath: CLIP, contentKey: KEY });
      expect(composeBarrierAllows(ledger, CLIP, KEY, S1B1).allow).toBe(true);
      expect(composeBarrierAllows(ledger, CLIP, KEY).allow).toBe(true);
    }
    expect(composeBarrierAllows(createBeatRelevanceLedger(), CLIP, KEY).allow).toBe(true);
  });
});

describe("the demand reaches exactly the two routes that produce route=backfill", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("BOTH BACKFILL PUSH CLOSURES ASK FOR AN APPROVAL", () => {
    /**
     * `backfillComposeMontageIfShort` and `ensureArchiveMontageVoiceCoverage` each define a push
     * closure and each hands it to `backfillArchiveMontageFromPool`. Fixing one and not the other
     * would leave the same defect reachable down the second path, which is how this codebase's
     * recurring shape — a rule N routes must follow, registered by some of them — keeps recurring.
     */
    const strict = code.match(/beatClipRefusedByRelevanceGate\([^)]*"approval"\)/g) ?? [];
    expect(strict.length, "one of the two backfill closures is still lenient").toBe(2);
  });

  it("and no other caller does", () => {
    const all = code.match(/beatClipRefusedByRelevanceGate\(/g) ?? [];
    const strict = code.match(/beatClipRefusedByRelevanceGate\([^)]*"approval"\)/g) ?? [];
    expect(all.length).toBeGreaterThan(strict.length + 1);
  });

  it("the primary and rescue routes keep their fail-open answer", () => {
    /** Named explicitly: this is the principle the change is allowed to leave standing. */
    expect(code).toContain('demand: "no_refusal" | "approval" = "no_refusal"');
  });
});

describe("the cost of the rule is counted and printed", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("ONLY REFUSALS THIS RULE ACTUALLY CAUSED ARE COUNTED", () => {
    /**
     * A `does_not_fit` would have been refused either way, and counting it here would inflate the
     * rule's apparent cost — a metric that flatters or blames itself is the thing this project
     * refuses to build.
     */
    expect(PIPE).toContain('if (demand === "approval" && barrier.reason.startsWith("backfill needs an approval"))');
    expect(PIPE).toContain("dedup.backfillRefusedWithoutApproval += 1;");
  });

  it("and the total is printed on every render, zero included", () => {
    /**
     * A line that appears only when the rule fires reads as "this never happens" on every render
     * that omits it. The number that matters is the one next to a quiet film.
     */
    expect(PIPE).toContain("[BackfillApproval] refused=${visualDedup.backfillRefusedWithoutApproval}");
    const decl = PIPE.indexOf("backfillRefusedWithoutApproval: 0,");
    expect(decl, "the counter is never initialised").toBeGreaterThan(-1);
  });
});
