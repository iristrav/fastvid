// ENV uses getters so that environment variables are read at call-time, not at
// module-initialisation time. This is critical in production (Cloud Run / Docker)
// where platform-injected secrets (BUILT_IN_FORGE_API_KEY, etc.) may not be
// present in the process environment until after the module graph is first loaded.
//
// Railway deployment: BUILT_IN_FORGE_API_KEY is not available on Railway.
// Railway: use LLM_API_KEY (OpenAI) by default; Groq optional via GROQ_API_KEY or LLM_PROVIDER=groq.
export type LlmProvider = "forge" | "gemini" | "cerebras" | "groq" | "openai" | "anthropic" | "none";

/** Read a Google AI Studio (Gemini) key — GEMINI_API_KEY or GOOGLE_API_KEY. Genuinely free up
 *  to Google's daily/per-minute quota (no billing account required for an AI Studio key). */
export function geminiKeyFromEnv(): string {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
}

/** Read a Cerebras key — CEREBRAS_API_KEY. Free tier: 14,400 requests/day, 1M tokens/day, no
 *  credit card required — by far the most generous free daily quota of any provider here
 *  (vs. Gemini's ~250/day and Groq's 1,000/day), on the same custom-silicon-fast inference
 *  Groq is known for. */
export function cerebrasKeyFromEnv(): string {
  return process.env.CEREBRAS_API_KEY?.trim() || "";
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

/** Which LLM backend to use (Forge > Gemini > Cerebras > OpenAI > Anthropic > Groq unless
 *  LLM_PROVIDER is set). */
export function resolveLlmProvider(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "gemini" && geminiKeyFromEnv()) return "gemini";
  if (forced === "cerebras" && cerebrasKeyFromEnv()) return "cerebras";
  if (forced === "groq" && groqKeyFromEnv()) return "groq";
  if (forced === "openai" && openAiKeyFromEnv()) return "openai";
  if (forced === "anthropic" && anthropicKeyFromEnv()) return "anthropic";
  if (forced === "forge" && process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  if (process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  // Gemini first by default: a genuinely free (no billing account needed) Google AI Studio key,
  // good quality for scripts/tags/editorial-review-style text work — the explicit point of
  // adding it was to stop defaulting to paid providers for everyday calls. Cerebras next: also
  // free with no billing account, and a much bigger daily quota (14,400 req/day vs Gemini's
  // ~250/day) — a natural second-tier free option before ever touching a paid provider. Falls
  // through to OpenAI/Anthropic/Groq exactly as before once both free daily quotas are hit.
  // Override with LLM_PROVIDER=openai (or =anthropic, =groq, =cerebras) if ever preferred instead.
  if (geminiKeyFromEnv()) return "gemini";
  if (cerebrasKeyFromEnv()) return "cerebras";
  if (openAiKeyFromEnv()) return "openai";
  if (anthropicKeyFromEnv()) return "anthropic";
  if (groqKeyFromEnv()) return "groq";
  return "none";
}

export function anthropicKeyFromEnv(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() ?? "";
}

export function llmApiKeyForProvider(provider: LlmProvider): string {
  switch (provider) {
    case "forge":
      return process.env.BUILT_IN_FORGE_API_KEY?.trim() ?? "";
    case "gemini":
      return geminiKeyFromEnv();
    case "cerebras":
      return cerebrasKeyFromEnv();
    case "groq":
      return groqKeyFromEnv();
    case "openai":
      return openAiKeyFromEnv();
    case "anthropic":
      return anthropicKeyFromEnv();
    default:
      return "";
  }
}

export const ENV = {
  get appId() { return process.env.VITE_APP_ID ?? ""; },
  get cookieSecret() { return process.env.JWT_SECRET ?? ""; },
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get oAuthServerUrl() { return process.env.OAUTH_SERVER_URL ?? ""; },
  get ownerOpenId() { return process.env.OWNER_OPEN_ID ?? ""; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get forgeApiUrl() { return process.env.BUILT_IN_FORGE_API_URL ?? ""; },
  get groqApiKey() { return groqKeyFromEnv(); },
  /** Active LLM backend — Forge (Manus) > OpenAI > Groq. */
  get llmProvider(): LlmProvider {
    return resolveLlmProvider();
  },
  /** Bearer token for the active LLM provider (legacy name: forgeApiKey). */
  get forgeApiKey() {
    return llmApiKeyForProvider(this.llmProvider);
  },
  get useForge() { return this.llmProvider === "forge"; },
  get useGemini() { return this.llmProvider === "gemini"; },
  get useCerebras() { return this.llmProvider === "cerebras"; },
  get useGroq() { return this.llmProvider === "groq"; },
  /** True when using OpenAI directly (no Forge / Groq key). */
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
