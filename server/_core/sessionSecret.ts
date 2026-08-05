/**
 * Shared JWT session-signing secret, used by every place that signs or
 * verifies a Fastvid session cookie (tRPC context, password-reset sign-in,
 * the raw Express download/stream routes).
 *
 * Previously each call site fell back independently to the literal string
 * "fallback-secret-change-in-production" whenever JWT_SECRET was unset. If
 * that ever shipped to production, the fallback — visible in this public
 * source file — becomes the live signing key, letting anyone forge a valid
 * session cookie for any account. In production we now refuse to sign or
 * verify anything with that fallback; outside production it's kept so local
 * dev works without a .env file.
 */
const FALLBACK_DEV_SECRET = "fallback-secret-change-in-production";

export function getSessionSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (secret) return new TextEncoder().encode(secret);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[Fastvid] JWT_SECRET is not set. Refusing to sign/verify sessions with a hardcoded fallback secret in production."
    );
  }
  return new TextEncoder().encode(FALLBACK_DEV_SECRET);
}
