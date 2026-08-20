import { Readable } from "stream";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadStallTimeoutMs } from "./sourcingPolicy";

// RONDE 21 — the mechanism behind render 527's hang.
//
// fetchWithTimeout arms an AbortController, awaits fetch(), then clears its timer in `finally`.
// fetch() resolves the moment the response HEADERS arrive, so the timer is already disarmed before
// a single body byte is read. downloadToFileStreaming then did:
//
//     await pipeline(body, fs.createWriteStream(destPath));   // no timeout whatsoever
//
// Node streams have no inactivity timeout either. A server that sent headers and then went quiet
// (socket open, zero bytes) parked that await forever — and since every layer above it is a plain
// `await`, the whole render stopped behind one stalled socket. 49 call sites route through this
// one function, so the guard belongs here.
//
// These tests drive the real function with a body stream that never delivers, and one that
// delivers slowly, to prove the guard fires on "no progress" and NOT on "slow".

const STALL_MS = 5_000; // the helper's configurable floor — see downloadStallTimeoutMs()

let stallingBody: Readable;

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  const mockFetch = vi.fn(async () => ({
    ok: true,
    body: stallingBody,
    headers: { get: () => null },
  }));
  return { ...actual, default: mockFetch };
});

describe("RONDE 21 — a stalled download body can no longer hang the render", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r21-"));
    process.env.DOWNLOAD_STALL_TIMEOUT_MS = String(STALL_MS);
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DOWNLOAD_STALL_TIMEOUT_MS;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes an idle budget that is finite and env-overridable", () => {
    expect(downloadStallTimeoutMs()).toBe(STALL_MS);
    delete process.env.DOWNLOAD_STALL_TIMEOUT_MS;
    expect(downloadStallTimeoutMs()).toBe(30_000);
    expect(Number.isFinite(downloadStallTimeoutMs())).toBe(true);
  });

  it("rejects when the body delivers no bytes at all (the render-527 case)", async () => {
    // A body that produces nothing, ever — exactly a server that sent headers then went quiet.
    stallingBody = new Readable({ read() { /* never pushes, never ends */ } });
    const { downloadToFileStreaming } = await import("./videoPipeline");

    vi.useFakeTimers();
    const dest = path.join(dir, "stalled.mp4");
    const promise = downloadToFileStreaming("https://example.test/a.mp4", dest, 12_000, "stall test");
    const assertion = expect(promise).rejects.toThrow(/stalled — no data/);
    await vi.advanceTimersByTimeAsync(STALL_MS + 100);
    await assertion;
  });

  it("rejects mid-transfer when the bytes stop arriving", async () => {
    // Delivers one chunk, then goes silent — a transfer that dies partway through.
    stallingBody = new Readable({ read() { /* pushed manually below */ } });
    const { downloadToFileStreaming } = await import("./videoPipeline");

    vi.useFakeTimers();
    const dest = path.join(dir, "partial.mp4");
    const promise = downloadToFileStreaming("https://example.test/b.mp4", dest, 12_000, "partial test");
    const assertion = expect(promise).rejects.toThrow(/stalled — no data/);
    stallingBody.push(Buffer.alloc(1024));
    await vi.advanceTimersByTimeAsync(STALL_MS + 100);
    await assertion;
    // The half-written file must not be left behind for the composer to pick up.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("does NOT interrupt a slow but steadily progressing download", async () => {
    // Chunks keep arriving with gaps just under the idle window — total duration far exceeds it.
    // This is the regression guard: the fix must catch "no progress", never merely "slow".
    stallingBody = new Readable({ read() { /* pushed manually below */ } });
    const { downloadToFileStreaming } = await import("./videoPipeline");

    vi.useFakeTimers();
    const dest = path.join(dir, "slow.mp4");
    const promise = downloadToFileStreaming("https://example.test/c.mp4", dest, 12_000, "slow test");

    for (let i = 0; i < 4; i++) {
      stallingBody.push(Buffer.alloc(512));
      await vi.advanceTimersByTimeAsync(STALL_MS - 500); // just inside the window each time
    }
    stallingBody.push(null); // clean end of stream
    await vi.advanceTimersByTimeAsync(100);

    const { bytesWritten } = await promise;
    expect(bytesWritten).toBe(4 * 512); // ~20s total, well past the 5s idle window
    expect(fs.existsSync(dest)).toBe(true);
  });
});
