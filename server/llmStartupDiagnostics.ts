import { githubModelsKeyFromEnv, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./_core/env";

export type LlmDiagnostics = {
  role: "web" | "worker";
  provider: LlmProvider;
  githubConfigured: boolean;
  openAiConfigured: boolean;
  railway: boolean;
  workerMode: boolean;
  hint: string;
};

export function getLlmDiagnostics(role: "web" | "worker"): LlmDiagnostics {
  const provider = resolveLlmProvider();
  const githubConfigured = Boolean(githubModelsKeyFromEnv());
  const openAiConfigured = Boolean(openAiKeyFromEnv());
  const railway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const workerMode = process.env.WORKER_MODE === "true";

  let hint = "LLM ready.";
  if (provider === "github") {
    hint = `Using GitHub Models (${process.env.GITHUB_MODELS_MODEL?.trim() || "openai/gpt-4o-mini"}, free tier).`;
  } else if (provider === "openai") {
    hint = `Using OpenAI (${process.env.LLM_MODEL?.trim() || "gpt-4o"}).`;
  } else if (provider === "forge") {
    hint = "Using Manus Forge.";
  } else {
    hint = "No LLM key — set GITHUB_MODELS_TOKEN (free) or LLM_API_KEY (OpenAI) on web and worker services.";
  }

  if (role === "web" && railway && !workerMode) {
    hint += " Video jobs run on the worker — set the same key(s) there too.";
  }

  return {
    role,
    provider,
    githubConfigured,
    openAiConfigured,
    railway,
    workerMode,
    hint,
  };
}

export function logLlmStartupDiagnostics(role: "web" | "worker"): LlmDiagnostics {
  const d = getLlmDiagnostics(role);
  console.log(
    `[Fastvid] LLM (${role}): provider=${d.provider}, github=${d.githubConfigured}, openai=${d.openAiConfigured}`
  );
  if (d.provider === "none") {
    console.error(`[Fastvid] ✗ ${d.hint}`);
  } else {
    console.log(`[Fastvid] ✓ ${d.hint}`);
  }
  return d;
}

/** Ensure some LLM key is configured before script generation. */
export function assertProductionLlmReady(): void {
  if (resolveLlmProvider() !== "none") return;
  const service = process.env.RAILWAY_SERVICE_NAME ?? "this service";
  throw new Error(
    `LLM not configured (${service}): set LLM_API_KEY (OpenAI) on web and worker, then redeploy.`
  );
}
