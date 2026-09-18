/**
 * ONE YOUTUBE TURN PER BEAT — the same beat cannot be sent to the same provider twice.
 *
 * ── The question this file has to be able to answer NO to ───────────────────────────────────
 *
 *     "Kan dezelfde beat nog twee keer bij YouTube terecht?"
 *
 * Before RONDE 260 the answer was yes, by four different doors. `tryBeatRealYouTubeFootage` had
 * sixteen call sites, and eight FURTHER sites called `fetchYouTubeCCClips` directly without going
 * near it: `fetchBeatYoutubeOnly`, the historical cascade's `youtube_cc` tier, the research race's
 * entity and celebrity tasks, and the beat cascade's hero / real-event / archival-early /
 * archival-late tiers. Three of those could fire for one beat in a single pass.
 *
 * Render 589 is what that costs, measured: 1751 candidates examined, 104 downloads attempted,
 * across the whole render, for ONE adopted clip.
 *
 * ── What is tested here, and what is deliberately not ───────────────────────────────────────
 *
 * The register's behaviour is tested against the real exported functions — claim, re-entry, close,
 * refusal. Nothing is mocked into a provider: no YouTube call is made, no network is touched, and
 * no fake provider response is constructed anywhere in this file.
 *
 * The call sites are tested STRUCTURALLY, against the source. That is the only honest way to prove
 * "there is no ninth door": running one code path proves that path, while the claim being made is
 * about every path. §13 asks the test to fail when a beat can reach YouTube more than once, and a
 * new direct `fetchYouTubeCCClips(` call written next round is exactly how that would happen again.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  claimYoutubeTurn,
  endYoutubeTurnForBeat,
  youtubeTurnKey,
  type YoutubeTurnRecord,
} from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** The one field of the render state this register reads. */
const freshRegister = (): { youtubeTurnByBeat: Map<string, YoutubeTurnRecord> } => ({
  youtubeTurnByBeat: new Map(),
});

/* ═══════════ 1 — a beat gets one turn, whoever asks ═══════════ */

describe("§13 — the same beat cannot be sent to YouTube twice", () => {
  it("the second route is refused, whatever it calls itself", () => {
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 2, 1, "resolveBeatClipFast");
    expect(first.granted).toBe(true);
    if (!first.granted) return;
    endYoutubeTurnForBeat(dedup, first.key, first.token, "YOUTUBE_NO_RESULTS", null);

    for (const who of [
      "resolveBeatClipTurbo",
      "fetchBeatClipFromScript",
      "historical cascade",
      "research race",
      "archival early",
      "hero",
      "fetchLastResortRealClip",
    ]) {
      const again = claimYoutubeTurn(dedup, 2, 1, who);
      expect(again.granted, `${who} was allowed a second turn`).toBe(false);
    }
  });

  it("a refused route is handed the outcome, not sent away empty", () => {
    /**
     * The turn produced a file. Withholding it would lose footage the render has already paid the
     * search, the download and the transcode for — which is the mirror-image bug of asking twice.
     */
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 0, 0, "research YouTube first");
    if (!first.granted) throw new Error("first claim refused");
    endYoutubeTurnForBeat(dedup, first.key, first.token, "ADOPTED", "/w/yt_s0b0.mp4");

    const second = claimYoutubeTurn(dedup, 0, 0, "archival");
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.record.clip).toBe("/w/yt_s0b0.mp4");
    expect(second.record.outcome).toBe("ADOPTED");
    expect(second.record.requestedBy).toBe("research YouTube first");
  });

  it("every OTHER beat still gets its own turn — this is per beat, not per render", () => {
    const dedup = freshRegister();
    const a = claimYoutubeTurn(dedup, 1, 0, "fast");
    if (!a.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, a.key, a.token, "YOUTUBE_NO_RESULTS", null);

    expect(claimYoutubeTurn(dedup, 1, 1, "fast").granted).toBe(true);
    expect(claimYoutubeTurn(dedup, 2, 0, "fast").granted).toBe(true);
    expect(youtubeTurnKey(1, 0)).toBe("s1b0");
  });

  it("a beat refused a turn in scene 1 does not refuse the same beat index in scene 2", () => {
    const dedup = freshRegister();
    const a = claimYoutubeTurn(dedup, 1, 3, "fast");
    if (!a.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, a.key, a.token, "ENTITY_BUDGET_EXHAUSTED", null);
    expect(claimYoutubeTurn(dedup, 2, 3, "fast").granted).toBe(true);
  });
});

/* ═══════════ 2 — one turn is one visit, not one query ═══════════ */

describe("§13 — a multi-query route keeps ONE turn across its queries", () => {
  it("the holder re-enters with its own token and is granted the same turn", () => {
    /**
     * The historical cascade walks its tiers once per query. Claiming per call would make "one
     * turn" mean "one query" and cost that cascade the query variety that is its entire point.
     */
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 0, 2, "historical cascade");
    if (!first.granted) throw new Error("claim refused");

    const reentry = claimYoutubeTurn(dedup, 0, 2, "historical cascade", first.token);
    expect(reentry.granted).toBe(true);
    if (!reentry.granted) return;
    expect(reentry.token).toBe(first.token);
    expect(dedup.youtubeTurnByBeat.size).toBe(1);
  });

  it("a DIFFERENT route cannot re-enter an open turn, even holding a stale token", () => {
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 0, 2, "historical cascade");
    if (!first.granted) throw new Error("claim refused");

    expect(claimYoutubeTurn(dedup, 0, 2, "research race").granted).toBe(false);
    expect(claimYoutubeTurn(dedup, 0, 2, "research race", first.token + 1).granted).toBe(false);
    expect(claimYoutubeTurn(dedup, 0, 2, "research race", 0).granted).toBe(false);
  });

  it("re-entry is refused once the turn has been closed", () => {
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 0, 2, "historical cascade");
    if (!first.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, first.key, first.token, "POOLED_INTO_CASCADE:2", null);
    expect(claimYoutubeTurn(dedup, 0, 2, "historical cascade", first.token).granted).toBe(false);
  });
});

/* ═══════════ 3 — a turn ends exactly once, and says how ═══════════ */

describe("§B — every turn ends exactly once", () => {
  it("the first close wins; a second cannot rewrite the outcome", () => {
    const dedup = freshRegister();
    const claim = claimYoutubeTurn(dedup, 0, 0, "fast");
    if (!claim.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, claim.key, claim.token, "ADOPTED", "/w/a.mp4");
    endYoutubeTurnForBeat(dedup, claim.key, claim.token, "FAILED", null);

    const record = dedup.youtubeTurnByBeat.get("s0b0")!;
    expect(record.outcome).toBe("ADOPTED");
    expect(record.clip).toBe("/w/a.mp4");
  });

  it("a route cannot close a turn it does not hold", () => {
    const dedup = freshRegister();
    const claim = claimYoutubeTurn(dedup, 0, 0, "fast");
    if (!claim.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, claim.key, claim.token + 999, "FAILED", null);

    const record = dedup.youtubeTurnByBeat.get("s0b0")!;
    expect(record.endedAtMs, "an unheld close ended someone else's turn").toBeNull();
    expect(record.outcome).toBe("OPEN");
  });

  it("an open turn is distinguishable from a finished one", () => {
    const dedup = freshRegister();
    const claim = claimYoutubeTurn(dedup, 0, 0, "fast");
    if (!claim.granted) throw new Error("claim refused");
    expect(dedup.youtubeTurnByBeat.get("s0b0")!.endedAtMs).toBeNull();
    endYoutubeTurnForBeat(dedup, claim.key, claim.token, "YOUTUBE_NO_RESULTS", null);
    expect(dedup.youtubeTurnByBeat.get("s0b0")!.endedAtMs).toBeTypeOf("number");
  });

  it("a state with no register is granted rather than silently refused", () => {
    /**
     * A refusal this function cannot record would be a stille fallback: the caller skips YouTube
     * and nothing anywhere says why. Granting is the honest answer for a hand-built state.
     */
    const claim = claimYoutubeTurn({ youtubeTurnByBeat: undefined as never }, 0, 0, "fast");
    expect(claim.granted).toBe(true);
  });
});

/* ═══════════ 4 — §15: SKIPPED is not DECLINED is not ENDED ═══════════ */

describe("§15 — the vocabulary an operator can act on", () => {
  /**
   * RONDE 260B moved this vocabulary. It used to live in `tryBeatRealYouTubeFootage`, which decided
   * for itself whether a search was due; that function is now the provider adapter and owns no
   * policy at all. The capability question, the ceiling, the terminal reason and the turn all
   * belong to `runCentralYoutubeTurn`, so that is where these claims are checked.
   */
  const turnFn = (): string => {
    const at = PIPELINE.indexOf("export async function runCentralYoutubeTurn(");
    expect(at, "runCentralYoutubeTurn moved").toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
  };

  it("a missing capability is SKIPPED and names which capability", () => {
    const body = turnFn();
    expect(body).toContain("turn=SKIPPED");
    expect(body).toContain("sourcing_disabled");
    expect(body).toContain("not_ready");
    expect(body).toContain("YOUTUBE_CAPABILITY_UNAVAILABLE");
  });

  it("an exhausted ceiling is a separate outcome from a missing capability", () => {
    const body = turnFn();
    expect(body).toContain("YOUTUBE_BUDGET_EXHAUSTED");
    expect(body).toContain("entity_ceiling");
  });

  it("the started line comes BEFORE the work and the ceiling question after it", () => {
    /**
     * §13's ordering. START is printed once the turn is genuinely claimed, and the two SKIPPED
     * reasons below it close that same turn — so a render log always carries a START with a
     * matching END, including for a turn that did nothing.
     */
    const body = turnFn();
    expect(body.indexOf("turn=START")).toBeLessThan(body.indexOf("YOUTUBE_CAPABILITY_UNAVAILABLE"));
    expect(body.indexOf("turn=START")).toBeLessThan(body.indexOf("YOUTUBE_BUDGET_EXHAUSTED"));
    expect(body.indexOf("turn=START")).toBeLessThan(body.indexOf("turn=END"));
  });

  it("an empty query list does not consume the beat's turn", () => {
    /**
     * Not a capability fact and not a budget fact — the query builder produced nothing, and a later
     * route with a usable query must still be able to take the beat's turn. The claim is given
     * back rather than closed, which is what `releaseUnstartedYoutubeTurn` is for.
     */
    const body = turnFn();
    expect(body).toContain('finish("YOUTUBE_NO_QUERY", null)');
    expect(PIPELINE).toContain("YOUTUBE_OUTCOME_LEAVES_TURN_OPEN");
    expect(PIPELINE).toContain("function releaseUnstartedYoutubeTurn(");
  });

  it("every ending is one of the recorded outcomes, and refusal has its own line", () => {
    const body = turnFn();
    for (const outcome of [
      "YOUTUBE_ADOPTED",
      "YOUTUBE_NO_RESULTS",
      "YOUTUBE_NO_USABLE_CANDIDATE",
      "YOUTUBE_TIMEOUT",
      "YOUTUBE_SEARCH_FAILED",
      "YOUTUBE_CANDIDATES_DELIVERED",
    ]) {
      expect(body, outcome).toContain(outcome);
    }
    expect(PIPELINE).toContain("TURN_ALREADY_TAKEN");
    expect(PIPELINE).toContain("turn=ALREADY_COMPLETED");
  });

  it("a rejection reason is only used where the code can prove it", () => {
    /**
     * §12 — `YOUTUBE_VISION_REJECTED` is measured, by counting this beat's `does_not_fit` verdicts
     * across the turn. `RIGHTS_REJECTED` and `ADOPTION_REJECTED` are NOT here, and their absence is
     * the point: `adoptClip` returns a path or null and does not say which gate refused, so those
     * labels could only be guesses dressed as measurements.
     */
    expect(PIPELINE).toContain("function countBeatVisionRefusals(");
    expect(PIPELINE).toContain('entry.decision.verdict === "does_not_fit"');
    // As VALUES, not as words: the doc comment names them precisely to say they are not used.
    expect(PIPELINE).not.toContain('"YOUTUBE_RIGHTS_REJECTED"');
    expect(PIPELINE).not.toContain('"YOUTUBE_ADOPTION_REJECTED"');
  });
});

/* ═══════════ 5 — one door, and it is the only one ═══════════ */

describe("§18 — the static audit: no route reaches YouTube on its own", () => {
  /** Every `fetchYouTubeCCClips(` in the file that is a call rather than a declaration or prose. */
  const providerCallSites = (): Array<{ index: number; host: string }> => {
    const sites: Array<{ index: number; host: string }> = [];
    const re = /fetchYouTubeCCClips\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index));
      if (line.includes("export async function")) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      sites.push({ index: m.index, host: enclosingFunction(m.index) });
    }
    return sites;
  };

  /** The top-level function an offset sits in. */
  const enclosingFunction = (index: number): string => {
    const re = /\n(?:export )?(?:async )?function (\w+)/g;
    let name = "?";
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE)) && m.index < index) name = m[1];
    return name;
  };

  it("the provider has exactly ONE production call site, inside the adapter", () => {
    /**
     * This is the assertion §21 criterion 4 asks for, and the one that fails the day a new direct
     * `fetchYouTubeCCClips(` is written anywhere in production code. It names the offending host.
     */
    const hosts = providerCallSites().map((s) => s.host);
    expect(hosts).toEqual(["tryBeatRealYouTubeFootage"]);
  });

  it("the adapter has exactly ONE caller, and it is the central turn", () => {
    const re = /(?<![\w.])tryBeatRealYouTubeFootage\s*\(/g;
    const hosts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index));
      if (line.includes("async function")) continue;
      hosts.push(enclosingFunction(m.index));
    }
    expect(hosts).toEqual(["runCentralYoutubeTurn"]);
  });

  it("the four formerly independent routes now go through the central turn", () => {
    /**
     * Each of these used to call the provider itself. The check is not that the name survives — it
     * is that the enclosing function now contains a `runCentralYoutubeTurn({` and no provider call.
     */
    for (const route of [
      "fetchBeatYoutubeOnly",
      "fetchHistoricalBeatVideoInner",
      "researchBeatClipUnifiedInner",
      "fetchBeatClipInner",
    ]) {
      const at = PIPELINE.indexOf(`function ${route}(`);
      expect(at, `${route} not found`).toBeGreaterThan(-1);
      const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
      expect(body, `${route} does not reach the central turn`).toContain("runCentralYoutubeTurn({");
      expect(body, `${route} still calls the provider itself`).not.toContain("fetchYouTubeCCClips(");
    }
  });

  it("no branch decides on its own that a YouTube search is due", () => {
    /**
     * The capability question is the tell. A branch that asks `youtubeCcReady()` before reaching the
     * provider is a branch making a routing decision — which is exactly what this round removed.
     * Only the central turn, the fetcher itself and the readiness reporting may ask.
     */
    const re = /(?<![\w.])youtubeCcReady\s*\(\)/g;
    const hosts = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) hosts.add(enclosingFunction(m.index));
    /**
     * The allowed hosts, and why each one is not routing:
     *
     *   runCentralYoutubeTurn   the one place that MAY decide — this round's whole point
     *   youtubeCcReady          the function itself
     *   downloadYouTubeCCClip   prose in a doc comment
     *   probeYouTubeCcPipeline  the readiness probe, which reports and sources nothing
     *   maxEntityYoutubeFetchesPerVideo  sizes the per-video ceiling, does not route
     *   fetchUniqueStockForBeat sizes a WALL CLOCK for a mixed-provider path, does not route
     *   fetchUniqueStockForBeatInner  refuses when NO provider at all is configured
     *   _runVideoPipelineInner  reports whether any real-visual capability exists, at startup
     */
    for (const host of hosts) {
      expect(
        [
          "runCentralYoutubeTurn",
          "youtubeCcReady",
          "downloadYouTubeCCClip",
          "probeYouTubeCcPipeline",
          "maxEntityYoutubeFetchesPerVideo",
          "fetchUniqueStockForBeat",
          "fetchUniqueStockForBeatInner",
          "_runVideoPipelineInner",
          /**
           * Declares tier 1 UNAVAILABLE for the sourcing ladder — the opposite of routing to
           * it. Its answer can only make a beat skip YouTube, never reach it.
           */
          "beatSourcingDeclines",
        ],
        `${host} decides for itself whether to try YouTube`
      ).toContain(host);
    }
  });

  it("the beat cascade's tiers keep their own relevance floors", () => {
    /**
     * §11 — folding the tiers into one query set would have meant one shared `minRelevanceScore`:
     * either loosening the two strict tiers, which is forbidden outright, or tightening the lenient
     * one, which silently changes what a beat may adopt. The request carries the floor instead.
     */
    expect(PIPELINE).toContain("minRelevanceScore?: number;");
    expect(PIPELINE).toContain("req.minRelevanceScore ?? 1");
    const floorOf = (tier: string): string => {
      const at = PIPELINE.indexOf(tier);
      expect(at, `${tier} moved`).toBeGreaterThan(-1);
      // To the end of the argument list, not the first `)` — a query expression has its own.
      return PIPELINE.slice(at, PIPELINE.indexOf("\n", PIPELINE.indexOf('"', at + tier.length)));
    };
    expect(floorOf('"hero", "hero"'), "the hero tier lost its floor").toContain(", 2,");
    expect(floorOf('"archival early", "archival"')).toContain(", 2,");
    expect(floorOf('"archival", "archival"')).toContain(", 2,");
    expect(floorOf('"real-event YouTube", "event"')).toContain(", 1,");
  });
});

/* ═══════════ 6 — nothing from the round before was undone ═══════════ */

describe("§C — RONDE 259's transfer reserve and the YouTube clock still stand", () => {
  it("the reserve taken at scope open is untouched", () => {
    expect(PIPELINE).toContain("reserveYoutubeTurn(scope);");
    expect(PIPELINE).toContain("export function remainingNonYoutubeScopeMs()");
    expect(PIPELINE).toContain("youtubeReservedMs");
    expect(PIPELINE).toContain("youtubeTurnEndedAtMs");
  });

  it("no budget was raised to pay for this round", () => {
    expect(PIPELINE).toContain("const YOUTUBE_SEARCH_TIMEOUT_MS = 12_000;");
    expect(PIPELINE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPELINE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
  });

  it("the per-video entity ceiling was not raised either", () => {
    expect(PIPELINE).toContain("dedup.entityYoutubeFetchesUsed >= dedup.perf.maxEntityYoutubePerVideo");
  });
});
