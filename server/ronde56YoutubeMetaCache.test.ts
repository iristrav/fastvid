import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * RONDE 56 — YouTube found 185 videos and delivered 2.
 *
 * Render 531 put the whole loss in one place:
 *
 *     185 results -> 103 download attempts -> 2 adopted
 *      85 RapidAPI failures, every one of them
 *          · ABORTED by the enclosing scope, never a real timeout
 *          · at the META step, never reaching the download
 *          · granted "own 3s" — the floor of scopedTimeoutMs, i.e. the scene was already spent
 *      86 attempts for 14 unique video ids
 *      metadataCacheHits = 0
 *
 * Two fixes, both in fetchRapidApiYoutubeMeta: cache the lookup per render, and run it outside
 * the beat's deadline. The download deliberately stays inside the scope — it writes to workDir,
 * and a detached write into a cleaned-up directory is the ENOENT bug the scope signal exists to
 * prevent.
 */

const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * RONDE 104: walk the parameter list by BALANCE, not to its first `)`.
 *
 * `indexOf(")", start)` stops inside the first parameter that has parentheses of its own — a doc
 * comment, a default, an inline function type. The `{` matched after that can then be an inline
 * object RETURN TYPE rather than the body, and the test reads a few lines of a type declaration
 * while appearing to read the implementation: a test that passes for the wrong reason.
 */
function signatureBodyBrace(src: string, start: number): number {
  let i = src.indexOf("(", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const line = src.slice(i, src.indexOf("\n", i));
  return i + line.lastIndexOf("{");
}

/** The helper's body, brace-matched rather than taken as a character window. */
function metaHelper(src: string): string {
  const start = src.indexOf("async function fetchRapidApiYoutubeMeta(");
  expect(start).toBeGreaterThan(-1);
  const open = signatureBodyBrace(src, start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced helper");
}

describe("RONDE 56 #1 — the metadata lookup is cached per render", () => {
  it("a hit short-circuits before any request is made", () => {
    const h = metaHelper(SRC());
    const cacheRead = h.indexOf('getCachedProviderAsset(sourcingCache, "youtube_cc", videoId)');
    const fetchIdx = h.indexOf("fetchWithTimeout(");
    expect(cacheRead).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(cacheRead);
    expect(h).toContain("metadataCacheHits++");
  });

  it("a negative result is cached too, so a dead video is asked once", () => {
    const h = metaHelper(SRC());
    // `metadata !== undefined` rather than a truthiness check: null IS the cached answer for
    // "this video has no usable metadata", and truthiness would re-ask it every beat.
    expect(h).toContain("cached?.metadata !== undefined");
    expect(h).toContain('putCachedProviderAsset(sourcingCache, "youtube_cc", videoId, { metadata: meta })');
  });

  it("the cache reaches the helper from the call site", () => {
    const src = SRC();
    // downloadYouTubeCCClip takes it...
    expect(src).toMatch(/export async function downloadYouTubeCCClip\([\s\S]{0,400}?sourcingCache\?: SourcingCache/);
    // ...its caller passes it...
    const callIdx = src.indexOf("const ok = await downloadYouTubeCCClip(");
    expect(callIdx).toBeGreaterThan(-1);
    expect(src.slice(callIdx, callIdx + 500)).toContain("sourcingCache");
    // ...and the helper is what the download path now uses.
    expect(src).toContain("await fetchRapidApiYoutubeMeta(videoId, sceneIndex, sourcingCache)");
  });

  it("the old inline lookup is gone", () => {
    const src = SRC();
    expect(src).not.toContain("const metaResp = await providerLimiter(\"youtube\").run(");
    expect(src).not.toContain("scopedTimeoutMs(20_000, 3_000)");
  });
});

describe("RONDE 56 #2 — the lookup runs outside the beat's deadline", () => {
  it("it is detached from the scene-fetch scope", () => {
    const h = metaHelper(SRC());
    expect(h).toContain("sceneFetchScopeStorage.exit(");
    // Detached means it gets its own full budget, not the scene's leftovers. Render 531 granted
    // it 3s — the clamp's floor — because the scene had nothing left to give.
    expect(h).toContain("fetchWithTimeout(metaUrl, 20_000,");
    expect(h).not.toContain("scopedTimeoutMs(");
  });

  it("the exit wraps the request, not merely the surrounding bookkeeping", () => {
    const h = metaHelper(SRC());
    const exitIdx = h.indexOf("sceneFetchScopeStorage.exit(");
    const fetchIdx = h.indexOf("fetchWithTimeout(", exitIdx);
    const closeIdx = h.indexOf("});", exitIdx);
    expect(fetchIdx).toBeGreaterThan(exitIdx);
    expect(fetchIdx).toBeLessThan(closeIdx);
  });

  it("the DOWNLOAD stays inside the scope — it writes to disk", () => {
    const src = SRC();
    const dlIdx = src.indexOf("`RapidAPI YouTube download scene ${sceneIndex}`");
    expect(dlIdx).toBeGreaterThan(-1);
    // Still clamped to the scene budget, and still cancellable by it.
    expect(src.slice(dlIdx - 400, dlIdx)).toContain("scopedTimeoutMs(youtubeDownloadTimeoutMs()");
    // The download must not be detached: a write landing after workDir is cleaned up is ENOENT.
    const helper = metaHelper(src);
    expect(helper).not.toContain("downloadToFileStreaming");
  });

  it("a scope abort still does not blame the provider", () => {
    const h = metaHelper(SRC());
    // The RONDE 52 rule survives the move: the breaker counts real failures, not budget aborts.
    expect(h).toContain("if (!isScopeAbortError(err)) markYoutubeSearchResult(false);");
  });
});

describe("RONDE 56 — the counters that measured this now move", () => {
  it("both metadata counters are written", () => {
    const h = metaHelper(SRC());
    // metadata=0 and metadataCacheHits=0 in render 531 meant nothing was recording either side.
    expect(h).toContain("metadataCount++");
    expect(h).toContain("metadataCacheHits++");
  });

  it("the metrics shape already carried these fields — nothing new was invented", () => {
    const src = SRC();
    expect(src).toContain("metadataCount: 0, metadataCacheHits: 0");
  });
});
