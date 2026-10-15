/**
 * VIDEO 659 — FIX D: ONE RETRY FOR A REAL NETWORK FAULT TOWARDS OPENAI.
 *
 * Production, 12:06:51: `[LLM] openai network/timeout failure: fetch failed` — the connection
 * dropped before OpenAI saw the question, and ifr_Z0PZ434's look before the download ended as "the
 * picture editor's answer could not be read". Such a fault now gets one more try after 2 s, and
 * both attempts and the outcome are logged. Nothing else is retried: not a timeout, not a cancelled
 * call, not an HTTP answer from the provider. Two faults in a row fail exactly as before, and a
 * failed look is never an approval.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetProviderCooldownsForTests, invokeLLM, isTransientNetworkFailure, LLM_NETWORK_RETRY_WAIT_MS } from "./_core/llm";
import { lookBeforeDownload, type SheetDeps, type Storyboard } from "./youtubePreviewSheet";

const ENV_KEYS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY", "BUILT_IN_FORGE_API_KEY", "BUILT_IN_FORGE_API_URL", "LLM_PROVIDER", "LLM_BUDGET_ENFORCE"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let calls = 0;
let logs: string[] = [];

/** `fetch failed` as undici throws it: a TypeError whose cause carries the socket's code. */
const fetchFailed = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
const ok = (content: string) =>
  new Response(
    JSON.stringify({ id: "x", created: 1, model: "stub", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
/** The answers in turn: an Error is thrown as the network fault, a Response is returned. */
const answers = (...seq: Array<Error | (() => Response)>) => {
  globalThis.fetch = (async () => {
    const next = seq[Math.min(calls, seq.length - 1)]!;
    calls++;
    if (next instanceof Error) throw next;
    return next();
  }) as typeof fetch;
};
const ask = () => invokeLLM({ messages: [{ role: "user", content: "x" }], maxTokens: 50 });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENAI_API_KEY = "stub-openai";
  process.env.LLM_BUDGET_ENFORCE = "false";
  __resetProviderCooldownsForTests();
  calls = 0;
  logs = [];
  const keep = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "log").mockImplementation(keep);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  __resetProviderCooldownsForTests();
  vi.restoreAllMocks();
});

describe("VIDEO 659 fix D — what counts as a passing network fault", () => {
  it("fetch failed, a reset or refused connection, a DNS hiccup: yes", () => {
    expect(isTransientNetworkFailure(fetchFailed())).toBe(true);
    expect(isTransientNetworkFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientNetworkFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } }))).toBe(true);
  });
  it("a timeout, a cancelled call, an HTTP answer, a refusal: no", () => {
    expect(isTransientNetworkFailure(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe(false);
    expect(isTransientNetworkFailure(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))).toBe(false);
    /** Even when the aborted socket left a network code behind: a timeout stays a timeout. */
    expect(isTransientNetworkFailure(Object.assign(new Error("fetch failed"), { name: "TimeoutError", cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(isTransientNetworkFailure(fetchFailed(), cancelled.signal)).toBe(false);
    expect(isTransientNetworkFailure(new Error("LLM invoke failed (openai): 400 Bad Request"))).toBe(false);
    expect(isTransientNetworkFailure(new Error("does_not_fit: the frame shows a talk show"))).toBe(false);
    expect(isTransientNetworkFailure(null)).toBe(false);
  });
});

describe("VIDEO 659 fix D — invokeLLM", () => {
  it("recovers on the second attempt, after 2 s, and says so", async () => {
    answers(fetchFailed(), () => ok("the answer"));
    const t0 = Date.now();
    const out = await ask();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LLM_NETWORK_RETRY_WAIT_MS - 50);
    expect(LLM_NETWORK_RETRY_WAIT_MS).toBe(2_000);
    expect(calls).toBe(2);
    expect(out.choices[0]?.message?.content).toBe("the answer");
    expect(logs.some((l) => /\[LLM\] openai network failure \(attempt 1\/2\): fetch failed — one retry in 2s/.test(l))).toBe(true);
    expect(logs.some((l) => /\[LLM\] openai network retry succeeded \(attempt 2\/2\)/.test(l))).toBe(true);
    expect(logs.some((l) => /rate-limit retries/.test(l))).toBe(false);
  }, 10_000);

  it("two faults in a row: exactly two attempts, then the same failure as before — no third", async () => {
    answers(fetchFailed(), fetchFailed(), () => ok("never reached"));
    await expect(ask()).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(2);
    expect(logs.some((l) => /attempt 1\/2/.test(l))).toBe(true);
    expect(logs.some((l) => /\[LLM\] openai network\/timeout failure \(attempt 2\/2 — no further retry\): fetch failed/.test(l))).toBe(true);
  }, 10_000);

  it("a timeout is not retried (one attempt)", async () => {
    answers(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), () => ok("never reached"));
    await expect(ask()).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
  });

  it("an HTTP answer from OpenAI is not a network fault: no network retry", async () => {
    answers(() => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, statusText: "Bad Request" }), () => ok("never reached"));
    await expect(ask()).rejects.toThrow(/400/);
    expect(calls).toBe(1);
    expect(logs.some((l) => /attempt 1\/2/.test(l))).toBe(false);
  });

  it("an answer that arrives is never asked again, whatever it says", async () => {
    answers(() => ok(JSON.stringify({ frames: [] })), () => ok("second"));
    const out = await ask();
    expect(calls).toBe(1);
    expect(out.choices[0]?.message?.content).toBe(JSON.stringify({ frames: [] }));
  });
});

describe("VIDEO 659 fix D — the look before the download, through the real invokeLLM", () => {
  const SB: Storyboard = {
    durationSec: 600,
    width: 160,
    height: 90,
    rows: 5,
    columns: 5,
    fragments: Array.from({ length: 5 }, (_, j) => ({ url: `https://i.ytimg.com/sb/x/L2/M${j}.jpg`, durationSec: 120 })),
  };
  const deps = (): SheetDeps => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v659retry-"));
    return {
      workDir,
      fetchStoryboard: async () => SB,
      fetchBytes: async () => Buffer.from("jpeg"),
      fetchTranscript: async () => [],
      compose: async (_f, out) => {
        fs.writeFileSync(out, "sheet");
        return true;
      },
      ask: async () => {
        const r = await ask();
        const c = r.choices[0]?.message?.content;
        return typeof c === "string" ? c : null;
      },
      log: () => undefined,
    };
  };
  const SENTENCES = ["A factory floor in Fremont.", "Workers on the line.", "Cars leave the plant."];

  it("two network faults: no sheet — the video is not approved, it falls back to the one guessed section", async () => {
    answers(fetchFailed(), fetchFailed());
    const out = await lookBeforeDownload({ videoId: "ifr_Z0PZ434", title: "t", sentences: SENTENCES, durationSec: 600, deps: deps() });
    expect(out.kind).toBe("no_sheet");
    expect(calls).toBe(2);
  }, 10_000);

  it("one network fault, then the answer: the look goes on with the picture editor's verdict", async () => {
    answers(fetchFailed(), () => ok(JSON.stringify({ frames: [{ frame: 1, depicts: "a talk show studio", sentences: [] }] })));
    const out = await lookBeforeDownload({ videoId: "ifr_Z0PZ434", title: "t", sentences: SENTENCES, durationSec: 600, deps: deps() });
    expect(out.kind).toBe("nothing_fits");
    expect(calls).toBe(2);
  }, 10_000);
});
