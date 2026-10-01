/**
 * ONE ROUTE — suppliers supply candidates; none of them wins because of who it is, and the look
 * before a YouTube download ranks rather than refuses.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const POOL = readFileSync(path.join(__dirname, "youtubeVideoPool.ts"), "utf8");
const CURATED = readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

function bodyOf(sig: string): string {
  const at = PIPE.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
}

describe("one adoption for every supplier of an archive gap", () => {
  it("YouTube's candidates and the cascade's pool are judged together", () => {
    const ladder = bodyOf("export async function fetchBeatArchivalThenPexels(");
    expect(ladder).not.toContain("if (ytClip) return ytClip;");
    expect(ladder).toContain("const candidates = [...(ytCandidates ?? []), ...(pool ?? []), ...(personPool ?? [])];");
    expect(ladder).toContain("adoptHistoricalBeatVideoPool(candidates,");
  });
});

describe("the YouTube look ranks, the VisualJudge decides", () => {
  it("'does not serve this sentence' orders rows, it does not drop them", () => {
    expect(PIPE).not.toContain("does not serve this sentence title=\"${title}\" — not downloaded");
    /** The per-beat thumbnail triage went with the per-beat YouTube search; the pool ranks by `servesBeats`. */
    expect(PIPE).not.toContain("youtubeRowsWithoutNonFootage");
  });

  it("a pool video serving no beat is not unusable, and a beat is offered every usable video", () => {
    expect(POOL).not.toContain('why = "serves no beat"');
    expect(POOL).not.toContain("if (!c.serves.some((s) => mine.has(s))) continue;");
  });
});

describe("the archive matcher ranks; content refusals are the VisualJudge's", () => {
  it("no local non-documentary filter, no reuse tier, no rotation", () => {
    expect(CURATED).not.toMatch(/isNonDocumentaryVisualHay\(/);
    expect(CURATED).toContain('judgeArchiveAssetMaterial(asset).decision === "REJECT"');
    /** The negative-score refusal (RONDE 9) is the VisualJudge's; the matcher asks it. */
    expect(CURATED).toContain('judgeArchiveAssetScore(score).decision === "REJECT"');
    expect(CURATED).not.toContain("allowing clip reuse");
    expect(CURATED).not.toContain("rotateCuratedCandidates");
  });
});
