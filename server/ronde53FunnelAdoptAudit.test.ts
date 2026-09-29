import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * RONDE 53 — the retrieval funnel adopts clips and never recorded doing so.
 *
 * Ronde 51 closed the scene-pool branch in fetchSceneVisualsInner. Render 531 shows it was only
 * half the problem: eleven of seventeen manifest lines still read "beat=? source=unknown", and
 * the quality report still said "adopt audit beats=8" for a video holding seventeen clips.
 *
 * Every one of those eleven was either *_curated_a*.mp4 or *_pool_*.mp4 — the two payload kinds
 * downloadFunnelCandidate produces. The funnel's winner block registered the candidate id, the
 * embedding similarity and the segment similarities, but not the adoption.
 */

const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The funnel's winner block, brace-matched rather than taken as a character window. */
function funnelWinnerBlock(src: string): string {
  const marker = src.indexOf("let winner = pickBestFunnelCandidate(");
  expect(marker).toBeGreaterThan(-1);
  const start = src.indexOf("if (winner) {", marker);
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced funnel winner block");
}

/**
 * The FunnelCandidateSource union, READ from retrievalFunnel.ts rather than restated here.
 *
 * RONDE 177: this list used to be a copy, and the copy went stale the moment R169 added
 * `youtube_cc` to the funnel — the categorisation test below kept passing on ten sources while the
 * eleventh fell through into no bucket at all in production. Reading the union is what makes the
 * next new source fail this test on the day it is added rather than in a render report.
 */
function declaredFunnelSources(): string[] {
  const funnel = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
  const union = funnel.slice(
    funnel.indexOf("export type FunnelCandidateSource ="),
    funnel.indexOf("export type FunnelStrategy")
  );
  const sources = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  expect(sources.length, "the funnel union could not be read").toBeGreaterThanOrEqual(10);
  return sources;
}

describe("RONDE 53 — every funnel source lands in a real category", () => {

  it("the source union in retrievalFunnel has not grown past what the audit knows", () => {
    const audit = readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
    // A new provider added to the funnel without adding it here would silently go uncounted.
    for (const source of declaredFunnelSources()) {
      expect(audit.includes(`"${source}"`), `${source} is not named in clipAdoptAudit`).toBe(true);
    }
  });
});
