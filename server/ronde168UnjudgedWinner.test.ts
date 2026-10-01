/**
 * RONDE 168 — video 555 put a NASA clip about equality under the Tehran Conference.
 *
 * ── What the render shipped ──────────────────────────────────────────────────────────────────
 *
 *     [BeatRelevance] s2b3 funnel:loc              does_not_fit
 *     [BeatRelevance] s2b3 funnel:internet_archive does_not_fit
 *     [RenderAsset]   provider=nasa scene=2 beat=3
 *                     file=..._nasa_Hidden_Figures_Way_NASA_s_Vision_of_Equality...
 *                     verdict=does_not_fit reprieved=false rendered=true
 *
 * `rendered=true` with `reprieved=false` on a refused clip. RONDE 167's new invariant caught it
 * independently — `[VisualFitAudit] INVARIANT_BROKEN beat=s2b3 severity=TOTALLY_UNRELATED is on
 * screen with no reprieve` — which is what turned a suspicion into a finding.
 *
 * ── Why RONDE 166's guard never fired ────────────────────────────────────────────────────────
 *
 * Not severity, and not the reprieve. Control flow.
 *
 * The funnel's judging loop is `for (look = 0; look < MAX_JUDGEMENTS_PER_BEAT && winner; look++)`.
 * Each pass judges the CURRENT winner and, on a refusal, picks the next-best. It `break`s the
 * moment one passes — so a winner produced by a break has been judged.
 *
 * When the CEILING ends the loop instead, the winner left in hand is whatever the last refusal
 * picked, and nothing has ever looked at it. It is not in `beatImageRejectedIds` either, because
 * it was never refused — so the reprieve check does not fire, no severity is consulted, and
 * `funnelClip = clipPath` hands it to the montage. The funnel is the one adopt route that does not
 * go through `pushClip`, so the compose barrier never sees it either.
 *
 * Two refusals bought an UNEXAMINED third candidate a free pass. The more of a beat's candidates
 * were refused, the likelier its picture was one nobody had judged — the exact inverse of the
 * intent stated in the comment four lines above the loop: "It runs on the candidate about to be
 * ADOPTED, not on all of them."
 *
 * It also explains the render's own numbers: `never_asked=38`, `unknown=57 clips`, and a quality
 * report that says in plain Dutch "die clips zijn ONGEZIEN aangenomen".
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * The look budget is spent on judging, not on shopping. With two looks a beat may try two
 * candidates properly; it may not try two and then take a third on trust. An unjudged winner is
 * put back, and the beat continues with what it actually knows — the candidates it DID judge,
 * under RONDE 166's severity rules.
 *
 * No gate call is added and no ceiling is raised. What changes is which candidate the beat ends on
 * when the ceiling binds: a judged one, or none.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { MAX_JUDGEMENTS_PER_BEAT } from "./beatImageRelevanceGate";

import {
  VisualSourceLedger,
  assertNoSelectedClipWithoutOutcome,
  recordAssetOutcome,
} from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 168 — the unjudged candidate is accounted for, not just dropped", () => {
  it("never_judged is its own ending, distinct from not_chosen", () => {
    /**
     * "We looked and preferred another" and "we never looked" are opposite facts. Video 555
     * shipped a picture on the second while its audit read like the first.
     */
    const l = new VisualSourceLedger({ renderId: "r168" });
    const r = l.createLineage({ sceneIndex: 2, beatIndex: 3, localPath: "/w/nasa.mp4", provider: "nasa" });
    l.recordEvent(r.lineageId, "SELECTED", { status: "OK" });
    recordAssetOutcome(l, "/w/nasa.mp4", "never_judged", "s2b3");
    l.markFinalVideo([]);
    expect(l.allEvents().at(-1)?.reason).toBe("never_judged:s2b3");
    expect(assertNoSelectedClipWithoutOutcome(l).ok).toBe(true);
  });

});

describe("RONDE 168 — nothing else moved", () => {

  it("RONDE 167's invariant and audits are untouched", () => {
    expect(PIPE).toContain("assertNoSelectedClipWithoutOutcome(ledger)");
    expect(PIPE).toContain("cache.lineage.setContentKeyResolver(clipContentKey);");
  });
});
