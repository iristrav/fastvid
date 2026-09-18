/**
 * THE LADDER, ENFORCED AT RUNTIME.
 *
 * ── What the previous round left ────────────────────────────────────────────────────────────
 *
 * `sourcingTiers.ts` wrote the policy down: four tiers, every provider placed, and `tierMayRun`
 * as the rule. What it could not do was make the pipeline obey it. The order still lived in about
 * thirty beat-resolution functions calling providers across 94 sites, each with its own copy.
 *
 * ── Where the enforcement goes, and why there ───────────────────────────────────────────────
 *
 * Not in the thirty functions. Collapsing those into one caller is a rewrite this round is told
 * not to do, and thirty places each remembering a rule is thirty places that can forget it — the
 * exact lesson RONDE 260 learnt about YouTube.
 *
 * It goes where every provider search ALREADY passes. The forensic audit found that FastVid has
 * one gate for this: sixteen external providers reach the network through `searchGateDecision`,
 * thirteen via `cachedProviderSearch` and three via `admitProviderQuery`. A rule asked there is
 * asked of every route at once, including routes written next year.
 *
 *     beat
 *       ↓
 *     runCentralVisualSourcing        ← opens the ladder for this beat
 *       ↓
 *     existing beat resolution         ← unchanged; still decides WHAT to search for
 *       ↓
 *     searchGateDecision               ← asks this module whether that tier may run
 *       ↓
 *     provider
 *
 * So the strategies keep their query intelligence and lose their say over tier order. That is the
 * split the round asks for: strategy is not the same thing as a sourcing route.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────────────────────
 *
 * It searches nothing, downloads nothing, ranks nothing and adopts nothing. It holds one fact per
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

export type BeatSourcingLadder = {
  renderId: string;
  sceneIndex: number;
  beatIndex: number;
  /** Tiers a provider search has actually been admitted for. */
  attempted: Set<SourcingTier>;
  /** Tiers the caller has decided are unavailable, with the reason it decided that. */
  declined: Map<SourcingTier, string>;
  /** Every refusal this ladder handed out, for the end-of-beat line. */
  refusals: Array<{ provider: string; tier: SourcingTier; skipped: SourcingTier[] }>;
  /** Providers admitted, in order, so a render log reads as a ladder rather than a set. */
  admitted: Array<{ provider: string; tier: SourcingTier }>;
};

const ladderStore = new AsyncLocalStorage<BeatSourcingLadder>();

/** The beat currently being sourced, or undefined outside `runCentralVisualSourcing`. */
export function currentBeatLadder(): BeatSourcingLadder | undefined {
  return ladderStore.getStore();
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
};

/**
 * Open the ladder for one beat and run the existing beat resolution inside it.
 *
 * The production entry point for visual sourcing. Everything a beat does to find a picture happens
 * inside this scope, which is what makes the tier order enforceable without rewriting the routes
 * that do the finding.
 */
export async function runCentralVisualSourcing<T>(
  params: CentralVisualSourcingParams,
  run: () => Promise<T>
): Promise<T> {
  const ladder: BeatSourcingLadder = {
    renderId: params.renderId,
    sceneIndex: params.sceneIndex,
    beatIndex: params.beatIndex,
    attempted: new Set(),
    declined: new Map((params.declined ?? []).map((d) => [d.tier, d.reason])),
    refusals: [],
    admitted: [],
  };
  try {
    return await ladderStore.run(ladder, run);
  } finally {
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

/* ═══════════════════════ the question the gate asks ═══════════════════════ */

export type TierAdmission =
  | { admitted: true }
  | { admitted: false; tier: SourcingTier; skipped: SourcingTier[] };

/**
 * May this provider be searched for the beat currently being sourced?
 *
 * Called from `searchGateDecision`, which every external provider passes. Outside a beat ladder —
 * the scene pool, a warm-up, a test — the answer is always yes: this enforces an ORDER within a
 * beat, and there is no order to enforce where there is no beat.
 *
 * Admission is recorded as an attempt, so the ladder is built by the searches that actually
 * happen rather than by anyone remembering to announce them.
 */
export function admitProviderForTier(provider: string): TierAdmission {
  const ladder = ladderStore.getStore();
  if (!ladder) return { admitted: true };

  const tier = providerTier(provider);
  if (!tier) return { admitted: true };

  const verdict = tierMayRun(provider, ladder.attempted, new Set(ladder.declined.keys()));
  if (!verdict.ok) {
    ladder.refusals.push({ provider, tier, skipped: verdict.skipped });
    console.log(
      `[CentralSourcing] s${ladder.sceneIndex}b${ladder.beatIndex} ` +
        `TIER_OUT_OF_ORDER provider=${provider} tier=${tierNumber(tier)}:${tier} ` +
        `skipped=${verdict.skipped.map((t) => `${tierNumber(t)}:${t}`).join(",")}`
    );
    return { admitted: false, tier, skipped: verdict.skipped };
  }
  noteTierAttempted(tier, provider);
  return { admitted: true };
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
  return (
    `[CentralSourcing] render=${ladder.renderId} s${ladder.sceneIndex}b${ladder.beatIndex} ` +
    `ladder ${state} providers=${ladder.admitted.length}${refused}`
  );
}
