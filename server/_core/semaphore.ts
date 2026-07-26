/**
 * Semaphore — limits concurrent access to a shared resource.
 *
 * Global FFmpeg semaphore: caps concurrent ffmpeg/ffprobe child processes across the whole
 * server, regardless of which subsystem spawns them (compose, montage, beat-fetch, CLIP
 * vision, ...) — each has its own local parallelism setting, but nothing previously stopped
 * their sum from bursting past what the container can actually fork at once.
 * Per-user render lock: max 1 active video render per user account.
 */

export class Semaphore {
  private _available: number;
  private _max: number;
  private _queue: Array<() => void> = [];

  constructor(max: number) {
    this._max = max;
    this._available = max;
  }

  acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._available++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get waiting(): number {
    return this._queue.length;
  }

  get active(): number {
    return this._max - this._available;
  }
}

// Was 16, then 6 — Railway logs kept showing sustained "spawn /bin/sh EAGAIN" (the OS itself
// refusing to fork) across every subsystem at once — color fallback, archive clip extraction,
// CLIP vision, ffprobe — even at 6 concurrent children (1392 EAGAIN in under 7 minutes on video
// 460, with 5 scenes exhausting their entire hardened color-fallback retry budget and still
// failing). Likely Railway's per-container pids.max ceiling (~1000 processes, independent of
// the 24 vCPU/24GB plan allocation — each ffmpeg call costs 2 processes: the /bin/sh wrapper +
// the binary itself), not a memory/CPU shortage — a Railway support request to raise it is
// pending. Lowered further as a stopgap: trades more per-scene speed for actually finishing.
// Raise again once the platform-side limit is confirmed fixed. Tune via FFMPEG_CONCURRENCY_LIMIT.
export const ffmpegSemaphore = new Semaphore(
  parseInt(process.env.FFMPEG_CONCURRENCY_LIMIT ?? "3", 10)
);

/**
 * Per-user render lock. Each user can only have 1 active video render at a time.
 * A second render request waits until the first finishes.
 */
const userRenderLocks = new Map<string | number, Semaphore>();

export function getUserRenderSemaphore(userId: string | number): Semaphore {
  let sem = userRenderLocks.get(userId);
  if (!sem) {
    sem = new Semaphore(1);
    userRenderLocks.set(userId, sem);
  }
  return sem;
}
