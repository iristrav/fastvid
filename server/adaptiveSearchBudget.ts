/**
 * RONDE 267 — MORE CHANCES TO LOOK, NOT LONGER TO WAIT.
 *
 * ── The distinction this module exists to hold ──────────────────────────────────────────────
 *
 * Every previous attempt at "YouTube needs more time" raised a timeout. RONDE 259 proved what that
 * buys: `YOUTUBE_BEAT_BUDGET_MS` went from 30s to 45s and not one outcome changed, because the
 * parent scope clamped it. A longer timeout is longer waiting on the same request.
 *
 * What a beat actually needs, when its first look returned something worth pursuing, is ANOTHER
 * LOOK. So every turn this module grants is the same length as the first — the caller's own
 * per-turn budget, untouched — and what varies is HOW MANY it may take. That is the whole design,
 * and §3 of the brief says it in one line: extra zoekgelegenheid, niet langer wachten.
 *
 * ── Topic-agnostic by construction, not by discipline ───────────────────────────────────────
 *
 * Nothing here can see the subject. There is no "historical", no "WW2", no provider name, no
 * keyword list — a decision that could read the topic would eventually be taught to special-case
 * one, and the brief lists fifteen categories precisely to forbid that. The caller states whether
 * the provider suits the NEED; this decides whether another look is worth taking.
 *
 * For the same reason this does not contain a capability engine. Capability is an input, supplied
 * by whoever already knows it. A second opinion about which provider suits which need would drift
 * from the first, and the brief forbids a parallel engine.
 *
 * ── Adaptive is not unlimited ───────────────────────────────────────────────────────────────
 *
 * `MAX_SEARCH_TURNS` is a hard ceiling no input can raise, and §7's other bounds — candidates,
 * downloads, preparation, Vision calls — remain where they already are. This module can only ever
 * say "one more turn of the length you already allow" or "no". It cannot lengthen anything, spend
 * anything, or admit a candidate.
 *
 * ── And it never grants a look nobody can judge ─────────────────────────────────────────────
 *
 * §5. Searching for candidates that cannot reach a verdict produces unverified footage, which the
 * adoption guard will refuse anyway — so the honest answer is to stop, with a reason, rather than
 * to fill a shortlist nobody can empty.
 */

/** What the caller knows about this beat and this provider at the moment it asks. */
export type SearchTurnContext = {
  /** Turns already taken for this beat/provider pair. The first call passes 0. */
  turnsTaken: number;
  /**
   * Candidates the previous turns produced that survived eligibility and ranked well enough to be
   * worth a verdict. Not "results returned" — a turn that returned fifty unusable rows produced
   * nothing promising, and §3 requires that to end the turns rather than extend them.
   */
  promisingSoFar: number;
  /** Whether this provider can plausibly supply the KIND of picture the beat asked for. */
  providerSuitsNeed: boolean;
  /** Vision verdicts still available to this beat. Zero means an extra look cannot be judged. */
  visionCapacityRemaining: number;
  /** What the enclosing scope still has. `Infinity` outside a scope. */
  remainingScopeMs: number;
  /** One turn's own cost — the caller's existing per-turn budget, never changed here. */
  turnBudgetMs: number;
  /**
   * A candidate already in hand that has not yet been judged, and would be lost if the beat
   * stopped now. §6: this must not disappear because a generic budget is nearly spent.
   */
  promisingCandidateAwaitingVerdict?: boolean;
};

export type SearchTurnDecision =
  | {
      grant: true;
      reason: "FIRST_TURN" | "PROMISING_RESULTS" | "PROMISING_CANDIDATE_AT_RISK";
      /** Always the caller's own per-turn budget. This module never lengthens a request. */
      turnBudgetMs: number;
    }
  | {
      grant: false;
      reason:
        | "TURN_CEILING_REACHED"
        | "PROVIDER_NOT_CAPABLE"
        | "NOTHING_PROMISING"
        | "NO_VISION_CAPACITY"
        | "SEARCH_BUDGET_EXHAUSTED";
      detail: string;
    };

/**
 * The hard ceiling. No input raises it.
 *
 * Three rather than two because the shape the brief describes needs a middle: a first look that
 * finds something, a second that confirms the source is productive, and a third that is the last
 * one. Past that a provider that has not delivered is not about to.
 */
export const MAX_SEARCH_TURNS = 3;

/**
 * A turn is only worth starting if the scope can also pay for what the turn produces.
 *
 * Expressed as a multiple of the caller's own turn budget rather than as a new constant, so a
 * profile that shortens its turns shortens this with it and the two can never disagree.
 */
export const TURN_PLUS_FOLLOW_THROUGH = 2;

/**
 * May this beat take another look at this provider?
 *
 * Pure. Reads no clock, no environment and no global state, so the same context always produces
 * the same decision and a test can state one without building a render.
 */
export function shouldGrantSearchTurn(ctx: SearchTurnContext): SearchTurnDecision {
  const need = ctx.turnBudgetMs * TURN_PLUS_FOLLOW_THROUGH;
  const affordable = !Number.isFinite(ctx.remainingScopeMs) || ctx.remainingScopeMs >= need;

  /**
   * §6 — FIRST, because a candidate already in hand outranks every other consideration here.
   *
   * It has been found, it has survived eligibility, and the only thing between it and a verdict is
   * a clock. Losing it to a generic budget is the failure the brief names explicitly, and the one
   * this ordering exists to prevent: the ceiling, capability and "nothing promising" all describe
   * whether a NEW search is worth taking, and none of them is a reason to drop something already
   * found.
   *
   * It is still bounded — it cannot exceed the ceiling, it cannot conjure Vision capacity, and it
   * still takes one ordinary turn.
   */
  if (
    ctx.promisingCandidateAwaitingVerdict &&
    ctx.turnsTaken < MAX_SEARCH_TURNS &&
    ctx.visionCapacityRemaining > 0 &&
    affordable
  ) {
    return {
      grant: true,
      reason: "PROMISING_CANDIDATE_AT_RISK",
      turnBudgetMs: ctx.turnBudgetMs,
    };
  }

  if (ctx.turnsTaken >= MAX_SEARCH_TURNS) {
    return {
      grant: false,
      reason: "TURN_CEILING_REACHED",
      detail: `${ctx.turnsTaken} of ${MAX_SEARCH_TURNS} turns already taken`,
    };
  }

  if (!ctx.providerSuitsNeed) {
    return {
      grant: false,
      reason: "PROVIDER_NOT_CAPABLE",
      detail: "this provider cannot supply the kind of picture this beat asked for",
    };
  }

  /**
   * §5 — a look nobody can judge produces unverified footage the adoption guard will refuse. The
   * honest answer is to stop with a reason rather than fill a shortlist nobody can empty.
   */
  if (ctx.visionCapacityRemaining <= 0) {
    return {
      grant: false,
      reason: "NO_VISION_CAPACITY",
      detail: "no verdict is available for anything another turn would find",
    };
  }

  if (!affordable) {
    return {
      grant: false,
      reason: "SEARCH_BUDGET_EXHAUSTED",
      detail:
        `${Math.round(ctx.remainingScopeMs / 1000)}s left and a turn plus what it produces ` +
        `needs ${Math.round(need / 1000)}s`,
    };
  }

  /** The first look is always taken: nothing is known about this provider for this beat yet. */
  if (ctx.turnsTaken === 0) {
    return { grant: true, reason: "FIRST_TURN", turnBudgetMs: ctx.turnBudgetMs };
  }

  /**
   * §3 — a turn that returned nothing worth judging is the end of the turns, not the start of
   * more. This is what keeps "adaptive" from meaning "repeat the same bad request".
   */
  if (ctx.promisingSoFar <= 0) {
    return {
      grant: false,
      reason: "NOTHING_PROMISING",
      detail: `${ctx.turnsTaken} turn(s) produced nothing worth a verdict`,
    };
  }

  return { grant: true, reason: "PROMISING_RESULTS", turnBudgetMs: ctx.turnBudgetMs };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §8 — THE LEDGER, SO THE QUESTION CAN BE ANSWERED AFTERWARDS.
 *
 * "Did FASTVID actually look longer because it was worth it, or did it only wait longer?" is not
 * answerable from a duration. It needs turns and what each turn produced, per beat and per
 * provider, which is what this records.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export type SearchBudgetRow = {
  sceneIndex: number;
  beatIndex: number;
  provider: string;
  searchTurns: number;
  searchDurationMs: number;
  candidatesReturned: number;
  eligibleCandidates: number;
  rankedCandidates: number;
  shortlistedCandidates: number;
  visionAsked: number;
  visionFit: number;
  visionMismatch: number;
  downloadsStarted: number;
  downloadsSucceeded: number;
  adopted: number;
  searchBudgetExhausted: boolean;
  /** Why the turns ended. Empty only while they have not. */
  reason: string;
};

export type SearchBudgetLedger = { rows: Map<string, SearchBudgetRow> };

export function createSearchBudgetLedger(): SearchBudgetLedger {
  return { rows: new Map() };
}

const rowKey = (s: number, b: number, p: string) => `s${s}b${b}:${p}`;

export function searchBudgetRow(
  ledger: SearchBudgetLedger,
  sceneIndex: number,
  beatIndex: number,
  provider: string
): SearchBudgetRow {
  const key = rowKey(sceneIndex, beatIndex, provider);
  let row = ledger.rows.get(key);
  if (!row) {
    ledger.rows.set(
      key,
      (row = {
        sceneIndex,
        beatIndex,
        provider,
        searchTurns: 0,
        searchDurationMs: 0,
        candidatesReturned: 0,
        eligibleCandidates: 0,
        rankedCandidates: 0,
        shortlistedCandidates: 0,
        visionAsked: 0,
        visionFit: 0,
        visionMismatch: 0,
        downloadsStarted: 0,
        downloadsSucceeded: 0,
        adopted: 0,
        searchBudgetExhausted: false,
        reason: "",
      })
    );
  }
  return row;
}

/** Record one granted turn and what it cost. */
export function noteSearchTurn(
  ledger: SearchBudgetLedger,
  sceneIndex: number,
  beatIndex: number,
  provider: string,
  durationMs: number,
  candidatesReturned: number
): void {
  const row = searchBudgetRow(ledger, sceneIndex, beatIndex, provider);
  row.searchTurns += 1;
  row.searchDurationMs += Math.max(0, durationMs);
  row.candidatesReturned += Math.max(0, candidatesReturned);
}

/**
 * Record why the turns ended.
 *
 * §6 and §9: no silent disappearance. A refusal that does not reach this has not been explained,
 * and `unexplainedSearchStops` below counts exactly that.
 */
export function noteSearchStopped(
  ledger: SearchBudgetLedger,
  sceneIndex: number,
  beatIndex: number,
  provider: string,
  decision: Extract<SearchTurnDecision, { grant: false }>
): void {
  const row = searchBudgetRow(ledger, sceneIndex, beatIndex, provider);
  row.reason = `${decision.reason}: ${decision.detail}`;
  row.searchBudgetExhausted = decision.reason === "SEARCH_BUDGET_EXHAUSTED";
}

/**
 * §9's invariant, as a number.
 *
 * A row whose turns ended without a recorded reason is a search that stopped and did not say why —
 * which, when a promising candidate was in hand, is precisely the loss the brief forbids.
 */
export function unexplainedSearchStops(ledger: SearchBudgetLedger): SearchBudgetRow[] {
  return [...ledger.rows.values()].filter((r) => r.searchTurns > 0 && r.reason === "");
}

/** One line per beat/provider pair, for the render report. Empty when nothing searched. */
export function formatSearchBudget(ledger: SearchBudgetLedger): string[] {
  const rows = [...ledger.rows.values()].filter((r) => r.searchTurns > 0);
  if (rows.length === 0) return [];
  return rows.map(
    (r) =>
      `[SearchBudget] s${r.sceneIndex}b${r.beatIndex} provider=${r.provider} ` +
      `turns=${r.searchTurns} durationMs=${r.searchDurationMs} returned=${r.candidatesReturned} ` +
      `eligible=${r.eligibleCandidates} ranked=${r.rankedCandidates} ` +
      `shortlisted=${r.shortlistedCandidates} visionAsked=${r.visionAsked} ` +
      `fit=${r.visionFit} mismatch=${r.visionMismatch} ` +
      `downloads=${r.downloadsStarted}/${r.downloadsSucceeded} adopted=${r.adopted} ` +
      `exhausted=${r.searchBudgetExhausted} reason=${r.reason || "still searching"}`
  );
}
