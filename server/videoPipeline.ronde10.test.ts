import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/** Statically imported so the module's load does not count against a test timeout. */
import { capYoutubeClipDurationForTest } from "./videoPipeline";

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
    /**
     * RONDE 160 — bounded by the statement that ENDS the fallback, not by a character count.
     *
     * This used to slice a fixed 500 characters, so adding a comment inside the guard pushed the
     * assignment out of the window and failed a test whose subject had not changed. A guard that
     * breaks on reformatting teaches people to edit the guard. The delimiter below is the next
     * real statement, so the whole fallback is always in view however it is commented.
     */
    const block = codeOnly(
      pipelineSrc.slice(idx, pipelineSrc.indexOf("if (!effectiveSearchData)", idx))
    );
    expect(block).toContain('license === "any"');
    expect(block).toContain("youtubeRapidSearchFallbackEnabled()");
    expect(block).toContain("searchYoutubeViaRapidApi(query, sceneIndex, maxResults)");
    /** RONDE 160 — and no licence-SPECIFIC mode may reach the scraped search. */
    expect(block).not.toContain('license === "youtube"');
    expect(block).not.toContain('license === "creative_common"');
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

describe("RONDE 10 — fair-use excerpts stay short, where fair use is what is relied on", () => {
  /**
   * ── Why this assertion moved from a string to a behaviour ─────────────────────────────────
   *
   * It used to match `if (fileTag === "ytfu") return Math.min(...)` literally, under the heading
   * "pre-existing cap, unchanged". The cap's PURPOSE is a fair-use mitigation: a short
   * transformative excerpt is a far easier claim than a long one. The project has since stated an
   * authorisation to use YouTube as a production source, and under it the material is not being
   * used under fair use — so a ceiling shorter than the narration the clip plays under is just a
   * worse edit, and it now applies where its reasoning applies.
   *
   * Everything the cap guaranteed is still asserted, and now against the real function rather
   * than against its source text: it is bounded to 8s, it is settable, it binds whenever fair use
   * is being relied on, and it has never touched the licence-named passes.
   */
  it("the cap still exists, is still bounded to <= 8s, and is still settable", () => {
    expect(pipelineSrc).toContain("function youtubeFairUseMaxClipSec()");
    expect(pipelineSrc).toContain("if (!isNaN(n) && n >= 2 && n <= 8) return n;");
    expect(pipelineSrc).toContain('if (fileTag !== "ytfu") return duration;');
  });

  it("it binds on the unfiltered pass whenever fair use is what is being relied on", () => {
    const before = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
    const beforeMax = process.env.FAIR_USE_YT_MAX_SEC;
    try {
      delete process.env.FAIR_USE_YT_MAX_SEC;
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "false";
      expect(capYoutubeClipDurationForTest(7.5, "ytfu")).toBe(5);
      /** And an explicit ceiling binds regardless of the authorisation. */
      process.env.FAIR_USE_YT_MAX_SEC = "3";
      delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      expect(capYoutubeClipDurationForTest(7.5, "ytfu")).toBe(3);
    } finally {
      if (before === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = before;
      if (beforeMax === undefined) delete process.env.FAIR_USE_YT_MAX_SEC;
      else process.env.FAIR_USE_YT_MAX_SEC = beforeMax;
    }
  });
});
