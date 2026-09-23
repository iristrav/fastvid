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

describe("§1 — one refusal, read by everything that can act on it", () => {
  it("PASSINGSCORED EXCLUDES WHAT THE BEAT IMAGE GATE REFUSED", () => {
    expect(PIPE).toContain(
      "const passingScored = scored\n" +
        "          .filter(s => s.visionResult.pass)\n" +
        "          .filter(s => !dedup.beatImageRejectedIds.has(s.candidate.id));"
    );
  });

  it("and pickBestFunnelCandidate still applies the same exclusion it always did", () => {
    expect(FUNNEL).toContain(".filter(s => s.visionResult.pass)");
    expect(FUNNEL).toContain(".filter(s => !rejectedCandidateIds?.has(s.candidate.id));");
  });

  it("THE WINNER IS STILL CHOSEN BY THAT FUNCTION — this round did not move the decision", () => {
    expect(PIPE).toContain(
      "pickBestFunnelCandidate(scored, dedup.usedFunnelCandidateIds, dedup.beatImageRejectedIds)"
    );
  });
});

/* ═══════════ §2 — the archive is what this protects ═══════════ */

describe("§2 — ingestion reads the corrected set", () => {
  it("THE INGESTION LOOP ITERATES passingScored", () => {
    expect(PIPE).toContain("for (const s of passingScored) {");
    expect(PIPE).toContain("queueArchiveIngestion(s.clipPath, s.candidate);");
  });

  it("RONDE 9's rule is untouched — stock is still never archive material", () => {
    expect(PIPE).toContain('if (src === "pexels" || src === "pixabay") continue;');
  });

  it("and an already-archived clip is still not re-ingested", () => {
    expect(PIPE).toContain('if (src === "archive") continue;');
  });
});

/* ═══════════ §3 — the claim the log makes is now true ═══════════ */

describe("§3 — 'the picture editor passed' has to mean it", () => {
  it("the line still says what it says", () => {
    expect(PIPE).toContain("runner-up clip(s) the picture editor passed");
  });

  it("A REFUSED CLIP CAN NO LONGER REACH THAT SENTENCE", () => {
    /**
     * The sentence is unchanged; what changed is that it is now earned. A clip in
     * beatImageRejectedIds is filtered out before `approvedKept` can count it, so the log cannot
     * describe a refusal as an approval again.
     */
    const at = PIPE.indexOf("const passingScored = scored");
    const ingest = PIPE.indexOf("for (const s of passingScored) {");
    expect(at).toBeGreaterThan(-1);
    expect(ingest).toBeGreaterThan(at);
    expect(PIPE.slice(at, at + 400)).toContain("beatImageRejectedIds");
  });
});

/* ═══════════ §4 — nothing was loosened ═══════════ */

describe("§4 — this removes from a set and admits nothing", () => {
  it("no threshold appears in the change", () => {
    const at = PIPE.indexOf("const passingScored = scored");
    const body = PIPE.slice(at, at + 400);
    for (const f of ["threshold", "THRESHOLD", ">=", "<="]) {
      expect(body, `the fix must not carry a threshold (${f})`).not.toContain(f);
    }
  });

  it("and the reason the fix exists is recorded where the code is", () => {
    expect(PIPE).toContain("RONDE 631 — THE PICTURE EDITOR'S REFUSAL REACHES THE ARCHIVE");
    expect(PIPE).toContain("NOTHING IS LOOSENED");
  });
});
