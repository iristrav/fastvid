/**
 * RONDE 652 — A CANCELLED RENDER GIVES ITS LOCK AND ITS SLOT BACK WITHIN A MINUTE.
 *
 * Render 607, first attempt: cancelled at 17:47:17 (`Video generation cancelled` on every step
 * still running), last log line 17:47:47, then nothing. No `RenderLock … RELEASED`, although the
 * release sits in a `finally`: the pipeline's promise never settled, because cancelling is
 * cooperative and one await was waiting on something that never came back. The lock stayed held
 * until its lease ran out (40 min) and the second attempt started at 18:17; the worker's slot
 * stayed taken until the queue's 3-hour watchdog.
 *
 * This is the part that does not depend on the pipeline's cooperation. Once a cancel has been
 * requested, the render has a grace period to stop by itself — which it almost always does, at
 * its next checkpoint. If it has not, the render is ABANDONED: its caller gets a rejection, so
 * the `finally` that releases the lock runs and the queue frees the slot; its child processes
 * are killed; and the abandoned run is marked so every later checkpoint in it throws, even
 * after the video's own cancel flag has been cleared for the next attempt.
 *
 * Nothing here decides that a render should be cancelled. It only acts on a cancel that
 * something else already requested.
 */

export const RENDER_CANCEL_GRACE_MS_DEFAULT = 60_000;
const RENDER_CANCEL_GRACE_MS_MIN = 5_000;
const RENDER_CANCEL_GRACE_MS_MAX = 10 * 60_000;
const POLL_MS_DEFAULT = 2_000;

/** How long a cancelled render may take to stop by itself. `RENDER_CANCEL_GRACE_MS`, bounded. */
export function renderCancelGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RENDER_CANCEL_GRACE_MS?.trim();
  if (!raw) return RENDER_CANCEL_GRACE_MS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return RENDER_CANCEL_GRACE_MS_DEFAULT;
  return Math.min(RENDER_CANCEL_GRACE_MS_MAX, Math.max(RENDER_CANCEL_GRACE_MS_MIN, n));
}

export const RENDER_ABANDONED_MESSAGE = "Video generation cancelled — render abandoned";

export type AbandonWatch = {
  /** Rejects once the render is abandoned; never settles otherwise. Race the render against it. */
  readonly abandoned: Promise<never>;
  /** Stop watching. Call in the render's `finally`. */
  stop(): void;
};

export function watchForAbandonedRender(params: {
  videoId: number;
  /** True once a cancel has been requested for this render. */
  isCancelled: () => boolean;
  graceMs: number;
  /** Kill what can be killed and mark the run. Called once, before `abandoned` rejects. */
  onAbandon: (reason: string) => void;
  pollMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): AbandonWatch {
  const now = params.now ?? Date.now;
  const log = params.log ?? ((line: string) => console.warn(line));
  let reject!: (err: Error) => void;
  const abandoned = new Promise<never>((_, r) => {
    reject = r;
  });
  /** A watch stopped before it fired never rejects; one that fired after its race settled must not surface. */
  abandoned.catch(() => {});

  let cancelSeenAt: number | null = null;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    if (cancelSeenAt == null) {
      if (!params.isCancelled()) return;
      cancelSeenAt = now();
      log(
        `[RenderCancel] video=${params.videoId} cancel seen — the render has ` +
          `${Math.round(params.graceMs / 1000)}s to stop by itself before its lock and slot are released`
      );
      return;
    }
    const waited = now() - cancelSeenAt;
    if (waited < params.graceMs) return;
    done = true;
    clearInterval(timer);
    const reason =
      `cancelled ${Math.round(waited / 1000)}s ago and still running — ` +
      `abandoned so its render lock and worker slot are released`;
    try {
      params.onAbandon(reason);
    } catch (err) {
      log(`[RenderCancel] video=${params.videoId} abandon cleanup failed: ${(err as Error).message}`);
    }
    reject(new Error(`${RENDER_ABANDONED_MESSAGE}: ${reason}`));
  }, params.pollMs ?? POLL_MS_DEFAULT);
  timer.unref?.();

  return {
    abandoned,
    stop() {
      done = true;
      clearInterval(timer);
    },
  };
}
