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

describe("RONDE 53 — the funnel winner is recorded", () => {
  it("the block that adopts a funnel winner records the adoption", () => {
    const block = funnelWinnerBlock(SRC());
    expect(block).toContain("funnelClip = clipPath;");
    expect(block).toContain("recordClipAdopt(");
    expect(block).toContain("dedup.clipAdoptAudit");
  });

  it("it records the candidate's own source, not a hardcoded label", () => {
    const block = funnelWinnerBlock(SRC());
    // candidate.source is already the vocabulary summarizeAdoptAudit classifies.
    expect(block).toMatch(/recordClipAdopt\([\s\S]{0,400}?candidate\.source/);
    expect(block).not.toMatch(/recordClipAdopt\([\s\S]{0,400}?"fallback"/);
    expect(block).not.toMatch(/recordClipAdopt\([\s\S]{0,400}?"unknown"/);
  });

  it("it records the beat it was fetched for, not the scene", () => {
    const block = funnelWinnerBlock(SRC());
    expect(block).toMatch(/recordClipAdopt\(\s*[\s\S]{0,120}?scene\.index,\s*beat\.index,\s*beat\.text/);
  });

  it("the clip it records is the one that actually becomes the beat's clip", () => {
    const block = funnelWinnerBlock(SRC());
    // Both must be `clipPath` — recording a different path is what breaks the manifest lookup.
    const adoptIdx = block.indexOf("recordClipAdopt(");
    const adoptCall = block.slice(adoptIdx, adoptIdx + 400);
    expect(adoptCall).toContain("clipPath");
    expect(block.indexOf("funnelClip = clipPath;")).toBeLessThan(adoptIdx);
  });
});

describe("RONDE 53 — every funnel source lands in a real category", () => {
  it("all ten FunnelCandidateSource values are classified by the audit", async () => {
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    // The full FunnelCandidateSource union as retrievalFunnel declares it.
    const sources = [
      "archive", "pexels", "pixabay", "wikimedia", "internet_archive",
      "europeana", "openverse", "nasa", "nara", "loc",
    ];
    const audit = createClipAdoptAudit();
    sources.forEach((s, i) => recordClipAdopt(audit, 0, i, `b${i}`, `/w/c${i}.mp4`, s));
    const summary = summarizeAdoptAudit(audit);

    expect(summary.beatsFilled).toBe(sources.length);
    // Nothing may fall through into "counted as a beat but categorised as nothing" — that is
    // what produced "beats=13 wiki=0 arch=7 stock=0" in render 530.
    const categorised =
      summary.archiveBeats + summary.wikiBeats + summary.stockBeats + summary.klingBeats +
      summary.fallbackBeats;
    expect(categorised).toBe(sources.length);
    // And none of them is a placeholder: these are all real media.
    expect(summary.fallbackBeats).toBe(0);
  });

  it("the source union in retrievalFunnel has not grown past what the audit knows", () => {
    const funnel = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
    const union = funnel.slice(
      funnel.indexOf("export type FunnelCandidateSource ="),
      funnel.indexOf("export type FunnelStrategy")
    );
    const declared = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const audit = readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
    // A new provider added to the funnel without adding it here would silently go uncounted.
    for (const source of declared) {
      expect(audit.includes(`"${source}"`)).toBe(true);
    }
  });
});

describe("RONDE 53 — both adoption routes are now covered", () => {
  it("the scene-pool route from RONDE 51 is still recorded", () => {
    const src = SRC();
    const idx = src.indexOf("if (poolClip) {\n          clip = poolClip;");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 1400)).toContain("recordClipAdopt(");
  });

  it("downloadFunnelCandidate has exactly one caller, and that caller records", () => {
    const src = SRC();
    const callers = [...src.matchAll(/await downloadFunnelCandidate\(/g)];
    // If a second call site appears, it needs the same treatment — fail loudly rather than
    // silently losing another route's adoptions.
    expect(callers).toHaveLength(1);
    expect(funnelWinnerBlock(src)).toContain("recordClipAdopt(");
  });
});
