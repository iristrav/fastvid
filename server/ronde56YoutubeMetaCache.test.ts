import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { YOUTUBE_META_PROBE_TIMEOUT_MS } from "./sourcingPolicy";

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



  it("the old inline lookup is gone", () => {
    const src = SRC();
    expect(src).not.toContain("const metaResp = await providerLimiter(\"youtube\").run(");
    expect(src).not.toContain("scopedTimeoutMs(20_000, 3_000)");
  });
});


describe("RONDE 56 — the counters that measured this now move", () => {

  it("the metrics shape already carried these fields — nothing new was invented", () => {
    const src = SRC();
    expect(src).toContain("metadataCount: 0, metadataCacheHits: 0");
  });
});
