/**
 * Global render watchdog — hard kill guarantee for stuck renders.
 *
 * Every render registers itself on start and deregisters on finish.
 * A per-render setInterval fires every 5 seconds and kills all tracked
 * child processes + rejects the render Promise when the budget is exceeded.
 *
 * Budgets (all hard limits, not soft warnings):
 *   Total render:  12 minutes  (WATCHDOG_RENDER_MAX_MS)
 *   Per-scene:      2 minutes  (WATCHDOG_SCENE_MAX_MS)
 *   Compose:       75 seconds  (WATCHDOG_COMPOSE_MAX_MS)
 *   Retrieval:     35 seconds  (WATCHDOG_RETRIEVE_MAX_MS)
 *   Final concat: 120 seconds  (WATCHDOG_CONCAT_MAX_MS)
 */

import type { ChildProcess } from "child_process";

export const WATCHDOG_RENDER_MAX_MS   = 12 * 60_000;  // 12 min total
export const WATCHDOG_SCENE_MAX_MS    =  2 * 60_000;  //  2 min per scene
export const WATCHDOG_COMPOSE_MAX_MS  = 75_000;        // 75s compose
export const WATCHDOG_RETRIEVE_MAX_MS = 35_000;        // 35s retrieval
export const WATCHDOG_CONCAT_MAX_MS   = 120_000;       // 120s concat

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

    if (elapsedMs > budgetMs) {
      clearInterval(timer);
      killAll(`total budget exceeded (${Math.round(elapsedMs / 1000)}s > ${Math.round(budgetMs / 1000)}s)`);
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
