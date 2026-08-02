// ENV uses getters so that environment variables are read at call-time, not at
// module-initialisation time. This is critical in production (Cloud Run / Docker)
// where platform-injected secrets (BUILT_IN_FORGE_API_KEY, etc.) may not be
// present in the process environment until after the module graph is first loaded.
//
// Railway deployment: BUILT_IN_FORGE_API_KEY is not available on Railway.
// Railway: use LLM_API_KEY (OpenAI) by default; Groq optional via GROQ_API_KEY or LLM_PROVIDER=groq.
export type LlmProvider = "forge" | "groq" | "openai" | "anthropic" | "none";

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

/** Which LLM backend to use (Forge > Anthropic > Groq > OpenAI unless LLM_PROVIDER is set). */
export function resolveLlmProvider(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "groq" && groqKeyFromEnv()) return "groq";
  if (forced === "openai" && openAiKeyFromEnv()) return "openai";
  if (forced === "anthropic" && anthropicKeyFromEnv()) return "anthropic";
  if (forced === "forge" && process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  if (process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  // OpenAI first by default: Anthropic billing has repeatedly run out mid-render (confirmed
  // live — every fresh process re-discovers this the hard way with one wasted, logged failure
  // before falling back), so trying it first on every process start/restart just burns a call
  // and a warning for nothing. OpenAI stays the primary provider until Anthropic billing is
  // sorted; override with LLM_PROVIDER=anthropic (or =groq) if that changes.
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
