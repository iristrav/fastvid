/**
 * A REFUSED CLIP IS NOT ARCHIVE MATERIAL — RONDE 631.
 *
 * ── Render 599, scene 1 beat 1, one second of log ───────────────────────────────────────────
 *
 *     …providerAssetId=OqFhvKarYjU stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
 *     …providerAssetId=rPCWO-wZaLo stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
 *     [Ingestion] s1b1 keeping 2 approved runner-up clip(s) the picture editor passed
 *         — they lost the beat, not the judgement
 *
 * The picture editor did not pass them. It refused both, with reasons: a young German soldier
 * wearing an Iron Cross, and a map of the 1st Belorussian Front, against narration about the
 * orders Hitler issued in the bunker. Both were queued into the CURATED ARCHIVE anyway.
 *
 * ── Why it was possible ─────────────────────────────────────────────────────────────────────
 *
 * Two verdicts, one of them read. `visionResult.pass` is the FUNNEL's — a CLIP-similarity score.
 * `dedup.beatImageRejectedIds` is the beat image gate's — a model that looked at the frames.
 * `pickBestFunnelCandidate` (retrievalFunnel.ts:1601) reads both:
 *
 *     .filter(s => s.visionResult.pass)
 *     .filter(s => !rejectedCandidateIds?.has(s.candidate.id))
 *
 * `passingScored`, which feeds archive ingestion, read only the first.
 *
 * ── Why the archive is the worst place for this ─────────────────────────────────────────────
 *
 * The curated archive is source #2 and it OUTLIVES the render that wrote it. A refused picture
 * stored as approved comes back on every later render as archive material, with its refusal
 * nowhere in sight. RONDE 9 already drew this line for stock footage — "a generic Pexels clip that
 * happened to win a Hitler beat was ingested tagged 'adolf hitler', then outranked real archival
 * footage on every later Hitler render (the self-poisoning loop)". This is the same loop through a
 * different door.
 *
 * ── What did NOT change ─────────────────────────────────────────────────────────────────────
 *
 * Nothing is admitted. The fix removes clips from a set. No threshold moves, no gate is added, and
 * the winner is chosen exactly as before — by the function that was already applying this rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");

/* ═══════════ §1 — the two readers now agree ═══════════ */


/* ═══════════ §2 — the archive is what this protects ═══════════ */


/* ═══════════ §3 — the claim the log makes is now true ═══════════ */


/* ═══════════ §4 — nothing was loosened ═══════════ */

describe("§4 — this removes from a set and admits nothing", () => {
  it("no threshold appears in the change", () => {
    const at = PIPE.indexOf("const passingScored = scored");
    const body = PIPE.slice(at, at + 400);
    for (const f of ["threshold", "THRESHOLD", ">=", "<="]) {
      expect(body, `the fix must not carry a threshold (${f})`).not.toContain(f);
    }
  });

});
