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
  // Prefer Manus Forge key; fall back to OPENAI_API_KEY for Railway deployments
  get forgeApiKey() { return process.env.BUILT_IN_FORGE_API_KEY || process.env.OPENAI_API_KEY || ""; },
  // True when running on Railway (no Manus Forge key available)
  get useOpenAI() { return !process.env.BUILT_IN_FORGE_API_KEY && !!process.env.OPENAI_API_KEY; },
};
