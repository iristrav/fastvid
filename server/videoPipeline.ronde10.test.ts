import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 10 — quota-free YouTube search fallback.
//
// The official YouTube Data API search costs 100 quota units per call (~100/day), so it 429s
// after a handful of renders — the sole reason YouTube contributed 0 clips in renders 512-518
// (every search got a 429). This adds an opt-in RapidAPI (scraped, quota-free) search fallback,
// used ONLY when the official search is unavailable AND ONLY for the fair-use path: RapidAPI
// search cannot confirm a Creative Commons license, so the strict-CC path is never routed
// through it, and the CC guarantee is untouched.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("RONDE 10 — the fallback is strictly opt-in and key-gated", () => {
  const fn = codeOnly(
    pipelineSrc.slice(
      pipelineSrc.indexOf("function youtubeRapidSearchFallbackEnabled()"),
      pipelineSrc.indexOf("const RAPIDAPI_YT_SEARCH_HOST")
    )
  );

  it("requires both the explicit flag AND a RapidAPI key", () => {
    // RONDE 18 follow-up: the literal `=== "true"` moved into the case-tolerant envFlagIsOn helper.
    expect(fn).toContain('envFlagIsOn("ENABLE_YOUTUBE_RAPID_SEARCH")');
    expect(fn).toContain("Boolean(RAPIDAPI_KEY)");
  });

  it("is off unless the flag is exactly 'true' (not merely set)", () => {
    // Guards against the loose `!== "false"` default that would enable it silently.
    expect(fn).not.toContain('!== "false"');
  });
});

describe("RONDE 10 — the CC guarantee is never routed through the scraped search", () => {
  it("the fallback fires only for the fair-use path (license === 'any')", () => {
    const idx = pipelineSrc.indexOf("let effectiveSearchData = searchData;");
    expect(idx).toBeGreaterThan(-1);
    const block = codeOnly(pipelineSrc.slice(idx, idx + 500));
    expect(block).toContain('license === "any"');
    expect(block).toContain("youtubeRapidSearchFallbackEnabled()");
    expect(block).toContain("searchYoutubeViaRapidApi(query, sceneIndex, maxResults)");
  });

  it("the fallback only fires when the official search yielded nothing (429/empty)", () => {
    const idx = pipelineSrc.indexOf("let effectiveSearchData = searchData;");
    const block = codeOnly(pipelineSrc.slice(idx, idx + 500));
    expect(block).toContain("(!effectiveSearchData || (effectiveSearchData.items?.length ?? 0) === 0)");
  });

  it("the official strict-CC search still sets videoLicense=creativeCommon", () => {
    // Untouched by RONDE 10 — the CC path's license filter is intact.
    expect(pipelineSrc).toContain('searchUrl.searchParams.set("videoLicense", "creativeCommon");');
  });
});

describe("RONDE 10 — the RapidAPI search helper is safe and shape-compatible", () => {
  const fnStart = pipelineSrc.indexOf("async function searchYoutubeViaRapidApi(");
  const fnEnd = pipelineSrc.indexOf("export async function searchYoutubeVideoCandidates(");
  const fn = pipelineSrc.slice(fnStart, fnEnd);

  it("exists and returns the same shape the official-API producer returns", () => {
    expect(fnStart).toBeGreaterThan(-1);
    // Same { items: [{ id: { videoId }, snippet: {...} }] } shape → downstream code unchanged.
    expect(fn).toContain("id: { videoId: r.videoId }");
    expect(fn).toContain("snippet: {");
    expect(fn).toContain("return { items: rows };");
  });

  it("only keeps real video rows with a videoId", () => {
    expect(fn).toContain('r?.type === "video" && typeof r.videoId === "string" && r.videoId.length > 0');
  });

  it("respects maxResults (never floods the pipeline)", () => {
    expect(fn).toContain(".slice(0, maxResults)");
  });

  it("sends the RapidAPI auth headers on its own search host", () => {
    expect(fn).toContain('"x-rapidapi-host": RAPIDAPI_YT_SEARCH_HOST');
    expect(fn).toContain('"x-rapidapi-key": RAPIDAPI_KEY');
  });

  it("is bounded by a timeout and fails open to null on any error", () => {
    expect(fn).toContain("fetchWithTimeout(");
    expect(fn).toMatch(/catch \(err\) \{[\s\S]{0,200}return null;/);
    // A non-ok HTTP response also returns null, never throws.
    expect(fn).toContain("if (!resp.ok) {");
  });
});

describe("RONDE 10b — the cloud ytdlp-service download sends the bearer token", () => {
  it("passes Authorization: Bearer from YOUTUBE_CC_DL_TOKEN when set, omits it otherwise", () => {
    const idx = pipelineSrc.indexOf("const cloudDlToken = process.env.YOUTUBE_CC_DL_TOKEN?.trim();");
    expect(idx).toBeGreaterThan(-1);
    const block = pipelineSrc.slice(idx, idx + 600);
    expect(block).toContain("const cloudHeaders = cloudDlToken ? { Authorization: `Bearer ${cloudDlToken}` } : {};");
    expect(block).toContain("{ headers: cloudHeaders }");
  });
});

describe("RONDE 10 — fair-use excerpts stay short (pre-existing cap, unchanged)", () => {
  it("the fair-use clip cap still exists and is bounded to <= 8s", () => {
    expect(pipelineSrc).toContain("function youtubeFairUseMaxClipSec()");
    // The existing cap: default 5s, env-tunable within [2, 8].
    expect(pipelineSrc).toContain("if (!isNaN(n) && n >= 2 && n <= 8) return n;");
    expect(pipelineSrc).toContain('if (fileTag === "ytfu") return Math.min(duration, youtubeFairUseMaxClipSec());');
  });
});
