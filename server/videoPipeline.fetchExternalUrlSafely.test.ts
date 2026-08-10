import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchExternalUrlSafely } from "./videoPipeline";

// F3-07 finding 3.1: fetchExternalUrlSafely() used a bare fetch() with no timeout at all for
// the custom-voiceover download — a stalled response could hang the whole render indefinitely.
// It now routes every hop through fetchWithTimeout (real AbortController), with the SSRF/
// redirect-validation logic (assertSafeExternalUrl / isPrivateOrReservedIp) left exactly as-is
// and completely unmocked here.
//
// assertSafeExternalUrl unconditionally rejects every loopback/private/reserved address — which
// means a real local http.Server (127.0.0.1, ::1, etc.) can never be used as a target here
// without weakening the exact guard this fix must leave untouched. Instead, these tests target
// a real, genuinely-public IP literal (8.8.8.8) so the SSRF check runs for real and legitimately
// allows it (no mocking of the guard itself), and mock only node-fetch's actual network I/O
// (the layer fetchWithTimeout calls) — the same "mock the primitive, exercise the real
// timeout/redirect logic" approach used for F3-06.
vi.mock("node-fetch", () => ({ default: vi.fn() }));

import fetchModule from "node-fetch";
const mockedFetch = vi.mocked(fetchModule);

function fakeResponse(over: Partial<{ ok: boolean; status: number; location: string | null; body: Buffer }>) {
  const body = over.body ?? Buffer.alloc(0);
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? over.location ?? null : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Awaited<ReturnType<typeof fetchModule>>;
}

describe("fetchExternalUrlSafely timeout (F3-07)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("fails within the given timeout when the response never completes", async () => {
    mockedFetch.mockImplementation(
      (_url, opts?: Record<string, unknown>) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }) as ReturnType<typeof fetchModule>
    );

    const start = Date.now();
    await expect(fetchExternalUrlSafely("http://8.8.8.8/audio.mp3", 5, 300)).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3_000); // nowhere near a real unbounded hang
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("still completes a normal successful download", async () => {
    const payload = Buffer.from("fake-mp3-bytes");
    mockedFetch.mockResolvedValue(fakeResponse({ ok: true, status: 200, body: payload }));

    const resp = await fetchExternalUrlSafely("http://8.8.8.8/audio.mp3", 5, 5_000);
    expect(resp.ok).toBe(true);
    const body = Buffer.from(await resp.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
  });

  it("still rejects a redirect to a disallowed internal address (SSRF guard unchanged)", async () => {
    mockedFetch.mockResolvedValue(
      fakeResponse({ ok: false, status: 302, location: "http://169.254.169.254/latest/meta-data/" })
    );

    await expect(fetchExternalUrlSafely("http://8.8.8.8/audio.mp3", 5, 5_000)).rejects.toThrow(
      /disallowed address/i
    );
  });

  it("still rejects localhost outright, before ever making a request", async () => {
    await expect(
      fetchExternalUrlSafely("http://localhost:1/audio.mp3", 5, 5_000)
    ).rejects.toThrow(/not allowed/i);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
