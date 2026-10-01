import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const curatedSrc = readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * RONDE 13, ONE ROUTE — recent same-subject use is computed once per render and handed to the
 * archive search, where it is a PREFERENCE (usageDiversity.preferLessUsed), never a filter. The
 * preference itself is tested in usageDiversity.test.ts.
 */
describe("RONDE 13 — the render's recent-use counts reach the archive search", () => {
  const code = codeOnly(pipelineSrc);

  it("the counts are computed once, before prefetch", () => {
    expect(code).toContain("const crossVideoUsageForRun = archiveCrossVideoVarietyEnabled(videoLength)");
    expect(code.match(/recentUsageCounts\(/g) ?? []).toHaveLength(1);
  });

  it("the archive route receives them from the render state", () => {
    expect(code).toContain("crossVideoUsage: dedup.crossVideoUsage");
    expect(code).toContain("visualDedup.crossVideoUsage = crossVideoUsageForRun");
  });

  it("and the archive search only reorders with them — no filter is left", () => {
    const curated = codeOnly(curatedSrc);
    expect(curated).toContain("ranked = preferLessUsed(ranked, {");
    expect(curated).not.toContain("applyCrossVideoVarietyDegrade");
    expect(curated).not.toContain("crossVideoExcludeIds");
  });
});
