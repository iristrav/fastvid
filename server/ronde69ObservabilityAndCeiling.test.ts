import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimYoutubeDownloadSlot,
  createSourcingCache,
  providerMetrics,
  __resetProviderCircuitBreakersForTest,
} from "./videoPipeline";
import { youtubeMaxDownloadsPerRender } from "./sourcingPolicy";

/**
 * RONDE 69 — two things render 534 could not tell us, and one it told us wrong.
 *
 * FIX 1. The Wikimedia breaker tripped and the log gave no reason:
 *
 *     [Pipeline] Wikimedia: 3 consecutive search failures — skipping for 3min
 *
 * Three of the eight breaker sites are catches and announce themselves. The other five were
 * `!resp.ok` and returned in silence, so a 429, a 403 and an outage all looked identical to
 * "Wikimedia found nothing". In render 534 I read that silence as evidence the deploy had not
 * landed. It was not evidence of anything — it was a gap in observation.
 *
 * FIX 2. The render-wide YouTube ceiling overshot:
 *
 *     ceiling reached for this RENDER (20/20 downloads, 0 accepted here)
 *                                     (21/20 ...)  (22/20 ...)  (23/20 ...)
 *
 * RONDE 68 put the counter on the render-scoped metrics, which was right. But the check stayed
 * at the top of the candidate loop and the increment stayed after the download returned, with
 * two awaits in between. Concurrent callers all read 19, all passed, all downloaded.
 */

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ────────────────────────────── FIX 1 — the silence ────────────────────────────── */

describe("RONDE 69 FIX 1 — a Wikimedia HTTP failure says which HTTP failure it was", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r69-wiki-"));

  /**
   * videoPipeline reaches the network through `import fetch from "node-fetch"`, so that is the
   * transport a test has to stand in for — stubbing globalThis.fetch changes nothing and the
   * request goes out for real.
   *
   * The scene candidate cache is forced to a MISS as well, otherwise fetchWikimediaImages is
   * served from the pool and never gets as far as the search request under test.
   */
  async function loadWithFetch(impl: (...args: never[]) => unknown) {
    vi.resetModules();
    vi.doMock("node-fetch", () => ({ default: impl }));
    vi.doMock("./sceneCandidateCache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./sceneCandidateCache")>()),
      getCandidatePool: vi.fn(async () => null),
      putCandidatePool: vi.fn(async () => {}),
    }));
    const mod = await import("./videoPipeline");
    mod.__resetProviderCircuitBreakersForTest();
    return mod;
  }

  /** A response object with only the fields fetchWithTimeout's callers read on the failure path. */
  const refuseWith = (status: number, statusText: string) =>
    vi.fn(async () => ({ ok: false, status, statusText }));

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node-fetch");
    vi.doUnmock("./sceneCandidateCache");
  });

  it("TEST 1 — a refused search logs the status, where before it logged nothing", async () => {
    const f = refuseWith(429, "Too Many Requests");
    const mod = await loadWithFetch(f);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const workDir = dir();
    try {
      const out = await mod.fetchWikimediaImages("Führerbunker 1945", 3, workDir, 1, 1);
      expect(out).toEqual([]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    // The request really was made through the stub — otherwise this test proves nothing.
    expect(f.mock.calls.length).toBeGreaterThan(0);
    const lines = warn.mock.calls.map((c) => c.join(" "));
    const hit = lines.filter((l) => l.includes("Wikimedia") && l.includes("HTTP 429"));
    expect(hit.length).toBeGreaterThan(0);
    // The reason phrase too, so an operator does not have to look 429 up.
    expect(hit[0]).toContain("Too Many Requests");
    expect(hit[0]).toContain("counting as a provider failure");
  });

  it("TEST 2 — and the failure still counts: three of them trip the breaker exactly as before", async () => {
    const f = refuseWith(503, "Service Unavailable");
    const mod = await loadWithFetch(f);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const workDir = dir();
    try {
      for (let i = 0; i < 3; i++) await mod.fetchWikimediaImages(`q${i}`, 3, workDir, i, 1);
      const callsAfterTrip = f.mock.calls.length;
      expect(callsAfterTrip).toBeGreaterThanOrEqual(3);
      // Fourth attempt: the breaker is in cooldown, so no request leaves at all.
      await mod.fetchWikimediaImages("q3", 3, workDir, 3, 1);
      expect(f.mock.calls.length).toBe(callsAfterTrip);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const trips = warn.mock.calls
      .map((c) => c.join(" "))
      .filter((l) => l.includes("consecutive search failures"));
    expect(trips).toHaveLength(1);
    expect(trips[0]).toContain("skipping for 3min");
  });

  it("TEST 3 — a cancellation FastVid caused logs nothing and counts nothing", async () => {
    // A request that never answers, so only the enclosing scene budget can end it. That is the
    // exact shape of the render-533 cancellation: the abort arrives on the scope's signal while
    // the request's own 5s timer has not fired.
    const hang = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const mod = await loadWithFetch(hang as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const workDir = dir();
    try {
      await mod
        .withSceneFetchTimeout(
          () => mod.fetchWikimediaImages("cancelled", 3, workDir, 7, 1),
          250,
          "wikimedia scene budget"
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    expect(hang.mock.calls.length).toBeGreaterThan(0);
    const lines = warn.mock.calls.map((c) => c.join(" "));
    // Nothing claims an HTTP status, because there was no HTTP response.
    expect(lines.filter((l) => /Wikimedia .*HTTP \d/.test(l))).toEqual([]);
    // And no streak was built, so nothing can trip: our own budget cannot stand a source down.
    expect(lines.filter((l) => l.includes("consecutive search failures"))).toEqual([]);
    // Proof the cancellation was classified as ours: a fourth call still goes out, which it
    // could not do if three cancellations had counted as three provider failures.
    const before = hang.mock.calls.length;
    const workDir2 = dir();
    try {
      await mod.fetchWikimediaImages("after cancel", 3, workDir2, 8, 1);
    } finally {
      fs.rmSync(workDir2, { recursive: true, force: true });
    }
    expect(hang.mock.calls.length).toBeGreaterThan(before);
  }, 30_000);

  it("TEST 4 — the log can carry the status and nothing else: no URL, no query, no key, no body", () => {
    const src = PIPELINE();
    const start = src.indexOf("function logWikimediaHttpFailure(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end);

    // Everything it could read off the request or the response, and does not.
    for (const forbidden of ["url", "Url", "URL", "json(", "text(", "body", "headers", "KEY", "key"]) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain("resp.status");
    expect(body).toContain("resp.statusText");
  });

  it("TEST 4b — and at runtime it prints neither the search terms nor a credential", async () => {
    const f = refuseWith(403, "Forbidden");
    const mod = await loadWithFetch(f);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const SECRET = "sk-do-not-print-me";
    vi.stubEnv("WIKIMEDIA_API_KEY", SECRET);

    const workDir = dir();
    try {
      await mod.fetchWikimediaImages("Hitler bunker april 1945", 3, workDir, 2, 1);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("HTTP 403"));
    expect(line).toBeDefined();
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("commons.wikimedia.org");
    expect(line).not.toContain("srsearch");
    expect(line).not.toContain("?");
    expect(line).not.toContain("&");
    // The query terms themselves are search intent; they do not belong in a status line.
    expect(line).not.toContain("Hitler");
  });

  it("every !resp.ok Wikimedia site now logs before it counts — none is silent any more", () => {
    const lines = PIPELINE().split("\n");
    const silent: number[] = [];
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      if (!l.includes("markWikimediaSearchResult(false)")) return;
      // Only the !resp.ok sites; the catch sites carry the isScopeAbortError guard and their
      // own console.warn on the line below, and RONDE 68 pins those separately.
      if (l.includes("isScopeAbortError")) return;
      const above = lines.slice(Math.max(0, i - 4), i).join("\n");
      if (!above.includes("logWikimediaHttpFailure(")) silent.push(i + 1);
    });
    expect(silent).toEqual([]);
  });

  it("the breaker itself was not touched — same trip count, same cooldown, same call", () => {
    const src = PIPELINE();
    expect(src).toContain("const WIKIMEDIA_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;");
    expect(src).toContain("const WIKIMEDIA_COOLDOWN_MS = 3 * 60_000;");
    // No cooldown, retry or threshold was smuggled into the logging helper.
    const start = src.indexOf("function logWikimediaHttpFailure(");
    const body = src.slice(start, src.indexOf("\n}", start));
    for (const forbidden of ["Cooldown", "Streak", "retry", "await", "return "]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("the three guarded catch sites still classify cancellation exactly as RONDE 68 left them", () => {
    const src = PIPELINE();
    /**
     * RONDE 136 raised this from three to FOUR.
     *
     * The count is a guard against a cancellation-classifying site appearing unnoticed, so the
     * right response to a new one is to re-read it and record why — which is this comment. The
     * fourth site is fetchWikimediaImageInfoBatch, the batched imageinfo helper that replaced the
     * per-title request loop (video 558: 32 HTTP 429s, 34 provider stand-downs, 38 results, zero
     * downloads). It classifies exactly as RONDE 68 left the other three: a scope cancellation is
     * not a provider failure.
     */
    const guards = [...src.matchAll(/if \(!isScopeAbortError\(err\)\) markWikimediaSearchResult\(false\);/g)];
    expect(guards).toHaveLength(4);
  });
});

/* ─────────────────────────── FIX 2 — the ceiling that held ─────────────────────────── */

describe("RONDE 69 FIX 2 — the YouTube ceiling is claimed, not checked", () => {
  const LIMIT = () => youtubeMaxDownloadsPerRender();

  beforeEach(() => {
    __resetProviderCircuitBreakersForTest();
  });

  it("TEST A (sequential) — the limit is reached exactly, and the next claim is refused", () => {
    const cache = createSourcingCache();
    const limit = LIMIT();
    expect(limit).toBe(20);

    for (let i = 0; i < limit; i++) {
      expect(claimYoutubeDownloadSlot(cache, limit)).toBe(true);
    }
    // The 21st is refused, and every one after it.
    expect(claimYoutubeDownloadSlot(cache, limit)).toBe(false);
    expect(claimYoutubeDownloadSlot(cache, limit)).toBe(false);

    // And the counter never passes the limit — 21/20 is what render 534 printed.
    expect(providerMetrics(cache, "youtube_cc").downloadCount).toBe(limit);
  });

  it("TEST B (concurrent) — ten simultaneous requests with five slots left take exactly five", async () => {
    const cache = createSourcingCache();
    const limit = LIMIT();
    // Spend all but five.
    for (let i = 0; i < limit - 5; i++) expect(claimYoutubeDownloadSlot(cache, limit)).toBe(true);

    // Ten callers that each yield at an await before they would download — the render-534
    // interleaving, reproduced. If the claim were a check followed by a later increment, all
    // ten would pass here.
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const claimed = claimYoutubeDownloadSlot(cache, limit);
        // The "download" happens after the claim and is allowed to take time and to fail.
        await new Promise((r) => setTimeout(r, 5));
        return claimed;
      })
    );

    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.filter((r) => !r)).toHaveLength(5);
    expect(providerMetrics(cache, "youtube_cc").downloadCount).toBe(limit);
  });

  it("TEST B2 — a failed download does not give its slot back", () => {
    const cache = createSourcingCache();
    const limit = 3;
    for (let i = 0; i < limit; i++) {
      expect(claimYoutubeDownloadSlot(cache, limit)).toBe(true);
      // The download fails. Nothing is returned to the pool: the cap is on ATTEMPTS.
    }
    expect(claimYoutubeDownloadSlot(cache, limit)).toBe(false);
    expect(providerMetrics(cache, "youtube_cc").downloadCount).toBe(limit);
  });

  it("TEST C (isolation) — a render that spends its budget does not spend another render's", () => {
    const renderA = createSourcingCache();
    const renderB = createSourcingCache();
    const limit = LIMIT();

    for (let i = 0; i < limit; i++) expect(claimYoutubeDownloadSlot(renderA, limit)).toBe(true);
    expect(claimYoutubeDownloadSlot(renderA, limit)).toBe(false);

    expect(providerMetrics(renderA, "youtube_cc").downloadCount).toBe(limit);
    expect(providerMetrics(renderB, "youtube_cc").downloadCount).toBe(0);
    // B still has its full budget.
    expect(claimYoutubeDownloadSlot(renderB, limit)).toBe(true);
    expect(providerMetrics(renderB, "youtube_cc").downloadCount).toBe(1);
  });

  it("TEST C2 — nothing is shared between renders: no module-level counter backs this", () => {
    const src = PIPELINE();
    const start = src.indexOf("export function claimYoutubeDownloadSlot(");
    const body = src.slice(start, src.indexOf("\n}", start));
    // It reads and writes the render's own SourcingCache and nothing else.
    expect(body).toContain('providerMetrics(cache, "youtube_cc")');
    for (const forbidden of ["global", "Global", "process.", "Mutex", "lock", "queue", "await"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("TEST D (configurable) — YOUTUBE_MAX_DOWNLOADS_PER_RENDER=5 allows exactly five", () => {
    vi.stubEnv("YOUTUBE_MAX_DOWNLOADS_PER_RENDER", "5");
    const limit = youtubeMaxDownloadsPerRender();
    expect(limit).toBe(5);

    const cache = createSourcingCache();
    let allowed = 0;
    for (let i = 0; i < 25; i++) if (claimYoutubeDownloadSlot(cache, limit)) allowed++;
    expect(allowed).toBe(5);
    expect(providerMetrics(cache, "youtube_cc").downloadCount).toBe(5);
  });

  it("the claim happens BEFORE the download, with nothing awaited in between", () => {
    const src = PIPELINE();
    const claim = src.indexOf("if (!claimDownloadSlot()) {");
    expect(claim).toBeGreaterThan(-1);
    const download = src.indexOf("const ok = await downloadYouTubeCCClip(", claim);
    expect(download).toBeGreaterThan(claim);
    // Between refusing and downloading there is only the refusal's log and its break.
    const between = src.slice(claim, download);
    expect(between).not.toContain("await");
    expect(between).toContain("break;");
  });

  it("the read and the write inside the claim are not separated by anything", () => {
    const src = PIPELINE();
    const start = src.indexOf("export function claimYoutubeDownloadSlot(");
    const body = src.slice(src.indexOf("{", start), src.indexOf("\n}", start));
    const statements = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(statements).toEqual([
      "{",
      'const m = providerMetrics(cache, "youtube_cc");',
      "if (m.downloadCount >= maxDownloads) return false;",
      "m.downloadCount++;",
      "return true;",
    ]);
  });

  it("the post-download increment RONDE 68 relied on is gone — the slot is counted once", () => {
    const src = PIPELINE();
    const bumps = [...src.matchAll(/providerMetrics\(sourcingCache, "youtube_cc"\)\.downloadCount\+\+/g)];
    expect(bumps).toHaveLength(0);
    // Exactly one place increments YouTube's download count now.
    const inner = [...src.matchAll(/m\.downloadCount\+\+;/g)];
    expect(inner).toHaveLength(1);
  });

  it("every call site threads the render's cache, or the ceiling counts against a throwaway", () => {
    // providerMetrics(undefined, ...) returns a FRESH empty object every time — deliberately, so
    // metrics can never fail a render. The cost is that a call site which omits the cache has no
    // ceiling at all. Five of the ten omitted it.
    const src = PIPELINE();
    const lines = src.split("\n");
    const missing: number[] = [];
    lines.forEach((l, i) => {
      if (!l.includes("fetchYouTubeCCClips(")) return;
      if (l.includes("async function") || l.includes("export async function")) return;
      const start = src.indexOf("fetchYouTubeCCClips(", lines.slice(0, i).join("\n").length);
      let depth = 0;
      let j = src.indexOf("(", start + "fetchYouTubeCCClips".length - 1);
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      if (!src.slice(start, j + 1).includes("sourcingCache")) missing.push(i + 1);
    });
    expect(missing).toEqual([]);
  });

  it("YouTube is still bounded, not disabled, and the source order is unchanged", () => {
    const src = PIPELINE();
    expect(src).not.toContain("YOUTUBE_DISABLED");
    expect(youtubeMaxDownloadsPerRender()).toBeGreaterThan(0);
    // RONDE 68's priority statement is left exactly as it was.
    expect(src).toContain("/** Quick script-ordered rescue: YouTube CC first, then capped Pexels. */");
    expect(src).toContain("if (realFootageFirstEnabled() && !youtubeOnlySourcingEnabled()) {");
  });

  it("no retry was added — a refused claim ends the loop, it does not try again", () => {
    const src = PIPELINE();
    const claim = src.indexOf("if (!claimDownloadSlot()) {");
    const block = src.slice(claim, claim + 400);
    expect(block).not.toMatch(/retry|setTimeout|continue;/);
  });
});
