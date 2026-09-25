/**
 * RONDE 653 — WHAT A WORKER GIVES BACK WHEN IT IS STOPPED MID-RENDER.
 *
 * Railway stops the old worker on every deploy with SIGTERM and, unless a draining time is
 * configured, SIGKILL straight after (the default draining time is 0 seconds). The worker's 25 s
 * drain therefore never ran: a render in flight died with its render lock held for the full
 * 40-minute lease and its video left in `generating` until the stall sweep re-queued it.
 *
 * With a draining time configured (`railway.worker.json`), the worker now has seconds, not
 * zero. Renders still running when the drain window closes cannot finish in that time — they take
 * minutes — so each is handed back: re-queued at once (the generation attempt bumped, so the dying
 * run writes nothing), and its render lock released, holder-scoped, so the next worker can start
 * the video immediately.
 *
 * The registry is how the shutdown path knows which locks this process holds. The pipeline adds a
 * render when it takes the lock and removes it in the same `finally` that releases it.
 */

const active = new Map<number, string>();

export function registerActiveRender(videoId: number, productionRenderId: string): void {
  active.set(videoId, productionRenderId);
}

export function unregisterActiveRender(videoId: number, productionRenderId: string): void {
  if (active.get(videoId) === productionRenderId) active.delete(videoId);
}

export function activeRenders(): Array<{ videoId: number; productionRenderId: string }> {
  return [...active].map(([videoId, productionRenderId]) => ({ videoId, productionRenderId }));
}

export type InterruptedRenderDeps = {
  requeue: (videoId: number, reason: string) => Promise<"requeued" | "failed" | "skipped">;
  releaseLock: (videoId: number, productionRenderId: string) => Promise<boolean>;
  log?: (line: string) => void;
};

/** Hand every render this process still holds back to the queue. Never throws. */
export async function handBackInterruptedRenders(
  reason: string,
  deps: InterruptedRenderDeps,
  renders = activeRenders()
): Promise<Array<{ videoId: number; requeue: string; lockReleased: boolean }>> {
  const log = deps.log ?? ((l: string) => console.warn(l));
  const results: Array<{ videoId: number; requeue: string; lockReleased: boolean }> = [];
  for (const r of renders) {
    /** Re-queue before releasing: a lock freed first could let another worker start a video whose row still says `generating`. */
    const requeue = await deps.requeue(r.videoId, reason).catch((err: Error) => `error: ${err.message?.slice(0, 80)}`);
    const lockReleased = await deps.releaseLock(r.videoId, r.productionRenderId).catch(() => false);
    unregisterActiveRender(r.videoId, r.productionRenderId);
    log(
      `[Shutdown] video=${r.videoId} render=${r.productionRenderId} handed back — ` +
        `requeue=${requeue} lockReleased=${lockReleased} (${reason})`
    );
    results.push({ videoId: r.videoId, requeue: String(requeue), lockReleased });
  }
  return results;
}
