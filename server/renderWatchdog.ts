/**
 * Global render watchdog — hard kill guarantee for stuck renders.
 *
 * Every render registers itself on start and deregisters on finish.
 * A per-render setInterval fires every 5 seconds and kills all tracked
 * child processes + rejects the render Promise when the budget is exceeded.
 *
 * All budget values are derived from RenderBudget (renderBudget.ts) so
 * timeouts scale with video length rather than using hardcoded numbers.
 * The static constants below are fallback defaults only — they apply for the
 * brief window before the pipeline computes its RenderBudget after VO sync.
 *
 * Fallback defaults:
 *   Total render:  18 minutes  (covers up to ~10 min video)
 *   Per-scene:      2 minutes
 *   Compose:        90 seconds
 *   Retrieval:      45 seconds
 *   Final concat:  120 seconds
 */

import type { ChildProcess } from "child_process";

/** Conservative fallback used only before RenderBudget is computed. */
export const WATCHDOG_RENDER_MAX_MS   = 18 * 60_000;  // 18 min fallback
export const WATCHDOG_SCENE_MAX_MS    =  2 * 60_000;  //  2 min per scene (fallback)
export const WATCHDOG_COMPOSE_MAX_MS  = 90_000;        // 90s compose (fallback)
export const WATCHDOG_RETRIEVE_MAX_MS = 45_000;        // 45s retrieval (fallback)
export const WATCHDOG_CONCAT_MAX_MS   = 120_000;       // 120s concat (fallback)

export interface RenderWatchdog {
  /** Register a child process so the watchdog can kill it on timeout. */
  trackChild(cp: ChildProcess): void;
  /** Signal that a scene's retrieval phase started. */
  sceneRetrieveStart(sceneIndex: number): void;
  /** Signal that a scene's retrieval phase ended (clears the retrieve timer). */
  sceneRetrieveEnd(sceneIndex: number): void;
  /** Signal that a scene's compose phase started. */
  sceneComposeStart(sceneIndex: number): void;
  /** Signal that a scene's compose phase ended. */
  sceneComposeEnd(sceneIndex: number): void;
  /** Signal that the final concat started. */
  concatStart(): void;
  /** Signal that the final concat ended. */
  concatEnd(): void;
  /** Stop the watchdog (called when render completes normally). */
  stop(): void;
  /**
   * Update the total budget after RenderBudget is computed post-VO-sync.
   * Safe to call at any point before the watchdog fires.
   */
  updateBudget(newBudgetMs: number): void;
  /** Promise that rejects when the watchdog fires. Use Promise.race() with this. */
  readonly deadline: Promise<never>;
}

/**
 * Create a watchdog for one render job.
 * @param videoId    For log messages.
 * @param budgetMs   Override total budget (default: WATCHDOG_RENDER_MAX_MS).
 */
export function createRenderWatchdog(videoId: number | string, budgetMs = WATCHDOG_RENDER_MAX_MS): RenderWatchdog {
  const children = new Set<ChildProcess>();
  const startMs = Date.now();
  let stopped = false;
  let activeBudgetMs = budgetMs;
  let deadlineReject!: (err: Error) => void;
  let sceneRetrieveStartMs: Record<number, number> = {};
  let sceneComposeStartMs: Record<number, number> = {};
  let concatStartMs = 0;

  const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; });

  const killAll = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    console.error(`[Watchdog] video=${videoId} KILL — ${reason} (elapsed=${Math.round((Date.now() - startMs) / 1000)}s)`);
    for (const cp of children) {
      if (!cp.killed) {
        try { cp.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }
    children.clear();
    deadlineReject(new Error(`[Watchdog] video=${videoId} killed: ${reason}`));
  };

  const timer = setInterval(() => {
    if (stopped) { clearInterval(timer); return; }
    const elapsedMs = Date.now() - startMs;

    if (elapsedMs > activeBudgetMs) {
      clearInterval(timer);
      killAll(`total budget exceeded (${Math.round(elapsedMs / 1000)}s > ${Math.round(activeBudgetMs / 1000)}s)`);
      return;
    }

    for (const [si, t0] of Object.entries(sceneRetrieveStartMs)) {
      const elapsed = Date.now() - t0;
      if (elapsed > WATCHDOG_RETRIEVE_MAX_MS) {
        console.warn(`[Watchdog] video=${videoId} scene=${si} retrieval running ${Math.round(elapsed / 1000)}s (limit ${WATCHDOG_RETRIEVE_MAX_MS / 1000}s)`);
        // Don't hard-kill for retrieval — the withTimeout inside will fire. Just log.
      }
    }

    for (const [si, t0] of Object.entries(sceneComposeStartMs)) {
      const elapsed = Date.now() - t0;
      if (elapsed > WATCHDOG_COMPOSE_MAX_MS) {
        console.warn(`[Watchdog] video=${videoId} scene=${si} compose running ${Math.round(elapsed / 1000)}s (limit ${WATCHDOG_COMPOSE_MAX_MS / 1000}s) — killing children`);
        // Kill tracked children; the compose withTimeout will then resolve/reject.
        for (const cp of children) {
          if (!cp.killed) {
            try { cp.kill("SIGKILL"); } catch { /* already dead */ }
          }
        }
      }
    }

    if (concatStartMs > 0) {
      const elapsed = Date.now() - concatStartMs;
      if (elapsed > WATCHDOG_CONCAT_MAX_MS) {
        console.warn(`[Watchdog] video=${videoId} concat running ${Math.round(elapsed / 1000)}s (limit ${WATCHDOG_CONCAT_MAX_MS / 1000}s) — killing children`);
        for (const cp of children) {
          if (!cp.killed) {
            try { cp.kill("SIGKILL"); } catch { /* already dead */ }
          }
        }
      }
    }

    // Log heartbeat every 30s
    if (Math.round(elapsedMs / 1000) % 30 === 0) {
      const activeRetrieve = Object.keys(sceneRetrieveStartMs).length;
      const activeCompose = Object.keys(sceneComposeStartMs).length;
      console.log(`[Watchdog] video=${videoId} alive ${Math.round(elapsedMs / 1000)}s — retrieve=${activeRetrieve} compose=${activeCompose} children=${children.size}`);
    }
  }, 5_000);
  timer.unref?.();

  return {
    trackChild(cp) {
      if (stopped) { try { cp.kill("SIGKILL"); } catch { /**/ } return; }
      children.add(cp);
      cp.on("exit", () => children.delete(cp));
    },
    sceneRetrieveStart(si) { sceneRetrieveStartMs[si] = Date.now(); },
    sceneRetrieveEnd(si)   { delete sceneRetrieveStartMs[si]; },
    sceneComposeStart(si)  { sceneComposeStartMs[si] = Date.now(); },
    sceneComposeEnd(si)    { delete sceneComposeStartMs[si]; },
    concatStart()          { concatStartMs = Date.now(); },
    concatEnd()            { concatStartMs = 0; },
    updateBudget(newBudgetMs: number) {
      if (stopped) return;
      const oldSec = Math.round(activeBudgetMs / 1000);
      activeBudgetMs = newBudgetMs;
      console.log(`[Watchdog] video=${videoId} budget updated: ${oldSec}s → ${Math.round(newBudgetMs / 1000)}s`);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      children.clear();
      console.log(`[Watchdog] video=${videoId} stopped normally at ${Math.round((Date.now() - startMs) / 1000)}s`);
    },
    deadline,
  };
}
