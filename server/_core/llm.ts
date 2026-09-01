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
  // F3-21: optional external cancellation. When the caller aborts this signal, the in-flight
  // provider fetch (and any not-yet-started fallback-chain attempt, since the same signal is
  // reused across providers) is aborted immediately instead of being left to run to its own
  // internal ~120s timeout after the caller has already given up and moved on. Combined with the
  // internal per-call timeout via AbortSignal.any() — passing this never shortens or lengthens
  // that existing internal timeout, it only adds an additional way for the request to end early.
  signal?: AbortSignal;
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
  /**
   * RONDE 119 — which provider actually produced this answer.
   *
   * The chain can move on twice before something replies, and until now the result carried no
   * trace of that: a caller logging a verdict could name the model string but not the provider
   * that served it, so "Groq is exhausted, did Gemini really pick it up?" was unanswerable from a
   * production log. Optional because a caller that does not care must not have to change.
   */
  provider?: LlmProvider;
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
    // F3-20: gemini-2.5-flash was retired for new users ("This model models/gemini-2.5-flash is
    // no longer available to new users") — confirmed in production as a hard 404/NOT_FOUND on
    // every call, 16 times in one render's log. gemini-3.6-flash is the current GA replacement
    // Flash-tier model on the same v1beta generateContent REST endpoint this file already calls
    // (no request-shape changes needed — this payload never sets temperature/topK/topP/
    // thinking_budget, the only fields that changed shape between generations). Override with
    // GEMINI_MODEL — e.g. gemini-3.5-flash-lite for more daily headroom at lower quality — if a
    // future deprecation repeats, without waiting on a redeploy.
    return process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  }
  return process.env.FORGE_LLM_MODEL?.trim() || "gemini-2.5-flash";
}

/** Groq daily quota hit — skip retries and prefer the next provider for subsequent calls. */
let groqCooldownUntilMs = 0;
export function isGroqInCooldown(): boolean {
  return Date.now() < groqCooldownUntilMs;
}

/**
 * RONDE 117 — set when Groq's cooldown is a DAILY exhaustion rather than a burst limit.
 *
 * The distinction matters in exactly one place: the all-providers-blocked recovery in invokeLLM
 * wipes the cooldown and forces one more Groq attempt, on the reasoning that a cooldown is a soft
 * guard. That is true of a per-minute limit and false of a spent daily budget — there the retry
 * cannot succeed AND the wipe erases the cooldown, so the next call repeats the whole discovery.
 */
let groqDailyExhaustedUntilMs = 0;
export function isGroqDailyExhausted(): boolean {
  return Date.now() < groqDailyExhaustedUntilMs;
}

/**
 * Clear the per-process provider cool-offs.
 *
 * These are module-level on purpose — a cooldown that reset per call would not be a cooldown —
 * which makes them leak between tests in one file. Exported for that, and named so nothing is
 * tempted to call it from the pipeline.
 */
export function __resetProviderCooldownsForTests(): void {
  groqCooldownUntilMs = 0;
  groqDailyExhaustedUntilMs = 0;
  geminiCooldownUntilMs = 0;
  geminiModelUnavailable = false;
  openAiCooldownUntilMs = 0;
}

function isGroqDailyQuotaError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("tokens per day") ||
    lower.includes("tpd") ||
    lower.includes("tokens per minute (tpd)")
  );
}

/** How long Groq is left alone once its DAILY token budget is gone. */
const GROQ_DAILY_COOLDOWN_MS = 60 * 60 * 1000;
/** Default cool-off for a burst (per-minute) limit that carried no retry hint. */
const GROQ_BURST_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * RONDE 117 — a daily exhaustion is not a burst, and Groq's retry hint does not know the
 * difference.
 *
 * From production:
 *
 *   429 – Rate limit reached for model `openai/gpt-oss-20b` … on tokens per day (TPD):
 *   Limit 200000, Used 199683, Requested 3630. Please try again in 23m51.216s.
 *
 * 317 tokens left of the day's 200 000. "Try again in 23m51s" is Groq's rolling-window estimate:
 * after that window a trickle frees up, enough for the next call to burn it and fail again, all
 * day. The old arithmetic preferred that hint over everything else —
 *
 *   waitSec != null && waitSec > 0 ? waitSec * 1000 : (daily ? 1h : 5min)
 *
 * — and Groq puts a hint in every one of these bodies, so the `daily ? 1h` branch, written for
 * exactly this case, was unreachable. A spent day got a 24-minute cool-off.
 *
 * The hint is still used, as a FLOOR rather than a ceiling: never shorter than Groq asked for,
 * and never shorter than an hour when the DAY is what ran out.
 *
 * Exported for RONDE 117's regression test — this is the arithmetic that was unreachable.
 */
export function markGroqCooldown(status: number, errorText: string): void {
  // The caller's status is what makes this a rate-limit response. The previous version asked
  // `!isRateLimitError(429)` — a literal 429 === 429, always true, so `!true` was false and the
  // guard never fired. It only read as one.
  const daily = isGroqDailyQuotaError(errorText);
  if (!isRateLimitError(status) && !daily) return;
  const hintMs = Math.max(0, (parseRetryAfterSeconds(errorText) ?? 0) * 1000);
  const cooldownMs = daily
    ? Math.max(hintMs, GROQ_DAILY_COOLDOWN_MS)
    : hintMs > 0
      ? hintMs
      : GROQ_BURST_COOLDOWN_MS;
  groqCooldownUntilMs = Math.max(groqCooldownUntilMs, Date.now() + cooldownMs);
  if (daily) {
    groqDailyExhaustedUntilMs = Math.max(groqDailyExhaustedUntilMs, Date.now() + cooldownMs);
    console.warn(
      `[LLM] Groq daily token budget exhausted — standing down for ` +
        `${Math.round(cooldownMs / 60_000)}min (Groq's own hint was ${Math.round(hintMs / 1000)}s)`
    );
  }
}

/**
 * RONDE 120 — OpenAI's cool-off, which used to be "forever".
 *
 * From the worker log, three seconds into render 543 — the FIRST LLM call of the process:
 *
 *   [LLM] OpenAI quota exhausted — skipping OpenAI for remainder of process lifetime.
 *   [LLM] openai failed (429) — falling back to gemini
 *
 * OpenAI is the configured provider on that worker (provider=openai, gpt-4o, key present). One
 * 429 and it was gone for the whole process — a Railway worker that stays up for days. Everything
 * after that ran on two free tiers: Groq, whose day ran out fourteen seconds later, and Gemini,
 * whose free tier is twenty requests per day. The render died at "Planning visuals", 25%.
 *
 * A permanent flag was defensible when it was the only guard against burning money on a dead
 * account. But it is the strictest treatment in the file applied to the only PAID provider: Groq
 * gets an hour, Gemini a minute, OpenAI got the rest of time. Topping up the account could not
 * bring it back without a redeploy.
 *
 * So it expires. Half an hour for a spent quota — one wasted round trip every thirty minutes is
 * nothing next to a worker that cannot make a video until someone notices and restarts it — and a
 * short one for an ordinary burst, which OpenAI never had at all before this.
 */
let openAiCooldownUntilMs = 0;
export function isOpenAiInCooldown(): boolean {
  return Date.now() < openAiCooldownUntilMs;
}
/** How long OpenAI is left alone once it reports the account's quota is spent. */
const OPENAI_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
/** Cool-off for an ordinary OpenAI rate limit — previously none at all. */
const OPENAI_BURST_COOLDOWN_MS = 60 * 1000;

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

/**
 * RONDE 120 — cool OpenAI down for a while, rather than for good.
 *
 * The retry hint is a FLOOR, never a ceiling, for the same reason as RONDE 117: the provider's own
 * "try again in Ns" describes a rolling window, and a spent account's window frees a trickle that
 * the next call burns immediately.
 *
 * Exported so the regression test can drive it with the verbatim production body.
 */
export function markOpenAiCooldown(status: number, body: string): void {
  const quota = isOpenAiQuotaError(429, body) || isOpenAiQuotaError(402, body);
  if (!quota && !isRateLimitError(status)) return;
  const hintMs = Math.max(0, (parseRetryAfterSeconds(body) ?? 0) * 1000);
  const cooldownMs = quota
    ? Math.max(hintMs, OPENAI_QUOTA_COOLDOWN_MS)
    : Math.max(hintMs, OPENAI_BURST_COOLDOWN_MS);
  openAiCooldownUntilMs = Math.max(openAiCooldownUntilMs, Date.now() + cooldownMs);
  if (quota) {
    console.warn(
      `[LLM] OpenAI quota spent — standing down for ${Math.round(cooldownMs / 60_000)}min ` +
        `(it is retried automatically after that; no redeploy needed)`
    );
  }
}

/**
 * RONDE 116 — "this request is bigger than my per-minute allowance".
 *
 * Groq answers an oversize prompt with 413, not 429:
 *
 *   413 Payload Too Large – Request too large for model `openai/gpt-oss-120b` … service tier
 *   `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17076
 *
 * That is a statement about GROQ's tier, not about the request. Gemini has no 8k-per-minute cap
 * and would have served the same prompt. Classifying it separately from 429 matters because the
 * two need opposite handling: a 429 is worth waiting out, while re-sending an oversize payload to
 * the same provider is guaranteed to fail again no matter how long you wait.
 */
export function isCapacityTooLargeError(status: number, body: string): boolean {
  if (status !== 413) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("too large") ||
    lower.includes("tokens per minute") ||
    lower.includes("tpm") ||
    lower.includes("reduce your message size")
  );
}

/**
 * RONDE 119 — "this provider had no capacity for the request" versus "this provider answered and
 * the answer was no good".
 *
 * The production line that started this round:
 *
 *   LLM invoke failed (groq, model=openai/gpt-oss-20b): 429 … tokens per day (TPD):
 *   Limit 200000, Used 199683, Requested 3630.
 *
 * The vision gate booked that as a FAILED judgement. It is not one: no model looked at the frame.
 * A render whose model is broken and a render whose account is out of tokens need opposite work,
 * and RONDE 105/115 built the counters to keep them apart — this is the predicate that lets the
 * chain say which of the two it hit.
 *
 * Deliberately narrow. A 400, a 500, a timeout, a truncated body and a malformed answer all stay
 * genuine failures: the provider was reachable and something else went wrong, and calling that
 * "unavailable" would hide a broken prompt behind a quota story.
 */
export function isProviderCapacityFailure(status: number, body: string): boolean {
  if (isRateLimitError(status)) return true; // 429 — TPD, TPM and RPM all land here
  if (isOpenAiQuotaError(status, body)) return true; // 402 insufficient_quota / billing
  if (isCapacityTooLargeError(status, body)) return true; // 413 — request over the tier's TPM
  // A model the account cannot reach is the same fact as no capacity: nothing judged anything.
  if (status === 404) return true;
  /**
   * RONDE 120 — 403, from the same worker log:
   *
   *   [LLM] Gemini failed: Gemini API error 403: { code: 403,
   *     message: "Your project has been denied access. Please contact support.",
   *     status: "PERMISSION_DENIED" }
   *
   * The provider refused to serve the request. Whatever the cause — a blocked project, a key
   * without rights, a region restriction — no model looked at anything, which is exactly the
   * condition this predicate exists to name.
   */
  if (status === 403) return true;
  return false;
}

/** Exported for RONDE 116's regression test: this is the predicate the provider chain consults. */
export function shouldFallbackToNextProvider(status: number, body: string): boolean {
  if (isRateLimitError(status)) return true;
  if (isOpenAiQuotaError(status, body)) return true;
  if (status === 404) return true; // model not found → try next provider
  /**
   * RONDE 120: a refused request must move on rather than end the call.
   *
   * 403 was in none of these buckets, so an OpenAI-compatible provider answering PERMISSION_DENIED
   * stopped the chain dead at `throw` with the other providers untouched — the same shape of bug
   * RONDE 116 found for 413. Gemini escaped it only because it is called from a different function
   * that continues on any error.
   */
  if (status === 403) return true;
  /**
   * RONDE 116: 413 was in none of the buckets above, so it fell past this check to `throw
   * lastError` — ending the whole call at the first provider while a provider that could serve
   * the request sat unused in the chain. Confirmed in production against Groq's 8000 TPM tier.
   */
  if (isCapacityTooLargeError(status, body)) return true;
  return status >= 500 && status < 600;
}

/**
 * RONDE 173 — sleep on a rate limit only when there is nobody else to ask.
 *
 * Render 555, between 10:37:34 and 10:42:18:
 *
 *     26 × [LLM] groq rate limit (attempt N/4) — retry in Ns      (145 seconds of sleep)
 *      9 × [LLM] Succeeded via groq (after N rate-limit retries)
 *      1 × [LLM] groq failed (429) — falling back to openai
 *      1 × [LLM] Succeeded via openai after groq failure
 *
 * Those last two lines are the point: OpenAI was in the chain, healthy, and demonstrably able to
 * serve these calls. `shouldFallbackToNextProvider` has returned true for a rate limit since it was
 * written — the fallback simply sat BELOW the retry branch, so a 429 slept instead of moving on, on
 * a render that then refused its research pass for want of budget and finished with three of
 * nineteen beats holding an approved picture.
 *
 * RONDE 129's classification already says this: `isRetryableFailure("RATE_LIMITED")` is false. The
 * sleep here was the one place that disagreed. It is kept for the single case where R129's rule
 * would strand a render rather than speed it up — a chain with no next provider, where waiting is
 * the only alternative to failing outright.
 *
 * Nothing about the request changes. The next provider is the same chain every other failure class
 * already falls through to (500s, 404s, 403s, 413s), carrying the same prompt.
 *
 * Extracted rather than inlined so the decision can be tested as itself: the Groq and OpenAI
 * endpoints are hardcoded, so a two-provider chain cannot be driven against a local stub, and a
 * test that reimplemented this condition would pass no matter what the call site did.
 */
export function rateLimitSleepSeconds(opts: {
  status: number;
  attempt: number;
  retryAfterSec: number | null;
  skipProviderRetries: boolean;
  nextProviderAvailable: boolean;
}): number | null {
  if (!isRateLimitError(opts.status)) return null;
  if (opts.skipProviderRetries) return null;
  if (opts.nextProviderAvailable) return null;
  if (opts.attempt >= 3) return null;
  if (opts.retryAfterSec == null || opts.retryAfterSec > 120) return null;
  return Math.min(90, opts.retryAfterSec);
}

function providersToTry(primary: LlmProvider): LlmProvider[] {
  const out: LlmProvider[] = [];
  const geminiAvailable = Boolean(geminiKeyFromEnv()) && !isGeminiInCooldown() && !geminiModelUnavailable;
  const groqAvailable = Boolean(groqKeyFromEnv()) && !isGroqInCooldown();
  const openAiAvailable = Boolean(openAiKeyFromEnv()) && !isOpenAiInCooldown();

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

/**
 * RONDE 115 — the marker that separates "no provider was ever contacted" from "a provider failed".
 *
 * invokeLLM can refuse before it opens a socket: no key configured anywhere, every provider in
 * cooldown or quota-exhausted, or the daily spend budget already spent. Those are the same
 * OUTCOME as a provider error for the caller — no answer — but they are a different FACT, and a
 * caller that counts them together reports a model outage where there was none.
 *
 * The knowledge lives here because this is the module that produces these throws. A caller
 * matching on message substrings would rot the moment one of them is reworded.
 */
export class LlmUnavailableError extends Error {
  readonly preflight = true as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

/** True when the call never reached a provider, so no attempt was actually made. */
export function isLlmPreflightRefusal(err: unknown): boolean {
  return err instanceof LlmUnavailableError || (err as { preflight?: boolean })?.preflight === true;
}

/**
 * RONDE 119 — every provider in the chain was out of capacity.
 *
 * A separate class from LlmUnavailableError on purpose. That one means "nothing was sent"; this
 * one means "a provider was contacted and told us it has nothing to give" — a 429 on the day's
 * tokens, a 413 over the tier's per-minute ceiling, an exhausted OpenAI quota. The OUTCOME is the
 * same (no answer) and both belong on the never-judged side of the counters, but the two are
 * different facts and RONDE 115's preflight predicate must keep meaning exactly what it meant.
 *
 * It carries the per-provider reasons so a log line can name all of them at once instead of the
 * one that happened to be last.
 */
export class LlmProviderUnavailableError extends Error {
  readonly providerUnavailable = true as const;
  constructor(
    message: string,
    readonly providers: ReadonlyArray<{ provider: LlmProvider; status: number; detail: string }> = []
  ) {
    super(message);
    this.name = "LlmProviderUnavailableError";
  }
}

/**
 * True when no answer came back because no provider had capacity — including the pre-flight case,
 * where the chain was empty before a socket was opened.
 *
 * This is the predicate a caller that counts judgements should use: it is exactly the set of
 * outcomes that must NOT be recorded as a failed model judgement.
 */
export function isLlmProviderUnavailable(err: unknown): boolean {
  if (isLlmPreflightRefusal(err)) return true;
  return (
    err instanceof LlmProviderUnavailableError ||
    (err as { providerUnavailable?: boolean })?.providerUnavailable === true
  );
}

/**
 * The provider's own HTTP answer, kept with the error.
 *
 * Gemini speaks a different API and is called from a different function, so its failures used to
 * arrive at the chain as a bare Error whose only evidence was a message string. Classifying by
 * substring would rot the first time a message is reworded; these fields are the response itself.
 */
type ProviderHttpError = Error & { llmProvider: LlmProvider; llmStatus: number; llmBody: string };

function providerHttpError(
  provider: LlmProvider,
  status: number,
  body: string,
  message: string
): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.llmProvider = provider;
  err.llmStatus = status;
  err.llmBody = body;
  return err;
}

/** Was this thrown error a provider saying it had no capacity? */
function isCapacityError(err: unknown): boolean {
  const e = err as Partial<ProviderHttpError>;
  if (typeof e?.llmStatus !== "number") return false;
  return isProviderCapacityFailure(e.llmStatus, e.llmBody ?? "");
}

const assertApiKey = () => {
  if (!ENV.forgeApiKey && !geminiKeyFromEnv() && !groqKeyFromEnv() && !openAiKeyFromEnv()) {
    throw new LlmUnavailableError(
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

// F3-20: a "model not found" 404 (wrong/deprecated GEMINI_MODEL) is permanent — unlike the RPM
// cooldown above, it will never clear itself, so without this flag every subsequent LLM call in
// the same render (and every later render in the same worker process) re-discovers the identical
// 404 before falling back, each one wasting a full request/response round trip first. Confirmed in
// production: 16 identical 404s across one render's log. Same permanent-until-process-restart
// pattern already used for the OpenAI cool-off below.
let geminiModelUnavailable = false;
export function isGeminiModelUnavailable(): boolean {
  return geminiModelUnavailable;
}
function isGeminiModelNotFoundError(status: number, body: string): boolean {
  return status === 404 && body.toUpperCase().includes("NOT_FOUND");
}

/**
 * RONDE 120 — Gemini's DAY is gone, not its minute.
 *
 * Verbatim from the worker log, the answer that ended render 543:
 *
 *   429 RESOURCE_EXHAUSTED — "Quota exceeded for metric:
 *   generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20,
 *   model: gemini-3.6-flash. Please retry in 29.141733906s."
 *   quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20"
 *
 * Twenty requests per DAY, and the body's own advice is to retry in 29 seconds. Every 429 got the
 * same 60-second cool-off, so a spent day was re-discovered a minute later, and a minute after
 * that, for the rest of the day — with two 4s/8s in-call retries burning twelve seconds of wall
 * clock each time before the chain even moved on.
 *
 * This is RONDE 117's Groq arithmetic applied to the provider it was not applied to. The
 * distinction is the quotaId, not the status: a per-minute Gemini limit still gets its minute.
 */
function isGeminiDailyQuotaError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("perday") ||
    lower.includes("per day") ||
    lower.includes("free_tier_requests") ||
    lower.includes("requestsperdayperprojectpermodel")
  );
}

/** How long Gemini is left alone once its DAILY request quota is gone. */
const GEMINI_DAILY_COOLDOWN_MS = 60 * 60 * 1000;
/** Cool-off for a Gemini burst (per-minute) limit — unchanged from before RONDE 120. */
const GEMINI_BURST_COOLDOWN_MS = 60 * 1000;
/**
 * Cool-off for a refused project (403 PERMISSION_DENIED).
 *
 * Deliberately minutes, not an hour: the same worker log shows Gemini answering 403 twice and then
 * serving real quota errors seconds later, so the denial was not permanent. Long enough to stop
 * every call re-discovering it, short enough that a transient refusal costs one render, not a day.
 */
const GEMINI_DENIED_COOLDOWN_MS = 5 * 60 * 1000;

/** Exported for RONDE 120's regression test: the arithmetic that treated a day as a minute. */
export function markGeminiCooldown(status: number, body: string): void {
  const daily = status === 429 && isGeminiDailyQuotaError(body);
  const denied = status === 403;
  if (status !== 429 && !denied) return;
  const hintMs = Math.max(0, (parseRetryAfterSeconds(body) ?? 0) * 1000);
  const cooldownMs = daily
    ? Math.max(hintMs, GEMINI_DAILY_COOLDOWN_MS)
    : denied
      ? GEMINI_DENIED_COOLDOWN_MS
      : Math.max(hintMs, GEMINI_BURST_COOLDOWN_MS);
  geminiCooldownUntilMs = Math.max(geminiCooldownUntilMs, Date.now() + cooldownMs);
  if (daily) {
    console.warn(
      `[LLM] Gemini daily request quota spent — standing down for ` +
        `${Math.round(cooldownMs / 60_000)}min (Gemini's own hint was ${Math.round(hintMs / 1000)}s)`
    );
  } else if (denied) {
    console.warn(
      `[LLM] Gemini refused the request (403 PERMISSION_DENIED) — standing down for ` +
        `${Math.round(cooldownMs / 60_000)}min instead of retrying it on every call`
    );
  }
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
  externalSignal?: AbortSignal,
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
    // F3-21: externalSignal (e.g. a caller's own deadline) is combined with, not a replacement
    // for, this existing internal timeout — an already-aborted externalSignal makes this fetch
    // reject immediately without a network round trip.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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
    // F3-20: permanent, non-retryable — no amount of retrying fixes an invalid/deprecated model
    // name, so skip straight to throwing (no `continue`, matching every other non-429 status
    // below) and mark Gemini unavailable for the rest of this process so subsequent calls don't
    // repeat the same wasted round trip.
    if (isGeminiModelNotFoundError(response.status, lastErrorText)) {
      geminiModelUnavailable = true;
      throw providerHttpError("gemini", response.status, lastErrorText,
        `Gemini API error ${response.status}: ${lastErrorText}`);
    }
    // Free-tier RPM (429/RESOURCE_EXHAUSTED) is a short-lived burst limit, not exhaustion of the
    // daily quota — worth one or two short retries before giving up on this call entirely.
    //
    // RONDE 120: unless the DAY is what ran out. Those two retries cost twelve seconds of wall
    // clock and cannot succeed — the quota resets tomorrow, not in eight seconds — so a spent day
    // moves on to the next provider immediately.
    if (response.status === 429 && attempt < 2 && !isGeminiDailyQuotaError(lastErrorText)) {
      const waitSec = 4 * (attempt + 1);
      console.warn(`[LLM] Gemini rate limit (attempt ${attempt + 1}/3) — retry in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }
    // Cool down so the next several calls in this render skip straight to the next provider
    // instead of each re-discovering the same limit. RONDE 120: how long depends on WHICH limit —
    // an hour for a spent day, a minute for a burst, five minutes for a refused project.
    markGeminiCooldown(response.status, lastErrorText);
    // RONDE 119: the status and body travel with the error, so the chain can tell "out of quota"
    // from "answered badly" without reading the sentence.
    throw providerHttpError("gemini", response.status, lastErrorText,
      `Gemini API error ${response.status}: ${lastErrorText}`);
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
    // Pre-flight: nothing is sent, so a caller must not record this as a provider failure.
    throw new LlmUnavailableError(
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
    signal,
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
    /**
     * RONDE 117 — ignoring a cooldown is a gamble, and a spent DAILY budget is the one case where
     * it cannot pay off.
     *
     * A per-minute limit clears by itself, so one more attempt may well succeed and is worth the
     * round trip. A day's tokens do not come back within the render. Worse, the reset below sets
     * groqCooldownUntilMs to 0 — so the cooldown that was protecting every later call is erased,
     * and each one repeats the whole discovery (primary fails, fallback fails, Groq fails) for
     * the rest of the day.
     */
    if (!hasVision && groqKey && !isGroqDailyExhausted()) {
      console.warn("[LLM] All providers in cooldown/exhausted — retrying Groq ignoring cooldown.");
      groqCooldownUntilMs = 0; // reset cooldown so this request can proceed
      chain = ["groq"];
    } else if (groqKey && isGroqDailyExhausted()) {
      // Say what is actually wrong. "API key is not configured" sent the last investigation to
      // the wrong place, and the key is plainly set.
      throw new LlmUnavailableError(
        "Groq's daily token budget is spent and no other provider is available. Set " +
        "GEMINI_API_KEY (free, Google AI Studio) or LLM_API_KEY (OpenAI) so calls can fall " +
        "through, or wait for Groq's daily quota to reset."
      );
    } else if (hasVision && groqKey) {
      /**
       * RONDE 119 — say what is actually missing.
       *
       * Groq is removed from every vision chain a few lines above (its vision models 404), so a
       * vision call with only a Groq key configured arrives here with the key plainly set and got
       * told "LLM API key is not configured". That is the same wrong signpost RONDE 117 removed
       * from the daily-quota branch, on the route the picture editor actually uses.
       */
      throw new LlmUnavailableError(
        "No vision-capable provider is available: Groq is excluded from image calls and no other " +
        "provider is usable right now. Set GEMINI_API_KEY (free, Google AI Studio) or LLM_API_KEY " +
        "(OpenAI) so image judgements can be made."
      );
    } else {
      // Every provider is keyless, cooled down or quota-exhausted — again, nothing is sent.
      throw new LlmUnavailableError(
        "LLM API key is not configured. Set GROQ_API_KEY or GEMINI_API_KEY on Railway (free), " +
        "or LLM_API_KEY / BUILT_IN_FORGE_API_KEY"
      );
    }
  }

  let lastError: Error | null = null;
  /**
   * RONDE 119 — why each provider dropped out, so the final throw can say which kind of failure
   * this was rather than only what the last one said.
   */
  const capacityBlocked: Array<{ provider: LlmProvider; status: number; detail: string }> = [];
  /** True once a provider fails for a reason that is NOT lack of capacity. */
  let sawRealFailure = false;
  const noteCapacityBlock = (provider: LlmProvider, status: number, body: string) => {
    capacityBlocked.push({ provider, status, detail: body.slice(0, 160) });
  };

  /**
   * RONDE 119 — the throw that told the caller the wrong thing.
   *
   * Both exits used to hand back the raw `lastError`: a plain Error reading
   *
   *   LLM invoke failed (groq, model=openai/gpt-oss-20b): 429 … tokens per day (TPD) …
   *
   * A caller cannot tell that apart from "the model answered rubbish", so the vision gate counted
   * a spent Groq day as a failed picture judgement — forty-four times over, in a render where no
   * model had looked at anything at all.
   *
   * When EVERY provider that dropped out did so for lack of capacity, the answer is that the
   * chain was unavailable, and it is thrown as such with all the reasons attached. If any provider
   * failed for another reason, that failure is the honest headline and is thrown unchanged, so a
   * genuine outage can never be dressed up as a quota problem.
   */
  function finalError(): Error {
    if (capacityBlocked.length > 0 && !sawRealFailure) {
      const summary = capacityBlocked
        .map((b) => `${b.provider} ${b.status}`)
        .join(", ");
      const err = new LlmProviderUnavailableError(
        `No LLM provider had capacity for this request (${summary}). ` +
          `Last response: ${lastError?.message ?? "unknown"}`,
        capacityBlocked
      );
      console.warn(`[LLM] chain exhausted — every provider out of capacity: ${summary}`);
      return err;
    }
    return (
      lastError ??
      new Error(
        groqKeyFromEnv() && geminiKeyFromEnv() && !openAiKeyFromEnv() && isGroqInCooldown() && isGeminiInCooldown()
          ? "LLM invoke failed: Gemini and Groq daily quotas exhausted — set LLM_API_KEY (OpenAI sk-...) for fallback"
          : "LLM invoke failed: no provider available"
      )
    );
  }

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
        const result = await invokeGemini(messages, apiKey, model, maxTokens ?? 8192, wantsJson, signal);
        if (i > 0) console.log(`[LLM] Succeeded via gemini after ${chain[0]} failure`);
        if (result.usage) {
          const { recordLlmUsage } = await import("./llmBudget");
          recordLlmUsage(model, result.usage.prompt_tokens, result.usage.completion_tokens, getActiveUserId() ?? null);
        }
        return { ...result, provider: "gemini" };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[LLM] Gemini failed:`, lastError.message);
        // RONDE 119: a 429/404 from Gemini is the same class of fact as Groq's spent day — the
        // model never judged anything. Anything else is a real failure and stays one.
        if (isCapacityError(err)) {
          noteCapacityBlock("gemini", (err as { llmStatus: number }).llmStatus, (err as { llmBody?: string }).llmBody ?? "");
        } else {
          sawRealFailure = true;
        }
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
        // F3-21: same externalSignal-combined-with-internal-timeout pattern as invokeGemini above
        // — an unset signal reproduces the exact prior behavior (just the 120s internal timeout).
        response = await fetch(resolveApiUrl(provider), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[LLM] ${provider} network/timeout failure:`, lastError.message);
        // A network fault is not a capacity fact — the provider never got to say anything about
        // its quota, so this stays a real failure.
        sawRealFailure = true;
        break;
      }

      if (response.ok) {
        if (i > 0 || attempt > 0) {
          console.log(
            `[LLM] Succeeded via ${provider}${attempt > 0 ? ` (after ${attempt} rate-limit retries)` : ""}` +
              (i > 0 ? ` after ${chain[0]} failure` : "")
          );
        }
        // response.ok only means the HTTP status was 2xx — a proxy or gateway in front of the
        // provider can still return a 200 with a non-JSON or truncated body. Previously .json()
        // throwing here escaped invokeLLM uncaught instead of falling through to the next
        // provider, same failure class as the unguarded fetch() fixed above.
        let result: InvokeResult;
        try {
          result = (await response.json()) as InvokeResult;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.warn(`[LLM] ${provider} returned malformed JSON:`, lastError.message);
          // The provider answered; the answer was unusable. That is a real failure.
          sawRealFailure = true;
          break;
        }
        if (result.usage) {
          const { recordLlmUsage } = await import("./llmBudget");
          recordLlmUsage(String(payload.model), result.usage.prompt_tokens, result.usage.completion_tokens, getActiveUserId() ?? null);
        }
        return { ...result, provider };
      }

      const errorText = await response.text();
      lastError = providerHttpError(
        provider,
        response.status,
        errorText,
        `LLM invoke failed (${provider}, model=${payload.model}): ${response.status} ${response.statusText} – ${errorText}`
      );
      /**
       * RONDE 119 — record WHY this provider is dropping out, right where the answer is in hand.
       *
       * `isProviderCapacityFailure` is deliberately narrow: a 429 (TPD/TPM/RPM), a 413 over the
       * tier's ceiling, an exhausted OpenAI quota, or a model this account cannot reach. Those are
       * "no capacity". A 400, a 500 or a malformed body are not, and stay failures.
       */
      if (isProviderCapacityFailure(response.status, errorText)) {
        noteCapacityBlock(provider, response.status, errorText);
      } else {
        sawRealFailure = true;
      }

      // Groq 404: configured vision model no longer available — retry once with fallback model.
      if (provider === "groq" && response.status === 404 && hasVision && payload.model !== GROQ_VISION_FALLBACK_MODEL) {
        console.warn(`[LLM] Groq vision model "${payload.model}" returned 404 — retrying with fallback ${GROQ_VISION_FALLBACK_MODEL}`);
        payload.model = GROQ_VISION_FALLBACK_MODEL;
        continue;
      }

      if (provider === "groq" && isRateLimitError(response.status)) {
        markGroqCooldown(response.status, errorText);
      }
      /**
       * RONDE 116 — stop re-discovering the same ceiling.
       *
       * A TPM rejection means Groq cannot take a request of this size right now. Without a
       * cooldown every remaining large call in the render pays a full round trip to learn the
       * same thing — the exact pattern already documented and fixed for Gemini's 404s ("16
       * identical 404s across one render's log"). Short, because a TPM window is a minute.
       */
      if (provider === "groq" && isCapacityTooLargeError(response.status, errorText)) {
        const waitSec = parseRetryAfterSeconds(errorText) ?? 60;
        groqCooldownUntilMs = Math.max(groqCooldownUntilMs, Date.now() + waitSec * 1000);
        console.warn(
          `[LLM] Groq TPM ceiling hit (${payload.model}) — request too large for this tier; ` +
            `falling through to the next provider and cooling Groq down for ${waitSec}s`
        );
      }
      if (provider === "openai") {
        markOpenAiCooldown(response.status, errorText);
      }

      const retryAfterSec = parseRetryAfterSeconds(errorText);
      const skipProviderRetries =
        // RONDE 116: an oversize payload is not a wait-and-retry condition — the same bytes will
        // be exactly as oversize in ninety seconds. Move on rather than sleeping for nothing.
        isCapacityTooLargeError(response.status, errorText) ||
        (provider === "groq" &&
          (isGroqDailyQuotaError(errorText) || (retryAfterSec != null && retryAfterSec > 120)));

      const waitSec = rateLimitSleepSeconds({
        status: response.status,
        attempt,
        retryAfterSec,
        skipProviderRetries,
        nextProviderAvailable: i + 1 < chain.length,
      });
      if (waitSec != null) {
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

      throw finalError();
    }
  }

  throw finalError();
}
