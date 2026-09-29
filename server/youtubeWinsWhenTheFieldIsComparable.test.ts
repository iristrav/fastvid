/**
 * YOUTUBE WINS WHEN THE FIELD IS COMPARABLE — RONDE 635.
 *
 * ── What decided the source, and what did not ───────────────────────────────────────────────
 *
 * `pickBestFunnelCandidate` expressed exactly one source preference: non-stock over stock, with
 * `STOCK_TIER_WIN_MARGIN`. INSIDE the non-stock tier — YouTube, Internet Archive, NARA, Wikimedia,
 * the curated archive — the highest `worstScore10` simply won.
 *
 * The only other place a source preference exists is `EXTERNAL_SOURCE_TIER_BONUS`, and its own
 * comment says what that is worth:
 *
 *     "It moves candidates up the shortlist, and nothing else … `pickBestFunnelCandidate` still
 *      picks the winner on real VisionGate scores."
 *
 * Render 600 is what that combination produces. YouTube reached `status=ASSIGNED` on four beats,
 * the first time in this pipeline's history — the shortlist bonus doing exactly its job — and the
 * delivered film came out `fromArchive=4`. The bonus decided who got LOOKED AT. Nothing decided
 * who got USED.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 *     YouTube 0.82, Archive 0.88   ->  YouTube      an 0.06 edge decides nothing
 *     YouTube 6.0,  Archive 9.0    ->  Archive      three points is not a marginal edge
 *
 * Sized identically to `STOCK_TIER_WIN_MARGIN` and measured on the identical 0-10 scale, because
 * it is the identical statement about the identical kind of evidence.
 *
 * ── What it cannot do, which is the half that matters ───────────────────────────────────────
 *
 * It runs over `passers`: candidates that already cleared VisionGate AND are not in
 * `rejectedCandidateIds`, the beat image gate's hard exclusion. So no threshold moves, no gate is
 * bypassed, and a preference can never reach a picture a judge refused. §3 of the brief in one
 * line: content first, technically usable second, gates third, adoption fourth — and only THEN
 * does the source preference speak.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  pickBestFunnelCandidate,
  preferredSourceWinMargin,
  PREFERRED_WINNER_SOURCES,
  STOCK_TIER_WIN_MARGIN,
  type FunnelCandidate,
  type ScoredFunnelCandidate,
} from "./retrievalFunnel";

const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");

function cand(id: string, source: FunnelCandidate["source"], rankingScore = 0.5): FunnelCandidate {
  return {
    id,
    source,
    title: id,
    rankingScore,
    embeddingSimilarity: null,
    archiveKeywordScore: null,
    clipSimilarity: null,
  } as unknown as FunnelCandidate;
}

function scored(c: FunnelCandidate, score: number | null, pass = true): ScoredFunnelCandidate {
  return {
    candidate: c,
    clipPath: `/tmp/${c.id.replace(/[^a-z0-9]/gi, "_")}.mp4`,
    visionResult: { pass, worstScore10: score, skipped: false, fromCache: false },
  } as unknown as ScoredFunnelCandidate;
}

const yt = (id: string, score: number, pass = true) =>
  scored(cand(id, "youtube_cc" as FunnelCandidate["source"]), score, pass);
const ia = (id: string, score: number, pass = true) =>
  scored(cand(id, "internet_archive" as FunnelCandidate["source"]), score, pass);
const wiki = (id: string, score: number) =>
  scored(cand(id, "wikimedia" as FunnelCandidate["source"]), score);
const pexels = (id: string, score: number) =>
  scored(cand(id, "pexels" as FunnelCandidate["source"]), score);

/* ═══════════ §1 — the preference, where the winner is chosen ═══════════ */

/* ═══════════ §2 — fallback: no suitable YouTube means archive ═══════════ */

/* ═══════════ §3 — a preference may not reach a refused picture ═══════════ */

/* ═══════════ §4 — nothing else in the function moved ═══════════ */

/* ═══════════ §5 — the preference is stated, not scattered ═══════════ */

describe("§5 — one place says what the film is made of", () => {

  it("the shortlist bonus is untouched — it answers a different question", () => {
    expect(FUNNEL).toContain("return 0.22;");
    expect(FUNNEL).toContain("export function youtubeSourceTierBonus()");
  });

});
