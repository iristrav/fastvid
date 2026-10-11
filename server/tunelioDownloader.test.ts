import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  TUNELIO_CREATE_COST,
  TUNELIO_COOLDOWN_MS,
  acquireTunelioSource,
  clampWindow,
  cutWindowArgs,
  dropTunelioSources,
  isPrivateOrLocalAddress,
  readCreditsBalance,
  redactSecrets,
  resetTunelioStateForTests,
  retryAfterMs,
  TUNELIO_SOURCE_TTL_MS,
  tunelioCreateClaimKey,
  tunelioEnabled,
  tunelioStateSnapshot,
  validateDownloadUrl,
  validateDownloadUrlResolved,
  type TunelioDeps,
  type TunelioOutcome,
} from "./tunelioDownloader";

/**
 * TUNELIO FIRST — every rule of the route, without one paid call: the API is a scripted fetch,
 * the transfer writes bytes locally, ffprobe is a stub. See tunelioDownloader.ts for the rules.
 */
const KEY = "tk_test_secret_0123456789";
const VIDEO = "qIF8gAZbvuM";
const GOOD_URL = "https://cdn.tunelio.dev/tunnel/abc123?sig=xyz";

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };

function scriptedFetch(script: Record<string, Scripted | (() => Scripted)>, calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, redirect: init?.redirect });
    const key = Object.keys(script).find((k) => url.includes(k));
    if (!key) throw new Error(`unscripted ${url}`);
    const s = typeof script[key] === "function" ? (script[key] as () => Scripted)() : (script[key] as Scripted);
    const body = s.body === undefined ? "" : typeof s.body === "string" ? s.body : JSON.stringify(s.body);
    return new Response(body, { status: s.status, headers: s.headers ?? {} });
  }) as unknown as typeof fetch;
}

let dir: string;
let calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }>;
let downloads: Array<{ url: string; timeoutMs: number; maxBytes: number }>;
let logs: string[];
let clock: number;

beforeEach(() => {
  resetTunelioStateForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunelio-test-"));
  calls = [];
  downloads = [];
  logs = [];
  clock = 1_000_000;
});
afterEach(() => {
  dropTunelioSources();
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ TUNELIO_API_KEY: KEY, TUNELIO_ENABLED: "true", ...over });

function deps(over: Partial<TunelioDeps> & { script?: Record<string, Scripted | (() => Scripted)>; bytes?: number; probe?: TunelioDeps["probe"] } = {}): TunelioDeps {
  const script = over.script ?? {
    "/credits": { status: 200, body: { credits: 100 } },
    "/create": { status: 200, body: { status: "ok", url: GOOD_URL, filename: "v.mp4", quality: "720p", mode: "video", file_size: 123_456 } },
  };
  const bytes = over.bytes ?? 50_000;
  return {
    env: env(),
    fetchImpl: scriptedFetch(script, calls),
    download: over.download ?? (async (url, outPath, timeoutMs, maxBytes) => {
      downloads.push({ url, timeoutMs, maxBytes });
      fs.writeFileSync(outPath, Buffer.alloc(bytes, 1));
      return { ok: true, status: 200, bytes };
    }),
    probe: over.probe ?? (async () => ({ width: 1280, height: 720, durationSec: 212.4, hasAudio: true })),
    lookup: over.lookup ?? (async () => ["203.0.113.10"]),
    now: () => clock,
    sourceDir: dir,
    log: (l) => logs.push(l),
    ...over,
  };
}

const acquire = (d = deps(), opts = { timeoutMs: 30_000 }) => acquireTunelioSource(VIDEO, d, opts);
const createCalls = () => calls.filter((c) => c.url.includes("/create"));
const creditsCalls = () => calls.filter((c) => c.url.includes("/credits"));

describe("switches", () => {
  it("on ONLY with a key AND TUNELIO_ENABLED exactly \"true\"", () => {
    expect(tunelioEnabled(env())).toBe(true);
    expect(tunelioEnabled(env({ TUNELIO_ENABLED: " TRUE " }))).toBe(true);
    /** the opt-in is missing, empty or something else: off */
    expect(tunelioEnabled({ TUNELIO_API_KEY: KEY })).toBe(false);
    expect(tunelioEnabled(env({ TUNELIO_ENABLED: undefined }))).toBe(false);
    expect(tunelioEnabled(env({ TUNELIO_ENABLED: "" }))).toBe(false);
    expect(tunelioEnabled(env({ TUNELIO_ENABLED: "   " }))).toBe(false);
    for (const v of ["false", " FALSE ", "1", "yes", "on", "enabled", "tru", "true;", "True "])
      expect(tunelioEnabled(env({ TUNELIO_ENABLED: v })), `TUNELIO_ENABLED=${JSON.stringify(v)}`).toBe(v.trim().toLowerCase() === "true");
    /** the switch without a key is still off */
    expect(tunelioEnabled({ TUNELIO_ENABLED: "true" })).toBe(false);
    expect(tunelioEnabled({ TUNELIO_ENABLED: "true", TUNELIO_API_KEY: "   " })).toBe(false);
    expect(tunelioEnabled({})).toBe(false);
  });

  it("a missing or non-\"true\" TUNELIO_ENABLED is a value, not a call", async () => {
    for (const over of [{ TUNELIO_ENABLED: undefined }, { TUNELIO_ENABLED: "" }, { TUNELIO_ENABLED: "1" }, { TUNELIO_ENABLED: "yes" }]) {
      const out = await acquire(deps({ env: env(over) }));
      expect(out).toMatchObject({ ok: false, code: "DISABLED", paid: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("a missing key is a value, not a call", async () => {
    const out = await acquire(deps({ env: { TUNELIO_ENABLED: "true" } }));
    expect(out).toMatchObject({ ok: false, code: "NO_KEY", paid: false });
    expect(calls).toHaveLength(0);
  });

  it("TUNELIO_ENABLED=false is a value, not a call", async () => {
    const out = await acquire(deps({ env: env({ TUNELIO_ENABLED: "false" }) }));
    expect(out).toMatchObject({ ok: false, code: "DISABLED", paid: false });
    expect(calls).toHaveLength(0);
  });
});

describe("the happy path", () => {
  it("checks the balance, makes ONE /create with the key, downloads WITHOUT the key, probes, keeps the source", async () => {
    const out = (await acquire()) as TunelioOutcome;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(fs.existsSync(out.path)).toBe(true);
    expect(out.path.endsWith(".mp4")).toBe(true);
    expect(out).toMatchObject({ bytes: 50_000, durationSec: 212.4, width: 1280, height: 720, cached: false });
    expect(creditsCalls()).toHaveLength(1);
    expect(createCalls()).toHaveLength(1);
    const create = createCalls()[0]!;
    expect(create.url).toContain("quality=720p");
    expect(create.url).toContain(encodeURIComponent(`https://www.youtube.com/watch?v=${VIDEO}`));
    expect(create.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(create.redirect).toBe("manual");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.url).toBe(GOOD_URL);
    expect(downloads[0]!.timeoutMs).toBe(30_000);
    /** The transfer never sees the key: the download dep gets a URL and limits, nothing else. */
    expect(JSON.stringify(downloads)).not.toContain(KEY);
    expect(tunelioStateSnapshot().credits).toBe(100 - TUNELIO_CREATE_COST);
  });

  it("never prints the key or a URL", async () => {
    await acquire();
    const all = logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("cdn.tunelio.dev");
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).toContain("step=ready");
  });

  it("a second window of the same video is served from the kept source: no second /create", async () => {
    const first = await acquire();
    const second = await acquire();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.path).toBe(first.path);
    expect(second.cached).toBe(true);
    expect(createCalls()).toHaveLength(1);
    expect(tunelioStateSnapshot().stats.sourcesServed).toBe(1);
  });

  it("concurrent callers for one video share one in-flight /create", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      download: async (_url, outPath) => {
        await gate;
        fs.writeFileSync(outPath, Buffer.alloc(50_000, 1));
        return { ok: true, status: 200, bytes: 50_000 };
      },
    });
    const a = acquireTunelioSource(VIDEO, d, { timeoutMs: 30_000 });
    const b = acquireTunelioSource(VIDEO, d, { timeoutMs: 30_000 });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(createCalls()).toHaveLength(1);
  });

  it("the balance is cached for a while; after the TTL it is asked again", async () => {
    await acquire();
    resetSourcesOnly();
    clock += 1_000;
    await acquire();
    expect(creditsCalls()).toHaveLength(1);
    resetSourcesOnly();
    clock += 11 * 60_000;
    await acquire();
    expect(creditsCalls()).toHaveLength(2);
  });
});

/** Forget the kept source but keep balances and cooldowns, so the next call pays again. */
function resetSourcesOnly() {
  dropTunelioSources();
}

describe("credits", () => {
  it("an insufficient balance skips the route BEFORE any paid call and starts a cooldown", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 9 } } } }));
    expect(out).toMatchObject({ ok: false, code: "INSUFFICIENT_CREDITS", paid: false });
    expect(createCalls()).toHaveLength(0);
    const next = await acquire();
    expect(next).toMatchObject({ ok: false, code: "COOLDOWN" });
    expect(tunelioStateSnapshot(clock).cooldownMsLeft).toBeGreaterThan(0);
  });

  it("a balance that cannot be read is treated as insufficient: no paid call", async () => {
    for (const body of [{ ok: true }, "not json", { credits: "many" }]) {
      resetTunelioStateForTests();
      calls = [];
      const out = await acquire(deps({ script: { "/credits": { status: 200, body } } }));
      expect(out, JSON.stringify(body)).toMatchObject({ ok: false, code: "CREDITS_UNKNOWN", paid: false });
      expect(createCalls()).toHaveLength(0);
    }
  });

  it("a negative, non-numeric, boolean, nested or missing balance never leads to a paid call", async () => {
    const bodies: unknown[] = [
      { credits: -5 },
      { credits: "-10" },
      { credits: "abc" },
      { credits: true },
      { credits: null },
      { credits: { value: 100 } },
      { credits: [100] },
      { plan: "free" },
      "100",
      null,
    ];
    for (const body of bodies) {
      resetTunelioStateForTests();
      calls.length = 0;
      const out = await acquire(deps({ script: { "/credits": { status: 200, body }, "/create": { status: 200, body: { status: "ok", url: GOOD_URL } } } }));
      expect(out.ok, JSON.stringify(body)).toBe(false);
      expect((out as { code: string }).code, JSON.stringify(body)).toMatch(/^(INSUFFICIENT_CREDITS|CREDITS_UNKNOWN)$/);
      expect((out as { paid: boolean }).paid).toBe(false);
      expect(createCalls(), JSON.stringify(body)).toHaveLength(0);
    }
    /** exactly the documented cost is the floor: 9 is too little, 10 is enough */
    resetTunelioStateForTests();
    calls.length = 0;
    expect((await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 9 } } } }))).ok).toBe(false);
    expect(createCalls()).toHaveLength(0);
    resetTunelioStateForTests();
    calls.length = 0;
    expect((await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 10 } }, "/create": { status: 200, body: { status: "ok", url: GOOD_URL, file_size: 1000 } } } }))).ok).toBe(true);
    expect(createCalls()).toHaveLength(1);
  });

  it("the balance is read from any of the plausible field names", () => {
    expect(readCreditsBalance({ credits: 84 })).toBe(84);
    expect(readCreditsBalance({ balance: "16" })).toBe(16);
    expect(readCreditsBalance({ credits_left: 0 })).toBe(0);
    expect(Number.isNaN(readCreditsBalance({ plan: "trial" }))).toBe(true);
    expect(Number.isNaN(readCreditsBalance(null))).toBe(true);
  });

  it("a 402 on /create sets the balance to zero and puts the route on cooldown", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 402, body: { error: "insufficient_credits" } } } }));
    expect(out).toMatchObject({ ok: false, code: "INSUFFICIENT_CREDITS" });
    expect(tunelioStateSnapshot().credits).toBe(0);
    expect((await acquire()).ok).toBe(false);
    expect(createCalls()).toHaveLength(1);
  });

  it("a 401 on /credits puts the route on a long cooldown without a paid call", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 401, body: { error: "unauthorized" } } } }));
    expect(out).toMatchObject({ ok: false, code: "UNAUTHORIZED", paid: false });
    expect(createCalls()).toHaveLength(0);
    expect(tunelioStateSnapshot(clock).cooldownMsLeft).toBe(TUNELIO_COOLDOWN_MS.unauthorized);
  });
});

describe("one paid call across replicas (the claim store)", () => {
  it("the claim key names the video and the source window", () => {
    const k = tunelioCreateClaimKey(VIDEO, clock);
    expect(k).toBe(`tunelio:create:${VIDEO}:${Math.floor(clock / TUNELIO_SOURCE_TTL_MS)}`);
    expect(k.length).toBeLessThanOrEqual(128);
    expect(tunelioCreateClaimKey(VIDEO, clock + TUNELIO_SOURCE_TTL_MS)).not.toBe(k);
  });

  it("the worker whose claim lands makes the one /create; the claim is asked AFTER the balance and BEFORE the paid call", async () => {
    const claims: string[] = [];
    const out = await acquire(deps({ claimCreate: async (k) => (claims.push(k), true) }));
    expect(out.ok).toBe(true);
    expect(claims).toEqual([tunelioCreateClaimKey(VIDEO, clock)]);
    expect(creditsCalls()).toHaveLength(1);
    expect(createCalls()).toHaveLength(1);
    const order = calls.map((c) => (c.url.includes("/credits") ? "credits" : "create"));
    expect(order).toEqual(["credits", "create"]);
  });

  it("a claim held by another worker means NO paid call, not paid, remembered for the video, no cooldown for other videos", async () => {
    let asked = 0;
    const d = deps({ claimCreate: async () => (asked++, false) });
    const out = await acquire(d);
    expect(out).toMatchObject({ ok: false, code: "CLAIMED_ELSEWHERE", paid: false });
    expect(createCalls()).toHaveLength(0);
    /** the same video again: answered from memory, the store is not asked twice */
    const again = await acquire(d);
    expect(again).toMatchObject({ ok: false, code: "VIDEO_REFUSED" });
    expect(asked).toBe(1);
    expect(createCalls()).toHaveLength(0);
    expect(tunelioStateSnapshot(clock).cooldownMsLeft).toBe(0);
    /** another video is free to claim */
    const other = await acquireTunelioSource("otherVideo01", deps({ claimCreate: async () => true }), { timeoutMs: 30_000 });
    expect(other.ok).toBe(true);
    expect(createCalls()).toHaveLength(1);
  });

  it("a claim store that cannot answer means NO paid call either (fail closed), and is asked again next time", async () => {
    let asked = 0;
    const d = deps({ claimCreate: async () => { asked++; throw new Error("ECONNRESET db"); } });
    expect(await acquire(d)).toMatchObject({ ok: false, code: "CLAIM_UNKNOWN", paid: false });
    expect(await acquire(d)).toMatchObject({ ok: false, code: "CLAIM_UNKNOWN", paid: false });
    expect(asked).toBe(2);
    expect(createCalls()).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("a kept source is served without asking the claim store again", async () => {
    let asked = 0;
    const d = deps({ claimCreate: async () => (asked++, true) });
    expect((await acquire(d)).ok).toBe(true);
    expect((await acquire(d)).ok).toBe(true);
    expect(asked).toBe(1);
    expect(createCalls()).toHaveLength(1);
  });

  it("without a claim dependency (single process) the paid call goes out as before", async () => {
    expect((await acquire(deps())).ok).toBe(true);
    expect(createCalls()).toHaveLength(1);
  });
});

describe("the one paid call and its answers", () => {
  it("429 is a cooldown of Retry-After seconds, capped, and never a second /create", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "30" } } } }));
    expect(out).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(tunelioStateSnapshot(clock).cooldownMsLeft).toBe(30_000);
    expect((await acquire()).ok).toBe(false);
    expect(createCalls()).toHaveLength(1);
    expect(retryAfterMs("900")).toBe(TUNELIO_COOLDOWN_MS.rateLimitedMax);
    expect(retryAfterMs(null)).toBe(TUNELIO_COOLDOWN_MS.rateLimitedDefault);
  });

  it("404 marks the video as not served and is not asked again", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 404, body: { error: "not_found" } } } }));
    expect(out).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const again = await acquire();
    expect(again).toMatchObject({ ok: false, code: "VIDEO_REFUSED" });
    expect(createCalls()).toHaveLength(1);
  });

  it("a timeout on /create is TIMEOUT, counted as paid, and not repeated at once", async () => {
    const d = deps({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, headers: {} });
        if (url.includes("/credits")) return new Response(JSON.stringify({ credits: 100 }), { status: 200 });
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }) as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    try {
      const p = acquireTunelioSource(VIDEO, d, { timeoutMs: 30_000 });
      await vi.advanceTimersByTimeAsync(61_000);
      const out = await p;
      expect(out).toMatchObject({ ok: false, code: "TIMEOUT", paid: true });
    } finally {
      vi.useRealTimers();
    }
    expect(createCalls()).toHaveLength(1);
    expect(tunelioStateSnapshot(clock).cooldownMsLeft).toBeGreaterThan(0);
  });

  it("an answer without status ok, or with a non-video mode, is a paid failure remembered for the video", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 200, body: { status: "error" } } } }));
    expect(out).toMatchObject({ ok: false, code: "INVALID_RESPONSE", paid: true });
    expect(downloads).toHaveLength(0);
    expect(await acquire()).toMatchObject({ ok: false, code: "VIDEO_REFUSED" });
    expect(createCalls()).toHaveLength(1);
  });

  it("a declared file size over the ceiling is refused before the transfer", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 200, body: { status: "ok", url: GOOD_URL, file_size: 5_000_000_000 } } } }));
    expect(out).toMatchObject({ ok: false, code: "TOO_LARGE", paid: true });
    expect(downloads).toHaveLength(0);
  });
});

describe("the download URL is checked before a byte moves", () => {
  it.each([
    ["http://cdn.tunelio.dev/x", "not https"],
    ["https://user:pw@cdn.tunelio.dev/x", "credentials"],
    ["https://127.0.0.1/x", "ip literal"],
    ["https://10.0.0.5/x", "ip literal"],
    ["https://[::1]/x", "ip literal"],
    ["https://localhost/x", "local"],
    ["https://worker.internal/x", "local"],
    ["https://cdn/x", "no domain"],
    ["https://cdn.tunelio.dev:8443/x", "port"],
    ["ftp://cdn.tunelio.dev/x", "scheme"],
    ["", "empty"],
    [42, "not a string"],
  ])("%s is refused (%s)", (url) => {
    expect(validateDownloadUrl(url).ok).toBe(false);
  });

  it("a plain https host on 443 passes the static checks", () => {
    expect(validateDownloadUrl("https://cdn.tunelio.dev/tunnel/abc?sig=1").ok).toBe(true);
    expect(validateDownloadUrl("https://cdn.tunelio.dev:443/tunnel/abc").ok).toBe(true);
  });

  it("a host that resolves to a private, loopback or link-local address is refused", async () => {
    for (const addr of ["10.1.2.3", "192.168.0.9", "172.20.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "100.64.0.1"]) {
      const v = await validateDownloadUrlResolved(GOOD_URL, async () => ["203.0.113.1", addr]);
      expect(v.ok, addr).toBe(false);
      expect(isPrivateOrLocalAddress(addr), addr).toBe(true);
    }
    expect(isPrivateOrLocalAddress("203.0.113.1")).toBe(false);
    expect(isPrivateOrLocalAddress("2606:4700::1")).toBe(false);
    expect((await validateDownloadUrlResolved(GOOD_URL, async () => [])).ok).toBe(false);
    expect((await validateDownloadUrlResolved(GOOD_URL, async () => { throw new Error("ENOTFOUND"); })).ok).toBe(false);
  });

  it("an invalid signed URL from the API is a paid failure and no transfer", async () => {
    const out = await acquire(deps({ script: { "/credits": { status: 200, body: { credits: 100 } }, "/create": { status: 200, body: { status: "ok", url: "http://cdn.tunelio.dev/x" } } } }));
    expect(out).toMatchObject({ ok: false, code: "INVALID_URL", paid: true });
    expect(downloads).toHaveLength(0);
    const priv = await acquire(deps({ lookup: async () => ["10.0.0.1"] }));
    expect(priv).toMatchObject({ ok: false, code: "VIDEO_REFUSED" });
  });
});

describe("the transfer and the file", () => {
  it("a failed transfer (non-2xx, e.g. a refused redirect) is DOWNLOAD_FAILED, paid, never retried with the key", async () => {
    const out = await acquire(deps({ download: async () => ({ ok: false, status: 302, bytes: null }) }));
    expect(out).toMatchObject({ ok: false, code: "DOWNLOAD_FAILED", paid: true });
    expect(downloads).toHaveLength(0);
    expect(createCalls()).toHaveLength(1);
    expect(await acquire()).toMatchObject({ ok: false, code: "VIDEO_REFUSED" });
  });

  it("a transfer that throws on the byte ceiling is TOO_LARGE and leaves no part file", async () => {
    const out = await acquire(deps({ download: async (_u, outPath) => { fs.writeFileSync(outPath, "x"); throw new Error("response exceeds maximum size of 1 bytes"); } }));
    expect(out).toMatchObject({ ok: false, code: "TOO_LARGE", paid: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a transfer that times out is TIMEOUT and leaves no part file", async () => {
    const out = await acquire(deps({ download: async () => { throw new Error("Tunelio source: timeout after 30000ms"); } }));
    expect(out).toMatchObject({ ok: false, code: "TIMEOUT", paid: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a tiny body is EMPTY", async () => {
    const out = await acquire(deps({ bytes: 500 }));
    expect(out).toMatchObject({ ok: false, code: "EMPTY", paid: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an unreadable file, a file without video, and a file without audio are refused and deleted", async () => {
    const cases: Array<[TunelioDeps["probe"], string]> = [
      [async () => null, "INVALID_FILE"],
      [async () => ({ width: 0, height: 0, durationSec: 10, hasAudio: true }), "NO_VIDEO_STREAM"],
      [async () => ({ width: 1280, height: 720, durationSec: 10, hasAudio: false }), "NO_AUDIO_STREAM"],
      [async () => ({ width: 1280, height: 720, durationSec: 0, hasAudio: true }), "INVALID_FILE"],
    ];
    for (const [probe, code] of cases) {
      resetTunelioStateForTests();
      const out = await acquire(deps({ probe }));
      expect(out, code).toMatchObject({ ok: false, code, paid: true });
      expect(fs.readdirSync(dir), code).toEqual([]);
    }
  });

  it("the ceiling is handed to the transfer and a body over it is refused even when the transfer did not stop", async () => {
    const script = {
      "/credits": { status: 200, body: { credits: 100 } },
      "/create": { status: 200, body: { status: "ok", url: GOOD_URL, mode: "video" } },
    };
    const out = await acquireTunelioSource(VIDEO, deps({ script, bytes: 2_000 }), { timeoutMs: 1_000, maxBytes: 1_500 });
    expect(out).toMatchObject({ ok: false, code: "TOO_LARGE", paid: true });
    expect(downloads[0]!.maxBytes).toBe(1_500);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("helpers", () => {
  it("redactSecrets removes the key, bearer headers and URLs", () => {
    expect(redactSecrets(`key ${KEY} Bearer abc https://x.y/z?sig=1 end`, KEY)).toBe("key [REDACTED] Bearer [REDACTED] <url> end");
  });

  it("clampWindow keeps a window inside the source", () => {
    expect(clampWindow(10, 4, 212)).toEqual({ start: 10, duration: 4 });
    expect(clampWindow(210, 4, 212)).toEqual({ start: 208, duration: 4 });
    expect(clampWindow(5, 30, 20)).toEqual({ start: 0, duration: 20 });
    expect(clampWindow(-3, 4, 0)).toEqual({ start: 0, duration: 4 });
  });

  it("cutWindowArgs seeks before the input and re-encodes to mp4", () => {
    const args = cutWindowArgs("/s.mp4", "/d.mp4", 12.5, 4);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args[args.length - 1]).toBe("/d.mp4");
  });
});
