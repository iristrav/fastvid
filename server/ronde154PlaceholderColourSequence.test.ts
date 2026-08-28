/**
 * RONDE 154 — two placeholder cards in a row must not be one picture.
 *
 * ── The measurement ──────────────────────────────────────────────────────────────────────────
 *
 * Video 551, the first render carrying RONDE 152 (stills move) and RONDE 153 (research runs):
 *
 *                      video 550        video 551
 *     visual changes         237              382     +61%
 *     still segments           3                2
 *     longest still       34.13s           19.38s     −43%
 *     research attempts        0                1
 *
 * The frozen-still cause is gone. What is left is 19.38s, and it is not a still image at all — it
 * is placeholder colour cards that merged.
 *
 * ── Why they merged ──────────────────────────────────────────────────────────────────────────
 *
 * The colour was `colors[Math.abs(seed) % colors.length]`, `seed = sceneIndex * 1000 + slotIndex`.
 * Scene 2 of video 551 asked for slots 101, 102 and 302:
 *
 *     (2*1000 + 101) % 8 = 5
 *     (2*1000 + 102) % 8 = 6
 *     (2*1000 + 302) % 8 = 6      ← same colour as the card before it
 *
 * Two adjacent cards, one colour. To `mpdecimate` that is a single unchanging picture, which is
 * how a render whose longest individual card is about five seconds reported a 19.38s still.
 *
 * ── Why arithmetic could not fix it ──────────────────────────────────────────────────────────
 *
 * Slot numbers are tier markers, not a sequence: 101, 102, then 302. Any linear function of the
 * slot collides whenever two slots differ by a multiple of the palette size, and 302 − 102 = 200
 * is. `(scene * 31 + slot) % 8` was tried and collides on exactly this case — the test below keeps
 * that measurement so the next person does not retry it.
 *
 * The colour therefore comes from a counter of how many cards have been made, which is the only
 * quantity guaranteed to advance by one between consecutive cards.
 *
 * ── What this does NOT claim ─────────────────────────────────────────────────────────────────
 *
 * A card is still a card. This makes four consecutive cards read as four cards instead of one long
 * one; it does not put footage on screen, and the audit still reports every one of them as a
 * placeholder. The cure for a card is finding a picture — RONDE 153's work.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const PALETTE = 8;

/** Video 551's actual slot requests for scene 2, in the order they were made. */
const SCENE_2_SLOTS = [101, 102, 302] as const;

describe("RONDE 154 — the collision that produced a 19.38s still", () => {
  it("the old derivation really did give two adjacent cards the same colour", () => {
    const old = SCENE_2_SLOTS.map((slot) => Math.abs(2 * 1000 + slot) % PALETTE);
    expect(old).toEqual([5, 6, 6]);
    // Adjacent duplicate — the second and third card were one unchanging picture.
    expect(old[1]).toBe(old[2]);
  });

  it("the obvious arithmetic fix collides too — measured, so nobody retries it", () => {
    const mixed = SCENE_2_SLOTS.map((slot) => Math.abs(2 * 31 + slot) % PALETTE);
    expect(mixed[1]).toBe(mixed[2]);
  });

  it("a sequence counter cannot produce two the same in a row", () => {
    // Whatever the slot numbers are, successive draws differ while the palette has ≥2 entries.
    const drawn: number[] = [];
    let seq = 0;
    for (let card = 0; card < 40; card++) drawn.push(seq++ % PALETTE);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i], `card ${i}`).not.toBe(drawn[i - 1]);
    }
    // And it uses the whole palette rather than a corner of it.
    expect(new Set(drawn).size).toBe(PALETTE);
  });
});

describe("RONDE 154 — the pipeline uses the counter", () => {
  it("there is one counter, and it is module-scoped", () => {
    expect(PIPE).toContain("let colorFallbackSequence = 0;");
    expect((PIPE.match(/let colorFallbackSequence = 0;/g) ?? []).length).toBe(1);
  });

  it("both card sites draw from it", () => {
    // The text-over-gradient card and the plain colour card.
    expect((PIPE.match(/colorFallbackSequence\+\+/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("no card site keys its colour on sceneIndex alone any more", () => {
    // That was the bug: every placeholder beat in one scene got the identical colour.
    expect(PIPE).not.toContain("colors[Math.abs(sceneIndex) % colors.length]");
  });

  it("the sequence is drawn once per card, not once per internal retry", () => {
    /**
     * generateColorFallback delegates to _generateColorFallbackInner, which tries several encoder
     * commands in turn. Drawing inside the retry loop would advance the counter per attempt and,
     * worse, make the logged colour disagree with the encoded one.
     */
    expect(PIPE).toContain("const variant = variantIndex ?? colorFallbackSequence++;");
    expect(PIPE).toContain("_generateColorFallbackInner(sceneIndex, safeDuration, out, workDir, variant);");
  });

  it("an explicit variant still wins, so a caller can pin a colour", () => {
    expect(PIPE).toContain("variantIndex ?? colorFallbackSequence++");
  });
});

describe("RONDE 154 — nothing about what a card IS has changed", () => {
  it("a card is still a placeholder in the audit", () => {
    // The colour is cosmetic; the accounting is what tells the truth about coverage.
    expect(PIPE).toContain("isPlaceholderGuaranteedTier(tierOut.tier) ? \"rescue_placeholder\"");
  });

  it("no fake camera move was added — the card is a source, not a pan", () => {
    /**
     * SUPERSEDED IN PART BY RONDE 155, on the owner's explicit instruction.
     *
     * This round argued the card should stay a flat colour, because animating it would turn the
     * stillness audit green while showing the viewer the same absence of footage. The owner heard
     * that argument and overruled it: a frozen picture is unacceptable regardless of cause. R155
     * therefore replaced the flat `color=` source with an animated `gradients` one, measured at
     * longestStill 0.00s in 8 runs of 8.
     *
     * The concern behind this test was never really "flat vs moving" — it was that the accounting
     * must not improve when only the appearance does. That half is still asserted, here and above:
     * the clip is still adopted as rescue_placeholder, still in fallbackRatio, still penalised.
     *
     * What remains asserted below is the narrower rule that survives: the motion comes from the
     * SOURCE, not from a zoom or pan faked over a still. A zoompan here would be the pipeline
     * pretending to have a camera it does not have.
     */
    const idx = PIPE.indexOf("async function _generateColorFallbackInner");
    const body = PIPE.slice(idx, idx + 4200);
    expect(body).toContain("gradients=");
    expect(body).not.toContain("zoompan");
    expect(body).not.toContain("geq=");
    // The flat-colour ladder is still there for a box that cannot run the gradient source.
    expect(body).toContain('color=c=#${color}');
  });
});
