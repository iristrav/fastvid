import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { pipeline } from "stream/promises";
import fetch from "node-fetch";

// F3-14 finding 3.3: the custom-voiceover download's final body-read
// (Buffer.from(await resp.arrayBuffer())) had no timeout coverage at all — fetchWithTimeout's
// AbortController only protected fetchExternalUrlSafely up to the response headers arriving; its
// internal clearTimeout fired the instant fetch() itself resolved, before the caller ever started
// reading the body. fetchExternalUrlSafely (server/videoPipeline.ts) now passes
// AbortSignal.timeout(timeoutMs) straight into fetch() per redirect hop instead — the signal
// stays armed for the life of the request, so it also covers the body-read on the final
// (non-redirect) response. The caller (the customVoiceoverUrl branch of _runVideoPipelineInner,
// not separately exported) now streams that body straight to disk via pipeline() instead of
// buffering the whole file in memory, cleaning up any partial file on failure.
//
// IMPORTANT — why these tests don't call the real, exported fetchExternalUrlSafely directly:
// assertSafeExternalUrl (the SSRF guard fetchExternalUrlSafely always runs first, deliberately
// NOT touched by F3-14) unconditionally rejects every loopback/private/reserved address,
// including 127.0.0.1 — so a real local http.Server can never be reached through
// fetchExternalUrlSafely itself. This is documented, established precedent in this exact
// codebase: the existing videoPipeline.fetchExternalUrlSafely.test.ts deliberately mocks
// node-fetch and targets a real public IP literal for exactly this reason, instead of a local
// server. These tests take the complementary approach: they exercise the real per-hop fetch
// mechanism fetchExternalUrlSafely now uses (fetch + AbortSignal.timeout(timeoutMs) +
// redirect-manual, looped exactly like the production redirect loop) against a real local
// server, to prove the actual new timeout/streaming behavior end-to-end — while the SSRF guard
// itself (already proven, already untouched) is covered separately by the existing test file.
// fetchLikeCustomVoiceover() below is a byte-for-byte match of fetchExternalUrlSafely's loop body
// minus the assertSafeExternalUrl() call, and downloadCustomVoiceover() matches the Stage 2
// caller's body-consumption lines exactly.
//
// AbortSignal.timeout()'s internal timer is not affected by vi.useFakeTimers() (confirmed
// empirically during F3-13) — Test A therefore uses a real wall-clock wait against the real
// 60_000ms production default, matching F3-13's Test E/F precedent. This makes it slow (~60s) but
// it is the only way to genuinely exercise the real cancellation mechanism.
const CUSTOM_VOICEOVER_TIMEOUT_MS = 60_000;

async function fetchLikeCustomVoiceover(
  rawUrl: string,
  maxRedirects = 5,
  timeoutMs = CUSTOM_VOICEOVER_TIMEOUT_MS
): ReturnType<typeof fetch> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resp = await fetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return resp;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error("redirected too many times");
}

describe("custom-voiceover download body-timeout + streaming (F3-14 finding 3.3)", () => {
  let dir: string;
  let customAudioPath: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function startServer(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  /** Matches the Stage 2 custom-voiceover caller's body-consumption lines in
   *  _runVideoPipelineInner exactly: !resp.ok / !resp.body checks, then pipeline() straight to
   *  disk, with partial-file cleanup on any failure. */
  async function downloadCustomVoiceover(url: string): Promise<void> {
    const resp = await fetchLikeCustomVoiceover(url);
    if (!resp.ok) throw new Error(`Failed to download custom voiceover: ${resp.status}`);
    if (!resp.body) throw new Error("Custom voiceover download returned no response body");
    try {
      await pipeline(resp.body, fs.createWriteStream(customAudioPath));
    } catch (err) {
      if (fs.existsSync(customAudioPath)) {
        try { fs.unlinkSync(customAudioPath); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  it("Test A — a stalled body (headers + partial data, never completed) is aborted by the real 60s timeout, not left hanging, with no partial file left behind", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f314-hang-test-"));
    customAudioPath = path.join(dir, "custom_voiceover.mp3");
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.write(Buffer.alloc(20_000, "a")); // partial body
      // never call res.end() — the body never completes
    });

    const start = Date.now();
    await expect(downloadCustomVoiceover(`${baseUrl}/voice.mp3`)).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThan(50_000); // genuinely bounded by the ~60s timeout, not an early/unrelated rejection
    expect(elapsed).toBeLessThan(70_000); // aborted at ~60s, not left hanging indefinitely
    expect(fs.existsSync(customAudioPath)).toBe(false); // no partial file left behind
  }, 75_000);

  it("Test B — a normal, complete download succeeds: file exists with the correct size and content", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f314-success-test-"));
    customAudioPath = path.join(dir, "custom_voiceover.mp3");
    const payload = Buffer.from("x".repeat(50_000));
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(payload);
    });

    await downloadCustomVoiceover(`${baseUrl}/voice.mp3`);

    expect(fs.existsSync(customAudioPath)).toBe(true);
    expect(fs.statSync(customAudioPath).size).toBe(payload.length);
    expect(fs.readFileSync(customAudioPath).equals(payload)).toBe(true);
  }, 15_000);

  it("Test D — a single real redirect still resolves to the final content, streamed correctly (per-hop fresh AbortSignal)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f314-redirect-test-"));
    customAudioPath = path.join(dir, "custom_voiceover.mp3");
    const payload = Buffer.from("y".repeat(30_000));
    await startServer((req, res) => {
      if (req.url === "/redirect.mp3") {
        res.writeHead(302, { Location: "/final.mp3" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(payload);
    });

    await downloadCustomVoiceover(`${baseUrl}/redirect.mp3`);

    expect(fs.existsSync(customAudioPath)).toBe(true);
    expect(fs.statSync(customAudioPath).size).toBe(payload.length);
    expect(fs.readFileSync(customAudioPath).equals(payload)).toBe(true);
  }, 15_000);
});
