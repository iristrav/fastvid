/**
 * RONDE 166 (§3) — attention moments, classified on the live route.
 *
 * ── What the audit found ─────────────────────────────────────────────────────────────────────
 *
 * `classifyAttentionMoment` was written in RONDE 157 and called by nothing outside its own test.
 * The nine moments existed, the evidence rules existed, and no beat in any real video was ever
 * classified.
 *
 * ── What these tests guard ───────────────────────────────────────────────────────────────────
 *
 * Two things, and the second matters more than the first. That the classification now RUNS from
 * the production entry point — and that connecting it did not loosen the evidence rules. §3 is
 * explicit: a beat does not become a moment because it is first, or long, or in an important
 * scene. Half of what follows is beats that must still classify as null.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCinematicSceneInputs, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import type { Scene } from "./pipeline/types";

const ORIGINAL = process.env.CINEMATIC_EDITING_ENGINE;
beforeEach(() => {
  process.env.CINEMATIC_EDITING_ENGINE = "true";
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CINEMATIC_EDITING_ENGINE;
  else process.env.CINEMATIC_EDITING_ENGINE = ORIGINAL;
});

function scene(index: number, text: string): Scene {
  return { index, text, visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 };
}

function facts(index: number, texts: string[]): SceneFacts {
  return {
    scene: scene(index, texts.join(" ")),
    beats: texts.map((t, i) => ({
      index: i, text: t, searchQuery: "apple park", powerWord: "Apple",
      holdSec: 4, voiceStartSec: i * 4, voiceEndSec: i * 4 + 4,
    })),
    clips: texts.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 },
      adoption: { provider: "wikimedia", providerAssetId: `${index}${i}`, sourceUrl: "https://x/y" },
    })),
  };
}

/** Run the real pipeline over one scene's worth of beats and return the attention verdicts. */
function attentionFor(texts: string[]) {
  const built = buildCinematicSceneInputs({ scenes: [facts(0, texts)] });
  return runCinematicPipeline({ videoId: 1, scenes: built.scenes }).attention;
}

/**
 * The same, with the opening padded out so the beat under test is genuinely PAST the hook window.
 *
 * The window is the first 12 seconds AND the first four beats — both, not either. A fixture whose
 * beats all start inside it can only ever produce hooks, which is correct behaviour and a useless
 * test. The padding beats are deliberately empty of numbers, quotes and questions so they classify
 * as null and cannot affect what is being measured.
 */
const FILLER = [
  "Work continued through the winter.",
  "The surrounding roads were rebuilt.",
  "Landscaping followed in the spring.",
  "Contractors came and went for months.",
];
function attentionAfterOpening(text: string) {
  const out = attentionFor([...FILLER, text]);
  expect(out.slice(0, FILLER.length).filter(Boolean), "a filler beat classified as a moment").toEqual([]);
  return out[FILLER.length];
}

/* ═══════════════════════ it runs at all ═══════════════════════ */

describe("R166 §3 — the classification runs from the production entry point", () => {
  it("returns one verdict per beat, in beat order", () => {
    const out = attentionFor(["Apple spent 3 billion dollars.", "The campus opened later."]);
    expect(out).toHaveLength(2);
    expect(out[0]?.beatId).toBe("s0b0");
  });

  it("classifies a beat that opens with a figure as a hook, with its evidence", () => {
    const out = attentionFor(["Apple spent 3 billion dollars before anyone saw it."]);
    expect(out[0]).toBeTruthy();
    expect(out[0]!.moment).toBe("hook");
    /** The receipt, not just the verdict — a decision nobody can check is one nobody should trust. */
    expect(out[0]!.evidence).toContain("3");
  });

  it("carries the shot/camera/graphic advice that goes with the moment", () => {
    const out = attentionFor(["Apple spent 3 billion dollars before anyone saw it."]);
    const effects = out[0]!.effects;
    expect(typeof effects.why).toBe("string");
    expect(effects.why.length).toBeGreaterThan(0);
    expect(effects).toHaveProperty("preferShot");
    expect(effects).toHaveProperty("camera");
  });

  it("classifies a quotation past the opening as a quote", () => {
    expect(
      attentionAfterOpening('Jobs said, "It just works, and that is the point."')?.moment
    ).toBe("quote");
  });

  /**
   * Past the opening, a figure is a STATISTIC rather than a hook. Both readings are correct and the
   * difference is position — which is exactly why position is necessary for a hook and never
   * sufficient on its own.
   */
  it("classifies a figure past the opening as a statistic rather than a hook", () => {
    expect(attentionAfterOpening("The ring holds 12,000 people.")?.moment).toBe("statistic");
  });

  /** And the same sentence IN the opening is a hook — the pair is what proves the rule. */
  it("the same figure inside the opening is a hook", () => {
    expect(attentionFor(["The ring holds 12,000 people."])[0]?.moment).toBe("hook");
  });
});

/* ═══════════════════════ the evidence rules still hold ═══════════════════════ */

describe("R166 §3 — position alone never makes a beat a moment", () => {
  /**
   * The rule §3 states outright. An opening beat with nothing in it is not a hook; a `hook`
   * requires an early beat that ALSO carries a number, a quotation or a question.
   */
  it("a first beat with no number, quote or question is NOT a hook", () => {
    const out = attentionFor(["The campus took a long time to finish."]);
    expect(out[0], "an empty opening beat was marked as a moment").toBeNull();
  });

  it("a long ordinary beat is not a moment either", () => {
    const out = attentionFor([
      "The campus took a long time to finish and the work went on through several seasons " +
        "while the surrounding roads were rebuilt and the landscaping was planted out.",
    ]);
    expect(out[0]).toBeNull();
  });

  it("most beats of an ordinary scene classify as null", () => {
    const out = attentionFor([
      "The campus took a long time to finish.",
      "Work continued through the winter.",
      "The surrounding roads were rebuilt.",
    ]);
    expect(out.filter(Boolean)).toHaveLength(0);
  });

  /** An empty beat cannot be a moment, and must not throw trying to be one. */
  it("an empty beat is null rather than an error", () => {
    const built = buildCinematicSceneInputs({ scenes: [facts(0, ["   "])] });
    if (built.scenes.length === 0) return;
    const out = runCinematicPipeline({ videoId: 1, scenes: built.scenes }).attention;
    expect(out.every((a) => a === null)).toBe(true);
  });
});

/* ═══════════════════════ determinism ═══════════════════════ */

describe("R166 §3 — the same script always classifies the same way", () => {
  it("is deterministic across runs", () => {
    const texts = [
      "Apple spent 3 billion dollars before anyone saw it.",
      'Jobs said, "It just works."',
      "Work continued through the winter.",
    ];
    const first = JSON.stringify(attentionFor(texts));
    for (let i = 0; i < 4; i++) {
      expect(JSON.stringify(attentionFor(texts))).toBe(first);
    }
  });

  /**
   * Position changes the READING and never the evidence: the same quotation is a `hook` in the
   * opening and a `quote` after it, and is a moment in both cases because the quotation is there.
   */
  it("position changes which moment a sentence is, not whether it is one", () => {
    const early = attentionFor(['Jobs said, "It just works."'])[0];
    const late = attentionAfterOpening('Jobs said, "It just works."');
    expect(early?.moment).toBe("hook");
    expect(late?.moment).toBe("quote");
    expect(early?.evidence).toContain("quotation");
  });
});
