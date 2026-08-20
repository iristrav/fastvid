import { readFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// FASE 7 DEEL 2 — ENOENT burst fix.
//
// Root cause (proven against deployment_logs_railway_1787127211765.log, render 511):
// withSceneFetchTimeout()'s timeout path already calls hardAbortScope(scope), which calls
// scope.controller.abort() and kills tracked child processes — but fetchWithTimeout() (used by
// downloadToFileStreaming(), which both the Pexels and Pixabay person-stock-fallback download
// loops go through) only ever listened to its own local per-call timer, never to that scope
// signal. A scene/beat-level timeout therefore abandoned the *logical* download attempt (the
// caller got a rejection and moved on) while the underlying fetch + fs.createWriteStream write
// kept running fully detached — sometimes finishing only after the render had already returned
// its URL and deleted workDir in its `finally` cleanup, at which point the write failed with
// ENOENT because the directory it targeted no longer existed.
//
// The fix threads the scope's existing AbortSignal into fetchWithTimeout via AbortSignal.any(),
// reusing the exact mechanism hardAbortScope() already uses for child processes instead of
// inventing a new one. These tests mock the "node-fetch" module (the actual import used by
// server/videoPipeline.ts — not the global fetch) and exercise downloadToFileStreaming() and
// withSceneFetchTimeout() (both exported) directly. fetchWithTimeout() itself is intentionally
// private; this fix is only meaningful through its public callers.

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("node-fetch", () => ({ default: mockFetch }));

function fakeResponse(body: string, headers: Record<string, string> = {}): any {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: true,
    body: Readable.from([Buffer.from(body)]),
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  };
}

describe("FASE 7 — ENOENT lifecycle: scope timeout actually cancels the in-flight download", () => {
  let workDir: string;

  afterEach(() => {
    mockFetch.mockReset();
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("aborts the underlying fetch when the enclosing scope times out, instead of leaving it running detached", async () => {
    const { downloadToFileStreaming, withSceneFetchTimeout } = await import("./videoPipeline");
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fase7-enoent-abort-"));
    const destPath = path.join(workDir, "scene_0_b0_person_stock_vid1_raw.mp4");

    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: unknown, opts: any) => {
      capturedSignal = opts?.signal;
      // Never resolves on its own — simulates a slow/stuck provider response. Before the FASE 7
      // fix, nothing but this fetch's own (here: 60s) internal timer could ever settle it, so a
      // fast scope-level timeout would abandon it while it kept running. After the fix, the
      // scope's abort() reaches this signal directly.
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(
      withSceneFetchTimeout(
        () => downloadToFileStreaming("https://example.invalid/video.mp4", destPath, 60_000, "test download"),
        50, // scope times out almost immediately — far shorter than the download's own 60s timer
        "test scope"
      )
    ).rejects.toThrow();

    // The decisive assertion: the signal actually passed to fetch() was aborted by the scope
    // timeout, not left dangling. Before the fix this was always false here (fetchWithTimeout's
    // signal was independent of the scope), so the mocked fetch's promise — and the real
    // download it stands in for — would simply never settle.
    expect(capturedSignal?.aborted).toBe(true);

    // The partial file must not exist afterward — downloadToFileStreaming's existing
    // catch-and-unlink behavior (unchanged by this fix) still applies once the fetch rejects.
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("does not touch the abort signal when there is no enclosing scope (no behavior change for non-scoped callers)", async () => {
    const { downloadToFileStreaming } = await import("./videoPipeline");
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fase7-enoent-noscope-"));
    const destPath = path.join(workDir, "no_scope_raw.mp4");

    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: unknown, opts: any) => {
      capturedSignal = opts?.signal;
      return Promise.resolve(fakeResponse("x".repeat(60_000), { "content-length": "60000" }));
    });

    // Called directly, with no withSceneFetchTimeout scope around it.
    const { response } = await downloadToFileStreaming(
      "https://example.invalid/video.mp4",
      destPath,
      5_000,
      "unscoped download"
    );

    expect(response.ok).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);
    expect(fs.existsSync(destPath)).toBe(true);
  });

  it("successful download writes the file, and cleanup afterward (fs.rmSync) succeeds cleanly", async () => {
    const { downloadToFileStreaming, withSceneFetchTimeout } = await import("./videoPipeline");
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fase7-enoent-success-"));
    const destPath = path.join(workDir, "scene_1_b2_person_stock_vid2_raw.mp4");
    const body = "x".repeat(60_000);

    mockFetch.mockImplementation(() =>
      Promise.resolve(fakeResponse(body, { "content-length": String(body.length) }))
    );

    const { response, bytesWritten } = await withSceneFetchTimeout(
      () => downloadToFileStreaming("https://example.invalid/video.mp4", destPath, 5_000, "successful download"),
      5_000,
      "test scope"
    );

    expect(response.ok).toBe(true);
    expect(bytesWritten).toBe(body.length);
    expect(fs.existsSync(destPath)).toBe(true);

    // Mirrors the render's own `finally { fs.rmSync(workDir, { recursive: true, force: true }) }`
    // — must not throw just because a completed download's file is sitting in workDir.
    expect(() => fs.rmSync(workDir, { recursive: true, force: true })).not.toThrow();
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("a genuine download failure (non-timeout) still cleans up the partial file, unchanged", async () => {
    const { downloadToFileStreaming } = await import("./videoPipeline");
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fase7-enoent-failure-"));
    const destPath = path.join(workDir, "scene_2_b1_person_stock_vid3_raw.mp4");

    mockFetch.mockImplementation(() => Promise.reject(new Error("network error")));

    await expect(
      downloadToFileStreaming("https://example.invalid/video.mp4", destPath, 5_000, "failing download")
    ).rejects.toThrow("network error");

    expect(fs.existsSync(destPath)).toBe(false);
  });
});

describe("FASE 7 — source-level checks: fix location and constraints", () => {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("fetchWithTimeout merges the scene-fetch scope's AbortSignal via AbortSignal.any, reusing the existing scope mechanism", () => {
    const idx = src.indexOf("async function fetchWithTimeout(");
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 1800);
    expect(scoped).toContain("sceneFetchScopeStorage.getStore()?.controller.signal");
    expect(scoped).toContain("AbortSignal.any([controller.signal, scopeSignal])");
  });

  it("downloadToFileStreaming was NOT reverted back to buffering the whole response via arrayBuffer()", () => {
    const idx = src.indexOf("export async function downloadToFileStreaming(");
    expect(idx).toBeGreaterThan(-1);
    // RONDE 21 widened this window: the function grew when the body-read stall guard was added,
    // pushing createWriteStream past the old fixed 3500-char slice. The assertion itself is
    // unchanged — this still proves the function streams to disk rather than buffering.
    const scoped = src.slice(idx, idx + 6000);
    expect(scoped).not.toContain("arrayBuffer()");
    expect(scoped).toContain("fs.createWriteStream(destPath)");
  });

  it("no new retry/circuit-breaker/mkdir-workaround was introduced by this fix", () => {
    const idx = src.indexOf("async function fetchWithTimeout(");
    const scoped = src.slice(idx, idx + 1800);
    expect(scoped).not.toContain("mkdirSync");
    expect(scoped).not.toContain("circuitBreaker");
    expect(scoped.match(/retries--/g) ?? []).toHaveLength(0);
  });
});
