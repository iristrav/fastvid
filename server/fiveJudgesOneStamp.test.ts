/**
 * FIVE JUDGES, ONE STAMP — RONDE 609.
 *
 * ── What render 597 refused ─────────────────────────────────────────────────────────────────
 *
 *     [AdoptionGuard] scene=2 beat=2 route=beat_fetch eligible=false vision=APPROVED
 *       blocked=FUNNEL_WITHOUT_EVIDENCE
 *       reason=route "beat_fetch" claims REAL_FUNNEL without eligibility
 *       file=scene_2_b2_pool_youtube_cc_ytcc_3k-HbACK31g__…mp4
 *
 * `vision=APPROVED`. The editor looked and said yes. What was missing was the stamp that records
 * "this candidate has provenance and survived its route's filters" — and that clip's provenance
 * was complete: lineage=rmuccwkmt-1#40, provider=youtube_cc, providerAssetId=3k-HbACK31g, and it
 * had just been ingested into the operator's own archive as asset 57782.
 *
 * Four clips in one render, all APPROVED, all refused for the same missing flag:
 *
 *     s2b0  beat_fetch  scene_2_b0_curated_a57364.mp4
 *     s2b1  beat_fetch  scene_2_b1_curated_a57378.mp4
 *     s0b1  beat_fetch  scene_0_b1_curated_a57656.mp4
 *     s2b2  beat_fetch  the YouTube clip
 *
 * ── The shape ───────────────────────────────────────────────────────────────────────────────
 *
 * Five functions judge a beat's picture. One stamped. `[EligibilityGap]` — the warning for "the
 * stamp found nothing to mark" — appears ZERO times in render 597, which is the tell: the writer
 * was not reached at all, rather than reached and defeated.
 *
 * ── What is NOT relaxed ─────────────────────────────────────────────────────────────────────
 *
 * `markEligible` still returns false for a file the ledger has never seen, and still refuses to
 * invent provenance. The eligibility REQUIREMENT is untouched; REAL_FUNNEL still needs both halves.
 * What changes is that the four routes which already satisfied it stop being refused for never
 * having passed the one desk that writes it down.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { adoptionPolicyFor, adoptionGuardVerdict } from "./adoptionPolicy";
import { VisualSourceLedger } from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ §1 — every judge passes the desk ═══════════ */

describe("§1 — the five judges", () => {
  it("there are still exactly five callers of the judge", () => {
    /**
     * If a sixth appears, it either goes through `judgeBeatClipRelevance` — in which case it is
     * stamped and this number simply moves — or it does not, and then this test has done its job
     * by making someone look.
     */
    const calls = [...PIPE.matchAll(/(?<!function )judgeBeatClipRelevance\(\s*(?:dedup|relevance\.dedup)/g)];
    expect(calls.length, "a judge appeared or vanished — check it reaches the stamp").toBe(5);
  });

  it("THE STAMP IS INSIDE THE JUDGE, so all five reach it", () => {
    const at = PIPE.indexOf("async function judgeBeatClipRelevance(");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, PIPE.indexOf("const decision = await checkBeatRelevance({", at));
    expect(body, "the judge no longer stamps eligibility").toContain(
      "noteEligibleForJudgement(dedup, params.clipPath"
    );
  });

  it("and it is stamped BEFORE the judgement is paid for", () => {
    const at = PIPE.indexOf("async function judgeBeatClipRelevance(");
    const body = PIPE.slice(at, at + 3500);
    const stamp = body.indexOf("noteEligibleForJudgement(dedup, params.clipPath");
    const check = body.indexOf("await checkBeatRelevance({");
    expect(stamp).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(stamp, "the stamp records a decision that is made by calling the judge").toBeLessThan(check);
  });

  it("the vision gate KEEPS its own call — moving it would have narrowed one route", () => {
    /**
     * `beatClipPassesVisionGate` stamps before the shortlist admission, and that admission can
     * return early without ever reaching `judgeBeatClipRelevance`. Both call the one helper;
     * `markLineageEligible` is idempotent, so the second stamp costs nothing.
     */
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("noteEligibleForJudgement(dedup, clipPath");
  });

  it("ONE BODY — no route open-codes the write or the gap line", () => {
    const helper = PIPE.indexOf("function noteEligibleForJudgement(");
    expect(helper).toBeGreaterThan(-1);
    /**
     * TWO raw ledger writes in this file, and the second is not a leak.
     *
     *   noteEligibleForJudgement    "this is worth judging"   — the helper, used by all five judges
     *   adoptClip                   "adopt_clip_gates_cleared" — a DIFFERENT moment: the
     *                               deterministic gates have been cleared at adoption time, which
     *                               RONDE 94 documented as its own hook.
     *
     * A third would mean a route started answering the question for itself again.
     */
    const rawWrites = [...PIPE.matchAll(/lineage\??\.\s*markEligible\(/g)].length;
    expect(rawWrites, "a route started writing eligibility for itself again").toBe(2);
    expect(PIPE).toContain('markEligible(p, contentKey, "adopt_clip_gates_cleared")');
    /**
     * EMISSIONS, not mentions — a doc comment at line ~22842 quotes the bare tag as part of the
     * record, so the match requires the `scene=` that only a real log line carries. TWO emitters, reporting two different failures:
     *
     *   noteEligibleForJudgement   route=<judge>       the ledger has no record for this clip
     *   fetchCuratedArchiveBeat…   route=curated_fetch the fetch returned a clip with NO PICK, so
     *                              no lineage record could be opened at all (RONDE 570)
     *
     * A third would mean a route started reporting its own gap instead of asking the helper.
     */
    const gapEmitters = [...PIPE.matchAll(/`\[EligibilityGap\] scene=/g)].length;
    expect(gapEmitters, "the gap line was copied").toBe(2);
    expect(PIPE).toContain("route=curated_fetch ");
  });
});

/* ═══════════ §2 — a drawn card is exempt ═══════════ */

describe("§2 — a placeholder never becomes eligible", () => {
  it("the stamp is skipped when the caller declared a placeholder", () => {
    const at = PIPE.indexOf("async function judgeBeatClipRelevance(");
    const body = PIPE.slice(at, at + 3500);
    expect(body).toContain("if (!params.placeholder) {");
    const guard = body.indexOf("if (!params.placeholder) {");
    const stamp = body.indexOf("noteEligibleForJudgement(dedup, params.clipPath");
    expect(guard, "a card would be stamped eligible").toBeLessThan(stamp);
  });

  it("which keeps RONDE 606's distinction intact", () => {
    /** The ladder's card rungs reach the judge with placeholder:true so it declines to look. */
    expect(PIPE).toContain("placeholder: isPlaceholderGuaranteedTier(tier.tier)");
  });
});

/* ═══════════ §3 — the requirement itself is untouched ═══════════ */

describe("§3 — nothing was relaxed", () => {
  it("beat_fetch and youtube_cc are still the strictest category", () => {
    for (const route of ["beat_fetch", "youtube_cc"]) {
      const p = adoptionPolicyFor(route);
      expect(p.category, `${route} was downgraded`).toBe("REAL_FUNNEL");
      expect(p.requiresEligibility, `${route} stopped needing provenance`).toBe(true);
      expect(p.visionRequirement, `${route} stopped needing a yes`).toBe("approved");
    }
  });

  it("RENDER 597's REFUSAL, REPLAYED: approved but unstamped is still refused", () => {
    /**
     * The guard is unchanged. This round does not make the verdict permissive — it makes the
     * stamp reachable. A clip that genuinely has no provenance still fails here, exactly as before.
     */
    const v = adoptionGuardVerdict({
      source: "beat_fetch",
      eligible: false,
      vision: "APPROVED",
      visionAvailable: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
    expect(v.allowed === false && v.reason).toContain("without eligibility");
  });

  it("and the same clip, once stamped, is allowed", () => {
    const v = adoptionGuardVerdict({
      source: "beat_fetch",
      eligible: true,
      vision: "APPROVED",
      visionAvailable: true,
    });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.visionEvidence).toBe("APPROVED");
  });

  it("a clip the editor REFUSED is still refused, stamp or no stamp", () => {
    const v = adoptionGuardVerdict({
      source: "beat_fetch",
      eligible: true,
      vision: "REJECTED",
      visionAvailable: true,
    });
    expect(v.allowed, "the stamp must not overrule the editor").toBe(false);
  });
});

/* ═══════════ §4 — provenance is still never invented ═══════════ */

describe("§4 — a clip with no record stays ineligible", () => {
  it("markEligible refuses a file the ledger has never seen", () => {
    const ledger = new VisualSourceLedger({ renderId: "r609" });
    expect(ledger.markEligible("/tmp/never_seen.mp4", "content:nope", "judged")).toBe(false);
    expect(ledger.isEligible("/tmp/never_seen.mp4", "content:nope")).toBe(false);
  });

  it("and the helper reports that, rather than passing it over", () => {
    const at = PIPE.indexOf("function noteEligibleForJudgement(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}", PIPE.indexOf("return recorded;", at)));
    expect(body).toContain("recorded === false");
    expect(body).toContain("[EligibilityGap]");
    expect(body, "an absent ledger is not a gap").not.toContain("if (!recorded)");
  });
});
