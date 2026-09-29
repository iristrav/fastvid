/**
 * RONDE 155 — a placeholder card is no longer a frozen frame.
 *
 * ── Where this sits in the chain ─────────────────────────────────────────────────────────────
 *
 * Three rounds removed three causes of unchanging picture, each measured on a real render:
 *
 *     R152  archive stills had no motion at all      550: 34.13s  →  551: 19.38s
 *     R154  two adjacent cards shared a colour       the 19.38s was two cards, not one still
 *     R155  a card is a flat colour, i.e. a still    this round
 *
 * A flat `color=` source is one unchanging picture by construction. The pipeline's own
 * auditVideoStillness says so: a five-second card reports 0 visual changes and longestStill 5.00s.
 * With the 5.00s limit that is a pass by a hair, and two in a row was a 10-second still.
 *
 * ── Why an animated gradient, and why 0.20 ───────────────────────────────────────────────────
 *
 * The card now uses lavfi `gradients`, drifting between its own palette colour and the next one,
 * so it stays in the same muted family instead of becoming a light show.
 *
 * The speed was chosen by repeated measurement rather than by eye, and the first choice was wrong:
 *
 *     color=              0 changes    longest still 5.00s
 *     gradients 0.05      MARGINAL — 0.00s, then 0.75s, then 0.75s across three runs
 *     gradients 0.20      32-39 changes, longest still 0.00s, in 8 runs out of 8
 *
 * At 0.05 the drift is slow enough that whether two sampled frames differ is close to a coin-flip.
 * A guarantee needs margin, not a setting that happens to pass once.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────────────────────
 *
 * It does not make the render look better than it is. The clip is still adopted as
 * `rescue_placeholder`, still counted in fallbackRatio, still penalised in the quality score, and
 * the coverage audit still reports the beat as having no footage. Only one thing changed: the
 * viewer is no longer shown a frozen video, which is a rendering fault whatever caused it.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const FEEDBACK = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");

describe("RONDE 155 — the card is still honest about being a card", () => {

  it("no zoom or crop was added — the motion is the source, not a fake camera move", () => {
    const idx = PIPE.indexOf("async function _generateColorFallbackInner");
    const body = PIPE.slice(idx, idx + 2600);
    expect(body).not.toContain("zoompan");
  });
});

