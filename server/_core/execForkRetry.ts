/**
 * Shared fork-pressure retry helper for ffmpeg/ffprobe child-process calls.
 *
 * Under heavy concurrent ffmpeg load, spawns can transiently fail with EAGAIN/"Cannot
 * fork" (at the OS process-table level), or ffmpeg's own filter graph can report
 * "Resource temporarily unavailable" internally (visible only in stderr). Both are
 * transient resource-pressure conditions, not real input/encode problems.
 */
export function isForkPressureError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EAGAIN") return true;
  const msg = `${(err as Error)?.message || ""} ${(err as { stderr?: string })?.stderr || ""}`;
  if (/resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg)) return true;
  // libx264's threaded encoder fails to spin up its worker pthreads under the same OS
  // process/thread pressure, but ffmpeg only surfaces this as a generic init error —
  // not EAGAIN — so it slips past the checks above and used to fail the clip outright
  // instead of retrying once the pressure eases.
  if (/error initializing output stream/i.test(msg) && /error while opening encoder/i.test(msg)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wrap any async child-process call with fork-pressure retries (default 3 attempts). */
export async function withForkRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let retriesLeft = retries;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (retriesLeft > 0 && isForkPressureError(err)) {
        retriesLeft--;
        await sleep(1500 * (retries - retriesLeft));
        continue;
      }
      throw err;
    }
  }
}
