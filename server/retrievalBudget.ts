/**
 * RONDE 97 §10 — WHAT ONE BEAT IS ALLOWED TO SPEND.
 *
 * ── What was already bounded, and what was not ──────────────────────────────────────────────
 *
 * RONDE 95 bounded the expensive half: `maxShortlistPerBeat()` limits how many candidates a beat
 * may put to the picture editor, derived from the existing `MAX_JUDGEMENTS_PER_BEAT`. That closed
 * the vision explosion — render 568's 240 unasked image-gate moments — and it is untouched here.
 *
 * The cheap-looking half was not bounded at all. A beat could issue any number of provider
 * queries, download any number of files, and re-enter the rescue ladder as often as a route chose
 * to call it. Render 568 spent 1667 provider queries to fill twenty slots and downloaded 100 files
 * to use ten; each of those is individually small and collectively the reason a render takes hours.
 *
 * ── Why the budgets are per beat and not per render ─────────────────────────────────────────
 *
 * A render-wide ceiling is spent in beat order: the early beats take everything and the last beats
 * get none, and the starvation lands on whichever beats happen to be last rather than on the ones
 * that deserve less. `MAX_BEAT_IMAGE_JUDGEMENTS` documents that lesson for judgements; the same
 * argument applies to every other resource a beat consumes.
 *
 * ── What exhaustion means ───────────────────────────────────────────────────────────────────
 *
 * Not an error and not a silent stop. A beat that has spent its retrieval budget has asked enough
 * questions; the honest response is to stop asking and let the beat settle for what it has, with
 * the reason recorded so the render can say WHY the beat looks the way it does. That is the same
 * shape as `SHORTLIST_FULL` in RONDE 95, and it feeds the same taxonomy.
 */

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * The four budgets, and where each number comes from.
 *
 * Every one is generous relative to what a healthy beat actually uses and tight relative to what
 * render 568 spent — the point is to bound a pathological beat, not to ration a normal one.
 */
export const BUDGETS = {
  /** 1667 queries over ~20 slots is 83 per beat. A beat that needs more is not searching, it is guessing. */
  queries: () => envInt("MAX_BEAT_QUERIES", 24, 1, 200),
  /** 100 downloads for 10 used clips. A beat gets enough attempts to survive bad files, not enough to trawl. */
  downloads: () => envInt("MAX_BEAT_DOWNLOADS", 12, 1, 100),
  /** Preparation is the expensive one after vision; RONDE 97's cache makes repeats free, so this bounds real work. */
  preparations: () => envInt("MAX_BEAT_PREPARATIONS", 10, 1, 100),
  /** The rescue ladder may be entered a few times, never indefinitely — the infinite-rescue case. */
  rescues: () => envInt("MAX_BEAT_RESCUES", 3, 1, 20),
} as const;

export type BudgetKind = keyof typeof BUDGETS;

export type BeatSpend = Record<BudgetKind, number>;

export type RetrievalBudgetState = {
  byBeat: Map<string, BeatSpend>;
  /** One line per exhaustion, so the render can say which beat stopped and why. */
  exhausted: Array<{ sceneIndex: number; beatIndex: number; kind: BudgetKind; limit: number }>;
};

export function createRetrievalBudgetState(): RetrievalBudgetState {
  return { byBeat: new Map(), exhausted: [] };
}

const key = (sceneIndex: number, beatIndex: number): string => `${sceneIndex}:${beatIndex}`;

function spendFor(state: RetrievalBudgetState, sceneIndex: number, beatIndex: number): BeatSpend {
  const k = key(sceneIndex, beatIndex);
  const existing = state.byBeat.get(k);
  if (existing) return existing;
  const fresh: BeatSpend = { queries: 0, downloads: 0, preparations: 0, rescues: 0 };
  state.byBeat.set(k, fresh);
  return fresh;
}

/**
 * MAY THIS BEAT SPEND ONE MORE?
 *
 * Charges on the way in and answers in one call, because the two must not be separable: a caller
 * that could ask without charging would eventually ask twice and charge once, and the budget would
 * drift away from the work it is meant to bound.
 *
 * The first refusal for a (beat, kind) is recorded once. A beat that keeps asking after it has
 * been refused is a route that is not reading the answer, and repeating the line thirty times
 * would bury the render's other findings rather than adding anything.
 */
export function budgetAllows(
  state: RetrievalBudgetState | undefined,
  sceneIndex: number,
  beatIndex: number,
  kind: BudgetKind
): boolean {
  if (!state) return true;
  const spend = spendFor(state, sceneIndex, beatIndex);
  const limit = BUDGETS[kind]();
  if (spend[kind] >= limit) {
    const already = state.exhausted.some(
      (e) => e.sceneIndex === sceneIndex && e.beatIndex === beatIndex && e.kind === kind
    );
    if (!already) state.exhausted.push({ sceneIndex, beatIndex, kind, limit });
    return false;
  }
  spend[kind] += 1;
  return true;
}

export function beatSpend(
  state: RetrievalBudgetState | undefined,
  sceneIndex: number,
  beatIndex: number
): BeatSpend {
  if (!state) return { queries: 0, downloads: 0, preparations: 0, rescues: 0 };
  return { ...spendFor(state, sceneIndex, beatIndex) };
}

/** Was this beat stopped by a budget rather than by a lack of candidates? */
export function budgetExhaustedFor(
  state: RetrievalBudgetState | undefined,
  sceneIndex: number,
  beatIndex: number
): BudgetKind[] {
  if (!state) return [];
  return state.exhausted
    .filter((e) => e.sceneIndex === sceneIndex && e.beatIndex === beatIndex)
    .map((e) => e.kind);
}

/**
 * What the render spent, and which beats hit a ceiling.
 *
 * A render with no exhaustion prints one totals line; the per-beat lines exist only for the beats
 * that were actually stopped, because those are the ones whose result needs explaining.
 */
export function formatRetrievalBudgets(state: RetrievalBudgetState | undefined): string[] {
  if (!state || state.byBeat.size === 0) return [];
  const total: BeatSpend = { queries: 0, downloads: 0, preparations: 0, rescues: 0 };
  for (const spend of state.byBeat.values()) {
    for (const kind of Object.keys(total) as BudgetKind[]) total[kind] += spend[kind];
  }
  const lines = [
    `[RetrievalBudget] beats=${state.byBeat.size} queries=${total.queries} ` +
      `downloads=${total.downloads} preparations=${total.preparations} rescues=${total.rescues} ` +
      `(perBeat caps q=${BUDGETS.queries()} d=${BUDGETS.downloads()} p=${BUDGETS.preparations()} r=${BUDGETS.rescues()})`,
  ];
  for (const e of state.exhausted) {
    lines.push(
      `[RetrievalBudget] s${e.sceneIndex}b${e.beatIndex} BUDGET_EXHAUSTED kind=${e.kind} ` +
        `limit=${e.limit} — the beat stopped asking, it did not run out of candidates`
    );
  }
  return lines;
}
