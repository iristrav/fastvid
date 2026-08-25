import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isScopeAbortError, withSceneFetchTimeout, fetchWithTimeout } from "./videoPipeline";

/**
 * RONDE 68 — a cancellation FastVid caused is not a provider fault.
 *
 * Render 533, Wikimedia:
 *
 *     [Pipeline] Wikimedia search failed for scene 1: Error: Aborted: Wikimedia search scene 1
 *                was cancelled by the enclosing scene budget
 *     [Pipeline] Wikimedia: 3 consecutive search failures — skipping for 3min
 *
 *     wikimedia: searches=0  results=0  downloads=0  accepted=0
 *
 * The pipeline cancelled Wikimedia, recorded Wikimedia as broken, and stood the source down for
 * the rest of the render. For a Führerbunker documentary that is the source.
 *
 * The mechanism to tell the two apart already existed — isScopeAbortError, added in RONDE 52 —
 * and had been applied to YouTube only. Sixteen catch-based breaker sites, three guarded.
 *
 * These tests pin the classification rule, not a new architecture: an error raised because OUR
 * budget ran out must not increment a provider's failure streak; an error the provider itself
 * produced must.
 */

const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Every `markXSearchResult(false)` and whether it is guarded, classified by its cause. */
function breakerSites() {
  const src = SRC().split("\n");
  const out: Array<{ line: number; provider: string; cause: "catch" | "http"; guarded: boolean }> = [];
  src.forEach((line, i) => {
    // Comments mention these markers too — RONDE 52 quotes one by name. Only real code counts.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const m = /mark(\w+)SearchResult\(false\)/.exec(line);
    if (!m) return;
    const ctx = src.slice(Math.max(0, i - 12), i).join("\n");
    const lastCatch = ctx.lastIndexOf("catch (");
    const lastNotOk = ctx.lastIndexOf("Resp.ok");
    out.push({
      line: i + 1,
      provider: m[1]!,
      cause: lastCatch > lastNotOk ? "catch" : "http",
      guarded: line.includes("isScopeAbortError"),
    });
  });
  return out;
}

describe("RONDE 68 TEST 1 — a scene-budget cancellation of Wikimedia is not a provider failure", () => {
  it("every Wikimedia catch site exempts the cancellation FastVid caused", () => {
    const wiki = breakerSites().filter((s) => s.provider === "Wikimedia" && s.cause === "catch");
    expect(wiki.length).toBeGreaterThan(0);
    for (const s of wiki) expect(s.guarded).toBe(true);
  });

  it("the two catches whose warnings appear verbatim in render 533 are among them", () => {
    const src = SRC();
    for (const marker of [
      "[Pipeline] Wikimedia search failed for scene ${sceneIndex}:",
      "[Pipeline] Wikimedia video search failed for scene ${sceneIndex}:",
    ]) {
      const idx = src.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      // The guard sits immediately above the warning that render 533 printed.
      expect(src.slice(Math.max(0, idx - 300), idx)).toContain(
        "if (!isScopeAbortError(err)) markWikimediaSearchResult(false);"
      );
    }
  });

  it("the error a cancelled fetch really produces is recognised as self-inflicted", async () => {
    const http = await import("http");
    const sockets: import("net").Socket[] = [];
    const server = http.createServer(() => {
      /* never answers */
    });
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      let inner: unknown;
      await withSceneFetchTimeout(
        async () => {
          try {
            await fetchWithTimeout(`http://127.0.0.1:${port}/x`, 20_000, "Wikimedia search scene 1");
          } catch (e) {
            inner = e;
          }
          return null;
        },
        250,
        "wikimedia scene budget"
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 350));
      expect(isScopeAbortError(inner)).toBe(true);
      expect((inner as Error).message).toContain("cancelled by the enclosing scene budget");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("RONDE 68 TEST 2 — a real Wikimedia HTTP failure still counts", () => {
  it("the !resp.ok sites are deliberately left unguarded — the provider did fail", () => {
    const wikiHttp = breakerSites().filter((s) => s.provider === "Wikimedia" && s.cause === "http");
    expect(wikiHttp.length).toBeGreaterThan(0);
    for (const s of wikiHttp) expect(s.guarded).toBe(false);
  });

  it("an ordinary error is not mistaken for a cancellation", () => {
    expect(isScopeAbortError(new Error("HTTP 503"))).toBe(false);
    expect(isScopeAbortError(new Error("Timeout: Wikimedia search exceeded 6s"))).toBe(false);
    expect(isScopeAbortError(new Error("ENOTFOUND commons.wikimedia.org"))).toBe(false);
    expect(isScopeAbortError(null)).toBe(false);
    expect(isScopeAbortError(undefined)).toBe(false);
    expect(isScopeAbortError("aborted")).toBe(false);
  });

  it("the breaker itself is untouched — same trip count, same cooldown", () => {
    const src = SRC();
    expect(src).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
    expect(src).toContain("const WIKIMEDIA_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;");
    expect(src).toContain("const WIKIMEDIA_COOLDOWN_MS = 3 * 60_000;");
  });
});

describe("RONDE 68 TEST 3 — one provider's cancellation cannot trip another's breaker", () => {
  it("each guard names its own provider's marker, so no streak is shared", () => {
    const src = SRC().split("\n");
    const guarded = src.filter((l) => l.includes("isScopeAbortError(err)) mark"));
    expect(guarded.length).toBeGreaterThanOrEqual(13);
    for (const line of guarded) {
      const m = /if \(!isScopeAbortError\(err\)\) mark(\w+)SearchResult\(false\);/.exec(line.trim());
      expect(m).not.toBeNull();
    }
  });

  it("YouTube's own guards are unchanged", () => {
    const src = SRC();
    const yt = [...src.matchAll(/if \(!isScopeAbortError\(err\)\) markYoutubeSearchResult\(false\);/g)];
    expect(yt.length).toBe(3);
  });

  it("every provider with a catch-based breaker is now guarded, not just Wikimedia", () => {
    const unguarded = breakerSites().filter((s) => s.cause === "catch" && !s.guarded);
    expect(unguarded).toEqual([]);
  });

  it("GDELT's accumulated error flag is classified the same way", () => {
    expect(SRC()).toContain("if (!isScopeAbortError(err)) gdeltAnyError = true;");
  });
});

describe("RONDE 68 TEST 4/5 — the archival sources get their turn", () => {
  it("the existing source order is left as designed, not rewritten", () => {
    const src = SRC();
    // resolveBeatClipFast states its intent in its own docstring. RONDE 68 does not overrule it:
    // the brief is to stop YouTube CONSUMING the budget, not to reorder the cascade.
    expect(src).toContain("/** Quick script-ordered rescue: YouTube CC first, then capped Pexels. */");
    expect(src).toContain("if (realFootageFirstEnabled() && !youtubeOnlySourcingEnabled()) {");
  });

  it("YouTube cannot spend the whole render's fetch budget on downloads", () => {
    const src = SRC();
    // Render-scoped ceiling (RONDE 68, commit 2866c8b) — not a per-call local.
    expect(src).toContain('const downloadsSoFar = () => providerMetrics(sourcingCache, "youtube_cc").downloadCount;');
    expect([...src.matchAll(/downloadsSoFar\(\) >= maxDownloadAttempts/g)]).toHaveLength(3);
  });

  it("and cannot start a transfer the remaining scene budget cannot finish", () => {
    const src = SRC();
    expect(src).toContain("remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS");
    expect(src).toContain("not enough to finish");
  });

  it("a cancelled archival search no longer removes the source for three minutes", () => {
    // The full chain from render 533, now broken at its first link.
    const src = SRC();
    const cancel = src.indexOf("if (!isScopeAbortError(err)) markWikimediaSearchResult(false);");
    expect(cancel).toBeGreaterThan(-1);
    expect(src).toContain("skipping for ${Math.round(WIKIMEDIA_COOLDOWN_MS / 60_000)}min");
  });
});

describe("RONDE 68 TEST 6/7/8 — nothing was loosened to achieve this", () => {
  it("TEST 6 — the provider caches are untouched", () => {
    const src = SRC();
    expect(src).toContain("getCachedProviderAsset");
    expect(src).toContain("putCachedProviderAsset");
    expect(src).toContain("getCandidatePool");
    expect(src).toContain("putCandidatePool");
  });

  it("TEST 7 — the candidate caps are untouched", () => {
    const src = SRC();
    expect(src).toContain("maxVisualCandidatesPerBeatTry");
    expect(src).toContain("MAX_FUNNEL_CANDIDATES_TO_SCORE");
  });

  it("TEST 8 — no request lost its limiter or its timeout", () => {
    const src = SRC();
    // providerLimiter still fronts the provider calls, and fetchWithTimeout still bounds them.
    expect([...src.matchAll(/providerLimiter\(/g)].length).toBeGreaterThan(10);
    expect([...src.matchAll(/fetchWithTimeout\(/g)].length).toBeGreaterThan(10);
    // The guard adds a condition to a breaker call; it starts no request of its own.
    const guardLines = src.split("\n").filter((l) => l.includes("isScopeAbortError(err)) mark"));
    for (const l of guardLines) {
      expect(l).not.toContain("fetch");
      expect(l).not.toContain("await");
    }
  });

  it("TEST 8 — no retry was added anywhere in this change", () => {
    const src = SRC();
    // A guard must never turn into "try again".
    const guardLines = src.split("\n").filter((l) => l.includes("isScopeAbortError(err))"));
    for (const l of guardLines) expect(l).not.toMatch(/retry|again|continue;/i);
  });
});
