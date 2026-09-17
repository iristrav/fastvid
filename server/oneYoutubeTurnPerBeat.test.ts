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
  const turnFn = (): string => {
    const at = PIPELINE.indexOf("async function tryBeatRealYouTubeFootage(");
    expect(at, "tryBeatRealYouTubeFootage moved").toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
  };

  it("a missing capability is SKIPPED and names which capability", () => {
    const body = turnFn();
    expect(body).toContain("YOUTUBE_TURN_SKIPPED");
    expect(body).toContain("CAPABILITY_UNAVAILABLE:sourcing_disabled");
    expect(body).toContain("CAPABILITY_UNAVAILABLE:not_ready");
  });

  it("an exhausted budget is a separate outcome from a missing capability", () => {
    expect(turnFn()).toContain("ENTITY_BUDGET_EXHAUSTED");
  });

  it("the started line comes AFTER the budget question, not before it", () => {
    /** A turn that could not run has not started, and a log that says otherwise is a half-truth. */
    const body = turnFn();
    expect(body.indexOf("ENTITY_BUDGET_EXHAUSTED")).toBeLessThan(
      body.indexOf("YOUTUBE_TURN_STARTED")
    );
  });

  it("an empty query list consumes no turn", () => {
    /**
     * Not a capability fact and not a budget fact — the query builder produced nothing, and a later
     * route with a usable query must still be able to take the beat's turn.
     */
    const body = turnFn();
    const noQueries = body.indexOf("if (youtubeQueries.length === 0) return null;");
    expect(noQueries, "the empty-query guard moved").toBeGreaterThan(-1);
    expect(noQueries, "a route with no queries can now hold the beat's turn").toBeLessThan(
      body.indexOf("claimYoutubeTurn(")
    );
  });

  it("every ending is one of the recorded outcomes, and refusal has its own line", () => {
    const body = turnFn();
    for (const outcome of ["ADOPTED", "NO_ADOPTABLE_CANDIDATE", "FAILED"]) {
      expect(body, outcome).toContain(outcome);
    }
    expect(PIPELINE).toContain("TURN_ALREADY_TAKEN");
    expect(PIPELINE).toContain("YOUTUBE_TURN_ENDED");
  });
});

/* ═══════════ 5 — there is no ninth door ═══════════ */

describe("§13 — no route reaches YouTube without holding the turn", () => {
  /**
   * Every `fetchYouTubeCCClips(` in the file, paired with the body of the top-level function it
   * sits in.
   *
   * The enclosing function, not a fixed window of characters. A window is the wrong instrument
   * twice over: too small and a guarded call reads as unguarded because a long comment pushed the
   * claim out of view; too large and an unguarded call inherits its NEIGHBOUR's claim and the test
   * passes while the door stands open. The function boundary is the scope the claim actually has.
   */
  const GUARDS = ["claimYoutubeTurn(", "askYoutubeOnceForThisBeat(", "claimCascadeYoutubeTurn()"];
  const callSites = (): Array<{ index: number; body: string; near: string }> => {
    const sites: Array<{ index: number; body: string; near: string }> = [];
    const re = /fetchYouTubeCCClips\(/g;
    const fnStart = /\n(?:export )?(?:async )?function /g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      // The declaration itself and prose mentions in comments are not call sites.
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index));
      if (line.includes("export async function")) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;

      let start = -1;
      fnStart.lastIndex = 0;
      let f: RegExpExecArray | null;
      while ((f = fnStart.exec(PIPELINE)) && f.index < m.index) start = f.index;
      expect(start, "no enclosing top-level function found").toBeGreaterThan(-1);
      const end = PIPELINE.indexOf("\n}\n", m.index);
      sites.push({
        index: m.index,
        body: PIPELINE.slice(start, end),
        near: PIPELINE.slice(Math.max(0, m.index - 200), m.index),
      });
    }
    return sites;
  };

  /**
   * A function with ONE call to the provider is guarded when the claim is anywhere in its body;
   * the claim governs the whole function and may sit far above behind its own explanation.
   *
   * A function with SEVERAL calls has to show a guard at each one. Body scope is not enough there:
   * the beat cascade holds four YouTube tiers, and if one of them loses its wrapper the other three
   * keep the word `askYoutubeOnceForThisBeat` in the body and the unguarded tier reads as covered.
   * That is the neighbour-inherits-the-guard failure, and a mutation proved this file had it.
   */
  const isGuarded = (site: { body: string; near: string }): boolean => {
    const callsInBody = site.body.split("fetchYouTubeCCClips(").length - 1;
    const scope = callsInBody > 1 ? site.near : site.body;
    return GUARDS.some((g) => scope.includes(g));
  };

  it("there are call sites to check — the scan itself has not gone blind", () => {
    expect(callSites().length).toBeGreaterThanOrEqual(6);
  });

  it("EVERY call to the provider is under a turn this beat holds", () => {
    /**
     * This is the test §13 asks for, and it is the one that fails when a ninth door is opened: a
     * new `fetchYouTubeCCClips(` written without claiming the turn has no `claimYoutubeTurn` or
     * `askYoutubeOnceForThisBeat` above it, and this assertion names the offending offset.
     */
    const unguarded = callSites().filter((s) => !isGuarded(s));
    expect(
      unguarded.map((s) => s.index),
      "a route reaches YouTube without holding the beat's turn"
    ).toEqual([]);
  });

  it("each of the four formerly-independent routes now claims", () => {
    for (const route of [
      "fetchBeatYoutubeOnly", // its own full YouTube route, looser adoption
      "claimCascadeYoutubeTurn", // the historical cascade's youtube_cc tier
      '"research race"', // the research race's merged task
      "askYoutubeOnceForThisBeat", // the beat cascade's four tiers
    ]) {
      expect(PIPELINE, route).toContain(route);
    }
  });

  it("the research race asks YouTube once, with the union of its query sets", () => {
    /**
     * It used to push up to THREE tasks: the entity queries, then one per celebrity/topic query.
     * Merging them is what makes one turn affordable without dropping a single query.
     */
    expect(PIPELINE).toContain("const unionQueries = [");
    expect(PIPELINE).toContain("POOLED_INTO_RESEARCH:");
  });

  it("the beat cascade's tiers keep their own relevance gates", () => {
    /**
     * §5-style check. Folding the tiers into one query set would have meant one shared
     * minRelevanceScore — either loosening the two strict tiers, which is forbidden outright, or
     * tightening the lenient one, which silently changes what a beat may adopt. Neither happened:
     * the tier order decides who takes the turn, and each tier keeps the gate it had.
     */
    const heroAt = PIPELINE.indexOf('askYoutubeOnceForThisBeat("hero"');
    const archivalAt = PIPELINE.indexOf('askYoutubeOnceForThisBeat("archival early"');
    const realEventAt = PIPELINE.indexOf('askYoutubeOnceForThisBeat("real-event YouTube"');
    expect(Math.min(heroAt, archivalAt, realEventAt)).toBeGreaterThan(-1);
    expect(PIPELINE.slice(archivalAt, archivalAt + 400)).toContain("beat.keywords, 2,");
    expect(PIPELINE.slice(realEventAt, realEventAt + 400)).toContain("beat.keywords, 1,");
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
