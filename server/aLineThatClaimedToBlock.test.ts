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
});
