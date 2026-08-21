import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { generateLeonardoAIClip, generateRunwayClip } from "./videoPipeline";

// F3-13 finding 3.2: generateLeonardoAIClip's generate/poll requests and generateRunwayClip's
// create/poll requests used withTimeout(fetch(...)) — a zombie-timeout pattern that rejects the
// caller on time but never actually cancels the underlying request (no AbortController). Both now
// use fetchWithTimeout (real AbortController), matching every AI-image provider already fixed by
// F3-08-A (Stability AI). Only the transport is mocked here (node-fetch, the exact technique used
// by videoPipeline.f308AiProviders.test.ts) — the real timeout values, poll interval/max-attempts,
// and response parsing all run unmocked.
//
// LEONARDO_API_KEY / RUNWAY_API_KEY are module-level consts captured from process.env at import
// time, so this file must be run with those env vars already set.
vi.mock("node-fetch", () => ({ default: vi.fn() }));

import fetchModule from "node-fetch";
const mockedFetch = vi.mocked(fetchModule);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("Leonardo AI + Runway Gen-4 create/poll timeout (F3-13 finding 3.2, tests A-D)", () => {
  let dir: string;
  let outputPath: string;

  beforeEach(() => {
    // RONDE 30: these were never set anywhere, and the provider credentials used to be
    // captured at import time, so this file could only pass when someone prefixed the
    // vitest command with them by hand. The keys are read at call time now, so setting
    // them here is enough — and a real key in the environment still wins.
    process.env.LEONARDO_API_KEY = process.env.LEONARDO_API_KEY || "test-key";
    process.env.RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "test-key";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f313-test-"));
    outputPath = path.join(dir, "scene_0.mp4");
    mockedFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("Test A — Leonardo create: aborts within the 30s budget via a real AbortSignal, instead of a zombie request", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockedFetch.mockImplementation(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          capturedSignal = signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const resultPromise = generateLeonardoAIClip("a prompt", 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(capturedSignal?.aborted).toBe(true); // real cancellation, not just a caller-side reject
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("Test B — Leonardo poll: aborts within the 10s budget via a real AbortSignal", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockedFetch.mockResolvedValueOnce(jsonResponse({ sdGenerationJob: { generationId: "gen1" } })); // generate succeeds
    mockedFetch.mockImplementationOnce(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          capturedSignal = signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const resultPromise = generateLeonardoAIClip("a prompt", 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000); // poll interval wait
    await vi.advanceTimersByTimeAsync(10_000); // poll's own timeout budget
    // A thrown timeout (unlike an !ok response, which the loop `continue`s past) is not caught
    // inside the poll loop itself — it propagates straight to the function's outer try/catch, so
    // the function returns null after this single poll attempt rather than exhausting all 12.
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("Test C — Runway create: aborts within the 30s budget via a real AbortSignal, instead of a zombie request", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockedFetch.mockImplementation(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          capturedSignal = signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const resultPromise = generateRunwayClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(capturedSignal?.aborted).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("Test D — Runway poll: aborts within the 10s budget via a real AbortSignal", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: "task1" })); // create succeeds
    mockedFetch.mockImplementationOnce(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          capturedSignal = signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const resultPromise = generateRunwayClip("prompt", null, 5, outputPath, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // A thrown timeout (unlike an !ok response, which the loop `continue`s past) is not caught
    // inside the poll loop itself — it propagates straight to the function's outer try/catch, so
    // the function returns null after this single poll attempt rather than exhausting all 36.
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
