/**
 * RONDE 97 §3 — PREPARE AN ASSET ONCE.
 *
 * ── The measurement this exists for ─────────────────────────────────────────────────────────
 *
 * Render 568 paid for archive asset ww2:57364 thirty-eight times and used it once. RONDE 88A
 * fixed one half of that — the SEARCH kept re-picking an asset the render had already refused,
 * because `adoptClip` wrote one of the two used-asset registers and not the other. This is the
 * other half: even with the search fixed, several routes can legitimately want the SAME asset for
 * the same beat within one render — the funnel, a rescue rung, a scene-level recovery — and every
 * one of them paid for its own download and its own ffmpeg pass.
 *
 * ── Why a key rather than "have we seen this asset" ─────────────────────────────────────────
 *
 * Because the same asset prepared for a 3-second slot and for an 8-second slot are two different
 * files, and returning one for the other would be a silent substitution — the failure class this
 * codebase has spent ten rounds removing. The key is (asset identity + what the preparation is
 * asked to produce). Same key means the same file, so reuse is exact rather than approximate;
 * different key means a real second preparation, and it happens.
 *
 * ── Why it is scoped to the work directory ─────────────────────────────────────────────────
 *
 * A render owns its work directory, so keying on it gives exactly render lifetime with no new
 * plumbing: `prepareCuratedArchiveClip` already receives `workDir` and does not receive the
 * render's dedup state. Two concurrent renders cannot see each other's prepared files, which is
 * the same isolation rule every other render-scoped ledger in this codebase follows — and the
 * files themselves live under that directory, so a cache entry can never outlive the file it
 * names.
 */
import * as fs from "fs";

export type PreparationCounters = {
  requested: number;
  started: number;
  succeeded: number;
  reused: number;
  skippedDuplicate: number;
  failed: number;
};

type Entry = {
  /** Resolved path of a finished preparation, or null while one is in flight. */
  path: string | null;
  /** The in-flight preparation, so a concurrent caller waits rather than starting a second. */
  inFlight: Promise<string> | null;
};

type Scope = {
  entries: Map<string, Entry>;
  counters: PreparationCounters;
};

const scopes = new Map<string, Scope>();

function scopeFor(workDir: string): Scope {
  const key = (workDir ?? "").trim() || "__no_workdir__";
  const existing = scopes.get(key);
  if (existing) return existing;
  const fresh: Scope = {
    entries: new Map(),
    counters: { requested: 0, started: 0, succeeded: 0, reused: 0, skippedDuplicate: 0, failed: 0 },
  };
  scopes.set(key, fresh);
  return fresh;
}

/**
 * THE KEY. Deterministic, and deliberately made of only what changes the OUTPUT FILE.
 *
 * `assetIdentity` is the canonical identity the rest of the pipeline already uses — a provider
 * asset id or a content key, never a URL, because RONDE 96 established that two URLs can name one
 * asset and one URL can name a preview of it.
 *
 * `holdSec` is rounded to a tenth: a preparation asked for 3.0000001s and one asked for 3.0s
 * produce the same file, and treating them as different keys would reintroduce the duplication
 * this module removes through the back door of floating-point noise.
 *
 * `variant` carries anything else that changes the bytes — a still-image pan direction, a
 * fair-use transform, a segment offset. A caller that transforms differently MUST pass a
 * different variant, and the doc on `runPreparation` says why omitting it would be a silent
 * substitution rather than a saving.
 */
export function preparationKey(input: {
  assetIdentity: string | number;
  holdSec: number;
  variant?: string;
}): string {
  const id = String(input.assetIdentity ?? "").trim() || "unknown";
  const hold = Number.isFinite(input.holdSec) ? Math.round(input.holdSec * 10) / 10 : 0;
  const variant = (input.variant ?? "").trim();
  return variant ? `${id}|${hold}|${variant}` : `${id}|${hold}`;
}

export type PreparationOutcome =
  | { status: "PREPARED"; path: string }
  | { status: "REUSED"; path: string }
  | { status: "FAILED"; error: Error };

/**
 * Run a preparation, or hand back the one this render already made for the same key.
 *
 * Three states, and the middle one is the reason this is not a plain Map:
 *
 *   · a finished preparation whose file still exists → REUSE, no work at all;
 *   · a preparation already IN FLIGHT → await it, so two routes racing for one asset produce one
 *     download rather than two. Render 568's thirty-eight preparations were mostly this case;
 *   · nothing → prepare, and record what happened.
 *
 * A cached path whose file has since vanished is treated as a miss rather than returned. Work
 * directories are swept, renders are killed and restarted, and returning a path to a file that is
 * no longer there would turn a saving into a crash further down.
 *
 * A failure is NOT cached. A refusal that depends on the asset is already remembered by the
 * caller's own memo (the source-floor memo, the used-asset registers); a failure that depends on
 * the network is not the asset's fault and must not become permanent for the render.
 */
export async function runPreparation(
  workDir: string,
  key: string,
  prepare: () => Promise<string>
): Promise<PreparationOutcome> {
  const scope = scopeFor(workDir);
  scope.counters.requested += 1;

  const existing = scope.entries.get(key);
  if (existing?.path && fs.existsSync(existing.path)) {
    scope.counters.reused += 1;
    return { status: "REUSED", path: existing.path };
  }
  if (existing?.inFlight) {
    scope.counters.skippedDuplicate += 1;
    try {
      return { status: "REUSED", path: await existing.inFlight };
    } catch (err) {
      return { status: "FAILED", error: err as Error };
    }
  }

  const entry: Entry = { path: null, inFlight: null };
  scope.entries.set(key, entry);
  scope.counters.started += 1;
  const run = prepare();
  entry.inFlight = run;
  try {
    const path = await run;
    entry.path = path;
    entry.inFlight = null;
    scope.counters.succeeded += 1;
    return { status: "PREPARED", path };
  } catch (err) {
    /** Not cached — see the note above on why a failure must not become permanent. */
    scope.entries.delete(key);
    scope.counters.failed += 1;
    return { status: "FAILED", error: err as Error };
  }
}

export function preparationCounters(workDir: string): PreparationCounters {
  return { ...scopeFor(workDir).counters };
}

/** Test-only, and used by the render's own cleanup so a work directory's entries do not leak. */
export function resetPreparationScope(workDir: string): void {
  scopes.delete((workDir ?? "").trim() || "__no_workdir__");
}

/**
 * What this render spent on preparation, and what it saved.
 *
 * `reused + skippedDuplicate` is the line render 568 needed: thirty-eight requests for one asset
 * would have printed `requested=38 started=1 reused=37`, which names the problem in one number
 * instead of leaving it to be counted by hand out of a log.
 */
export function formatPreparationCache(workDir: string): string[] {
  const c = preparationCounters(workDir);
  if (c.requested === 0) return [];
  const saved = c.reused + c.skippedDuplicate;
  const lines = [
    `[Preparation] requested=${c.requested} started=${c.started} succeeded=${c.succeeded} ` +
      `reused=${c.reused} skippedDuplicate=${c.skippedDuplicate} failed=${c.failed}`,
  ];
  if (saved > 0) {
    lines.push(
      `[Preparation] ${saved} preparation(s) avoided — the same asset was asked for more than once ` +
        `for the same slot`
    );
  }
  /**
   * More work started than requested is impossible, and a render that manages it has a counter
   * bug rather than a performance problem. Reported as a finding rather than left to be noticed.
   */
  if (c.started > c.requested) {
    lines.push(`[PreparationInvariant] STARTED_EXCEEDS_REQUESTED started=${c.started} requested=${c.requested}`);
  }
  if (c.succeeded + c.failed > c.started) {
    lines.push(
      `[PreparationInvariant] OUTCOMES_EXCEED_STARTS succeeded=${c.succeeded} failed=${c.failed} started=${c.started}`
    );
  }
  return lines;
}
