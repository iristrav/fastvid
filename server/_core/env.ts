// ENV uses getters so that environment variables are read at call-time, not at
// module-initialisation time. This is critical in production (Cloud Run / Docker)
// where platform-injected secrets (BUILT_IN_FORGE_API_KEY, etc.) may not be
// present in the process environment until after the module graph is first loaded.
//
// Railway deployment: BUILT_IN_FORGE_API_KEY is not available on Railway.
// Use OPENAI_API_KEY as fallback — the LLM helper will switch to api.openai.com automatically.
export const ENV = {
  get appId() { return process.env.VITE_APP_ID ?? ""; },
  get cookieSecret() { return process.env.JWT_SECRET ?? ""; },
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get oAuthServerUrl() { return process.env.OAUTH_SERVER_URL ?? ""; },
  get ownerOpenId() { return process.env.OWNER_OPEN_ID ?? ""; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get forgeApiUrl() { return process.env.BUILT_IN_FORGE_API_URL ?? ""; },
  // Prefer Manus Forge key; fall back to LLM_API_KEY for Railway deployments.
  // We use LLM_API_KEY (not OPENAI_API_KEY) to avoid Railway Railpack treating it as a build secret.
  get forgeApiKey() { return process.env.BUILT_IN_FORGE_API_KEY || process.env.LLM_API_KEY || ""; },
  get groqApiKey() { return process.env.GROQ_API_KEY ?? ""; },
  // True when running on Railway (no Manus Forge key available)
  get useOpenAI() { return !process.env.BUILT_IN_FORGE_API_KEY && !process.env.GROQ_API_KEY && !!process.env.LLM_API_KEY; },
  get useGroq() { return !process.env.BUILT_IN_FORGE_API_KEY && !!process.env.GROQ_API_KEY; },
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
