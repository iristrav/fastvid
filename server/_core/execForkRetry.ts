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
  return /resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg);
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
