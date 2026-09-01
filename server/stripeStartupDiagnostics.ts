/**
 * Fastvid — Stripe configuration check, run once at startup.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Creating a discount code in the admin panel failed with Stripe's own message:
 *
 *     Invalid API Key provided: price_...
 *
 * The value in STRIPE_SECRET_KEY was a Stripe price ID. Nothing in FastVid maps a price onto the
 * key — both `getStripe()` factories read STRIPE_SECRET_KEY and nothing else, and FastVid stores no
 * price ID at all (checkout builds an inline `price_data`). The value was simply the wrong one.
 *
 * It stayed invisible until somebody used the panel because nothing ever looked at the SHAPE of the
 * key, only at whether the variable was non-empty. A boot-time line makes the same mistake visible
 * before a person hits it, in the same place every other key already reports itself.
 *
 * ── What it does not do ──────────────────────────────────────────────────────────────────────
 *
 * It does not stop the process. Stripe is optional for FastVid — `.env.example` files it under
 * "not required for video quality" — and a render pipeline that refuses to boot over a billing
 * variable would turn a discount-code bug into an outage. It reports; the request-time guards in
 * routers.ts and stripeWebhook.ts are what refuse the call.
 *
 * It never prints the key. `redactStripeKey` keeps the prefix, which identifies the KIND of value
 * and is what a diagnosis needs, and drops the random tail, which is the part that is secret.
 */
import {
  ENV,
  describeStripeKeyProblem,
  redactStripeKey,
  stripeKeyMode,
  stripeKeyProblem,
  stripeSecretKeyFromEnv,
} from "./_core/env";

export type StripeDiagnostic = {
  ok: boolean;
  line: string;
  /** true when the line describes a real misconfiguration rather than an absent integration. */
  isError: boolean;
};

/**
 * The startup line, as a value, so it can be asserted on without capturing console output.
 *
 * `isProduction` is a parameter rather than a read of NODE_ENV so the live/test mix check is
 * testable both ways.
 */
export function stripeDiagnostic(
  rawKey = stripeSecretKeyFromEnv(),
  isProduction = ENV.isProduction
): StripeDiagnostic {
  const problem = stripeKeyProblem(rawKey);

  if (problem === "MISSING") {
    return {
      ok: false,
      isError: false,
      line: "[Fastvid] STRIPE_SECRET_KEY: ✗ NOT SET — billing and discount codes disabled",
    };
  }

  if (problem) {
    return {
      ok: false,
      isError: true,
      line: `[Fastvid] STRIPE_SECRET_KEY: ✗ INVALID — ${describeStripeKeyProblem(problem, rawKey)}`,
    };
  }

  const mode = stripeKeyMode(rawKey);

  /**
   * Test and live keys mixed up. Both directions are worth a word and only one is dangerous: a
   * test key in production means real customers cannot pay, a live key outside production means a
   * test click charges a real card.
   */
  if (isProduction && mode === "test") {
    return {
      ok: false,
      isError: true,
      line: `[Fastvid] STRIPE_SECRET_KEY: ⚠ TEST key in production (${redactStripeKey(rawKey)}) — ` +
        "real payments and real discount codes will not work; use the sk_live_… key",
    };
  }
  if (!isProduction && mode === "live") {
    return {
      ok: false,
      isError: true,
      line: `[Fastvid] STRIPE_SECRET_KEY: ⚠ LIVE key outside production (${redactStripeKey(rawKey)}) — ` +
        "anything done here charges real cards; use the sk_test_… key",
    };
  }

  return {
    ok: true,
    isError: false,
    line: `[Fastvid] STRIPE_SECRET_KEY: ✓ set (${mode ?? "unknown"} mode, ${redactStripeKey(rawKey)})`,
  };
}

/** Print it. Errors go to console.error so they survive a log level that hides info lines. */
export function logStripeStartupDiagnostics(): void {
  const diag = stripeDiagnostic();
  if (diag.isError) console.error(diag.line);
  else console.log(diag.line);
}
