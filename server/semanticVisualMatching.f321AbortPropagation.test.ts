import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// F3-21: analyzeBeatSemanticsWithLlm's original Promise.race() against a bare 14s setTimeout
// only stopped THIS function from waiting further — the underlying invokeLLM() fetch call kept
// running in the background afterward, unbounded, wasting network/LLM/CPU resources for a beat
// whose owning archive-fetch scope had already moved on. Production logs showed
// "[SemanticVisual] LLM analysis failed: semantic analysis timeout" landing in the same tight
// window as multiple "archive beat budget exceeded" events for other beats.
//
// Fix: invokeLLM() (server/_core/llm.ts) now accepts an optional `signal`, combined with (not
// replacing) its existing internal per-provider timeout, and threaded down into the actual
// fetch() call for both the Gemini and OpenAI-compatible request paths. analyzeBeatSemanticsWithLlm
// now creates a real AbortController, passes its signal into invokeLLM, and aborts it from the
// same 14s setTimeout that previously only fed a Promise.race — so the deadline now actually
// cancels the in-flight request instead of merely losing a race against it.
//
// global.fetch is mocked because llm.ts calls the bare global fetch (not node-fetch). These
// tests exercise the real analyzeBeatSemantics() -> invokeLLM() -> fetch(signal) wiring end to
// end with real timers (including a real ~14s wait for the abort test) — no mocking of the
// abort/race mechanism itself.
describe("analyzeBeatSemantics LLM-call abort propagation (F3-21)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.LLM_PROVIDER;
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.LLM_BUDGET_ENFORCE = "false";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  function groqOkResponse(jsonBody: Record<string, unknown>) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "chatcmpl-test",
        created: 0,
        model: "llama-test",
        choices: [
          { index: 0, message: { role: "assistant", content: JSON.stringify(jsonBody) }, finish_reason: "stop" },
        ],
      }),
      text: async () => "",
    } as unknown as Response;
  }

  it("Test A/F — a normal, fast LLM response completes successfully, exactly like before", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      groqOkResponse({
        summary: "soldiers marching through a ruined city",
        persons: [],
        locations: ["europe"],
        companies: [],
        events: [],
        objects: ["tanks"],
        emotions: [],
        timePeriods: ["1940s"],
        years: [],
        topicDomain: "wwii",
        searchTiers: [["soldiers tanks city"]],
      })
    );

    const { analyzeBeatSemantics } = await import("./semanticVisualMatching");
    const profile = await analyzeBeatSemantics(
      "Test A/F: Soldiers and tanks advanced through the ruined city.",
      "WWII Documentary"
    );

    expect(profile.searchTiers).toEqual([["soldiers tanks city"]]);
    expect(profile.topicDomain).toBe("wwii");
  });

  it("Test B/C/D/E — a beat whose LLM call never responds is aborted at the real 14s deadline via the exact signal fetch() received, and the function returns (falls back) instead of hanging forever", async () => {
    let capturedSignal: AbortSignal | undefined;
    let abortObserved = false;

    vi.spyOn(global, "fetch").mockImplementation(((_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        // Never resolves on its own — simulates a stuck/hung LLM request that, before this fix,
        // would have kept running in the background indefinitely (up to invokeLLM's own ~120s
        // internal timeout) after analyzeBeatSemantics had already given up on it.
        capturedSignal?.addEventListener("abort", () => {
          abortObserved = true;
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch);

    const { analyzeBeatSemantics } = await import("./semanticVisualMatching");

    const start = Date.now();
    const profile = await analyzeBeatSemantics(
      "Test B/C/D/E: A convoy of trucks crossed the desert at dawn.",
      "Desert Campaign Documentary"
    );
    const elapsed = Date.now() - start;

    // Proves the AbortSignal analyzeBeatSemantics created was actually threaded all the way down
    // to this specific fetch() call (not lost, not a disconnected/unrelated signal).
    expect(capturedSignal).toBeDefined();
    expect(abortObserved).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    // Settles at (approximately) the real 14s deadline — proves the deadline actually reached and
    // fired the abort, rather than the call hanging indefinitely or returning suspiciously fast.
    expect(elapsed).toBeGreaterThanOrEqual(13_500);
    expect(elapsed).toBeLessThan(18_000);

    // No uncontrolled background operation: the function itself returns normally (falls back to
    // the heuristic profile) instead of throwing or hanging — same external contract as before.
    expect(profile).toBeTruthy();
    expect(profile.searchTiers.length).toBeGreaterThan(0);
  }, 20_000);
});
