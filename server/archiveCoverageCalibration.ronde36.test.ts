import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 36 — measurement only.
//
// The Ronde-35 audit proved computeArchiveCoverage compares two quantities that are not on one
// scale: the embedding branch returns a raw text-to-text cosine in [0,1], the keyword branch an
// unbounded point sum divided by an arbitrary KEYWORD_SCORE_MAX, and the strategy thresholds
// (0.50 / 0.75 / 0.94) sit on top of both. Picking a correct recalibration needs those two
// numbers PAIRED per real evaluation, with the asset they came from — which nothing logged.
//
// These tests pin the instrumentation and, just as importantly, pin that this round changed
// nothing else: no threshold moved, no ranking touched, no extra provider work introduced.

const FUNNEL = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");

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

/** The body of computeArchiveCoverage, brace-matched from its declaration. */
function coverageFn(): string {
  const start = FUNNEL.indexOf("async function computeArchiveCoverage(");
  expect(start).toBeGreaterThan(-1);
  const bodyStart = signatureBodyBrace(FUNNEL, start);
  let depth = 0;
  let i = bodyStart;
  for (; i < FUNNEL.length; i++) {
    if (FUNNEL[i] === "{") depth++;
    else if (FUNNEL[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return FUNNEL.slice(start, i + 1);
}

describe("RONDE 36 — the calibration line exists and carries both scores", () => {
  it("emits a greppable [FunnelCalib] marker", () => {
    expect(FUNNEL).toContain("[FunnelCalib] s${sceneIndex}");
  });

  it("logs the embedding score and the RAW, unnormalised keyword score together", () => {
    // cosine at four decimals — enough resolution to sort beats into candidate bands later
    expect(FUNNEL).toContain('emb=${cosine === null ? "n/a" : cosine.toFixed(4)}');
    // keyword straight off the pick: no /KEYWORD_SCORE_MAX, no Math.min, no rounding
    expect(FUNNEL).toContain("kw=${pick?.score ?? \"unknown\"}");
    expect(FUNNEL).not.toMatch(/kw=\$\{[^}]*KEYWORD_SCORE_MAX/);
    expect(FUNNEL).not.toMatch(/kw=\$\{[^}]*toFixed/);
  });

  it("names the asset the coverage is actually based on, and never guesses", () => {
    expect(FUNNEL).toContain("asset=${assetId ?? \"unknown\"}");
    expect(FUNNEL).toContain('title="${title || "unknown"}"');
    // id and title come off the pick that is already in hand
    expect(FUNNEL).toContain("const assetId = pick?.asset?.id;");
    expect(FUNNEL).toContain("const title = pick?.asset?.title?.trim();");
    // never reconstructed from a file path
    expect(FUNNEL).not.toMatch(/logFunnelCalibration[\s\S]{0,800}?(basename|curatedClipPathAssetId)/);
  });

  it("logs on both branches — the embedding one and the keyword-only fallback", () => {
    const fn = coverageFn();
    // RONDE 38 added the beatDocument argument to both call sites.
    expect(fn).toContain("logFunnelCalibration(sceneIndex, maxEmb, top[maxEmbIdx], beatDocument);");
    expect(fn).toContain("logFunnelCalibration(sceneIndex, null, candidates[0], beatDocument);");
    // exactly one line per coverage evaluation, per branch
    expect((fn.match(/logFunnelCalibration\(/g) ?? []).length).toBe(2);
  });

  it("stays silent when there is no archive candidate to judge", () => {
    const fn = coverageFn();
    const earlyReturn = fn.indexOf("if (candidates.length === 0) return 0;");
    const firstLog = fn.indexOf("logFunnelCalibration(");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(firstLog);
  });
});

describe("RONDE 36 — the line costs nothing", () => {
  it("introduces no query, no embedding call and no fetch", () => {
    const start = FUNNEL.indexOf("function logFunnelCalibration(");
    expect(start).toBeGreaterThan(-1);
    const helper = FUNNEL.slice(start, FUNNEL.indexOf("\n}", start) + 2);
    for (const forbidden of [
      "await",
      "fetch(",
      "dbExecute",
      "scoreBeatAgainstStoredEmbedding",
      "loadStoredAssetEmbedding",
      "createTextEmbedding",
      "listCuratedArchiveCandidates",
      "buildSceneCandidatePool",
    ]) {
      expect(helper).not.toContain(forbidden);
    }
    // synchronous by signature: it returns void, so it cannot be doing async work
    expect(FUNNEL).toContain("): void {\n  const assetId = pick?.asset?.id;");
  });

  it("does not add a retrieval call to computeArchiveCoverage", () => {
    const fn = coverageFn();
    // the single pre-existing scoring call, unchanged in count
    expect((fn.match(/scoreBeatAgainstStoredEmbedding\(/g) ?? []).length).toBe(1);
    expect(fn).not.toContain("listCuratedArchiveCandidates(");
    expect(fn).not.toContain("buildSceneCandidatePool(");
  });
});

describe("RONDE 36 — behaviour is unchanged (measurement round, not calibration)", () => {
  it("no threshold or scale constant moved", () => {
    expect(FUNNEL).toContain("const KEYWORD_SCORE_MAX = 100;");
    expect(FUNNEL).toMatch(/const ARCHIVE_DOMINANT_THRESHOLD = envThreshold\("ARCHIVE_DOMINANT_THRESHOLD", 0\.46\)/);
    expect(FUNNEL).toMatch(/const INTERNET_DOMINANT_THRESHOLD = envThreshold\("INTERNET_DOMINANT_THRESHOLD", 0\.25\)/);
    expect(FUNNEL).toMatch(/export const BEAT_ARCHIVE_STOP_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_STOP_THRESHOLD", 0\.50\)/);
    expect(FUNNEL).toMatch(/export const BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD", 0\.42\)/);
    expect(FUNNEL).toMatch(/export const BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD = archiveThreshold\("BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD", 0\.30\)/);
    expect(FUNNEL).toContain("const MAX_CONSECUTIVE_ARCHIVE_ONLY = 2;");
  });

  it("both coverage branches still return exactly what they returned before", () => {
    const fn = coverageFn();
    expect(fn).toContain("return Math.min(1, maxEmb);");
    expect(fn).toContain("return Math.min(1, topScore / KEYWORD_SCORE_MAX);");
    expect(fn).toContain("if (!topScore || topScore <= 0) return 0;");
    // the embedding branch is still gated on a finite, positive maximum
    expect(fn).toContain("if (isFinite(maxEmb) && maxEmb > 0) {");
  });

  it("the max-picking loop reproduces Math.max() semantics for the returned value", () => {
    const fn = coverageFn();
    // -Infinity seed == Math.max() of an empty set, so an all-null top-K still falls through
    expect(fn).toContain("let maxEmb = -Infinity;");
    expect(fn).toContain("if (s === null) continue;");
    expect(fn).toContain("if (s > maxEmb) {");
    // Behavioural equivalence, spelled out rather than asserted on the source:
    const pick = (sims: (number | null)[]) => {
      let m = -Infinity;
      for (const s of sims) {
        if (s === null) continue;
        if (s > m) m = s;
      }
      return m;
    };
    const legacy = (sims: (number | null)[]) =>
      Math.max(...sims.filter((s): s is number => s !== null));
    for (const sims of [
      [0.2, 0.5, 0.1],
      [null, 0.4],
      [0.4, null],
      [] as (number | null)[],
      [null, null],
      [0.5, 0.5],
      [-0.1, 0.0],
    ]) {
      const a = pick(sims);
      const b = legacy(sims);
      // both feed the identical `isFinite(x) && x > 0` gate, so agreeing there is what matters
      expect(isFinite(a) && a > 0).toBe(isFinite(b) && b > 0);
      if (isFinite(a) && a > 0) expect(a).toBe(b);
    }
  });

  it("resolveStrategy, the gap strategy and mergeCandidates are untouched", () => {
    expect(FUNNEL).toContain("if (coverage > ARCHIVE_DOMINANT_THRESHOLD) return \"archive_dominant\";");
    expect(FUNNEL).toContain("if (coverage > INTERNET_DOMINANT_THRESHOLD) return \"hybrid\";");
    expect(FUNNEL).toContain("if (bestArchiveScore >= BEAT_ARCHIVE_STOP_THRESHOLD) strategy = \"archive_only\";");
    expect(FUNNEL).toContain("const kwBase = Math.min(1, pick.score / KEYWORD_SCORE_MAX);");
    expect(FUNNEL).toContain("const embBoost = embSim !== null ? embSim * 0.4 : 0;");
  });

  it("the existing strategy boundaries still read as written (pinned, not changed)", async () => {
    const {
      resolvePerBeatGapStrategy,
      BEAT_ARCHIVE_STOP_THRESHOLD,
      BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD,
      BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD,
    } = await import("./retrievalFunnel");

    // RONDE 51: the thresholds moved (render 530 measured the score band at 0.21–0.53, so the
    // old 0.94/0.75/0.50 were unreachable). What this test guards is the BOUNDARY SEMANTICS —
    // which comparison is >= and which is > , and that each tier owns the band below the one
    // above it. Those are expressed against the constants now, so the test keeps its meaning
    // when the numbers are retuned again after the next render.
    const STOP = BEAT_ARCHIVE_STOP_THRESHOLD;
    const ONE = BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD;
    const ALL = BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD;
    const eps = 0.001;

    expect(resolvePerBeatGapStrategy(STOP + eps)).toBe("archive_only");
    expect(resolvePerBeatGapStrategy(STOP)).toBe("archive_only");   // >= STOP
    expect(resolvePerBeatGapStrategy(STOP - eps)).toBe("one_external");
    expect(resolvePerBeatGapStrategy(ONE)).toBe("one_external");
    expect(resolvePerBeatGapStrategy(ONE - eps)).toBe("all_external");
    expect(resolvePerBeatGapStrategy(ALL)).toBe("all_external");
    expect(resolvePerBeatGapStrategy(ALL - eps)).toBe("aggressive");
    expect(resolvePerBeatGapStrategy(null)).toBe("aggressive");
    // The diversity guard is unchanged.
    expect(resolvePerBeatGapStrategy(STOP + 0.05, 2)).toBe("one_external");
    expect(resolvePerBeatGapStrategy(STOP + 0.05, 1)).toBe("archive_only");
  });
});

describe("RONDE 38 — the scene line now carries the context a human needs", () => {
  it("logs the archive name and the beat text alongside the two scores", () => {
    expect(FUNNEL).toContain('archive="${archive || "unknown"}"');
    expect(FUNNEL).toContain('title="${title || "unknown"}"');
    expect(FUNNEL).toContain('beat="${beat || "unknown"}"');
  });

  it("takes the archive name off the pick, never off a path or a guess", () => {
    expect(FUNNEL).toContain("const archive = pick?.archiveName?.trim();");
    expect(FUNNEL).not.toMatch(/logFunnelCalibration[\s\S]{0,1200}?(basename|split\("\/"\))/);
  });

  it("clamps the beat text to 60 characters and normalises whitespace", () => {
    expect(FUNNEL).toContain('const beat = beatDocument.replace(/\\s+/g, " ").trim().slice(0, 60);');
  });

  it("findBestArchiveScoreForBeat reports its winner without changing what it returns", () => {
    const start = FUNNEL.indexOf("export function findBestArchiveScoreForBeat(");
    expect(start).toBeGreaterThan(-1);
    const fn = FUNNEL.slice(start, FUNNEL.indexOf("\n}", start) + 2);
    // the out-object is optional, so every existing caller is unaffected
    expect(fn).toContain("bestOut?: { candidate?: FunnelCandidate }");
    // it is written only where `best` itself is updated — same comparison, same result
    expect(fn).toContain("best = score;\n      if (bestOut) bestOut.candidate = c;");
    expect(fn).toContain("return best;");
    // and it does no work of its own
    expect(fn).not.toContain("await");
    expect(fn).not.toContain("fetch(");
  });
});

describe("RONDE 38 — the per-beat line is measurement only", () => {
  const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("emits [FunnelBeatCalib] with a real beat index at the strategy decision", () => {
    expect(PIPELINE).toContain("[FunnelBeatCalib] s${scene.index}b${beat.index}");
    expect(PIPELINE).toContain("strategy=${gapStrategy}");
    expect(PIPELINE).toContain("archiveScore=${bestArchiveScore?.toFixed(4) ?? \"n/a\"}");
  });

  it("logs asset, archive, title and beat, with unknown where data is absent", () => {
    expect(PIPELINE).toContain('asset=${bcAssetId ?? "unknown"}');
    expect(PIPELINE).toContain('archive="${bcArchive || "unknown"}"');
    expect(PIPELINE).toContain('title="${bcTitle || "unknown"}"');
    expect(PIPELINE).toContain('kw=${bcKeyword ?? "unknown"}');
  });

  it("sits AFTER the strategy is resolved, so it cannot influence it", () => {
    const strategyIdx = PIPELINE.indexOf("const gapStrategy = resolvePerBeatGapStrategy(bestArchiveScore, dedup.consecutiveArchiveBeats);");
    const calibIdx = PIPELINE.indexOf("[FunnelBeatCalib]");
    const orderIdx = PIPELINE.indexOf("funnelCandidates = orderCandidatesForBeatGap(funnelResult.candidates, gapStrategy);");
    expect(strategyIdx).toBeGreaterThan(-1);
    expect(calibIdx).toBeGreaterThan(strategyIdx);
    expect(calibIdx).toBeLessThan(orderIdx);
  });

  it("the diagnostic block does no work: no await, no fetch, no query, no embedding", () => {
    const start = PIPELINE.indexOf("const bc = bestArchiveOut.candidate;");
    expect(start).toBeGreaterThan(-1);
    const block = PIPELINE.slice(start - 200, PIPELINE.indexOf("[FunnelBeatCalib]") + 900);
    for (const forbidden of ["await ", "fetch(", "dbExecute", "createTextEmbedding(", "scoreBeatAgainstStoredEmbedding("]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("the strategy call itself is untouched", () => {
    expect(PIPELINE).toContain("resolvePerBeatGapStrategy(bestArchiveScore, dedup.consecutiveArchiveBeats)");
    expect(PIPELINE).toContain("orderCandidatesForBeatGap(funnelResult.candidates, gapStrategy)");
  });
});
