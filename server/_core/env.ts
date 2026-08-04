// ENV uses getters so that environment variables are read at call-time, not at
// module-initialisation time. This is critical in production (Cloud Run / Docker)
// where platform-injected secrets (BUILT_IN_FORGE_API_KEY, etc.) may not be
// present in the process environment until after the module graph is first loaded.
//
// Railway deployment: BUILT_IN_FORGE_API_KEY is not available on Railway, so "forge" never
// actually resolves there — GitHub Models / OpenAI are the real providers in production.
export type LlmProvider = "forge" | "github" | "openai" | "none";

/** Read a GitHub Models token — GITHUB_MODELS_TOKEN, or GITHUB_TOKEN. Free for every GitHub
 *  account, no billing/credit card involved. Serves real OpenAI models (gpt-4o / gpt-4o-mini)
 *  via GitHub's own Azure-backed inference endpoint. Needs a fine-grained PAT with
 *  "models: read" permission — create one at github.com/settings/personal-access-tokens. Daily
 *  quota is modest (order of 50-150 requests/day depending on model tier). */
export function githubModelsKeyFromEnv(): string {
  return process.env.GITHUB_MODELS_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || "";
}

/** A dedicated OPENAI_API_KEY (matches voiceBeatAlignment.ts's convention), or LLM_API_KEY
 *  when it holds an OpenAI key (sk-...). */
export function openAiKeyFromEnv(): string {
  const dedicated = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (dedicated) return dedicated;
  const llm = process.env.LLM_API_KEY?.trim() ?? "";
  if (!llm) return "";
  return llm;
}

/** Which LLM backend to use (Forge > GitHub Models > OpenAI unless LLM_PROVIDER is set). */
export function resolveLlmProvider(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "github" && githubModelsKeyFromEnv()) return "github";
  if (forced === "openai" && openAiKeyFromEnv()) return "openai";
  if (forced === "forge" && process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  if (process.env.BUILT_IN_FORGE_API_KEY?.trim()) return "forge";
  // GitHub Models first by default: free for every GitHub account, no billing/credit card
  // involved, serves real OpenAI gpt-4o/gpt-4o-mini. Falls through to OpenAI once its daily
  // quota is hit. Override with LLM_PROVIDER=openai if ever preferred instead.
  if (githubModelsKeyFromEnv()) return "github";
  if (openAiKeyFromEnv()) return "openai";
  return "none";
}

export function llmApiKeyForProvider(provider: LlmProvider): string {
  switch (provider) {
    case "forge":
      return process.env.BUILT_IN_FORGE_API_KEY?.trim() ?? "";
    case "github":
      return githubModelsKeyFromEnv();
    case "openai":
      return openAiKeyFromEnv();
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
  // Base URL for Manus's built-in platform services (image generation, voice transcription,
  // maps, notifications, data API) — unrelated to which LLM chat provider is active below.
  get forgeApiUrl() { return process.env.BUILT_IN_FORGE_API_URL ?? ""; },
  /** Active LLM backend — Forge (Manus, dormant on Railway) > GitHub Models > OpenAI. */
  get llmProvider(): LlmProvider {
    return resolveLlmProvider();
  },
  /** Bearer token for the active LLM provider (legacy name: forgeApiKey). */
  get forgeApiKey() {
    return llmApiKeyForProvider(this.llmProvider);
  },
  get useForge() { return this.llmProvider === "forge"; },
  get useGithubModels() { return this.llmProvider === "github"; },
  /** True when using OpenAI directly (no Forge / GitHub Models key). */
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
