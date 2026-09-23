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

describe("§1 — a marginal edge no longer decides the source", () => {
  it("YOUTUBE WINS WHEN BOTH ARE VALID AND THE ARCHIVE'S EDGE IS MARGINAL", () => {
    /* The brief's own example, on the 0-10 scale this function actually uses. */
    const winner = pickBestFunnelCandidate([ia("ia:better", 8.8), yt("yt:good", 8.2)]);
    expect(winner?.candidate.source).toBe("youtube_cc");
  });

  it("and when the scores are equal", () => {
    expect(
      pickBestFunnelCandidate([ia("ia:a", 9), yt("yt:a", 9)])?.candidate.source
    ).toBe("youtube_cc");
  });

  it("and when YouTube is simply the better picture", () => {
    expect(
      pickBestFunnelCandidate([ia("ia:a", 6), yt("yt:a", 9)])?.candidate.source
    ).toBe("youtube_cc");
  });

  it("A DEMONSTRABLY BETTER ARCHIVE CLIP STILL WINS — THIS IS A MARGIN, NOT A RANK", () => {
    expect(
      pickBestFunnelCandidate([ia("ia:much_better", 9), yt("yt:weak", 6)])?.candidate.source
    ).toBe("internet_archive");
  });

  /**
   * THE MARGIN AND RONDE 65's NOISE FLOOR COMPOSE, AND THE FLOOR IS THE BINDING ONE.
   *
   * `discriminating` requires a spread STRICTLY GREATER than one point before any score is used
   * as a ranking at all, and the margin branch sits inside it. So a gap of exactly the margin is
   * still noise and YouTube keeps the beat; the archive takes it only once the field is both
   * discriminating and clear of the margin. Both guards point the same way, which is why this is
   * asserted rather than assumed.
   */
  it("the margin bites only past the point where the scores mean anything", () => {
    const m = preferredSourceWinMargin();
    /* Inside the noise floor: not a ranking, so the preference decides. */
    expect(
      pickBestFunnelCandidate([ia("ia:a", 5.9), yt("yt:a", 5)])?.candidate.source
    ).toBe("youtube_cc");
    /* A full point apart is still the floor, by RONDE 65's own ">" — YouTube keeps it. */
    expect(
      pickBestFunnelCandidate([ia("ia:a", 5 + m), yt("yt:a", 5)])?.candidate.source
    ).toBe("youtube_cc");
    /* Past both: a demonstrably better archive clip. */
    expect(
      pickBestFunnelCandidate([ia("ia:a", 5 + m + 0.5), yt("yt:a", 5)])?.candidate.source
    ).toBe("internet_archive");
  });

  it("it is the same statement as the stock rule, so it is the same size", () => {
    expect(preferredSourceWinMargin()).toBe(STOCK_TIER_WIN_MARGIN);
  });

  it("YouTube outranks every non-stock source, not just the internet archive", () => {
    const winner = pickBestFunnelCandidate([
      wiki("wiki:a", 8.9),
      ia("ia:a", 8.7),
      yt("yt:a", 8.1),
    ]);
    expect(winner?.candidate.source).toBe("youtube_cc");
  });
});

/* ═══════════ §2 — fallback: no suitable YouTube means archive ═══════════ */

describe("§2 — a beat with no usable YouTube is not starved", () => {
  it("THE ARCHIVE TAKES THE BEAT WHEN YOUTUBE HAS NOTHING", () => {
    expect(
      pickBestFunnelCandidate([ia("ia:a", 7), wiki("wiki:a", 6)])?.candidate.source
    ).toBe("internet_archive");
  });

  it("and when YouTube's only candidate failed VisionGate", () => {
    const winner = pickBestFunnelCandidate([yt("yt:fails", 9, false), ia("ia:a", 6)]);
    expect(winner?.candidate.source).toBe("internet_archive");
  });

  it("each beat asks again — the preference is per call, with no memory of a scene's fallback", () => {
    /* Beat 1 has no YouTube and falls back; beat 2 has one and takes it. */
    expect(pickBestFunnelCandidate([ia("ia:b1", 8)])?.candidate.source).toBe("internet_archive");
    expect(
      pickBestFunnelCandidate([ia("ia:b2", 8.6), yt("yt:b2", 8)])?.candidate.source
    ).toBe("youtube_cc");
  });
});

/* ═══════════ §3 — a preference may not reach a refused picture ═══════════ */

describe("§3 — every gate still comes first", () => {
  it("A YOUTUBE CLIP THE BEAT IMAGE GATE REFUSED NEVER WINS", () => {
    const winner = pickBestFunnelCandidate(
      [yt("yt:refused", 9.5), ia("ia:a", 6)],
      undefined,
      new Set(["yt:refused"])
    );
    expect(winner?.candidate.source).toBe("internet_archive");
  });

  it("and a YouTube clip VisionGate failed never wins, whatever it scored", () => {
    const winner = pickBestFunnelCandidate([yt("yt:failed", 10, false), ia("ia:a", 5)]);
    expect(winner?.candidate.id).toBe("ia:a");
  });

  it("A BEAT WITH ONLY REFUSED YOUTUBE RETURNS NOTHING RATHER THAN USING IT", () => {
    expect(
      pickBestFunnelCandidate([yt("yt:refused", 9)], undefined, new Set(["yt:refused"]))
    ).toBeNull();
  });

  it("the preference is applied to passers only, in the source itself", () => {
    const at = FUNNEL.indexOf("const preferred = nonStock.filter(");
    expect(at).toBeGreaterThan(-1);
    /* `nonStock` is derived from `passers`, which is derived from `allPassers`. */
    const before = FUNNEL.slice(FUNNEL.indexOf("export function pickBestFunnelCandidate"), at);
    expect(before).toContain(".filter(s => s.visionResult.pass)");
    expect(before).toContain(".filter(s => !rejectedCandidateIds?.has(s.candidate.id));");
    expect(before).toContain("const nonStock = passers.filter(");
  });
});

/* ═══════════ §4 — nothing else in the function moved ═══════════ */

describe("§4 — the rules this sits between are unchanged", () => {
  it("STOCK STILL LOSES TO A COMPARABLE NON-STOCK CANDIDATE", () => {
    expect(
      pickBestFunnelCandidate([pexels("px:a", 9.0), ia("ia:a", 8.9)])?.candidate.source
    ).toBe("internet_archive");
  });

  it("and a demonstrably better stock clip still wins, exactly as before", () => {
    expect(
      pickBestFunnelCandidate([pexels("px:a", 9.5), ia("ia:a", 5)])?.candidate.source
    ).toBe("pexels");
  });

  it("a marginal stock edge loses to YouTube exactly as it loses to the archive", () => {
    /* 0.5 points is not "demonstrably better" by the stock rule's own definition. */
    expect(
      pickBestFunnelCandidate([pexels("px:a", 9.0), yt("yt:a", 8.5)])?.candidate.source
    ).toBe("youtube_cc");
  });

  it("cross-beat variety still applies before the source preference", () => {
    /**
     * `yt:used` outscores everything and is already used, so it is excluded first and the beat
     * chooses between the two unused candidates — where the preference then speaks. The archive's
     * 0.5-point edge is inside the margin, so the fresh YouTube clip takes the beat.
     */
    const winner = pickBestFunnelCandidate(
      [yt("yt:used", 10), yt("yt:fresh", 7.5), ia("ia:a", 8)],
      new Set(["yt:used"])
    );
    expect(winner?.candidate.id).toBe("yt:fresh");
  });

  it("but variety is not overridden by the preference — a used YouTube clip stays excluded", () => {
    /* Even with a big archive edge, the unused archive clip wins over a used YouTube one. */
    const winner = pickBestFunnelCandidate(
      [yt("yt:used", 10), ia("ia:a", 6)],
      new Set(["yt:used"])
    );
    expect(winner?.candidate.id).toBe("ia:a");
  });

  it("and reuse is still the last resort rather than a loss", () => {
    const winner = pickBestFunnelCandidate([yt("yt:used", 9)], new Set(["yt:used"]));
    expect(winner?.candidate.id).toBe("yt:used");
  });

  it("A FLAT FIELD IS STILL TREATED AS NOISE, AND THE PREFERENCE DECIDES IT", () => {
    /**
     * RONDE 65's rule: a spread of one point on a rounded 0-10 scale carries no information.
     * With no margin clearable, the preferred source wins — which is the right answer when
     * nothing distinguishes the candidates.
     */
    expect(
      pickBestFunnelCandidate([ia("ia:a", 9), yt("yt:a", 8.5)])?.candidate.source
    ).toBe("youtube_cc");
  });

  it("an empty field is still null, not a picture", () => {
    expect(pickBestFunnelCandidate([])).toBeNull();
  });
});

/* ═══════════ §5 — the preference is stated, not scattered ═══════════ */

describe("§5 — one place says what the film is made of", () => {
  it("THE PREFERRED SET IS YOUTUBE, AND IT IS A SET RATHER THAN A CONDITION", () => {
    expect([...PREFERRED_WINNER_SOURCES]).toEqual(["youtube_cc"]);
  });

  it("it is an operator dial, like the tier bonus beside it", () => {
    expect(FUNNEL).toContain("process.env.PREFERRED_SOURCE_WIN_MARGIN");
    expect(FUNNEL).toContain("export function preferredSourceWinMargin()");
  });

  it("and no second copy of the rule grew anywhere else", () => {
    /* Declared once, and read only to split one list into its two halves inside one function. */
    expect(FUNNEL.split("PREFERRED_WINNER_SOURCES = new Set").length - 1).toBe(1);
    const fn = FUNNEL.slice(FUNNEL.indexOf("export function pickBestFunnelCandidate"));
    expect(fn.split("PREFERRED_WINNER_SOURCES.has(").length - 1).toBe(2);
    expect(FUNNEL.split("PREFERRED_WINNER_SOURCES.has(").length - 1).toBe(2);
  });

  it("the shortlist bonus is untouched — it answers a different question", () => {
    expect(FUNNEL).toContain("return 0.22;");
    expect(FUNNEL).toContain("export function youtubeSourceTierBonus()");
  });

  it("and so is the YouTube download cap", () => {
    expect(FUNNEL).toContain("export function maxShortlistPerYoutubeSource()");
    expect(FUNNEL).toContain("return 4;");
  });
});
