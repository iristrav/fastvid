import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// F3-20: gemini-2.5-flash was retired for new users — confirmed in production as a hard
// 404/NOT_FOUND on every single call (16 times in one render's log:
// "This model models/gemini-2.5-flash is no longer available to new users" / status NOT_FOUND).
// Two fixes: (1) resolveModel()'s Gemini default is now gemini-3.6-flash, the current GA
// Flash-tier model on the same v1beta generateContent REST endpoint; (2) a confirmed
// model-not-found 404 now marks Gemini unavailable for the rest of the process (mirroring the
// existing openAiQuotaExhausted pattern), so a still-broken GEMINI_MODEL override doesn't get
// re-tried (and re-fail) on every subsequent LLM call in the same render.
//
// global.fetch is mocked (llm.ts calls the bare global fetch, not node-fetch) — the retry/
// fallback/cooldown logic under test is the real, unmocked code. vi.resetModules() before each
// test gives a fresh copy of llm.ts's module-level cooldown/unavailable state, since that state
// is intentionally process-lifetime-scoped in production (not reset between calls).
describe("llm.ts Gemini model-not-found handling (F3-20)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.LLM_PROVIDER;
    process.env.LLM_BUDGET_ENFORCE = "false";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  function geminiOkResponse(text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
      text: async () => "",
    } as unknown as Response;
  }

  function gemini404NotFound() {
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: {
            code: 404,
            message:
              "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model.",
            status: "NOT_FOUND",
          },
        }),
    } as unknown as Response;
  }

  function gemini429() {
    return {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
    } as unknown as Response;
  }

  function openAiOkResponse(text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "chatcmpl-test",
        created: 0,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }),
      text: async () => "",
    } as unknown as Response;
  }

  it("Test A — a valid/supported model still makes a normal Gemini call via the existing client", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(geminiOkResponse("hello from gemini"));

    const { invokeLLM } = await import("./llm");
    const result = await invokeLLM({
      messages: [{ role: "user", content: "hi" }],
      preferProvider: "gemini",
    });

    expect(result.choices[0]?.message?.content).toBe("hello from gemini");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("gemini-3.6-flash");
    expect(calledUrl).not.toContain("gemini-2.5-flash");
  });

  it("Test A2 — GEMINI_MODEL explicitly set overrides the gemini-3.6-flash default with the exact configured value", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MODEL = "gemini-2.0-flash-custom";
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(geminiOkResponse("hello from custom model"));

    const { invokeLLM } = await import("./llm");
    const result = await invokeLLM({
      messages: [{ role: "user", content: "hi" }],
      preferProvider: "gemini",
    });

    expect(result.choices[0]?.message?.content).toBe("hello from custom model");
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("gemini-2.0-flash-custom");
    expect(calledUrl).not.toContain("gemini-3.6-flash");
  });

  it("Test B — a 404 NOT_FOUND is not retried (no retry storm): exactly one fetch call for the failed attempt", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(gemini404NotFound());

    const { invokeLLM } = await import("./llm");
    await expect(
      invokeLLM({ messages: [{ role: "user", content: "hi" }], preferProvider: "gemini" })
    ).rejects.toThrow();

    // No provider available to fall back to (only Gemini configured) — but the key assertion is
    // that invokeGemini's own internal loop never retried the 404: exactly one call, not three.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Test C — a 404 falls back to the existing OpenAI fallback, and a later call in the same process skips Gemini entirely instead of re-discovering the same 404", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) return gemini404NotFound();
      return openAiOkResponse("hello from openai fallback");
    });

    const { invokeLLM, isGeminiModelUnavailable } = await import("./llm");

    const first = await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
    expect(first.choices[0]?.message?.content).toBe("hello from openai fallback");
    expect(isGeminiModelUnavailable()).toBe(true);

    const geminiCallsAfterFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage.googleapis.com")
    ).length;
    expect(geminiCallsAfterFirst).toBe(1); // the one confirming 404

    // A second, later call in the same process must not re-attempt the known-broken model.
    fetchMock.mockClear();
    const second = await invokeLLM({ messages: [{ role: "user", content: "hi again" }] });
    expect(second.choices[0]?.message?.content).toBe("hello from openai fallback");
    const geminiCallsOnSecondInvoke = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage.googleapis.com")
    ).length;
    expect(geminiCallsOnSecondInvoke).toBe(0);
  });

  it("Test D — existing 429 rate-limit semantics are unchanged: 2 backoff retries then fallback, with the pre-existing cooldown still set", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) return gemini429();
      return openAiOkResponse("hello from openai after 429");
    });

    const { invokeLLM, isGeminiInCooldown, isGeminiModelUnavailable } = await import("./llm");
    const result = await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

    expect(result.choices[0]?.message?.content).toBe("hello from openai after 429");
    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage.googleapis.com")
    ).length;
    // Unchanged: initial attempt + 2 backoff retries = 3, same as before F3-20.
    expect(geminiCalls).toBe(3);
    // Unchanged: 429 exhaustion still sets the short cooldown...
    expect(isGeminiInCooldown()).toBe(true);
    // ...and, distinctly, this is a rate limit, not a model-not-found — the new F3-20 flag must
    // stay false so a genuinely-valid model isn't wrongly latched unavailable by a 429.
    expect(isGeminiModelUnavailable()).toBe(false);
  }, 20_000);

  it("Test E — the existing semantic-visual JSON output contract (choices[0].message.content as a raw JSON string) is unchanged", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const jsonPayload = JSON.stringify({ topicDomain: "wwii", searchTiers: [["soldiers tanks city"]] });
    vi.spyOn(global, "fetch").mockResolvedValue(geminiOkResponse(jsonPayload));

    const { invokeLLM } = await import("./llm");
    const result = await invokeLLM({
      messages: [
        { role: "system", content: "You extract structured visual search intent. Return JSON only." },
        { role: "user", content: "narration text" },
      ],
      preferProvider: "gemini",
      response_format: { type: "json_schema", json_schema: { name: "beat", schema: { type: "object" } } },
      maxTokens: 800,
    });

    const content = result.choices[0]?.message?.content;
    expect(typeof content).toBe("string");
    expect(JSON.parse(content as string)).toEqual({
      topicDomain: "wwii",
      searchTiers: [["soldiers tanks city"]],
    });
  });
});
