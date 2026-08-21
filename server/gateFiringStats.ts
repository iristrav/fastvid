/**
 * Per-gate firing counters — RONDE 29.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * The worst pipeline bug of the RONDE 25-27 stretch was the modern-content-mismatch gate: it was
 * called 152 times across three renders, it logged on every call, and its feature flag was on.
 * It simply could never return true — the evidence rule needed two frames to agree and the live
 * path only ever supplied one. A veto that cannot fire is not a conservative veto, it is an
 * absent one, and the video shipped modern office footage in a WWII documentary because of it.
 *
 * The three lenses used to audit dead code all missed it, by construction:
 *   call-graph analysis   finds code nobody calls          — this WAS called
 *   log comparison        finds subsystems that stay quiet — this DID log
 *   feature-flag review   finds what is switched off       — this WAS switched on
 *
 * What separates a healthy gate from that one is not whether it runs, but whether it ever says
 * no. So that is what gets counted here: per gate, how often it was ASKED and how often it
 * FIRED. A gate asked hundreds of times that has never once rejected anything is reported at the
 * end of the render. It may be legitimately clean material — the counter is a prompt to look,
 * not a verdict — but a broken gate can no longer hide behind a healthy-looking log.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────────────────────────
 *
 * Counters only. Nothing here changes a decision, and every function is a no-op outside a
 * render, so ingestion jobs, admin routes and unit tests are unaffected by construction.
 *
 * Storage is an AsyncLocalStorage of its own rather than a field on RenderCtx: gates live in
 * modules (localClipVision, archiveClipFilter) that must not import videoPipeline, and a bare
 * module-level counter would silently merge two concurrent renders on the same worker — the
 * exact bug class that moved elevenLabsQuotaExhausted into RenderCtx.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type GateCounter = {
  /** How often this gate was given a candidate to judge. */
  asked: number;
  /** How often it said no. */
  fired: number;
};

export type GateFiringStats = Map<string, GateCounter>;

export type GateFiringRow = { gate: string; asked: number; fired: number };

const gateStatsStorage = new AsyncLocalStorage<GateFiringStats>();

export function createGateFiringStats(): GateFiringStats {
  return new Map();
}

/** Runs `fn` with `stats` as the active collector. Nested calls replace, they do not merge. */
export function runWithGateFiringStats<T>(stats: GateFiringStats, fn: () => T): T {
  return gateStatsStorage.run(stats, fn);
}

/** The collector for the render currently on this async stack, or null outside one. */
export function getActiveGateFiringStats(): GateFiringStats | null {
  return gateStatsStorage.getStore() ?? null;
}

/**
 * Records one gate verdict. Silently inert outside a render — a gate helper shared with archive
 * ingestion or exercised by a unit test must not need to know whether a collector is present.
 */
export function recordGateVerdict(gate: string, fired: boolean): void {
  const stats = gateStatsStorage.getStore();
  if (!stats) return;
  let counter = stats.get(gate);
  if (!counter) {
    counter = { asked: 0, fired: 0 };
    stats.set(gate, counter);
  }
  counter.asked++;
  if (fired) counter.fired++;
}

/** All gates, busiest first. */
export function summarizeGateFiring(stats: GateFiringStats): GateFiringRow[] {
  return [...stats.entries()]
    .map(([gate, c]) => ({ gate, asked: c.asked, fired: c.fired }))
    .sort((a, b) => b.asked - a.asked || a.gate.localeCompare(b.gate));
}

/**
 * How many candidates a gate must have judged before "it never fired" means anything. Below
 * this, silence is just a small sample: a gate asked twice and rejecting neither is normal.
 * 20 is roughly one render's worth of candidates for a single gate.
 */
export const SILENT_GATE_MIN_ASKED = 20;

/** Gates that were asked plenty and never once said no — the shape of the RONDE 26 bug. */
export function findSilentGates(
  stats: GateFiringStats,
  minAsked: number = SILENT_GATE_MIN_ASKED
): GateFiringRow[] {
  return summarizeGateFiring(stats).filter((r) => r.asked >= minAsked && r.fired === 0);
}

/** `baked_text=3/64 vision_gate=12/58 modern_mismatch=0/41` — fired/asked per gate. */
export function formatGateFiringSummary(stats: GateFiringStats): string {
  const rows = summarizeGateFiring(stats);
  if (rows.length === 0) return "no gates recorded";
  return rows.map((r) => `${r.gate}=${r.fired}/${r.asked}`).join(" ");
}
