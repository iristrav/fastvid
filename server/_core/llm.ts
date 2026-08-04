import { ENV, githubModelsKeyFromEnv, llmApiKeyForProvider, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  /** Override the primary provider for this call (falls back normally if unavailable). */
  preferProvider?: LlmProvider;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

type NormalizedMessage = {
  role: Role;
  name?: string;
  tool_call_id?: string;
  content: string | Array<TextContent | ImageContent | FileContent>;
};

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message): NormalizedMessage => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

function messagesIncludeImages(messages: Message[]): boolean {
  for (const message of messages) {
    for (const part of ensureArray(message.content)) {
      if (typeof part !== "string" && part.type === "image_url") return true;
    }
  }
  return false;
}

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const resolveApiUrl = (provider: LlmProvider) => {
  if (provider === "github") return "https://models.github.ai/inference/chat/completions";
  if (provider === "openai") return "https://api.openai.com/v1/chat/completions";
  return ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";
};

function resolveModel(provider: LlmProvider): string {
  if (provider === "github") {
    // gpt-4o-mini by default: GitHub's "mini" tier gets a noticeably bigger daily quota
    // (~150/day) than the full gpt-4o tier (~50/day) — override with GITHUB_MODELS_MODEL
    // (e.g. "openai/gpt-4o") if quality matters more than headroom for a given deployment.
    return process.env.GITHUB_MODELS_MODEL?.trim() || "openai/gpt-4o-mini";
  }
  if (provider === "openai") {
    return process.env.LLM_MODEL?.trim() || "gpt-4o";
  }
  return process.env.FORGE_LLM_MODEL?.trim() || "gemini-2.5-flash";
}

/** GitHub Models daily quota hit (small: ~50-150/day) — skip retries and prefer the next
 *  provider for a cooldown period rather than repeatedly wasting a request confirming it. */
let githubCooldownUntilMs = 0;
export function isGithubInCooldown(): boolean {
  return Date.now() < githubCooldownUntilMs;
}

function isGithubDailyQuotaError(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("rate limit") || lower.includes("quota") || lower.includes("daily");
}

function markGithubCooldown(errorText: string): void {
  const waitSec = parseRetryAfterSeconds(errorText);
  const cooldownMs =
    waitSec != null && waitSec > 0
      ? waitSec * 1000
      : isGithubDailyQuotaError(errorText)
        ? 60 * 60 * 1000
        : 5 * 60 * 1000;
  githubCooldownUntilMs = Math.max(githubCooldownUntilMs, Date.now() + cooldownMs);
}

/** OpenAI quota exhausted — skip for remainder of process lifetime. */
let openAiQuotaExhausted = false;

function parseRetryAfterSeconds(body: string): number | null {
  const minSec = body.match(/try again in (\d+)m(\d+(?:\.\d+)?)s/i);
  if (minSec) {
    const sec = parseInt(minSec[1]!, 10) * 60 + parseFloat(minSec[2]!);
    if (!isNaN(sec) && sec > 0) return Math.ceil(sec);
  }
  const secOnly = body.match(/try again in (\d+(?:\.\d+)?)\s*s/i);
  if (secOnly) {
    const sec = parseFloat(secOnly[1]!);
    if (!isNaN(sec) && sec > 0) return Math.ceil(sec + 0.5);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(status: number): boolean {
  return status === 429;
}

function isOpenAiQuotaError(status: number, body: string): boolean {
  if (status !== 429 && status !== 402) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("insufficient_quota") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("billing")
  );
}

function markOpenAiQuotaExhausted(body: string): void {
  if (isOpenAiQuotaError(429, body) || isOpenAiQuotaError(402, body)) {
    openAiQuotaExhausted = true;
    console.warn("[LLM] OpenAI quota exhausted — skipping OpenAI for remainder of process lifetime.");
  }
}

function shouldFallbackToNextProvider(status: number, body: string): boolean {
  if (isRateLimitError(status)) return true;
  if (isOpenAiQuotaError(status, body)) return true;
  if (status === 404) return true; // model not found → try next provider
  return status >= 500 && status < 600;
}

function providersToTry(primary: LlmProvider): LlmProvider[] {
  const out: LlmProvider[] = [];
  const githubAvailable = Boolean(githubModelsKeyFromEnv()) && !isGithubInCooldown();
  const openAiAvailable = Boolean(openAiKeyFromEnv()) && !openAiQuotaExhausted;

  const push = (p: LlmProvider) => {
    if (p === "none" || out.includes(p)) return;
    if (p === "github" && !githubAvailable) return;
    if (p === "openai" && !openAiAvailable) return;
    if (!llmApiKeyForProvider(p)) return;
    out.push(p);
  };

  if (primary === "github" && !githubAvailable) {
    push("openai");
  } else if (primary !== "none") {
    push(primary);
  }

  if (githubAvailable) push("github");
  if (openAiAvailable) push("openai");
  return out;
}

const assertApiKey = () => {
  if (!ENV.forgeApiKey && !githubModelsKeyFromEnv() && !openAiKeyFromEnv()) {
    throw new Error(
      "LLM API key is not configured. Set GITHUB_MODELS_TOKEN (free, any GitHub account) or " +
      "LLM_API_KEY (OpenAI) on Railway."
    );
  }
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();
  const { isLlmBudgetExceeded, llmDailyBudgetUsd } = await import("./llmBudget");
  if (await isLlmBudgetExceeded()) {
    throw new Error(
      `LLM daily spend budget ($${llmDailyBudgetUsd()}) reached — refusing further calls until the ` +
      `UTC day rolls over. Override with LLM_DAILY_BUDGET_USD, or set LLM_BUDGET_ENFORCE=false to disable.`
    );
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    preferProvider,
  } = params;

  const hasVision = messagesIncludeImages(messages);
  const primary = preferProvider ?? resolveLlmProvider();
  let chain = providersToTry(primary);
  // GitHub Models' vision support is unconfirmed on the free tier, so excluded defensively —
  // add back once confirmed working.
  if (hasVision) chain = chain.filter((p) => p !== "github");
  if (chain.length === 0) {
    // All providers blocked (cooldown / quota). A cooldown is a soft rate-limit guard, not a
    // hard failure — retry ignoring it rather than give up entirely.
    if (!hasVision && githubModelsKeyFromEnv()) {
      console.warn("[LLM] All providers in cooldown/exhausted — retrying GitHub Models ignoring cooldown.");
      githubCooldownUntilMs = 0; // reset cooldown so this request can proceed
      chain = ["github"];
    } else {
      throw new Error(
        "LLM API key is not configured. Set GITHUB_MODELS_TOKEN on Railway (free), or LLM_API_KEY (OpenAI)."
      );
    }
  }

  let lastError: Error | null = null;
  const maxTokens = params.maxTokens ?? params.max_tokens;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const apiKey = llmApiKeyForProvider(provider);
    if (!apiKey) continue;

    // Anthropic uses a completely different API format
    const normalizedMessages = messages.map(normalizeMessage);

    const payload: Record<string, unknown> = {
      model: resolveModel(provider),
      messages: normalizedMessages,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    const normalizedToolChoice = normalizeToolChoice(
      toolChoice || tool_choice,
      tools
    );
    if (normalizedToolChoice) {
      payload.tool_choice = normalizedToolChoice;
    }

    if (provider === "forge") {
      payload.thinking = { budget_tokens: 128 };
      payload.max_tokens = maxTokens ?? 32768;
    } else {
      payload.max_tokens = maxTokens ?? 8192;
    }

    const normalizedResponseFormat = normalizeResponseFormat({
      responseFormat,
      response_format,
      outputSchema,
      output_schema,
    });

    if (normalizedResponseFormat) {
      payload.response_format = normalizedResponseFormat;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(resolveApiUrl(provider), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        if (i > 0 || attempt > 0) {
          console.log(
            `[LLM] Succeeded via ${provider}${attempt > 0 ? ` (after ${attempt} rate-limit retries)` : ""}` +
              (i > 0 ? ` after ${chain[0]} failure` : "")
          );
        }
        const result = (await response.json()) as InvokeResult;
        if (result.usage) {
          const { recordLlmUsage } = await import("./llmBudget");
          recordLlmUsage(String(payload.model), result.usage.prompt_tokens, result.usage.completion_tokens);
        }
        return result;
      }

      const errorText = await response.text();
      lastError = new Error(
        `LLM invoke failed (${provider}, model=${payload.model}): ${response.status} ${response.statusText} – ${errorText}`
      );

      if (provider === "github" && isRateLimitError(response.status)) {
        markGithubCooldown(errorText);
      }
      if (provider === "openai") {
        markOpenAiQuotaExhausted(errorText);
      }

      const retryAfterSec = parseRetryAfterSeconds(errorText);
      const skipProviderRetries =
        provider === "github" &&
        (isGithubDailyQuotaError(errorText) || (retryAfterSec != null && retryAfterSec > 120));

      if (
        isRateLimitError(response.status) &&
        !skipProviderRetries &&
        attempt < 3 &&
        retryAfterSec != null &&
        retryAfterSec <= 120
      ) {
        const waitSec = Math.min(90, retryAfterSec);
        console.warn(
          `[LLM] ${provider} rate limit (attempt ${attempt + 1}/4) — retry in ${waitSec}s`
        );
        await sleep(waitSec * 1000);
        continue;
      }

      if (shouldFallbackToNextProvider(response.status, errorText) && i + 1 < chain.length) {
        console.warn(
          `[LLM] ${provider} failed (${response.status})` +
            (skipProviderRetries ? " [daily/long quota — no retry]" : "") +
            ` — falling back to ${chain[i + 1]}`
        );
        break;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(
    githubModelsKeyFromEnv() && !openAiKeyFromEnv() && isGithubInCooldown()
      ? "LLM invoke failed: GitHub Models daily quota exhausted — set LLM_API_KEY (OpenAI sk-...) for fallback"
      : "LLM invoke failed: no provider available"
  );
}
