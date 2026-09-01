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
  /**
   * RONDE 174 — how close the gate came to firing, when it can say.
   *
   * `asked`/`fired` proved a gate was alive, and then could say nothing more. Render 530 measured
   * `modern_mismatch=0/54`; RONDE 51 recalibrated its thresholds against ten hand-read numbers and
   * wrote down "the per-candidate log line makes the next render measure it". The next render
   * measured `0/74` — and the per-candidate line only prints when the gate fires or would have
   * fired under the old rule, so a gate that comes nowhere near stays completely dark.
   *
   * So every round after a silent gate has had to guess whether the threshold is a hair too high
   * or the material simply is not what the gate looks for. This is the smallest shortfall any
   * candidate left on the table, in the gate's own units: 0.002 means the threshold is nearly
   * right, 0.08 means the evidence is not there at all. Null when the gate has no numeric
   * threshold to be short of.
   */
  closestShortfall: number | null;
  /**
   * How often the gate looked and had no applicable rule.
   *
   * A keyword gate carries rules for particular subjects — `documentary_beat_gate`'s blocklists
   * are about pharmacies, Columbus Ohio and a Dutch/US region lock. On a WWII documentary not one
   * of them can match, so 20 asks and 0 rejections is the gate being out of scope, not broken.
   * Counting that separately is the difference between a finding and a false alarm.
   */
  notArmed: number;
};

export type GateFiringStats = Map<string, GateCounter>;

export type GateFiringRow = {
  gate: string;
  asked: number;
  fired: number;
  closestShortfall: number | null;
  notArmed: number;
};

/** What a gate can say about a verdict beyond yes or no. */
export type GateEvidence = {
  /**
   * How far short of firing this candidate was, in the gate's own units. 0 or less means it
   * fired. Omit when the gate has no numeric threshold.
   */
  shortfall?: number;
  /** False when the gate had no applicable rule for this candidate. Defaults to true. */
  armed?: boolean;
};

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
export function recordGateVerdict(gate: string, fired: boolean, evidence?: GateEvidence): void {
  const stats = gateStatsStorage.getStore();
  if (!stats) return;
  let counter = stats.get(gate);
  if (!counter) {
    counter = { asked: 0, fired: 0, closestShortfall: null, notArmed: 0 };
    stats.set(gate, counter);
  }
  counter.asked++;
  if (fired) counter.fired++;
  if (evidence?.armed === false) counter.notArmed++;
  const shortfall = evidence?.shortfall;
  if (shortfall != null && Number.isFinite(shortfall)) {
    counter.closestShortfall =
      counter.closestShortfall == null ? shortfall : Math.min(counter.closestShortfall, shortfall);
  }
}

/** All gates, busiest first. */
export function summarizeGateFiring(stats: GateFiringStats): GateFiringRow[] {
  return [...stats.entries()]
    .map(([gate, c]) => ({
      gate,
      asked: c.asked,
      fired: c.fired,
      // Defaulted rather than read straight through. A counter built without these fields — an
      // older shape, a hand-made one in a test — would otherwise make `asked - notArmed` NaN, and
      // `NaN >= minAsked` is false, so the silent-gate detector would quietly report nothing at
      // all. A detector must never fail towards silence; that is the exact failure it exists for.
      closestShortfall: c.closestShortfall ?? null,
      notArmed: c.notArmed ?? 0,
    }))
    .sort((a, b) => b.asked - a.asked || a.gate.localeCompare(b.gate));
}

/**
 * How many candidates a gate must have judged before "it never fired" means anything. Below
 * this, silence is just a small sample: a gate asked twice and rejecting neither is normal.
 * 20 is roughly one render's worth of candidates for a single gate.
 */
export const SILENT_GATE_MIN_ASKED = 20;

/**
 * RONDE 105 — gates that are SUPPOSED to be silent.
 *
 * This detector looks for the RONDE 26 shape: asked constantly, never once said no. That is the
 * signature of a veto that cannot fire. It is also, exactly, the signature of a veto that was
 * deliberately taken away — and RONDE 103/104 took two away on purpose:
 *
 *   · `vision_gate`        CLIP's content verdicts are measurably inverted on archive material
 *                          (RONDE 58: a white-lives-matter sticker scored 0.2226 against a signed
 *                          photograph of Hitler at 0.2116 on the same beat), so it ranks and no
 *                          longer refuses.
 *   · `off_topic_protest`  reads a provider title or a filename, not the frame. In front of a
 *                          model that looks at the picture it can only take material away.
 *   · `off_topic_visual`   RONDE 114. Same reasoning, same shape, missed twice: it refuses a
 *                          candidate whose provider TITLE shares no token with the beat, and it
 *                          sat directly in front of the decider at both of its call sites. Real
 *                          archive titles share nothing constantly — "Bundesarchiv Bild
 *                          183-S33882" is the catalogue form of the German federal archive's
 *                          Hitler photographs.
 *
 * Both still record a verdict, because how often they WOULD have fired is worth knowing. Alarming
 * on them would tell a reader to "verify the check can still fire" about two checks designed not
 * to — a false alarm that trains people to ignore the real ones.
 *
 * `baked_text` is deliberately NOT on this list. It reads the pixels and it may still refuse, so
 * a silent baked_text is a genuine finding.
 */
export const INTENTIONALLY_NON_FIRING_GATES: ReadonlySet<string> = new Set([
  "vision_gate",
  "off_topic_protest",
  "off_topic_visual",
]);

/**
 * Gates that were asked plenty and never once said no — the shape of the RONDE 26 bug.
 *
 * Gates listed in INTENTIONALLY_NON_FIRING_GATES are excluded: they are demoted by design, and
 * reporting a design decision as a suspected defect is noise.
 */
export function findSilentGates(
  stats: GateFiringStats,
  minAsked: number = SILENT_GATE_MIN_ASKED
): GateFiringRow[] {
  return summarizeGateFiring(stats).filter(
    (r) =>
      // RONDE 174: a candidate the gate had no rule for was never really a question. Counting it
      // toward "asked plenty and never said no" is how a gate that is simply out of scope for
      // this video's subject gets reported as a suspected defect — every render, forever.
      r.asked - r.notArmed >= minAsked &&
      r.fired === 0 &&
      !INTENTIONALLY_NON_FIRING_GATES.has(r.gate)
  );
}

/**
 * RONDE 174 — what a silent gate can now say for itself.
 *
 *     modern_mismatch (74×, closest 0.021 short of firing)
 *     baked_text (31×)
 *
 * The number is the whole point. "Verify the check can still fire" is an instruction to go and
 * read code; "0.021 short" is a measurement that says whether the threshold or the material is
 * the reason — and it is the same unit the threshold is written in, so the next round can move it
 * on evidence instead of on ten numbers read by hand out of one log.
 */
export function describeSilentGate(row: GateFiringRow): string {
  const parts = [`${row.gate} (${row.asked}×`];
  if (row.notArmed > 0) parts.push(`, ${row.notArmed}× no applicable rule`);
  if (row.closestShortfall != null) {
    parts.push(
      row.closestShortfall <= 0
        ? ", cleared its threshold but did not fire"
        : `, closest ${row.closestShortfall.toFixed(3)} short of firing`
    );
  }
  return `${parts.join("")})`;
}

/**
 * Gates that looked but had no rule to apply, reported as information rather than as an alarm.
 *
 * A WWII documentary never touches `documentary_beat_gate`'s pharmacy, Columbus-Ohio or
 * Dutch/US-region rules. That is the gate being out of scope, and saying so is more useful than
 * saying nothing — an operator who sees 20 asks and no rejections deserves to know which.
 */
export function findOutOfScopeGates(
  stats: GateFiringStats,
  minAsked: number = SILENT_GATE_MIN_ASKED
): GateFiringRow[] {
  return summarizeGateFiring(stats).filter(
    (r) =>
      r.fired === 0 &&
      r.notArmed > 0 &&
      r.asked >= minAsked &&
      r.asked - r.notArmed < minAsked &&
      !INTENTIONALLY_NON_FIRING_GATES.has(r.gate)
  );
}

/** The demoted gates and how often they would have fired. Reported as information, never as an alarm. */
export function summarizeDemotedGates(stats: GateFiringStats): GateFiringRow[] {
  return summarizeGateFiring(stats).filter((r) => INTENTIONALLY_NON_FIRING_GATES.has(r.gate));
}

/** `baked_text=3/64 vision_gate=12/58 modern_mismatch=0/41` — fired/asked per gate. */
export function formatGateFiringSummary(stats: GateFiringStats): string {
  const rows = summarizeGateFiring(stats);
  if (rows.length === 0) return "no gates recorded";
  return rows.map((r) => `${r.gate}=${r.fired}/${r.asked}`).join(" ");
}
