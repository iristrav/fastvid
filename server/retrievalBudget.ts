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

import { getQueryScope } from "./searchQueryContract";

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
  /**
   * WORK THAT ARRIVED WITH NO BEAT TO CHARGE IT TO.
   *
   * A per-beat budget can only bound work that knows which beat it belongs to. RONDE 100B opens
   * the beat scope at the leaves — the functions that actually call a provider — precisely so that
   * every route carries its identity, and `[SearchQueryAudit] scene=? beat=?` was the receipt for
   * what happens when it does not.
   *
   * A charge that arrives outside any beat scope is therefore allowed through: refusing it would
   * stop legitimate render-level work, and guessing a beat would file the spend against one that
   * never asked. But it is COUNTED, because an unscoped download is a hole in this ceiling, and
   * the whole reason the downloads budget went four rounds without biting is that nobody could see
   * it was not being charged. If this number is large, the bound is not covering what it claims.
   */
  unscoped: BeatSpend;
  /**
   * RONDE 256 — WORK THAT NAMED ITS SCENE AND HAS NO BEAT TO NAME.
   *
   * Split out of `unscoped`, because the two had opposite meanings and one number.
   *
   * `buildSceneCandidatePool` opens `withQueryScope({ videoId, sceneIndex })` — deliberately, with
   * no beat. It is assembling a pool that several beats will draw from, so there IS no single beat
   * to charge, and the note above says why inventing one would be worse than counting it: the spend
   * would be filed against a beat that never asked.
   *
   * Render 585 reported `UNSCOPED total=568 downloads=227 preparations=341` beside twenty beats
   * refused by their own ceilings, which reads as a third of the render escaping the rem. Most of it
   * is scene-level work that never had a per-beat ceiling to escape. Counted apart so the number
   * that IS alarming — work that cannot name even a scene, and has therefore lost its provenance —
   * stops being buried in it.
   *
   * NO CEILING IS ATTACHED HERE. The scene pool bounds itself already, and a scene budget would be
   * a number invented without evidence that a ceiling is the thing missing.
   */
  sceneScoped: BeatSpend;
};

export function createRetrievalBudgetState(): RetrievalBudgetState {
  return {
    byBeat: new Map(),
    exhausted: [],
    unscoped: { queries: 0, downloads: 0, preparations: 0, rescues: 0 },
    sceneScoped: { queries: 0, downloads: 0, preparations: 0, rescues: 0 },
  };
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
 * ── RONDE 231 — THE THREE BUDGETS THAT WERE NEVER CHARGED ───────────────────────────────────
 *
 * This module declared four budgets. One was enforced.
 *
 *     $ grep -n 'budgetAllows(' server/*.ts | grep -v test
 *     server/retrievalBudget.ts:90:export function budgetAllows(    ← the definition
 *     server/videoPipeline.ts:32169: ... "queries")                 ← one caller
 *
 * `downloads`, `preparations` and `rescues` had a documented default, an env var, a comment
 * arguing the number, and a test file called `retrievalBudgetIsEnforced.test.ts` — and not one
 * call site. The limit of twelve downloads per beat was decided four rounds ago and has never
 * refused a download.
 *
 * Render 581 is the receipt: 2228 Pexels and Pixabay retrievals, 382 files actually written,
 * `adopted=0`, and YouTube reaching `0s left in the scene budget` on 28 of 32 attempts. The
 * spend that starved it was bounded on paper the whole time.
 *
 * ── Why an ambient charge and not a parameter ───────────────────────────────────────────────
 *
 * The choke points are `downloadToFileStreaming` (which documents itself as "the single choke
 * point every provider download funnels through") and `runPreparation` in preparationCache.ts.
 * Neither is handed the render's state, and neither should be: threading it means 37 call sites
 * again, and the 38th added next round starts uncharged. That is precisely the failure RONDE 173
 * describes for the sourcing cache and solves the same way.
 *
 * The beat identity is already ambient — `getQueryScope()`, opened at the same leaves as the
 * provenance — so the only thing missing is the state, and `setBudgetResolver` supplies it.
 */
let resolveBudget: (() => RetrievalBudgetState | undefined) | null = null;

/**
 * Teach this module how to find the current render's budget.
 *
 * videoPipeline owns `RenderCtx` and calls this once with a reader for it. Injected rather than
 * imported because preparationCache.ts is on the other side of the dependency graph from
 * videoPipeline, and a module-level state object here would be shared by two concurrent renders on
 * one worker — which is the exact hazard RenderCtx's AsyncLocalStorage exists to avoid.
 */
export function setBudgetResolver(fn: (() => RetrievalBudgetState | undefined) | null): void {
  resolveBudget = fn;
}

export function activeRetrievalBudget(): RetrievalBudgetState | undefined {
  try {
    return resolveBudget?.() ?? undefined;
  } catch {
    /** A budget that cannot be read must never be the reason a download fails. */
    return undefined;
  }
}

/**
 * MAY THE BEAT THAT IS CURRENTLY RUNNING SPEND ONE MORE?
 *
 * True when it may, and the spend is charged. False only when a beat is identified AND its budget
 * for that kind is gone — never because the ambient wiring is missing, which is counted under
 * `unscoped` instead. Refusing on a missing scope would turn a plumbing gap into lost footage.
 */
export function chargeAmbientBudget(kind: BudgetKind): boolean {
  const state = activeRetrievalBudget();
  if (!state) return true;
  const { sceneIndex, beatIndex } = getQueryScope();
  if (sceneIndex == null || beatIndex == null) {
    /**
     * RONDE 256 — a scene that named itself is not work that named nothing.
     *
     * Both are allowed through and neither is charged to a beat, which is unchanged. What changed
     * is that they are counted apart: the scene pool legitimately has no beat, and work with no
     * scene either has lost its provenance and is the number worth looking at.
     */
    if (sceneIndex != null) state.sceneScoped[kind] += 1;
    else state.unscoped[kind] += 1;
    return true;
  }
  return budgetAllows(state, sceneIndex, beatIndex, kind);
}

/**
 * What the render spent, and which beats hit a ceiling.
 *
 * A render with no exhaustion prints one totals line; the per-beat lines exist only for the beats
 * that were actually stopped, because those are the ones whose result needs explaining.
 */
export function formatRetrievalBudgets(state: RetrievalBudgetState | undefined): string[] {
  if (!state) return [];
  const unscopedTotal = (Object.keys(state.unscoped) as BudgetKind[]).reduce(
    (n, k) => n + state.unscoped[k],
    0
  );
  const sceneScopedTotal = (Object.keys(state.sceneScoped) as BudgetKind[]).reduce(
    (n, k) => n + state.sceneScoped[k],
    0
  );
  if (state.byBeat.size === 0 && unscopedTotal === 0 && sceneScopedTotal === 0) return [];
  const total: BeatSpend = { queries: 0, downloads: 0, preparations: 0, rescues: 0 };
  for (const spend of state.byBeat.values()) {
    for (const kind of Object.keys(total) as BudgetKind[]) total[kind] += spend[kind];
  }
  const lines = [
    `[RetrievalBudget] beats=${state.byBeat.size} queries=${total.queries} ` +
      `downloads=${total.downloads} preparations=${total.preparations} rescues=${total.rescues} ` +
      `(perBeat caps q=${BUDGETS.queries()} d=${BUDGETS.downloads()} p=${BUDGETS.preparations()} r=${BUDGETS.rescues()})`,
  ];
  /**
   * The hole, stated rather than assumed away. Work charged here was allowed through unbounded
   * because nothing said which beat it belonged to — so the per-beat caps above did not apply to
   * it, and a reader comparing the totals to the caps needs to know that.
   */
  /**
   * RONDE 256 — scene-level work, named as what it is.
   *
   * Printed BEFORE the unscoped line and worded differently on purpose. This is the scene candidate
   * pool doing its job: it has a scene and no beat, because it is building a pool several beats will
   * draw from. Render 585 reported it beside genuinely provenance-less work under one heading, and
   * 568 of those read as a third of the render escaping every ceiling.
   */
  if (sceneScopedTotal > 0) {
    const s = state.sceneScoped;
    lines.push(
      `[RetrievalBudget] SCENE_SCOPED total=${sceneScopedTotal} queries=${s.queries} ` +
        `downloads=${s.downloads} preparations=${s.preparations} rescues=${s.rescues} — ` +
        `scene-level work with no single beat to charge; the per-beat caps do not apply by design`
    );
  }
  if (unscopedTotal > 0) {
    const u = state.unscoped;
    lines.push(
      `[RetrievalBudget] UNSCOPED total=${unscopedTotal} queries=${u.queries} ` +
        `downloads=${u.downloads} preparations=${u.preparations} rescues=${u.rescues} — ` +
        `charged to no beat, so no per-beat cap applied to it`
    );
  }
  for (const e of state.exhausted) {
    lines.push(
      `[RetrievalBudget] s${e.sceneIndex}b${e.beatIndex} BUDGET_EXHAUSTED kind=${e.kind} ` +
        `limit=${e.limit} — the beat stopped asking, it did not run out of candidates`
    );
  }
  return lines;
}
