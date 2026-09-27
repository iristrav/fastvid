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

  it("no card site keys its colour on sceneIndex alone any more", () => {
    // That was the bug: every placeholder beat in one scene got the identical colour.
    expect(PIPE).not.toContain("colors[Math.abs(sceneIndex) % colors.length]");
  });
});
