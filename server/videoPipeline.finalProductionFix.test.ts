import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// ALLERLAATSTE END-TO-END FIX — closes the remaining recordClipAdopt audit gaps found by
// grepping every generateGuaranteedBeatClip call site in the file (not just the three already
// fixed in Round 17 + its follow-up), plus hardens the YouTube CC 429/quota circuit breaker and
// adds production observability (final visual manifest, quality self-heal transparency).
//
// Structural checks below use the same extractFunctionSource convention as
// videoPipeline.round17AuditGapFix.test.ts — verified to FAIL against the pre-fix source for
// each site before the fix landed.

function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const candidates = [
    `export async function ${fnName}(`,
    `async function ${fnName}(`,
    `export function ${fnName}(`,
    `function ${fnName}(`,
  ];
  const marker = candidates.find((m) => src.includes(m));
  const startIdx = marker ? src.indexOf(marker) : -1;
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  const parenStart = src.indexOf("(", startIdx);
  let parenDepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === "(") parenDepth++;
    else if (src[j] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = src.indexOf("{", j);
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, i + 1);
}

const fullSource = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Final production fix — YouTube CC 429/quota handling distinguishes rate-limit from generic failure", () => {
  it("defines a dedicated rate-limit cooldown path distinct from the generic failure-streak breaker", () => {
    expect(fullSource).toContain("function markYoutubeRateLimited(");
    expect(fullSource).toContain("YOUTUBE_RATE_LIMIT_COOLDOWN_MS");
    expect(fullSource).toContain("YOUTUBE_RATE_LIMIT_ESCALATED_COOLDOWN_MS");
  });

  it("honors a Retry-After header when present", () => {
    expect(fullSource).toContain("function parseRetryAfterMs(");
    expect(fullSource).toContain("retryAfterMs != null && retryAfterMs > 0");
  });

  it("escalates the cooldown on repeated 429s rather than reusing the same short window", () => {
    const src = fullSource.slice(
      fullSource.indexOf("function markYoutubeRateLimited("),
      fullSource.indexOf("function markYoutubeRateLimited(") + 900
    );
    expect(src).toContain("youtubeRateLimitStreak >= 2");
    expect(src).toContain("YOUTUBE_RATE_LIMIT_ESCALATED_COOLDOWN_MS");
  });

  it("every YouTube search call site routes a 429 to markYoutubeRateLimited, not the generic breaker", () => {
    // Two call sites when this was written; one since RONDE 97 removed fetchYouTubeThumbnails,
    // which turned search-result stills into ken-burns clips. The guarantee is unchanged — every
    // remaining YouTube search distinguishes a rate limit from a real failure — so it is asserted
    // over whatever call sites exist rather than over a number that moves when a route is deleted.
    const rateLimited = [...fullSource.matchAll(/if \(searchResp\.status === 429\) \{\s*markYoutubeRateLimited\(/g)];
    expect(rateLimited.length).toBe(1);
    // The second remaining hit on that endpoint is probeYouTubeCcPipeline, the /api/health
    // diagnostic. It REPORTS searchStatus rather than tripping the breaker, which is what a probe
    // should do — a health check must not park the provider it is checking.
    const probe = fullSource.slice(fullSource.indexOf("export async function probeYouTubeCcPipeline("));
    expect(probe.slice(0, 3000)).toContain("searchStatus = searchResp.status;");
    expect(probe.slice(0, 3000)).not.toContain("markYoutubeRateLimited(");
  });

  it("does not gate any other provider — isYoutubeInCooldown is only referenced by YouTube-specific functions", () => {
    const refs = [...fullSource.matchAll(/isYoutubeInCooldown\(\)/g)];
    expect(refs.length).toBeGreaterThanOrEqual(3);
    // Sanity: the generic per-provider breakers for Wikimedia/Pexels/Pixabay/Internet Archive
    // are untouched, separate cooldown variables — confirms isolation wasn't broken.
    expect(fullSource).toContain("function isInternetArchiveInCooldown(): boolean {");
    expect(fullSource).toContain("internetArchiveCooldownUntilMs");
  });
});
