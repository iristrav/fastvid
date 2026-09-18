/**
 * THE LADDER, ENFORCED AT RUNTIME.
 *
 * ── What the previous round left ────────────────────────────────────────────────────────────
 *
 * `sourcingTiers.ts` wrote the policy down: four tiers, every provider placed, and `tierMayRun`
 * as the rule. The round after it put the rule where every provider search already passes —
 * `searchGateDecision` — and opened a ladder inside `resolveBeatClip`.
 *
 * The integrity audit then found the hole that made that enforcement mostly decorative:
 * `resolveBeatClip` is the pipeline's THIRD route to a beat clip, not its first. The scene funnel
 * and the scene candidate pool both resolve beats before it is ever called, and both ran with no
 * ladder at all — where "no ladder" meant "always admitted". A Pexels clip could become a beat's
 * picture with tiers 1, 2 and 3 all NOT_REACHED, and nothing in the log said so.
 *
 * ── Two scopes, because there are two honest answers ────────────────────────────────────────
 *
 *   BEAT scope    one beat is choosing its picture. Order is enforced here, because here a lower
 *                 tier running first really does mean a higher tier was skipped.
 *
 *   SCENE scope   the funnel and the pool ask many providers for one scene, in parallel, and
 *                 cache the answers. Nothing is being chosen yet, and asking everything is not
 *                 skipping anything — so order is NOT enforced. What matters is that the tiers it
 *                 asked are WRITTEN DOWN, so the beats of that scene inherit the truth instead of
 *                 starting from a blank ladder that says tier 1 was never reached when it was.
 *
 * A beat therefore starts with what its scene actually attempted, and every route below it —
 * funnel adoption, pool download, the cascade, every rescue and every stock fallback — runs inside
 * that one ladder.
 *
 *     scene
 *       ↓
 *     runSceneVisualDiscovery          ← funnel / pool; records which tiers were really asked
 *       ↓
 *     beginBeatSourcing                ← one ladder for the whole beat, seeded with the above
 *       ↓
 *     funnel winner │ pool candidate │ cascade │ rescue │ stock fallback
 *       ↓
 *     searchGateDecision               ← asks this module whether that tier may run
 *       ↓
 *     provider
 *
 * ── What this module is NOT ─────────────────────────────────────────────────────────────────
 *
 * It searches nothing, downloads nothing, ranks nothing and adopts nothing. It holds two facts per
 * beat — which tiers have been attempted, and which have been explicitly declined — and answers
 * one question. Every quality gate downstream is untouched, and a provider this module admits is
 * still subject to eligibility, ranking, shortlist, Vision, rights and the adoption guard.
 */
import { AsyncLocalStorage } from "async_hooks";

import {
  SOURCING_TIERS,
  providerTier,
  tierMayRun,
  tierNumber,
  type SourcingTier,
} from "./sourcingTiers";

/* ═══════════════════════ the ladder, per beat ═══════════════════════ */

export type TierDecline = {
  tier: SourcingTier;
  /** What the caller KNOWS, not what it assumes — see `declineTier`. */
  reason: string;
};

/**
 * Which question this scope is answering.
 *
 * `beat` enforces order. `scene` records attempts without enforcing, because a scene-level pool
 * asks every tier at once and there is no "before" to violate. See the header.
 */
export type SourcingScope = "beat" | "scene";

export type BeatSourcingLadder = {
  kind: SourcingScope;
  renderId: string;
  sceneIndex: number;
  /** -1 for a scene scope, which belongs to no single beat. */
  beatIndex: number;
  /** Tiers a provider search has actually been admitted for. */
  attempted: Set<SourcingTier>;
  /** Tiers the caller has decided are unavailable, with the reason it decided that. */
  declined: Map<SourcingTier, string>;
  /** Every refusal this ladder handed out, for the end-of-beat line. */
  refusals: Array<{ provider: string; tier: SourcingTier; skipped: SourcingTier[] }>;
  /** Providers admitted, in order, so a render log reads as a ladder rather than a set. */
  admitted: Array<{ provider: string; tier: SourcingTier }>;
  /** Providers this scope refused because `sourcingTiers` has never heard of them. */
  unknown: string[];
  /** How many times compose has re-entered this beat's sourcing after its loop iteration ended. */
  composeEntries: number;
  /** True once those entries are spent: further sourcing is refused, and no tier is declined. */
  composeBudgetSpent: boolean;
};

const ladderStore = new AsyncLocalStorage<BeatSourcingLadder>();

/** The beat or scene currently being sourced, or undefined outside any scope. */
export function currentBeatLadder(): BeatSourcingLadder | undefined {
  return ladderStore.getStore();
}

function ladderKey(renderId: string, sceneIndex: number, beatIndex: number): string {
  return `${renderId}|s${sceneIndex}|b${beatIndex}`;
}

/* ═══════════════════════ the beat ladders a render has opened ═══════════════════════ */

/**
 * EVERY BEAT'S LADDER, KEPT AFTER ITS LOOP ITERATION ENDS.
 *
 * ── Why a beat's ladder has to outlive the beat loop ────────────────────────────────────────
 *
 * Compose is not the end of sourcing. When a scene turns out to be short, or a clip is refused
 * at the last moment, or a beat is still empty when the montage is assembled, the pipeline goes
 * looking for another picture — `fillBeatVisual`, `ensureBeatVisualFilled`,
 * `refillSceneStrictVoiceMatch`, `recoverSceneClipsIfEmpty`, `rescueFastShortComposeClips`, and
 * the scene backfill at the bottom of `fetchSceneVisualsInner` itself. All of them run after the
 * beat loop has closed, and all of them are sourcing for a beat that already has a ladder.
 *
 * Throwing that ladder away and opening a blank one would be the worst of both worlds: it would
 * report NOT_REACHED for tiers the beat genuinely walked, and it would make the compose rescue
 * re-earn a permission the render already paid for. Keeping it means a compose-time request
 * CONTINUES the beat rather than starting a second, parallel, more permissive one.
 *
 * Bounded by the render: `forgetRenderSourcing` drops a render's entries when its visuals are
 * done, the same way the storyboard and search-plan caches are released.
 */
const rememberedBeatLadders = new Map<string, BeatSourcingLadder>();

/**
 * How many times compose may re-enter ONE beat's sourcing before it is spent.
 *
 * The continuation budget §7 asks for, and no larger a mechanism than that. Without it a compose
 * rescue loop could re-enter the same beat without limit: the beat's wall clock is long gone by
 * then, and the ladder alone bounds ORDER, not attempts. Production passes `BUDGETS.rescues()`
 * so this shares the number the rescue ladder already uses rather than inventing a second one.
 *
 * Spending it REFUSES further sourcing; it does not decline a tier. A decline would unlock the
 * tiers below it, which is the opposite of what running out of budget means.
 */
export const DEFAULT_COMPOSE_ENTRIES_PER_BEAT = 3;

/* ═══════════════════════ what a scene actually asked ═══════════════════════ */

/**
 * Per scene: the tiers a scene-level discovery really attempted, and the ones it really declined.
 *
 * This is the seed a beat inherits. Bounded to the renders in flight — `forgetSceneDiscovery`
 * clears a render's entries, and a pipeline that forgets to call it loses a handful of small sets
 * rather than a clip cache, which is why this is a plain Map and not an LRU.
 */
type SceneDiscoveryRecord = {
  attempted: Set<SourcingTier>;
  declined: Map<SourcingTier, string>;
};
const sceneDiscovery = new Map<string, SceneDiscoveryRecord>();

/** What scene `sceneIndex` of render `renderId` proved about its tiers, or undefined. */
export function sceneDiscoverySeed(
  renderId: string,
  sceneIndex: number
): { attempted: SourcingTier[]; declined: TierDecline[] } | undefined {
  const rec = sceneDiscovery.get(ladderKey(renderId, sceneIndex, -1));
  if (!rec) return undefined;
  return {
    attempted: [...rec.attempted],
    declined: [...rec.declined].map(([tier, reason]) => ({ tier, reason })),
  };
}

/** Drop everything remembered for one render. Called when the render's visuals are finished. */
export function forgetSceneDiscovery(renderId: string): void {
  for (const key of [...sceneDiscovery.keys()]) {
    if (key.startsWith(`${renderId}|`)) sceneDiscovery.delete(key);
  }
}

/* ═══════════════════════ the orchestrator ═══════════════════════ */

export type CentralVisualSourcingParams = {
  renderId: string;
  sceneIndex: number;
  beatIndex: number;
  /**
   * Tiers the caller can already prove are unavailable — no API key, a capability switched off,
   * an empty archive for this render. Passed IN rather than worked out here, because this module
   * has no way to know any of it and guessing would turn "unavailable" into "unasked".
   *
   * §6's distinction, made structural: a tier that is missing from this list has NOT been
   * declined, and a provider below it is refused until something attempts it.
   */
  declined?: readonly TierDecline[];
  /**
   * Tiers that were genuinely attempted for this beat before its ladder opened — in practice the
   * scene-level funnel or pool, which really did query them.
   *
   * This is a FACT being carried, not a shortcut: the provider searches happened, were admitted by
   * this same gate, and their results are the candidate pool this beat is about to choose from.
   * Pretending otherwise would make the beat re-derive a truth the render already paid for, and
   * would report NOT_REACHED for a tier the log can show being asked.
   */
  seedAttempted?: readonly SourcingTier[];
};

function newLadder(
  kind: SourcingScope,
  params: CentralVisualSourcingParams
): BeatSourcingLadder {
  return {
    kind,
    renderId: params.renderId,
    sceneIndex: params.sceneIndex,
    beatIndex: params.beatIndex,
    attempted: new Set(params.seedAttempted ?? []),
    declined: new Map((params.declined ?? []).map((d) => [d.tier, d.reason])),
    refusals: [],
    admitted: [],
    unknown: [],
    composeEntries: 0,
    composeBudgetSpent: false,
  };
}

/**
 * Open the ladder for one beat and run the existing beat resolution inside it.
 *
 * Re-entrant on purpose. `beginBeatSourcing` opens the beat's ladder around the WHOLE beat, and
 * `resolveBeatClip` — one of the routes inside it — calls this. A second ladder there would reset
 * the very state the outer one exists to carry, so the same beat re-enters its own scope instead.
 */
export async function runCentralVisualSourcing<T>(
  params: CentralVisualSourcingParams,
  run: () => Promise<T>
): Promise<T> {
  const open = ladderStore.getStore();
  if (
    open &&
    open.kind === "beat" &&
    open.renderId === params.renderId &&
    open.sceneIndex === params.sceneIndex &&
    open.beatIndex === params.beatIndex
  ) {
    return run();
  }
  const ladder = newLadder("beat", params);
  try {
    return await ladderStore.run(ladder, run);
  } finally {
    console.log(formatLadder(ladder));
  }
}

/**
 * Open the beat's ladder for the remainder of this loop iteration, and hand back its closer.
 *
 * For the production beat loop, whose body is a thousand lines of branches, `break`s and
 * `continue`s that cannot be wrapped in a callback without rewriting it. `enterWith` is the API
 * Node provides for exactly this shape: the store is set for the rest of the current synchronous
 * execution and every async continuation of it.
 *
 * The caller MUST call the returned closer in a `finally`, which is why it is returned rather than
 * left to a second exported function — the pairing is visible at the call site.
 */
export function beginBeatSourcing(params: CentralVisualSourcingParams): () => void {
  const ladder = newLadder("beat", params);
  /**
   * Remembered, not discarded. The scene backfill and every compose rescue source for THIS beat
   * after this scope closes, and `resumeBeatSourcing` gives them the ladder the beat actually
   * walked instead of a blank one. See `rememberedBeatLadders`.
   */
  rememberedBeatLadders.set(
    ladderKey(params.renderId, params.sceneIndex, params.beatIndex),
    ladder
  );
  ladderStore.enterWith(ladder);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    console.log(formatLadder(ladder));
    /**
     * Leave no ladder AMBIENT. Whatever runs next is not this beat, and inheriting its attempted
     * set implicitly would let a later route believe tier 1 was asked for a beat that never asked
     * it. A compose rescue that IS this beat has to say so, through `resumeBeatSourcing`.
     */
    ladderStore.enterWith(undefined as unknown as BeatSourcingLadder);
  };
}

/**
 * Continue a beat's sourcing after its loop iteration has ended — the compose-time entry.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * The beat ladder bounded the beat loop, and sourcing does not stop there. The integrity audit
 * counted the paths that run afterwards and can still reach a provider: the scene backfill inside
 * `fetchSceneVisualsInner`, `fillBeatVisual`, `ensureBeatVisualFilled`,
 * `refillSceneStrictVoiceMatch`, `recoverSceneClipsIfEmpty`, `rescueFastShortComposeClips`,
 * `adoptStockBeatClipFallback` and `adoptEmergencyGeoStockClip`. Every one of them ran with no
 * ladder, which the gate reads as "admitted".
 *
 * ── Four situations, four honest answers ────────────────────────────────────────────────────
 *
 *   · this beat's ladder is already open      run inside it; nothing to do, nothing to charge.
 *   · a SCENE scope is open                   discovery; leave it alone.
 *   · this beat's ladder is remembered        re-enter it. The beat continues, with everything it
 *                                             attempted and everything it declined still true, and
 *                                             one continuation charged against its budget.
 *   · nothing is remembered                   open one, loudly, and STRICTLY: no tier attempted,
 *                                             only the declines the caller can actually prove.
 *                                             A beat the loop never reached has not walked a
 *                                             ladder, and pretending otherwise to let stock
 *                                             through is the exact fake this round forbids.
 */
export async function resumeBeatSourcing<T>(
  params: CentralVisualSourcingParams & { maxComposeEntries?: number },
  run: () => Promise<T>
): Promise<T> {
  const open = ladderStore.getStore();
  const key = ladderKey(params.renderId, params.sceneIndex, params.beatIndex);

  /** Already inside this beat, or inside a scene's discovery: neither is a continuation. */
  if (open && (open.kind === "scene" || ladderKey(open.renderId, open.sceneIndex, open.beatIndex) === key)) {
    return run();
  }

  const remembered = rememberedBeatLadders.get(key);
  const ladder = remembered ?? newLadder("beat", params);
  if (!remembered) {
    rememberedBeatLadders.set(key, ladder);
    console.log(
      `[CentralSourcing] render=${params.renderId} s${params.sceneIndex}b${params.beatIndex} ` +
        `LADDER_OPENED_AT_COMPOSE — no beat ladder was ever opened for this beat; ` +
        `starting strict (nothing attempted)`
    );
  }

  ladder.composeEntries += 1;
  const cap = params.maxComposeEntries ?? DEFAULT_COMPOSE_ENTRIES_PER_BEAT;
  if (ladder.composeEntries > cap && !ladder.composeBudgetSpent) {
    ladder.composeBudgetSpent = true;
    console.warn(
      `[CentralSourcing] render=${ladder.renderId} s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `COMPOSE_BUDGET_EXHAUSTED entries=${ladder.composeEntries} cap=${cap} — ` +
        `further compose-time sourcing for this beat is refused, no tier is declined`
    );
  }

  try {
    return await ladderStore.run(ladder, run);
  } finally {
    console.log(formatLadder(ladder));
  }
}

/** Release everything a render remembered about its sourcing. */
export function forgetRenderSourcing(renderId: string): void {
  for (const key of [...rememberedBeatLadders.keys()]) {
    if (key.startsWith(`${renderId}|`)) rememberedBeatLadders.delete(key);
  }
  forgetSceneDiscovery(renderId);
}

/** The ladder a beat walked, whether or not it is currently open. For tests and audits. */
export function rememberedLadderFor(
  renderId: string,
  sceneIndex: number,
  beatIndex: number
): BeatSourcingLadder | undefined {
  return rememberedBeatLadders.get(ladderKey(renderId, sceneIndex, beatIndex));
}

/**
 * Open a SCENE scope around a funnel or pool build.
 *
 * Order is not enforced here and that is the point: this asks many providers at once for a whole
 * scene, so there is no lower tier running "instead of" a higher one. What it does is write down
 * which tiers were really asked, so every beat of the scene starts from that fact.
 */
export async function runSceneVisualDiscovery<T>(
  params: { renderId: string; sceneIndex: number; declined?: readonly TierDecline[] },
  run: () => Promise<T>
): Promise<T> {
  const ladder = newLadder("scene", {
    renderId: params.renderId,
    sceneIndex: params.sceneIndex,
    beatIndex: -1,
    declined: params.declined,
  });
  try {
    return await ladderStore.run(ladder, run);
  } finally {
    const key = ladderKey(params.renderId, params.sceneIndex, -1);
    const prior = sceneDiscovery.get(key);
    /**
     * Merged, not replaced. A scene can be discovered more than once — a prefetch and an inline
     * build, a rebuild after a starved scene — and the second run forgetting the first would throw
     * away attempts that really happened.
     */
    const merged: SceneDiscoveryRecord = prior ?? { attempted: new Set(), declined: new Map() };
    for (const t of ladder.attempted) merged.attempted.add(t);
    for (const [t, reason] of ladder.declined) if (!merged.declined.has(t)) merged.declined.set(t, reason);
    sceneDiscovery.set(key, merged);
    console.log(formatLadder(ladder));
  }
}

/**
 * Record that the caller has decided a tier is unavailable.
 *
 * A decline is a decision and must carry the reason the code actually has. "Not tried" is not a
 * decline, and this is the only way to become one — which is what keeps `tierMayRun`'s two states
 * apart at runtime, not just in its own unit tests.
 */
export function declineTier(tier: SourcingTier, reason: string): void {
  const ladder = ladderStore.getStore();
  if (!ladder || ladder.declined.has(tier)) return;
  ladder.declined.set(tier, reason);
  console.log(
    `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
      `TIER_DECLINED tier=${tierNumber(tier)}:${tier} reason=${reason}`
  );
}

/**
 * The one reason a tier may be declined for running out of clock rather than out of material.
 *
 * Kept as a constant so the budget path cannot quietly reach for a reason that reads like a
 * provider verdict. A tier the render had no time to ask is not a tier that had nothing to give,
 * and a log that cannot tell those apart is a log that will be used to justify the wrong fix.
 */
export const BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

/** Record that a tier was genuinely attempted, for a provider that does not pass the search gate. */
export function noteTierAttempted(tier: SourcingTier, provider: string): void {
  const ladder = ladderStore.getStore();
  if (!ladder) return;
  if (!ladder.attempted.has(tier)) {
    ladder.attempted.add(tier);
    console.log(
      `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `TIER_${tierNumber(tier)}_ATTEMPTED tier=${tier} via=${provider}`
    );
  }
  ladder.admitted.push({ provider, tier });
}

/* ═══════════════════════ provider searches nobody scoped ═══════════════════════ */

/**
 * Provider searches that reached the gate with no scope open at all.
 *
 * Before the integrity audit this state was invisible: no ladder meant admitted, silently, and the
 * three scene-level routes that resolve most beats lived entirely in it. Counting it is what makes
 * "one authoritative route" a number somebody can check rather than a claim. A warm-up or a test
 * legitimately has no scope, so this is a counter and not a refusal.
 */
const unscopedSearches = new Map<string, number>();

/** How many provider searches ran with no sourcing scope, by provider. */
export function unscopedProviderSearches(): Record<string, number> {
  return Object.fromEntries([...unscopedSearches].sort((a, b) => b[1] - a[1]));
}

export function resetUnscopedProviderSearches(): void {
  unscopedSearches.clear();
}

/* ═══════════════════════ the question the gate asks ═══════════════════════ */

export type TierAdmission =
  | { admitted: true }
  | { admitted: false; tier: SourcingTier | null; skipped: SourcingTier[]; reason: string };

/**
 * May this provider be searched for the beat currently being sourced?
 *
 * Called from `searchGateDecision`, which every external provider passes.
 *
 * Three answers, for three genuinely different situations:
 *
 *   · no scope     admitted, and counted. A warm-up, a prefetch nobody scoped, a test. The count
 *                  is the audit's measure of how much still runs outside the architecture.
 *   · scene scope  admitted and recorded. Discovery asks everything; see the header.
 *   · beat scope   the ladder decides, and an unknown provider is refused rather than waved
 *                  through — a name `sourcingTiers` has never heard of is a new sourcing route
 *                  that nobody has placed, and silently admitting it is how the tier table stops
 *                  being the whole truth.
 *
 * Admission is recorded as an attempt, so the ladder is built by the searches that actually
 * happen rather than by anyone remembering to announce them.
 */
export function admitProviderForTier(provider: string): TierAdmission {
  const ladder = ladderStore.getStore();
  const tier = providerTier(provider);

  if (!ladder) {
    if (tier) unscopedSearches.set(provider, (unscopedSearches.get(provider) ?? 0) + 1);
    return { admitted: true };
  }

  if (!tier) {
    if (ladder.kind === "scene") return { admitted: true };
    if (!ladder.unknown.includes(provider)) ladder.unknown.push(provider);
    console.warn(
      `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `TIER_UNKNOWN_PROVIDER provider=${provider} — not in sourcingTiers.PROVIDER_TIER, refused`
    );
    return { admitted: false, tier: null, skipped: [], reason: "TIER_UNKNOWN_PROVIDER" };
  }

  if (ladder.kind === "scene") {
    noteTierAttempted(tier, provider);
    return { admitted: true };
  }

  /**
   * The continuation budget, spent. Refused rather than declined — see `resumeBeatSourcing`: a
   * decline would unlock every tier below it, which is the opposite of what running out means.
   */
  if (ladder.composeBudgetSpent) {
    console.log(
      `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `COMPOSE_BUDGET_EXHAUSTED provider=${provider} — refused`
    );
    return { admitted: false, tier, skipped: [], reason: "COMPOSE_BUDGET_EXHAUSTED" };
  }

  const verdict = tierMayRun(provider, ladder.attempted, new Set(ladder.declined.keys()));
  if (!verdict.ok) {
    ladder.refusals.push({ provider, tier, skipped: verdict.skipped });
    console.log(
      `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `TIER_OUT_OF_ORDER provider=${provider} tier=${tierNumber(tier)}:${tier} ` +
        `skipped=${verdict.skipped.map((t) => `${tierNumber(t)}:${t}`).join(",")}`
    );
    return { admitted: false, tier, skipped: verdict.skipped, reason: "TIER_OUT_OF_ORDER" };
  }
  noteTierAttempted(tier, provider);
  return { admitted: true };
}

/**
 * May a candidate ALREADY FOUND by a scene-level pool be adopted for this beat?
 *
 * The funnel and the pool find their candidates one scope up, so by the time a beat picks one
 * there is no provider search left for the gate to refuse — the network call happened for the
 * scene. This is the same question asked at the other end of that: the beat is about to spend this
 * candidate's tier, so the ladder gets its say before the download starts.
 *
 * Deliberately NOT a second rule. It calls `admitProviderForTier`, so a change to the ladder can
 * never apply to searches and miss adoptions.
 */
export function admitPoolCandidateTier(source: string): TierAdmission {
  return admitProviderForTier(source);
}

/* ═══════════════════════ the end-of-beat line ═══════════════════════ */

/**
 * One line per beat, in ladder order, so a render log can be read for what a beat actually tried.
 *
 * `attempted`, `declined` and `refused` are three different things and are printed as three
 * different things: a tier nobody asked for reads as neither attempted nor declined, which is
 * exactly the state §6 says must remain visible.
 */
export function formatLadder(ladder: BeatSourcingLadder): string {
  const state = SOURCING_TIERS.map((tier) => {
    const n = tierNumber(tier);
    if (ladder.attempted.has(tier)) return `${n}=ATTEMPTED`;
    const reason = ladder.declined.get(tier);
    if (reason) return `${n}=DECLINED(${reason})`;
    return `${n}=NOT_REACHED`;
  }).join(" ");
  const refused =
    ladder.refusals.length > 0
      ? ` outOfOrder=${ladder.refusals.length} e.g. ${ladder.refusals[0].provider}`
      : "";
  const unknown = ladder.unknown.length > 0 ? ` unknown=${ladder.unknown.join(",")}` : "";
  const where = ladder.kind === "scene" ? `s${ladder.sceneIndex} discovery` : `s${ladder.sceneIndex}b${ladder.beatIndex}`;
  return (
    `[CentralSourcing] render=${ladder.renderId} ${where} ` +
    `ladder ${state} providers=${ladder.admitted.length}${refused}${unknown}`
  );
}
