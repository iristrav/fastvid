import { groqKeyFromEnv, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./_core/env";

export type LlmDiagnostics = {
  role: "web" | "worker";
  provider: LlmProvider;
  groqConfigured: boolean;
  openAiConfigured: boolean;
  groqEnvVarNames: string[];
  railway: boolean;
  workerMode: boolean;
  hint: string;
};

function groqEnvVarNames(): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!/groq/i.test(name)) continue;
    if ((value?.trim() ?? "").length > 0) names.push(name);
  }
  if (
    (process.env.LLM_API_KEY?.trim() ?? "").startsWith("gsk_") &&
    !names.includes("LLM_API_KEY")
  ) {
    names.push("LLM_API_KEY (gsk_)");
  }
  return names;
}

export function getLlmDiagnostics(role: "web" | "worker"): LlmDiagnostics {
  const provider = resolveLlmProvider();
  const groqConfigured = Boolean(groqKeyFromEnv());
  const openAiConfigured = Boolean(openAiKeyFromEnv());
  const railway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const workerMode = process.env.WORKER_MODE === "true";

  let hint = "LLM ready.";
  if (provider === "groq") {
    hint = `Using Groq (${process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile"}).`;
  } else if (provider === "openai") {
    hint = railway
      ? "Using OpenAI on Railway — set GROQ_API_KEY on every service (web + worker) to avoid quota errors."
      : "Using OpenAI (gpt-4o).";
  } else if (provider === "none") {
    hint = railway
      ? "No LLM key — add GROQ_API_KEY to this Railway service (Variables → Redeploy)."
      : "No LLM key configured.";
  }

  if (role === "web" && railway && !workerMode) {
    hint += " Video jobs run on the worker service — GROQ_API_KEY must be set there too.";
  }

  return {
    role,
    provider,
    groqConfigured,
    openAiConfigured,
    groqEnvVarNames: groqEnvVarNames(),
    railway,
    workerMode,
    hint,
  };
}

export function logLlmStartupDiagnostics(role: "web" | "worker"): LlmDiagnostics {
  const d = getLlmDiagnostics(role);
  const vars =
    d.groqEnvVarNames.length > 0 ? d.groqEnvVarNames.join(", ") : "none";
  console.log(
    `[Fastvid] LLM (${role}): provider=${d.provider}, groq=${d.groqConfigured}, ` +
      `openai=${d.openAiConfigured}, groqVars=[${vars}]`
  );
  if (d.provider === "openai" && d.railway) {
    console.warn(`[Fastvid] ⚠ ${d.hint}`);
  } else if (d.provider === "groq") {
    console.log(`[Fastvid] ✓ ${d.hint}`);
  } else if (d.provider === "none") {
    console.error(`[Fastvid] ✗ ${d.hint}`);
  }
  return d;
}

/** Fail fast on Railway when only exhausted OpenAI is available. */
export function assertProductionLlmReady(): void {
  const railway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  if (!railway) return;

  if (groqKeyFromEnv()) return;
  if (resolveLlmProvider() === "forge") return;

  if (process.env.ALLOW_OPENAI_ON_RAILWAY === "true" && openAiKeyFromEnv()) return;

  const service = process.env.RAILWAY_SERVICE_NAME ?? "this service";
  throw new Error(
    `LLM not configured on Railway (${service}): add GROQ_API_KEY and redeploy. ` +
      `Video generation runs on the worker — set the same variable on web AND worker services. ` +
      `OpenAI (LLM_API_KEY) is skipped on Railway unless ALLOW_OPENAI_ON_RAILWAY=true.`
  );
}
