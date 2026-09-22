/**
 * A LINE THAT CLAIMED TO BLOCK — RONDE 620.
 *
 * ── What render 597 printed, and then did not do ────────────────────────────────────────────
 *
 *     [Pipeline] Scene 0 critical review: 1/4 clip(s) failed critical review
 *                — blocks export (strict voice↔visual)
 *
 * The film shipped. Two different flags decide these two things, and the message asked the one
 * that does not:
 *
 *     strictVoiceVisualMatchEnabled()   default ON     <- what the line read
 *     blockExportOnVisualMismatch()     default FALSE  <- what actually decides
 *
 * The second returns the first, but only after `allowDegradedVisualExport()`, which is
 * `beatVisualRescueEnabled()`, which defaults ON. So in the shipped configuration a failed
 * critical review does not block, and the log called it fatal — a reader watching that line had no
 * way to know the film was about to be delivered with the scene as it was.
 *
 * This is the same fault as a counter that reports a refusal it never made, which is why it is
 * worth a round of its own: every decision in this pipeline is read back out of these logs.
 *
 * ── What this round does NOT do ─────────────────────────────────────────────────────────────
 *
 * Nothing about the gate changes. No flag default moves, no threshold moves, and the export
 * decision is exactly what it was — a render that shipped before still ships. The line asks the
 * flag that owns the answer, and when it is not blocking it now names the reason, so the remedy is
 * visible instead of having to be traced through three functions.
 *
 * Whether a failed critical review SHOULD block is a configuration question with an owner, and it
 * is not this round's to answer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  allowDegradedVisualExport,
  beatVisualRescueEnabled,
  blockExportOnVisualMismatch,
  strictVoiceVisualMatchEnabled,
} from "./sourcingPolicy";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The shipped defaults: no override set for any flag in this chain. */
const withDefaults = <T>(fn: () => T): T => {
  const saved = { ...process.env };
  try {
    delete process.env.STRICT_VOICE_VISUAL_MATCH;
    delete process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH;
    delete process.env.ALLOW_DEGRADED_VISUAL_EXPORT;
    delete process.env.BEAT_VISUAL_RESCUE;
    return fn();
  } finally {
    process.env = saved;
  }
};

/* ═══════════ §1 — the two flags, and that they disagree ═══════════ */

describe("§1 — the defect in its own flags", () => {
  it("THE FLAG THE LINE READ IS ON BY DEFAULT", () => {
    withDefaults(() => expect(strictVoiceVisualMatchEnabled()).toBe(true));
  });

  it("AND THE FLAG THAT DECIDES IS OFF BY DEFAULT — so the line was wrong", () => {
    withDefaults(() => expect(blockExportOnVisualMismatch()).toBe(false));
  });

  it("the reason, in one chain: the rescue ladder is on, so degraded export is allowed", () => {
    withDefaults(() => {
      expect(beatVisualRescueEnabled(), "the rescue ladder defaults on").toBe(true);
      expect(allowDegradedVisualExport(), "which permits a degraded export").toBe(true);
      expect(blockExportOnVisualMismatch(), "which is what makes the block false").toBe(false);
    });
  });

  it("turn the rescue ladder off and the two agree again", () => {
    const saved = { ...process.env };
    try {
      delete process.env.STRICT_VOICE_VISUAL_MATCH;
      delete process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH;
      process.env.BEAT_VISUAL_RESCUE = "false";
      process.env.ALLOW_DEGRADED_VISUAL_EXPORT = "false";
      expect(strictVoiceVisualMatchEnabled()).toBe(true);
      expect(blockExportOnVisualMismatch(), "now it really does block").toBe(true);
    } finally {
      process.env = saved;
    }
  });
});

/* ═══════════ §2 — the line asks the flag that owns the answer ═══════════ */

describe("§2 — what the log now reads", () => {
  const site = () => {
    const at = SRC.indexOf("critical review: ${critical.summary}");
    expect(at, "the critical-review log site moved").toBeGreaterThan(-1);
    return SRC.slice(at, at + 2600);
  };

  it("THE DECIDING FLAG IS WHAT BRANCHES THE MESSAGE", () => {
    expect(site()).toContain("const blocks = blockExportOnVisualMismatch();");
    expect(site()).toContain("if (blocks) {");
  });

  it("and the 'blocks export' wording sits ONLY on the branch that blocks", () => {
    const body = site();
    const blocksAt = body.indexOf("— blocks export (strict voice↔visual)");
    const elseAt = body.indexOf("} else {");
    expect(blocksAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(-1);
    expect(blocksAt, "the fatal wording moved to the non-blocking branch").toBeLessThan(elseAt);
  });

  it("THE NON-BLOCKING BRANCH SAYS WHY, and that the film ships", () => {
    const body = site();
    expect(body).toContain("NOT blocking export in this configuration");
    expect(body).toContain("strictVoiceVisual=");
    expect(body).toContain("degradedVisualExportAllowed=");
    expect(body, "a reader must be told the outcome, not just the flags").toContain(
      "the film ships with this scene as it is"
    );
  });
});

/* ═══════════ §3 — nothing about the gate moved ═══════════ */

describe("§3 — reporting only", () => {
  it("the scene is still recorded as failed, exactly as before", () => {
    expect(SRC).toContain("sceneCriticalFailed.push(scenes[i]!.index);");
  });

  it("and it still reaches the quality report, which is what can block", () => {
    expect(SRC).toContain("      sceneCriticalFailed,");
    const report = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("opts?.sceneCriticalFailed ?? []");
    /** The real blocking rule, untouched by this round. */
    expect(report).toContain(
      "blocking: (policy.hardTier || policy.blockVisualMismatch) && (fallbackBeats > 0 || visualMismatch),"
    );
  });

  it("no flag default was changed to make the line true", () => {
    const policy = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(policy).toContain('return process.env.BEAT_VISUAL_RESCUE !== "false";');
    expect(policy).toContain('if (process.env.BLOCK_EXPORT_ON_VISUAL_MISMATCH === "false") return false;');
    expect(policy).toContain("  return strictVoiceVisualMatchEnabled();");
  });
});
