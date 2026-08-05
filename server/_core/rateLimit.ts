/**
 * In-memory sliding-window rate limiter for the unauthenticated auth
 * endpoints (login/register/forgotPassword/resetPassword/validateResetToken),
 * which previously had no throttling at all — enabling unthrottled
 * credential stuffing and reset-token guessing. Deliberately simple
 * (per-process Map, not Redis-backed): abuse prevention for a handful of
 * public procedures doesn't need cross-instance coordination to be
 * effective, and this has zero new infra dependency.
 */
type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 10;

export function checkRateLimit(key: string, maxRequests = DEFAULT_MAX_PER_WINDOW, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= maxRequests;
}

// Periodic sweep so long-lived processes don't accumulate stale IP buckets forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS * 2) buckets.delete(key);
  }
}, WINDOW_MS).unref();
