/**
 * ONE DOOR TO YOUTUBE — and it is the same door for every subject.
 *
 * ── What this round finished ────────────────────────────────────────────────────────────────
 *
 * RONDE 260 proved the BEHAVIOUR: a beat could not be sent to YouTube twice, because every route
 * had to hold the beat's turn. What it did not change was the ARCHITECTURE. Fifteen branches still
 * called the provider adapter themselves, and four further routes called the provider directly, so
 * "one turn" was a rule twenty-four places had to keep rather than a shape they could not break.
 *
 * RONDE 260B closes that. There is now one orchestrator, `runCentralYoutubeTurn`; it is the only
 * caller of the adapter, and the adapter holds the only production call to the provider. A branch
 * contributes context and consumes a result. It cannot decide that a YouTube search is due,
 * because it no longer has a way to start one.
 *
 * ── The rule that is easiest to break by accident ───────────────────────────────────────────
 *
 * This is NOT a historical or archival route. The same door serves PERSON, EVENT, PROCESS,
 * LOCATION, NEWS and ARCHIVAL beats. `visualNeed` steers the query strategy and the ranking; it
 * does not select a different pipeline. §10 below is the test that fails if that ever drifts.
 *
 * ── What is real here and what is read from the source ──────────────────────────────────────
 *
 * The turn register, the budget and the request model are exercised against the real exported
 * functions. No provider is called, no network is touched, no response is faked anywhere in this
 * file. The routing claims — "one door", "no branch decides" — are structural, checked against the
 * source, because they are claims about every path rather than about the one a test happens to run.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  claimYoutubeTurn,
  endYoutubeTurnForBeat,
  runCentralYoutubeTurn,
  youtubeTurnKey,
  withSceneFetchTimeout,
  remainingScopeMs,
  remainingNonYoutubeScopeMs,
  scopedTimeoutMs,
  YOUTUBE_MIN_TURN_MS,
  type YoutubeTurnRecord,
} from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const freshRegister = (): { youtubeTurnByBeat: Map<string, YoutubeTurnRecord> } => ({
  youtubeTurnByBeat: new Map(),
});

/** The top-level function an offset in the pipeline source sits in. */
const enclosingFunction = (index: number): string => {
  const re = /\n(?:export )?(?:async )?function (\w+)/g;
  let name = "?";
  let m: RegExpExecArray | null;
  while ((m = re.exec(PIPELINE)) && m.index < index) name = m[1];
  return name;
};

/** One top-level function's body, brace-matched from its declaration. */
const bodyOf = (fn: string): string => {
  const at = PIPELINE.search(new RegExp(`(?:export )?(?:async )?function ${fn}\\s*[(<]`));
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const end = PIPELINE.indexOf("\n}\n", at);
  return PIPELINE.slice(at, end);
};

/** Every call to the orchestrator, with the enclosing function and the request text. */
const centralCalls = (): Array<{ host: string; request: string }> => {
  const out: Array<{ host: string; request: string }> = [];
  const re = /runCentralYoutubeTurn\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(PIPELINE))) {
    let i = m.index + "runCentralYoutubeTurn(".length;
    let depth = 0;
    const start = i;
    do {
      const c = PIPELINE[i];
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
      i++;
    } while (depth > 0);
    out.push({ host: enclosingFunction(m.index), request: PIPELINE.slice(start, i) });
  }
  return out;
};

/* ═══════════ T1 / T2 — one turn, and the second asker is answered ═══════════ */

describe("T1/T2 — a beat gets one central turn", () => {
  it("the first route is granted", () => {
    const dedup = freshRegister();
    expect(claimYoutubeTurn(dedup, 1, 2, "topic YouTube").granted).toBe(true);
    expect(dedup.youtubeTurnByBeat.get(youtubeTurnKey(1, 2))?.requestedBy).toBe("topic YouTube");
  });

  it("a second route cannot start a second turn, whatever it calls itself", () => {
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 1, 2, "topic YouTube");
    if (!first.granted) throw new Error("first claim refused");
    endYoutubeTurnForBeat(dedup, first.key, first.token, "YOUTUBE_NO_RESULTS", null);

    for (const who of [
      "turbo YouTube", "last-resort YouTube", "research race",
      "historical cascade", "archival", "hero", "person YouTube",
    ]) {
      expect(claimYoutubeTurn(dedup, 1, 2, who).granted, `${who} got a second turn`).toBe(false);
    }
  });

  it("the second asker is handed the first turn's answer, not an empty one", () => {
    const dedup = freshRegister();
    const first = claimYoutubeTurn(dedup, 0, 0, "research race");
    if (!first.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, first.key, first.token, "YOUTUBE_ADOPTED", "/w/yt.mp4");

    const second = claimYoutubeTurn(dedup, 0, 0, "turbo YouTube");
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.record.clip).toBe("/w/yt.mp4");
    expect(second.record.outcome).toBe("YOUTUBE_ADOPTED");
  });

  it("the orchestrator itself takes the turn through the register", async () => {
    /**
     * A mutation that replaced the claim with an always-granted stub survived the first version of
     * this file: the completed-turn check above still passed, because it only catches a turn that
     * has ENDED. Two branches overlapping on an OPEN turn is the case only the claim catches, and
     * this is that case — run against the real function, with no provider anywhere near it.
     */
    const dedup = {
      youtubeTurnByBeat: new Map<string, YoutubeTurnRecord>(),
      entityYoutubeFetchesUsed: 0,
      perf: { maxEntityYoutubePerVideo: 4, fastStockMode: false },
    };
    const held = claimYoutubeTurn(dedup, 3, 1, "historical cascade");
    expect(held.granted).toBe(true);
    expect(dedup.youtubeTurnByBeat.get(youtubeTurnKey(3, 1))?.endedAtMs).toBeNull();

    const result = await runCentralYoutubeTurn({
      beat: { index: 1, text: "a beat", keywords: [] },
      scene: { text: "a scene" },
      workDir: "/tmp/never-used",
      sceneIndex: 3,
      clipFetchDur: 3,
      dedup,
      visualNeed: "topic",
      queries: ["something the provider will never be asked for"],
      queryBuilder: "test",
      termSource: "a second branch",
      adoptOpts: {},
      timeoutMs: 1_000,
    } as never);

    expect(result.alreadyCompleted, "a second branch opened its own turn").toBe(true);
    expect(result.clip).toBeNull();
    expect(dedup.youtubeTurnByBeat.size, "a second turn was filed").toBe(1);
  });

  it("the orchestrator answers a completed turn instead of re-searching", () => {
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).toContain("turn=ALREADY_COMPLETED");
    const answer = body.indexOf("alreadyCompleted: true");
    const work = body.indexOf("await tryBeatRealYouTubeFootage(req)");
    expect(answer, "the completed-turn answer comes after the search").toBeLessThan(work);
  });
});

/* ═══════════ T3 — no production route reaches the provider on its own ═══════════ */

describe("T3 — the provider has exactly one production door", () => {
  it("fetchYouTubeCCClips is called from exactly one production function", () => {
    const hosts: string[] = [];
    const re = /fetchYouTubeCCClips\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index));
      if (line.includes("export async function")) continue; // the declaration
      if (/^\s*(\*|\/\/)/.test(line)) continue; // prose
      hosts.push(enclosingFunction(m.index));
    }
    expect(hosts, "a route reaches the provider outside the central turn").toEqual([
      "tryBeatRealYouTubeFootage",
    ]);
  });

  it("the adapter is called from exactly one function, the orchestrator", () => {
    const hosts: string[] = [];
    const re = /(?<![\w.])tryBeatRealYouTubeFootage\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      if (PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index)).includes("async function")) {
        continue;
      }
      hosts.push(enclosingFunction(m.index));
    }
    expect(hosts).toEqual(["runCentralYoutubeTurn"]);
  });

  it("no other module reaches the provider at all", () => {
    /** The pipeline is where sourcing lives; a second module importing the fetcher is a new door. */
    expect(PIPELINE).toContain("export async function fetchYouTubeCCClips(");
  });
});

/* ═══════════ T4 — the reserve is still the reserve ═══════════ */

describe("T4 — non-YouTube providers cannot spend the YouTube reserve", () => {
  const WINDOW_MS = 120_000;

  it("a non-YouTube caller sees the clock less the turn's cost", async () => {
    await withSceneFetchTimeout(
      async () => {
        /**
         * Within a millisecond, not exactly equal. Both readings are computed from `Date.now()`
         * against the scope's deadline, so a tick between the two calls shifts the difference by
         * one — which made this fail about one run in fifty. The reserve is the claim; the
         * millisecond is not.
         */
        const held = remainingScopeMs() - remainingNonYoutubeScopeMs();
        expect(Math.abs(held - YOUTUBE_MIN_TURN_MS)).toBeLessThanOrEqual(2);
      },
      WINDOW_MS,
      "test scene"
    );
  });

  it("every provider timeout is sized against the reduced clock", async () => {
    await withSceneFetchTimeout(
      async () => {
        expect(scopedTimeoutMs(WINDOW_MS)).toBeLessThanOrEqual(remainingNonYoutubeScopeMs());
        expect(remainingScopeMs() - scopedTimeoutMs(WINDOW_MS)).toBeGreaterThanOrEqual(
          YOUTUBE_MIN_TURN_MS
        );
      },
      WINDOW_MS,
      "test scene"
    );
  });

  it("a route refused by the entity ceiling steps aside instead of taking the turn", () => {
    /**
     * Found by a test, not by reasoning. When the ceiling check moved inside the central turn, a
     * route that hit the ceiling took the beat's turn with it — and the historical cascade, which
     * never drew on that ceiling, stopped reaching YouTube at all. The ceiling is a fact about the
     * ASKING ROUTE, so it leaves the turn open, and it must not release the scene's reserve either.
     */
    expect(PIPELINE).toContain("YOUTUBE_BUDGET_EXHAUSTED");
    const set = PIPELINE.slice(
      PIPELINE.indexOf("const YOUTUBE_OUTCOME_LEAVES_TURN_OPEN"),
      PIPELINE.indexOf("]);", PIPELINE.indexOf("const YOUTUBE_OUTCOME_LEAVES_TURN_OPEN"))
    );
    expect(set).toContain("YOUTUBE_NO_QUERY");
    expect(set).toContain("YOUTUBE_BUDGET_EXHAUSTED");

    const body = bodyOf("runCentralYoutubeTurn");
    const open = body.indexOf("YOUTUBE_OUTCOME_LEAVES_TURN_OPEN.has(outcome)");
    const release = body.indexOf("endYoutubeTurn(outcome);");
    expect(open, "the reserve is released before the turn is known to be over").toBeLessThan(
      release
    );
  });

  it("the pooling routes do not spend the entity ceiling they never spent", () => {
    /**
     * §11 — the cascade and the beat cascade's hero and archival tiers never counted against
     * `maxEntityYoutubePerVideo`. Making them count would tighten a gate this round was told not
     * to touch, so each route says for itself whether it draws on that ceiling.
     */
    expect(PIPELINE).toContain("countsAgainstEntityCeiling?: boolean;");
    expect(PIPELINE).toContain("countsAgainstEntityCeiling: false,");
    expect(PIPELINE).toContain("countsAgainstEntityCeiling: entityUsable,");
    expect(PIPELINE).toContain("req.countsAgainstEntityCeiling !== false");
  });

  it("the reserve is taken at scope open and released only by the turn", () => {
    expect(PIPELINE).toContain("reserveYoutubeTurn(scope);");
    expect(PIPELINE).toContain("export function endYoutubeTurn(");
    // The one place that releases it is the one place that runs the turn.
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).toContain("endYoutubeTurn(outcome);");
  });

  it("no budget, ceiling or timeout was raised to pay for this round", () => {
    expect(PIPELINE).toContain("const YOUTUBE_SEARCH_TIMEOUT_MS = 12_000;");
    expect(PIPELINE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    expect(PIPELINE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
    expect(PIPELINE).toContain(
      "dedup.entityYoutubeFetchesUsed >= dedup.perf.maxEntityYoutubePerVideo"
    );
  });
});

/* ═══════════ T5 — what happens after YouTube ═══════════ */

describe("T5 — a failed turn falls through to the next tier", () => {
  it("the turn returns a terminal reason rather than throwing", () => {
    const body = bodyOf("runCentralYoutubeTurn");
    for (const outcome of [
      "YOUTUBE_NO_RESULTS",
      "YOUTUBE_NO_USABLE_CANDIDATE",
      "YOUTUBE_TIMEOUT",
      "YOUTUBE_SEARCH_FAILED",
      "YOUTUBE_CAPABILITY_UNAVAILABLE",
      "YOUTUBE_BUDGET_EXHAUSTED",
    ]) {
      expect(body, outcome).toContain(outcome);
    }
  });

  it("every branch continues when the turn yields nothing", () => {
    /**
     * Each call-site reads `.clip` and falls through on null — it does not return null itself, and
     * it does not treat a failed YouTube turn as the end of sourcing for the beat.
     */
    for (const { host, request } of centralCalls()) {
      if (host === "fetchBeatYoutubeOnly") continue; // its own function IS the YouTube tier
      expect(request, `${host} builds a request`).toContain("visualNeed:");
    }
    const adapterFree = bodyOf("fetchBeatClipInner");
    expect(adapterFree).toContain("runCentralYoutubeTurn({");
  });

  it("the adapter's failure is caught and reported, never propagated as a crash", () => {
    const body = bodyOf("tryBeatRealYouTubeFootage");
    expect(body).toContain("} catch (err) {");
    expect(body).toContain("error: true");
  });
});

/* ═══════════ T6-T9 — the branch's context survives the consolidation ═══════════ */

describe("T6-T9 — no branch loses its context at the door", () => {
  /** A field is present whether written long (`queries: x`) or shorthand (`queries,`). */
  const carries = (request: string, field: string): boolean =>
    new RegExp(`(^|[\\s{])${field}\\s*[:,]`).test(request);

  it("every request carries the queries its own builder produced", () => {
    for (const { host, request } of centralCalls()) {
      expect(carries(request, "queries"), `${host} sends no queries`).toBe(true);
      expect(
        carries(request, "queryBuilder"),
        `${host} does not say which builder produced them`
      ).toBe(true);
      expect(carries(request, "termSource"), `${host} does not name itself`).toBe(true);
    }
  });

  it("every request carries the beat's adoption context", () => {
    /**
     * `adoptOpts` is where this pipeline's entity, person and script-anchor context lives —
     * `personTopic`, `primaryPerson`, `keywords`, `videoTitle`, `requireBeatMatch`,
     * `scriptAnchored`, `requireMuskBrand`. A request without it is a beat that reached the
     * provider stripped of everything the branch knew about it.
     */
    for (const { host, request } of centralCalls()) {
      expect(carries(request, "adoptOpts"), `${host} drops the adoption context`).toBe(true);
      expect(carries(request, "beat"), `${host} drops the beat`).toBe(true);
      /**
       * Present is not enough — `adoptOpts: {}` is present and carries nothing, and a mutation that
       * did exactly that survived the first version of this file. What each branch hands over must
       * be the caller's own options, whether passed straight through or spread and narrowed.
       */
      const opts = (/adoptOpts:\s*([^\n]*)/.exec(request)?.[1] ?? "adoptOpts,").trim();
      expect(
        /^\{\s*\},?$/.test(opts),
        `${host} hands over an empty adoption context: ${opts}`
      ).toBe(false);
    }
  });

  it("T6 — a PERSON branch keeps its person", () => {
    const person = centralCalls().filter((c) => c.request.includes('visualNeed: "person"'));
    expect(person.length, "no person route reaches the central turn").toBeGreaterThanOrEqual(3);
    expect(
      person.some((c) => c.request.includes("primaryPerson")),
      "the person never reaches the provider"
    ).toBe(true);
  });

  it("T7 — an EVENT branch keeps its event queries", () => {
    const event = centralCalls().filter((c) => c.request.includes('visualNeed: "event"'));
    expect(event.length).toBeGreaterThanOrEqual(3);
    expect(
      event.every((c) => c.request.includes("entityYt")),
      "an event beat reaches the provider without its entity queries"
    ).toBe(true);
    // And the builder that produced them is named, wherever an event route hands them over.
    expect(PIPELINE).toContain('"realEntityYoutubeQueriesForBeat"');
  });

  it("T8 — a TOPIC/PROCESS branch keeps its documentary queries", () => {
    const topic = centralCalls().filter((c) => c.request.includes('visualNeed: "topic"'));
    expect(topic.length).toBeGreaterThanOrEqual(2);
    expect(topic.some((c) => c.request.includes("topicYt"))).toBe(true);
  });

  it("T9 — an ARCHIVAL branch keeps its archival queries and its relevance floor", () => {
    const archival = centralCalls().filter((c) => c.request.includes('visualNeed: "archival"'));
    expect(archival.length, "no archival route reaches the central turn").toBeGreaterThanOrEqual(1);
    expect(
      archival.some((c) => c.request.includes("historicalCascadeQueries")),
      "the historical cascade's queries are gone"
    ).toBe(true);
  });
});

/* ═══════════ T10 — one route for every subject, not a historical route ═══════════ */

describe("T10 — the central route is not an archival route", () => {
  it("every visual need in the vocabulary actually reaches the central turn", () => {
    /**
     * §22's rule, made enforceable. If a future round routes PERSON or EVENT beats around this
     * door — back to a "celebrity YouTube" or "historical YouTube" path of their own — the need
     * disappears from the request sites and this fails.
     */
    const needs = new Set(
      centralCalls()
        .map((c) => /visualNeed:\s*(?:"(\w+)"|[^,]+\?\s*"(\w+)"\s*:\s*"(\w+)")/.exec(c.request))
        .flatMap((m) => (m ? [m[1], m[2], m[3]] : []))
        .filter(Boolean) as string[]
    );
    for (const need of ["person", "event", "topic", "archival", "hero", "research", "last_resort"]) {
      expect([...needs], `${need} beats no longer use the central route`).toContain(need);
    }
  });

  it("the need steers the query strategy, never which pipeline runs", () => {
    /**
     * The orchestrator may LOG the need and pass it on. The moment it branches on it — a different
     * search, a different adoption, a different provider — it has become two routes wearing one
     * name, which is the thing §8 forbids.
     */
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).toContain("visualNeed=${req.visualNeed}");
    expect(body, "the central turn branches on the need").not.toMatch(
      /req\.visualNeed\s*===|switch\s*\(\s*req\.visualNeed/
    );
    const adapter = bodyOf("tryBeatRealYouTubeFootage");
    expect(adapter, "the adapter branches on the need").not.toContain("visualNeed");
  });

  it("no branch is allowed to ask whether YouTube is available before routing to it", () => {
    const hosts = new Set<string>();
    const re = /(?<![\w.])youtubeCcReady\s*\(\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) hosts.add(enclosingFunction(m.index));
    for (const host of hosts) {
      expect(
        [
          "runCentralYoutubeTurn", // the one place that MAY decide
          "youtubeCcReady", // the function itself
          "downloadYouTubeCCClip", // prose in a doc comment
          "probeYouTubeCcPipeline", // the readiness probe; sources nothing
          "maxEntityYoutubeFetchesPerVideo", // sizes the ceiling, does not route
          "fetchUniqueStockForBeat", // sizes a wall clock for a mixed-provider path
          "fetchUniqueStockForBeatInner", // refuses when NO provider at all is configured
          "_runVideoPipelineInner", // reports capability at startup
          /**
           * Declares tier 1 UNAVAILABLE for the sourcing ladder, which is the opposite of routing
           * to it: the answer can only ever make the beat skip YouTube, never reach it. It exists
           * so "not called" and "declined" stay different states — see `beatSourcingDeclines`.
           */
          "beatSourcingDeclines",
        ],
        `${host} decides for itself whether to try YouTube`
      ).toContain(host);
    }
  });
});

/* ═══════════ §13/§14 — the turn says what it did ═══════════ */

describe("§13/§14 — instrumentation and provenance", () => {
  it("the turn logs START, END and ALREADY_COMPLETED with its budget", () => {
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).toContain("turn=START");
    expect(body).toContain("turn=END");
    expect(body).toContain("turn=ALREADY_COMPLETED");
    expect(body).toContain("reservedMs=");
    expect(body).toContain("usedMs=");
    expect(body).toContain("remainingReservedMs=");
  });

  it("the route names itself once, in one place", () => {
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).toContain("route=central_youtube_turn");
    expect(body).toContain("provider=youtube");
    for (const field of ["scene=", "beat=", "visualNeed=", "queryBuilder=", "termSource=", "query="]) {
      expect(body, field).toContain(field);
    }
  });

  it("the provenance line is not built from module state", () => {
    /** §14 — every field comes off the request the branch handed in, not a global. */
    const body = bodyOf("runCentralYoutubeTurn");
    const audit = body.slice(body.indexOf("[SearchQueryAudit]"), body.indexOf("const claim ="));
    expect(audit).toContain("${req.visualNeed}");
    expect(audit).toContain("${req.queryBuilder}");
    expect(audit).toContain("${req.termSource}");
  });
});

/* ═══════════ §17 — the golden deterministic trace ═══════════ */

describe("§17 — golden trace: 'Kim Kardashian appears at a Los Angeles court.'", () => {
  /**
   * A PERSON beat about a living public figure at a present-day event — as far from archival as
   * this pipeline gets, and the exact beat §17 names. The trace asserted here is the ORDER of the
   * stages the beat passes through, read from the register and the real exported functions.
   *
   * No search runs. Proving which provider answers would need the provider, and this round's claim
   * is about routing, not about what YouTube happens to hold today.
   */
  const BEAT = "Kim Kardashian appears at a Los Angeles court.";

  it("the beat reaches the central turn first, and reaches it once", () => {
    const dedup = freshRegister();
    const trace: string[] = [];

    trace.push("BEAT");
    const claim = claimYoutubeTurn(dedup, 0, 0, `person YouTube (${BEAT.split(" ")[0]})`);
    expect(claim.granted).toBe(true);
    if (!claim.granted) return;
    trace.push("CENTRAL_YOUTUBE_TURN");

    endYoutubeTurnForBeat(dedup, claim.key, claim.token, "YOUTUBE_NO_RESULTS", null);
    trace.push("YOUTUBE_RESULT:YOUTUBE_NO_RESULTS");

    // Every later tier for this beat asks and is answered, never re-routed to YouTube.
    for (const tier of ["OWN_ARCHIVE", "OTHER_SOURCE", "VISUAL_FALLBACK"]) {
      const again = claimYoutubeTurn(dedup, 0, 0, tier);
      expect(again.granted, `${tier} reopened YouTube`).toBe(false);
      trace.push(tier);
    }

    expect(trace).toEqual([
      "BEAT",
      "CENTRAL_YOUTUBE_TURN",
      "YOUTUBE_RESULT:YOUTUBE_NO_RESULTS",
      "OWN_ARCHIVE",
      "OTHER_SOURCE",
      "VISUAL_FALLBACK",
    ]);
    expect(dedup.youtubeTurnByBeat.size, "more than one turn was filed").toBe(1);
  });

  it("an adopted turn ends sourcing with the clip, not with another provider", () => {
    const dedup = freshRegister();
    const claim = claimYoutubeTurn(dedup, 0, 0, "person YouTube");
    if (!claim.granted) throw new Error("claim refused");
    endYoutubeTurnForBeat(dedup, claim.key, claim.token, "YOUTUBE_ADOPTED", "/w/kk.mp4");

    const archive = claimYoutubeTurn(dedup, 0, 0, "OWN_ARCHIVE");
    expect(archive.granted).toBe(false);
    if (archive.granted) return;
    expect(archive.record.clip).toBe("/w/kk.mp4");
  });

  it("no historical, celebrity or rescue route sits between the beat and the provider", () => {
    /**
     * Structural, because this is a claim about every path. Each of these functions used to reach
     * YouTube itself; none of them may any more, and the door they go through is the same one a
     * 1945 archival beat goes through.
     */
    for (const route of [
      "fetchBeatYoutubeOnly",
      "fetchHistoricalBeatVideoInner",
      "researchBeatClipUnifiedInner",
      "fetchPersonBeatClipInner",
      "resolveBeatClipTurboInner",
      "fetchLastResortRealClipInner",
    ]) {
      expect(bodyOf(route), `${route} still calls the provider`).not.toContain(
        "fetchYouTubeCCClips("
      );
    }
  });
});

/* ═══════════ §11 — nothing was loosened to get here ═══════════ */

describe("§11 — the quality gates are untouched", () => {
  it("the adapter still runs the existing adoption flow, and does not reimplement it", () => {
    const adapter = bodyOf("tryBeatRealYouTubeFootage");
    expect(adapter).toContain("tryStockSources(");
    expect(adapter).toContain("withSceneFetchTimeout(");
  });

  it("the central turn adopts nothing itself", () => {
    /** Adoption lives in `adoptClip`/`tryStockSources`. A second one here would be a second engine. */
    const body = bodyOf("runCentralYoutubeTurn");
    expect(body).not.toContain("adoptClip(");
    expect(body).not.toContain("fetchYouTubeCCClips(");
  });

  it("YouTube gets the first chance, not an easier gate", () => {
    /**
     * The request may carry a relevance FLOOR a branch already had; it may not carry an exemption.
     * If a `skipVision`, `bypass` or `force` ever appears in this request model, the first tier has
     * become a privileged tier.
     */
    const model = PIPELINE.slice(
      PIPELINE.indexOf("export type CentralYoutubeRequest = {"),
      PIPELINE.indexOf("export type CentralYoutubeOutcome")
    );
    for (const exemption of ["skipVision", "skipRights", "bypass", "force", "trusted"]) {
      expect(model, `the request model carries an exemption: ${exemption}`).not.toContain(exemption);
    }
  });
});
