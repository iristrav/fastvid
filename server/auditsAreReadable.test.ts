/**
 * P21 / P24 / P26 — THE AUDITS SAY WHAT THEY MEAN.
 *
 * Three findings from one production log, and they share a shape: nothing was computed wrongly, and
 * a reader could not act on any of it.
 *
 * ── P24: four numbers, four questions, near-identical names ─────────────────────────────────
 *
 *     finalClips=8    final_clips=7    7 x [RenderAsset]    [AssetIdentity] TOTAL clips=8
 *
 * Read as four answers to one question that disagreed. They are four different questions — distinct
 * clips the render used, clips PROVEN in the delivered file, clips a verdict was recorded for, and
 * clips carrying a rehydratable identity — and 8 ≠ 7 because a clip the render used need not have
 * reached the file, and a clip in the file need not have been judged.
 *
 * The one field promising the delivered file was the one that never described it: `finalClips`
 * carried `qualityReport.totalClips`. It is `uniqueClips` now, which is what it counts.
 *
 * ── P21: four gate lines that all looked like losses ────────────────────────────────────────
 *
 * `[ComposeGate] … scope abandoned —` appeared four times. Two of its three outcomes are PASSES:
 * a clip already adopted is kept, and so is one with a usable earlier measurement. The verdict sat
 * at the end of a long sentence, so four lines had to be read in full to learn that nothing had
 * necessarily gone wrong.
 *
 * ── P26: 580 [error] lines, not one [warn] — and no code change can fix it ──────────────────
 *
 * The request was to log routine rejections as warnings and real failures as errors. That cannot
 * work, and the reason is one level below this codebase: in Node, `console.warn` and `console.error`
 * BOTH write to stderr. A collector that labels the stderr stream `[error]` therefore labels all 442
 * `console.warn` calls in videoPipeline as errors, however carefully each one was chosen.
 *
 * So severity cannot be carried by the console level. It has to be carried by the TEXT, or by a
 * record that is not the log — and one already exists: the pipeline report stored with every video
 * has its own `warnings` section. This file pins the constraint so the unworkable fix is not
 * attempted again.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { formatComposeScopeDecision } from "./composeEligibility";
import { PIPELINE_SECTION_TITLES } from "./renderPipelineReport";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

/* ═══════════════════════ P24 — a name that counts what it says ═══════════════════════ */

describe("the glance figure is named after what it counts", () => {
  it("is uniqueClips, not finalClips", () => {
    const report = read("renderPipelineReport.ts");
    expect(report).toContain("uniqueClips?: number;");
    expect(report).not.toContain("finalClips?: number;");
  });

  it("still carries the render's distinct clip count", () => {
    expect(read("videoPipeline.ts")).toContain("uniqueClips: qualityReport.totalClips,");
  });

  /** Renaming the field and leaving the reader is half a fix. The four counts are set out once. */
  it("says what the other three counts are, and why they differ", () => {
    const report = read("renderPipelineReport.ts");
    expect(report).toContain("four questions");
    expect(report).toContain("clips PROVEN in the delivered file");
    expect(report).toContain("[RenderAsset]");
    expect(report).toContain("[AssetIdentity]");
  });

  /** The strict one is untouched: `final_clips` remains the FINAL_VIDEO count and nothing else. */
  it("leaves the strict count alone", () => {
    const lineage = read("visualSourceLineage.ts");
    expect(lineage).toContain("`  final_clips=${rendered.length}`");
    expect(lineage).toContain("const rendered = input.records.filter((r) => r.finalVideoAt != null);");
  });
});

/* ═══════════════════════ P21 — the verdict before the story ═══════════════════════ */

describe("an abandoned scope says whether the clip survived", () => {
  const line = (verdict: Parameters<typeof formatComposeScopeDecision>[0]["verdict"]) =>
    formatComposeScopeDecision({ sceneIndex: 2, clipIndex: 5, basename: "shot.mp4", verdict });

  it("a clip already adopted is KEPT, and says so before the reason", () => {
    const s = line({ decision: "pass", basis: "already_adopted" });
    expect(s).toContain("scope abandoned KEPT —");
    expect(s.indexOf("KEPT")).toBeLessThan(s.indexOf("already adopted"));
  });

  it("a clip kept on an earlier measurement is also KEPT", () => {
    expect(line({ decision: "pass", basis: "prior_measurement" })).toContain("scope abandoned KEPT —");
  });

  it("the one outcome that loses a clip is REFUSED", () => {
    const s = line({ decision: "fail", basis: "scope_abandoned_unmeasured" });
    expect(s).toContain("scope abandoned REFUSED —");
    expect(s).not.toContain("KEPT");
  });

  /**
   * The two are greppable apart. That is the whole point: counting `[ComposeGate]` lines told you
   * how often the budget ran out, and nothing about what it cost.
   */
  it("KEPT and REFUSED never appear on the same line", () => {
    for (const v of [
      { decision: "pass", basis: "already_adopted" },
      { decision: "pass", basis: "prior_measurement" },
      { decision: "fail", basis: "scope_abandoned_unmeasured" },
    ] as const) {
      const s = line(v);
      expect(s.includes("KEPT") && s.includes("REFUSED")).toBe(false);
    }
  });

  /** The condition stays in the head — it is what somebody counting these lines is counting. */
  it("still says the scope was abandoned", () => {
    for (const v of [
      { decision: "pass", basis: "already_adopted" },
      { decision: "fail", basis: "scope_abandoned_unmeasured" },
    ] as const) {
      expect(line(v)).toContain("scope abandoned");
    }
  });

  /** A verdict without its reason is the other half of the same defect. */
  it("keeps the reason after the verdict", () => {
    expect(line({ decision: "fail", basis: "scope_abandoned_unmeasured" })).toContain(
      "never adopted and has no earlier measurement"
    );
  });
});

/* ═══════════════════════ P26 — where severity can actually live ═══════════════════════ */

describe("severity cannot come from the console level", () => {
  /**
   * The constraint, from Node itself. `console.warn` is not a quieter `console.error`; it is the
   * same stream. Anything that labels streams will label both the same way, which is why a log with
   * 442 careful `console.warn` calls contained zero `[warn]` lines.
   */
  it("console.warn and console.error write to the same stream", () => {
    /**
     * Measured in a child process, not in this one. Vitest replaces `console` to capture test
     * output, so spying on `process.stderr` here would measure the test runner rather than Node —
     * and a test that measures the wrong thing is exactly what this file is about.
     */
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const script = 'console.log("L"); console.warn("W"); console.error("E");';
    // spawnSync, because execFileSync returns stdout alone and the point is to compare the two.
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const onStdout = run.stdout;
    const onStderr = run.stderr;

    // Only console.log reaches stdout…
    expect(onStdout).toContain("L");
    expect(onStdout).not.toContain("W");
    expect(onStdout).not.toContain("E");
    // …and warn AND error share stderr, which is the whole finding.
    expect(onStderr).toContain("W");
    expect(onStderr).toContain("E");
    expect(onStderr).not.toContain("L");
  });

  /**
   * So the record that CAN carry severity is the stored pipeline report, which has its own section
   * for it. A reader looking for what went wrong should be sent there, not to a grep of the log.
   */
  it("the stored report has a section for warnings", () => {
    expect(PIPELINE_SECTION_TITLES.warnings).toBeTruthy();
    expect(Object.keys(PIPELINE_SECTION_TITLES)).toContain("warnings");
  });

  /** And the finding is written down where the next person will look for it. */
  it("the constraint is recorded, so the unworkable fix is not tried again", () => {
    const self = read("auditsAreReadable.test.ts");
    expect(self).toContain("BOTH write to stderr");
  });
});
