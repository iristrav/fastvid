import { ENV, geminiKeyFromEnv, groqKeyFromEnv, llmApiKeyForProvider, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./env";
import { getActiveUserId } from "../videoGenerationCancel";

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
  return ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";
};

// llama-4-scout-17b-16e-instruct was deprecated by Groq on 2026-06-17 (404 "model does not
// exist"). qwen3-vl-32b-instruct also 404s on this account — Groq gates it to Enterprise-tier
// customers, so "does not exist" there actually meant "no access", not "wrong name". Falling
// back to llama-4-maverick-17b-128e-instruct, Groq's other vision-capable Llama 4 model,
// documented as available on standard (non-Enterprise) accounts. If this 404s too, don't guess
// again from here — check console.groq.com (logged into the actual account) for the exact model
// IDs it has access to, and override via GROQ_VISION_MODEL without waiting on a redeploy.
const GROQ_VISION_FALLBACK_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";

function resolveModel(provider: LlmProvider, hasVision: boolean, maxTokens?: number): string {
  if (provider === "groq") {
    if (hasVision) {
      return process.env.GROQ_VISION_MODEL?.trim() || GROQ_VISION_FALLBACK_MODEL;
    }
    // llama-3.1-8b-instant / llama-3.3-70b-versatile were deprecated by Groq on 2026-06-17 —
    // openai/gpt-oss-20b and openai/gpt-oss-120b are Groq's own documented replacements.
    const fastModel = process.env.GROQ_FAST_MODEL?.trim() || "openai/gpt-oss-20b";
    const heavyModel = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
    if (process.env.GROQ_USE_70B === "true") return heavyModel;
    if (maxTokens != null && maxTokens > 4000) return heavyModel;
    // Default fast model — preserves Groq TPD quota on Railway.
    return fastModel;
  }
  if (provider === "openai") {
    return process.env.LLM_MODEL?.trim() || "gpt-4o";
  }
  if (provider === "gemini") {
    // Flash (not Flash-Lite) by default — noticeably better quality for script/tag/editorial
    // writing, and its free-tier quota (~250 req/day, 10 RPM) is still comfortably above this
    // app's actual per-video call volume. Override with GEMINI_MODEL — e.g. gemini-2.5-flash-lite
    // for more daily headroom at lower quality, or gemini-2.5-pro for the reverse trade.
    return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  }
  return process.env.FORGE_LLM_MODEL?.trim() || "gemini-2.5-flash";
}

/** Groq daily quota hit — skip retries and prefer the next provider for subsequent calls. */
let groqCooldownUntilMs = 0;
export function isGroqInCooldown(): boolean {
  return Date.now() < groqCooldownUntilMs;
}

function isGroqDailyQuotaError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("tokens per day") ||
    lower.includes("tpd") ||
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
  const geminiAvailable = Boolean(geminiKeyFromEnv()) && !isGeminiInCooldown();
  const groqAvailable = Boolean(groqKeyFromEnv()) && !isGroqInCooldown();
  const openAiAvailable = Boolean(openAiKeyFromEnv()) && !openAiQuotaExhausted;

  const push = (p: LlmProvider) => {
    if (p === "none" || out.includes(p)) return;
    if (p === "gemini" && !geminiAvailable) return;
    if (p === "groq" && !groqAvailable) return;
    if (p === "openai" && !openAiAvailable) return;
    if (!llmApiKeyForProvider(p)) return;
    out.push(p);
  };

  if (primary === "gemini" && !geminiAvailable) {
    push("groq");
  } else if (primary === "groq" && !groqAvailable) {
    push("gemini");
  } else if (primary !== "none") {
    push(primary);
  }

  if (geminiAvailable) push("gemini");
  if (groqAvailable) push("groq");
  if (openAiAvailable) push("openai");
  return out;
}

const assertApiKey = () => {
  if (!ENV.forgeApiKey && !geminiKeyFromEnv() && !groqKeyFromEnv() && !openAiKeyFromEnv()) {
    throw new Error(
      "LLM API key is not configured. Set GEMINI_API_KEY (free, Google AI Studio) or GROQ_API_KEY " +
      "(free) on Railway, or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
    );
  }
};

/** Convert OpenAI-style content parts to Gemini parts, mapping image_url → inline_data. */
function convertToGeminiParts(parts: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of parts) {
    if (typeof c === "string") { if (c) out.push({ text: c }); continue; }
    const part = c as Record<string, unknown>;
    if (part.type === "text") {
      const t = String(part.text ?? "");
      if (t) out.push({ text: t });
    } else if (part.type === "image_url") {
      const url = String((part.image_url as Record<string, unknown>)?.url ?? "");
      const imgMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (imgMatch) out.push({ inline_data: { mime_type: imgMatch[1], data: imgMatch[2] } });
    }
  }
  return out;
}

/** Gemini free-tier RPM hit — skip retries and prefer the next provider for a short cooldown. */
let geminiCooldownUntilMs = 0;
export function isGeminiInCooldown(): boolean {
  return Date.now() < geminiCooldownUntilMs;
}

/** Call Google's Generative Language API — different format from OpenAI-compatible APIs.
 *  Gemini has no "assistant" role (uses "model") and no separate system message slot in
 *  `contents` (system text is a dedicated systemInstruction field). */
async function invokeGemini(
  messages: Message[],
  apiKey: string,
  model: string,
  maxTokens: number,
  wantsJson?: boolean,
): Promise<InvokeResult> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const systemText = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => (typeof c === "string" ? c : "text" in c ? c.text : "")).join("\n") : ""))
    .join("\n\n");

  const contents = nonSystemMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: typeof m.content === "string"
      ? [{ text: m.content }]
      : Array.isArray(m.content)
        ? convertToGeminiParts(m.content as unknown[])
        : [{ text: String(m.content) }],
  }));

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(wantsJson ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let lastErrorText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // Same gap as the OpenAI-compatible path above: no timeout meant a hung connection to
    // Gemini would leave this fetch pending indefinitely instead of erroring into the retry loop.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      return {
        choices: [{
          message: { role: "assistant", content: text },
          finish_reason: data.candidates?.[0]?.finishReason === "STOP" ? "stop" : (data.candidates?.[0]?.finishReason ?? null),
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
        },
      } as unknown as InvokeResult;
    }

    lastErrorText = await response.text();
    // Free-tier RPM (429/RESOURCE_EXHAUSTED) is a short-lived burst limit, not exhaustion of the
    // daily quota — worth one or two short retries before giving up on this call entirely.
    if (response.status === 429 && attempt < 2) {
      const waitSec = 4 * (attempt + 1);
      console.warn(`[LLM] Gemini rate limit (attempt ${attempt + 1}/3) — retry in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (response.status === 429) {
      // Retries exhausted this call — cool down briefly so the next several calls in this
      // render skip straight to the next provider instead of each re-discovering the same limit.
      geminiCooldownUntilMs = Date.now() + 60_000;
    }
    throw new Error(`Gemini API error ${response.status}: ${lastErrorText}`);
  }
  throw new Error(`Gemini API error: ${lastErrorText}`);
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
  // Groq vision models consistently return 404 — remove Groq from vision calls entirely.
  if (hasVision) chain = chain.filter((p) => p !== "groq");
  if (chain.length === 0) {
    // All providers blocked (cooldown / quota). A cooldown is a soft rate-limit guard, not a
    // hard failure — retry ignoring it rather than give up entirely.
    const groqKey = groqKeyFromEnv();
    if (!hasVision && groqKey) {
      console.warn("[LLM] All providers in cooldown/exhausted — retrying Groq ignoring cooldown.");
      groqCooldownUntilMs = 0; // reset cooldown so this request can proceed
      chain = ["groq"];
    } else {
      throw new Error(
        "LLM API key is not configured. Set GROQ_API_KEY or GEMINI_API_KEY on Railway (free), " +
        "or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
      );
    }
  }

  let lastError: Error | null = null;
  const maxTokens = params.maxTokens ?? params.max_tokens;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const apiKey = llmApiKeyForProvider(provider);
    if (!apiKey) continue;

    // Gemini uses a completely different API format (no /chat/completions equivalent).
    if (provider === "gemini") {
      try {
        const model = resolveModel(provider, hasVision, maxTokens);
        const wantsJson = !!(responseFormat ?? response_format ?? outputSchema ?? output_schema);
        const result = await invokeGemini(messages, apiKey, model, maxTokens ?? 8192, wantsJson);
        if (i > 0) console.log(`[LLM] Succeeded via gemini after ${chain[0]} failure`);
        if (result.usage) {
          const { recordLlmUsage } = await import("./llmBudget");
          recordLlmUsage(model, result.usage.prompt_tokens, result.usage.completion_tokens, getActiveUserId() ?? null);
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[LLM] Gemini failed:`, lastError.message);
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
      // No timeout previously meant a hung connection to the provider would leave this fetch
      // pending indefinitely — no error to trigger the retry/fallback-provider chain below, no
      // way for a caller to ever move on. This is the first pipeline stage (script generation);
      // a stall here blocked everything downstream with nothing to recover it. A thrown fetch
      // error (network failure, or this timeout firing) previously also had nowhere to go —
      // unlike an HTTP-level error response, it wasn't caught here at all, so it skipped the
      // provider-fallback chain below entirely and escaped invokeLLM uncaught. Now it's treated
      // the same as any other provider failure: record it and fall through to the next provider.
      let response: Response;
      try {
        response = await fetch(resolveApiUrl(provider), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[LLM] ${provider} network/timeout failure:`, lastError.message);
        break;
      }

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
          recordLlmUsage(String(payload.model), result.usage.prompt_tokens, result.usage.completion_tokens, getActiveUserId() ?? null);
        }
        return result;
      }

      const errorText = await response.text();
      lastError = new Error(
        `LLM invoke failed (${provider}, model=${payload.model}): ${response.status} ${response.statusText} – ${errorText}`
      );

      // Groq 404: configured vision model no longer available — retry once with fallback model.
      if (provider === "groq" && response.status === 404 && hasVision && payload.model !== GROQ_VISION_FALLBACK_MODEL) {
        console.warn(`[LLM] Groq vision model "${payload.model}" returned 404 — retrying with fallback ${GROQ_VISION_FALLBACK_MODEL}`);
        payload.model = GROQ_VISION_FALLBACK_MODEL;
        continue;
      }

      if (provider === "groq" && isRateLimitError(response.status)) {
        markGroqCooldown(errorText);
      }
      if (provider === "openai") {
        markOpenAiQuotaExhausted(errorText);
      }

      const retryAfterSec = parseRetryAfterSeconds(errorText);
      const skipProviderRetries =
        provider === "groq" &&
        (isGroqDailyQuotaError(errorText) || (retryAfterSec != null && retryAfterSec > 120));

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
    groqKeyFromEnv() && geminiKeyFromEnv() && !openAiKeyFromEnv() && isGroqInCooldown() && isGeminiInCooldown()
      ? "LLM invoke failed: Gemini and Groq daily quotas exhausted — set LLM_API_KEY (OpenAI sk-...) for fallback"
      : "LLM invoke failed: no provider available"
  );
}
