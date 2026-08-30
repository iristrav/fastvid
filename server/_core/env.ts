// ENV uses getters so that environment variables are read at call-time, not at
// module-initialisation time. This is critical in production (Cloud Run / Docker)
// where platform-injected secrets (BUILT_IN_FORGE_API_KEY, etc.) may not be
// present in the process environment until after the module graph is first loaded.
//
// Railway deployment: BUILT_IN_FORGE_API_KEY is not available on Railway, so "forge" never
// actually resolves there — Gemini / Groq / OpenAI are the real providers in production.
//
// Note: GitHub Models (a previously-supported free provider here) was permanently retired by
// GitHub on 2026-07-30 — it's not coming back, don't re-add it without checking that first.
export type LlmProvider = "forge" | "gemini" | "groq" | "openai" | "none";

/** Read a Google AI Studio (Gemini) key — GEMINI_API_KEY or GOOGLE_API_KEY. Genuinely free up
 *  to Google's daily/per-minute quota (no billing account required for an AI Studio key). */
export function geminiKeyFromEnv(): string {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
}

/** Read Groq key — GROQ_API_KEY, GROQ_KEY, any *GROQ* env var, or gsk_* in LLM_API_KEY. */
export function groqKeyFromEnv(): string {
  const direct =
    process.env.GROQ_API_KEY?.trim() ||
    process.env.GROQ_KEY?.trim() ||
    "";
  if (direct) return direct;

  for (const [name, value] of Object.entries(process.env)) {
    if (!/groq/i.test(name)) continue;
    const v = value?.trim() ?? "";
    if (v.startsWith("gsk_")) return v;
  }

  const llm = process.env.LLM_API_KEY?.trim() ?? "";
  if (llm.startsWith("gsk_")) return llm;
  return "";
}

/** A dedicated OPENAI_API_KEY (matches voiceBeatAlignment.ts's convention), or LLM_API_KEY
 *  when it holds an OpenAI key (sk-) rather than Groq (gsk_). */
export function openAiKeyFromEnv(): string {
  const dedicated = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (dedicated) return dedicated;
  const llm = process.env.LLM_API_KEY?.trim() ?? "";
  if (!llm || llm.startsWith("gsk_")) return "";
  return llm;
}

/** Which LLM backend to use (Forge > Gemini > Groq > OpenAI unless LLM_PROVIDER is set). */
export function resolveLlmProvider(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "gemini" && geminiKeyFromEnv()) return "gemini";
  if (forced === "groq" && groqKeyFromEnv()) return "groq";
  if (forced === "openai" && openAiKeyFromEnv()) return "openai";
  if (forced === "forge" && process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  if (process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  // Gemini first by default: a genuinely free (no billing account needed) Google AI Studio key.
  // Groq next: also free, no billing account, much bigger daily quota. Falls through to OpenAI
  // once both free daily quotas are hit. Override with LLM_PROVIDER=openai (or =groq) if ever
  // preferred instead.
  if (geminiKeyFromEnv()) return "gemini";
  if (groqKeyFromEnv()) return "groq";
  if (openAiKeyFromEnv()) return "openai";
  return "none";
}

export function llmApiKeyForProvider(provider: LlmProvider): string {
  switch (provider) {
    case "forge":
      return process.env.BUILT_IN_FORGE_API_KEY?.trim() ?? "";
    case "gemini":
      return geminiKeyFromEnv();
    case "groq":
      return groqKeyFromEnv();
    case "openai":
      return openAiKeyFromEnv();
    default:
      return "";
  }
}

/* ═══════════════════════ Stripe secret key ═══════════════════════ */

/**
 * What is wrong with the value in STRIPE_SECRET_KEY, if anything.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * Creating a discount code in the admin panel failed with Stripe's own error:
 *
 *     Invalid API Key provided: price_...
 *
 * Stripe echoes back the key it was handed, so that message says exactly what happened: the value
 * in STRIPE_SECRET_KEY was a Stripe PRICE ID, not a secret key. Nothing in FastVid maps a price
 * onto the key — `getStripe()` in routers.ts and stripeWebhook.ts both read STRIPE_SECRET_KEY and
 * nothing else, and FastVid does not use a stored price ID anywhere (checkout builds an inline
 * `price_data`). The wrong value was pasted into the variable.
 *
 * The code could not have told anyone that. It checked only that the variable was non-empty, so a
 * price ID passed the check, went to Stripe, and came back as an error about an API key — pointing
 * the reader at Stripe's configuration rather than at the one environment variable at fault.
 *
 * Naming the shape is the whole fix on this side: a `price_…` value can only ever be a paste error,
 * and saying so beats forwarding it and relaying the confusion.
 */
export type StripeKeyProblem =
  | "MISSING"
  | "PRICE_ID"
  | "PRODUCT_ID"
  | "PUBLISHABLE_KEY"
  | "WEBHOOK_SECRET"
  | "NOT_A_SECRET_KEY";

/**
 * Safe for a log line: the identifying prefix and the length, never the body.
 *
 * A Stripe key's prefix is what tells you which kind of value it is and which mode it belongs to,
 * and it is not the secret — the random tail is. So the prefix is exactly what a diagnostic needs
 * and exactly what is safe to print.
 */
export function redactStripeKey(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "(empty)";
  const underscore = value.indexOf("_", value.startsWith("sk_") || value.startsWith("rk_") ? 3 : 0);
  const prefix = underscore > 0 ? value.slice(0, underscore + 1) : value.slice(0, 3);
  return `${prefix}…(${value.length} chars)`;
}

/** null means the value is usable as a Stripe secret key. */
export function stripeKeyProblem(raw: string | undefined): StripeKeyProblem | null {
  const value = raw?.trim() ?? "";
  if (!value) return "MISSING";
  // `sk_` is a secret key; `rk_` is a restricted key, which Stripe recommends for exactly this
  // kind of server-side use and which authenticates the same way. Both are accepted.
  if (value.startsWith("sk_") || value.startsWith("rk_")) return null;
  if (value.startsWith("price_")) return "PRICE_ID";
  if (value.startsWith("prod_")) return "PRODUCT_ID";
  if (value.startsWith("pk_")) return "PUBLISHABLE_KEY";
  if (value.startsWith("whsec_")) return "WEBHOOK_SECRET";
  return "NOT_A_SECRET_KEY";
}

/** A sentence an operator can act on, naming the variable and never the secret. */
export function describeStripeKeyProblem(problem: StripeKeyProblem, raw?: string): string {
  const seen = `Got ${redactStripeKey(raw)}.`;
  switch (problem) {
    case "MISSING":
      return "STRIPE_SECRET_KEY is not set. Add the secret key (sk_live_… or sk_test_…) from " +
        "Stripe → Developers → API keys.";
    case "PRICE_ID":
      return `STRIPE_SECRET_KEY holds a Stripe PRICE ID, not an API key. ${seen} A price_… value ` +
        "belongs to a price, never to authentication — put the secret key (sk_live_… or " +
        "sk_test_…) from Stripe → Developers → API keys in STRIPE_SECRET_KEY.";
    case "PRODUCT_ID":
      return `STRIPE_SECRET_KEY holds a Stripe PRODUCT ID, not an API key. ${seen} Use the secret ` +
        "key (sk_live_… or sk_test_…) from Stripe → Developers → API keys.";
    case "PUBLISHABLE_KEY":
      return `STRIPE_SECRET_KEY holds Stripe's PUBLISHABLE key, not the secret key. ${seen} The ` +
        "publishable key is the browser-side one; the server needs the sk_… key beside it.";
    case "WEBHOOK_SECRET":
      return `STRIPE_SECRET_KEY holds the webhook signing secret. ${seen} That value belongs in ` +
        "STRIPE_WEBHOOK_SECRET; STRIPE_SECRET_KEY needs the sk_… API key.";
    case "NOT_A_SECRET_KEY":
      return `STRIPE_SECRET_KEY is not a Stripe secret key. ${seen} It must start with sk_ (or ` +
        "rk_ for a restricted key).";
  }
}

/** "live", "test", or null when the value is not a usable key at all. */
export function stripeKeyMode(raw: string | undefined): "live" | "test" | null {
  const value = raw?.trim() ?? "";
  if (stripeKeyProblem(value)) return null;
  if (value.startsWith("sk_live_") || value.startsWith("rk_live_")) return "live";
  if (value.startsWith("sk_test_") || value.startsWith("rk_test_")) return "test";
  return null;
}

/** The configured Stripe secret key, trimmed. Empty when unset — validation is the caller's. */
export function stripeSecretKeyFromEnv(): string {
  return process.env.STRIPE_SECRET_KEY?.trim() ?? "";
}

export const ENV = {
  get appId() { return process.env.VITE_APP_ID ?? ""; },
  get cookieSecret() { return process.env.JWT_SECRET ?? ""; },
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get oAuthServerUrl() { return process.env.OAUTH_SERVER_URL ?? ""; },
  get ownerOpenId() { return process.env.OWNER_OPEN_ID ?? ""; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  // Base URL for Manus's built-in platform services (image generation, voice transcription,
  // maps, notifications, data API) — unrelated to which LLM chat provider is active below.
  get forgeApiUrl() { return process.env.BUILT_IN_FORGE_API_URL ?? ""; },
  get groqApiKey() { return groqKeyFromEnv(); },
  /** Active LLM backend — Forge (Manus, dormant on Railway) > Gemini > Groq > OpenAI. */
  get llmProvider(): LlmProvider {
    return resolveLlmProvider();
  },
  /** Bearer token for the active LLM provider (legacy name: forgeApiKey). */
  get forgeApiKey() {
    return llmApiKeyForProvider(this.llmProvider);
  },
  get useForge() { return this.llmProvider === "forge"; },
  get useGemini() { return this.llmProvider === "gemini"; },
  get useGroq() { return this.llmProvider === "groq"; },
  /** True when using OpenAI directly (no Forge / Gemini / Groq key). */
  get useOpenAI() { return this.llmProvider === "openai"; },
  get resendApiKey() { return process.env.RESEND_API_KEY ?? ""; },
  get serpApiKey() { return process.env.SERPAPI_KEY ?? ""; },
  get youtubeApiKey() { return process.env.YOUTUBE_API_KEY ?? ""; },
  // AI Provider keys (Phase 2 — High Quality Video)
  get runwayApiKey() { return process.env.RUNWAY_API_KEY ?? ""; },
  get klingApiKey() { return process.env.KLING_API_KEY ?? ""; },
  get klingApiSecret() { return process.env.KLING_API_SECRET ?? ""; },
  get elevenLabsApiKey() { return process.env.ELEVENLABS_API_KEY ?? ""; },
  get lumaApiKey() { return process.env.LUMA_API_KEY ?? ""; },
  get leonardoApiKey() { return process.env.LEONARDO_API_KEY ?? ""; },
  get pikaApiKey() { return process.env.PIKA_API_KEY ?? ""; },
  get pixabayApiKey() { return process.env.PIXABAY_API_KEY ?? ""; },
};
