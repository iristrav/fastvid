import { ENV, anthropicKeyFromEnv, groqKeyFromEnv, llmApiKeyForProvider, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./env";

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

function textFromNormalizedContent(content: NormalizedMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Groq vision models reject system + image in the same request — fold system into user. */
function adaptGroqVisionMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const hasImages = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url")
  );
  if (!hasImages) return messages;

  const systems = messages.filter((m) => m.role === "system");
  if (!systems.length) return messages;

  const systemText = systems
    .map((m) => textFromNormalizedContent(m.content))
    .filter(Boolean)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  if (!systemText.trim()) return rest;

  const userIdx = rest.findIndex((m) => m.role === "user");
  if (userIdx < 0) {
    return [{ role: "user", content: systemText }, ...rest];
  }

  const user = rest[userIdx]!;
  const prefix = `${systemText}\n\n`;
  let merged: NormalizedMessage;
  if (typeof user.content === "string") {
    merged = { ...user, content: prefix + user.content };
  } else if (Array.isArray(user.content)) {
    merged = {
      ...user,
      content: [{ type: "text", text: prefix }, ...user.content],
    };
  } else {
    return rest;
  }

  const out = [...rest];
  out[userIdx] = merged;
  return out;
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
  if (provider === "groq") return "https://api.groq.com/openai/v1/chat/completions";
  if (provider === "openai") return "https://api.openai.com/v1/chat/completions";
  if (provider === "anthropic") return "https://api.anthropic.com/v1/messages";
  return ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";
};

function resolveModel(provider: LlmProvider, hasVision: boolean, maxTokens?: number): string {
  if (provider === "groq") {
    if (hasVision) {
      return process.env.GROQ_VISION_MODEL?.trim() || "meta-llama/llama-4-scout-17b-16e-instruct";
    }
    const fastModel = process.env.GROQ_FAST_MODEL?.trim() || "llama-3.1-8b-instant";
    const heavyModel = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";
    if (process.env.GROQ_USE_70B === "true") return heavyModel;
    if (maxTokens != null && maxTokens > 4000) return heavyModel;
    // Default fast model — preserves Groq TPD quota on Railway.
    return fastModel;
  }
  if (provider === "openai") {
    return process.env.LLM_MODEL?.trim() || "gpt-4o";
  }
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";
  }
  return process.env.FORGE_LLM_MODEL?.trim() || "gemini-2.5-flash";
}

/** Groq daily quota hit — skip retries and prefer OpenAI for subsequent calls. */
let groqCooldownUntilMs = 0;

/** OpenAI quota exhausted — skip for remainder of process lifetime. */
let openAiQuotaExhausted = false;

/** Anthropic credit balance too low — skip for remainder of process lifetime. */
let anthropicCreditExhausted = false;

export function isAnthropicCreditExhausted(): boolean { return anthropicCreditExhausted; }

export function isGroqInCooldown(): boolean {
  return Date.now() < groqCooldownUntilMs;
}

function isGroqDailyQuotaError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("tokens per day") ||
    lower.includes("tpd") ||
    lower.includes("tokens per minute (tpm)") ||
    lower.includes("tokens per minute (tpd)")
  );
}

function markGroqCooldown(errorText: string): void {
  if (!isGroqDailyQuotaError(errorText) && !isRateLimitError(429)) return;
  const waitSec = parseRetryAfterSeconds(errorText);
  const cooldownMs =
    waitSec != null && waitSec > 0
      ? waitSec * 1000
      : isGroqDailyQuotaError(errorText)
        ? 60 * 60 * 1000
        : 5 * 60 * 1000;
  groqCooldownUntilMs = Math.max(groqCooldownUntilMs, Date.now() + cooldownMs);
}

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
  return status >= 500 && status < 600;
}

function providersToTry(primary: LlmProvider): LlmProvider[] {
  const out: LlmProvider[] = [];
  const groqAvailable = Boolean(groqKeyFromEnv()) && !isGroqInCooldown();
  const openAiAvailable = Boolean(openAiKeyFromEnv()) && !openAiQuotaExhausted;
  const anthropicAvailable = Boolean(anthropicKeyFromEnv()) && !anthropicCreditExhausted;

  const push = (p: LlmProvider) => {
    if (p === "none" || out.includes(p)) return;
    if (p === "groq" && !groqAvailable) return;
    if (p === "openai" && !openAiAvailable) return;
    if (p === "anthropic" && !anthropicAvailable) return;
    if (!llmApiKeyForProvider(p)) return;
    out.push(p);
  };

  if (primary === "anthropic" && !anthropicAvailable) {
    push("groq");
  } else if (primary === "groq" && !groqAvailable) {
    push("anthropic");
  } else if (primary !== "none") {
    push(primary);
  }

  if (anthropicAvailable) push("anthropic");
  if (groqAvailable) push("groq");
  // OpenAI is disabled — quota is exhausted; Anthropic + Groq cover all tasks.
  return out;
}

const assertApiKey = () => {
  if (!ENV.forgeApiKey && !groqKeyFromEnv() && !openAiKeyFromEnv() && !anthropicKeyFromEnv()) {
    throw new Error(
      "LLM API key is not configured. Set GROQ_API_KEY on Railway (free), or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
    );
  }
};

/** Convert OpenAI-style content parts to Anthropic content blocks, mapping image_url → image. */
function convertToAnthropicContent(parts: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of parts) {
    if (typeof c === "string") { if (c) out.push({ type: "text", text: c }); continue; }
    const part = c as Record<string, unknown>;
    if (part.type === "text") {
      const t = String(part.text ?? "");
      if (t) out.push({ type: "text", text: t });
    } else if (part.type === "image_url") {
      const url = String((part.image_url as Record<string, unknown>)?.url ?? "");
      const imgMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (imgMatch) out.push({ type: "image", source: { type: "base64", media_type: imgMatch[1], data: imgMatch[2] } });
    }
  }
  return out;
}

/** Call Anthropic Messages API — different format from OpenAI-compatible APIs. */
async function invokeAnthropic(
  messages: Message[],
  apiKey: string,
  model: string,
  maxTokens: number,
  wantsJson?: boolean,
): Promise<InvokeResult> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const systemParts = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => (typeof c === "string" ? c : "text" in c ? c.text : "")).join("\n") : ""));
  if (wantsJson) systemParts.push("Respond with valid JSON only. No markdown, no explanation.");
  const systemText = systemParts.join("\n\n");

  const anthropicMessages = nonSystemMessages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? (convertToAnthropicContent(m.content as unknown[]))
        : String(m.content),
  }));

  const payload: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  };
  if (systemText) payload.system = systemText;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 400 && errorText.toLowerCase().includes("credit balance")) {
      anthropicCreditExhausted = true;
      console.warn("[LLM] Anthropic credit balance too low — skipping Anthropic for remainder of process lifetime.");
    }
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    id: string;
    content: Array<{ type: string; text: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
  };

  // Convert Anthropic response to OpenAI-compatible InvokeResult
  const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  return {
    choices: [{
      message: { role: "assistant", content: text },
      finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason,
    }],
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
  } as unknown as InvokeResult;
}

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
  if (chain.length === 0) {
    // All providers blocked (cooldown / quota). Try Groq anyway if key exists — cooldown is
    // a soft rate-limit guard, not a hard failure. Better to retry than to give up entirely.
    const groqKey = groqKeyFromEnv();
    if (groqKey) {
      console.warn("[LLM] All providers in cooldown/exhausted — retrying Groq ignoring cooldown.");
      groqCooldownUntilMs = 0; // reset cooldown so this request can proceed
      chain = ["groq"];
    } else {
      throw new Error(
        "LLM API key is not configured. Set GROQ_API_KEY on Railway (free), or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
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
    if (provider === "anthropic") {
      try {
        const model = resolveModel(provider, hasVision, maxTokens);
        const wantsJson = !!(responseFormat ?? response_format ?? outputSchema ?? output_schema);
        const result = await invokeAnthropic(messages, apiKey, model, maxTokens ?? 8192, wantsJson);
        if (i > 0) console.log(`[LLM] Succeeded via anthropic after ${chain[0]} failure`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[LLM] Anthropic failed:`, lastError.message);
        continue;
      }
    }

    let normalizedMessages = messages.map(normalizeMessage);
    if (provider === "groq") {
      normalizedMessages = adaptGroqVisionMessages(normalizedMessages);
    }

    const payload: Record<string, unknown> = {
      model: resolveModel(provider, hasVision, maxTokens),
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
        return (await response.json()) as InvokeResult;
      }

      const errorText = await response.text();
      lastError = new Error(
        `LLM invoke failed (${provider}, model=${payload.model}): ${response.status} ${response.statusText} – ${errorText}`
      );

      if (provider === "groq" && isRateLimitError(response.status)) {
        markGroqCooldown(errorText);
      }
      if (provider === "openai") {
        markOpenAiQuotaExhausted(errorText);
      }

      const retryAfterSec = parseRetryAfterSeconds(errorText);
      const skipGroqRetries =
        provider === "groq" &&
        (isGroqDailyQuotaError(errorText) || (retryAfterSec != null && retryAfterSec > 120));

      if (
        isRateLimitError(response.status) &&
        !skipGroqRetries &&
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
            (skipGroqRetries ? " [daily/long quota — no retry]" : "") +
            ` — falling back to ${chain[i + 1]}`
        );
        break;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(
    groqKeyFromEnv() && !openAiKeyFromEnv() && isGroqInCooldown()
      ? "LLM invoke failed: Groq daily quota exhausted — set LLM_API_KEY (OpenAI sk-...) for fallback"
      : "LLM invoke failed: no provider available"
  );
}
