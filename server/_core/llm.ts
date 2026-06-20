import { ENV, groqKeyFromEnv, llmApiKeyForProvider, openAiKeyFromEnv, resolveLlmProvider, type LlmProvider } from "./env";

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

function resolveModel(provider: LlmProvider, hasVision: boolean, maxTokens?: number): string {
  if (provider === "groq") {
    if (hasVision) {
      return process.env.GROQ_VISION_MODEL?.trim() || "llama-3.2-11b-vision-preview";
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
  return process.env.FORGE_LLM_MODEL?.trim() || "gemini-2.5-flash";
}

/** Groq daily quota hit — skip retries and prefer OpenAI for subsequent calls. */
let groqCooldownUntilMs = 0;

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

function shouldFallbackToNextProvider(status: number, body: string): boolean {
  if (isRateLimitError(status)) return true;
  if (isOpenAiQuotaError(status, body)) return true;
  return status >= 500 && status < 600;
}

function providersToTry(primary: LlmProvider): LlmProvider[] {
  const out: LlmProvider[] = [];
  const groqAvailable = Boolean(groqKeyFromEnv()) && !isGroqInCooldown();
  const openAiAvailable = Boolean(openAiKeyFromEnv());

  const push = (p: LlmProvider) => {
    if (p === "none" || out.includes(p)) return;
    if (p === "groq" && !groqAvailable) return;
    if (p === "openai" && !openAiAvailable) return;
    if (!llmApiKeyForProvider(p)) return;
    out.push(p);
  };

  if (primary === "groq" && !groqAvailable && openAiAvailable) {
    push("openai");
  } else if (primary !== "none") {
    push(primary);
  }

  if (openAiAvailable) push("openai");
  if (groqAvailable) push("groq");
  return out;
}

const assertApiKey = () => {
  if (!ENV.forgeApiKey && !groqKeyFromEnv() && !openAiKeyFromEnv()) {
    throw new Error(
      "LLM API key is not configured. Set GROQ_API_KEY on Railway (free), or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
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

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  const hasVision = messagesIncludeImages(messages);
  const primary = resolveLlmProvider();
  const chain = providersToTry(primary);
  if (chain.length === 0) {
    throw new Error(
      "LLM API key is not configured. Set GROQ_API_KEY on Railway (free), or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
    );
  }

  let lastError: Error | null = null;
  const maxTokens = params.maxTokens ?? params.max_tokens;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const apiKey = llmApiKeyForProvider(provider);
    if (!apiKey) continue;

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
