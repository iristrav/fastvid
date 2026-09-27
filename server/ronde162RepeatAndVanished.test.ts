/**
 * RONDE 162 — the repetition and the vanished assets are the same defect.
 *
 * ── The trace, from render 553's own log ─────────────────────────────────────────────────────
 *
 *     Scene 2 started — clips=4, duration=22.2s
 *     Scene 2: dropping mostly-black clip scene_2_b1_curated_a56087.mp4
 *     Scene 2: dropping mostly-black clip scene_2_b3_curated_a56190.mp4
 *     Scene 2: only 2/7 unique clips for 21.9s voice
 *     Scene 2: montage 8.0s cannot reach 21.9s of voice even at the 2x cap — playing it 2x
 *     [RepeatAudit] repeated screen 21s (24.8%) — passed NO
 *       REPEAT  seen at 59s, 60s, 74s, 75s, 76s
 *       REPEAT  seen at 61s, 62s, 77s, 78s, 79s, 80s
 *
 * Scene 2 runs from 56.2s to 78.4s. Both repeats sit inside it, about fifteen seconds apart —
 * the length of one pass of its montage.
 *
 * ── Root cause of the repetition ─────────────────────────────────────────────────────────────
 *
 * NOT a dedup failure. The sourcing dedup never saw a second use of anything, because there was
 * not one: the scene had two clips for 21.9 seconds of narration. Compose validation dropped two
 * of its four clips as mostly-black — correctly — and there was a rescue for "every clip failed"
 * and none at all for "some did". The halved montage then hit RONDE 157's replay, which is what
 * put those two pictures on screen twice.
 *
 * More archive candidates for that scene had been found and scored and were never used (#56042,
 * #56176, #56168, #56212). So the fix is to ask for replacements when validation takes footage
 * away, through the rescue that already existed — not to pad the count with a colour card, which
 * would trade a repeat for something worse.
 *
 * ── Root cause of VANISHED_WITHOUT_OUTCOME ───────────────────────────────────────────────────
 *
 * Two routes, both silent drops:
 *
 *   · requireValidClip returned null for an unreadable file, an unusable stream or a mostly-black
 *     frame, and the caller filtered the null out. Every one of those is a correct refusal and
 *     none of them was written down.
 *   · composeReadySceneClips skipped placeholders on the assumption that a placeholder has no
 *     lineage record. RONDE 159 wrote that assumption down; render 553 disproved it — six
 *     `_guaranteed.mp4` clips hold ADOPTED events and were reported vanished for exactly this.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * The replacement block only, bounded by the branch that follows it.
 *
 * A fixed-size window would run into the all-clips-failed branch below, which legitimately does
 * generate a guaranteed card — and the assertion that this block adds no card would then read
 * that neighbour's code and fail on it. Measured boundaries, not a guessed length.
 */
const replacementBlock = (): string => {
  // From the note that explains the block, so the reasoning is covered too.
  const from = PIPE.indexOf("RONDE 162 — validation may take footage away");
  const to = PIPE.indexOf("if (safeClips.length === 0) {", from);
  return PIPE.slice(from, to);
};

/** requireValidClip's body, bounded by the section marker after it. */
const validationBody = (): string => {
  const from = PIPE.indexOf("async function requireValidClip(");
  const to = PIPE.indexOf("// ─── 3c1.", from);
  return PIPE.slice(from, to);
};

describe("RONDE 162 — what this round did not touch", () => {

  it("the hold sites are still the two earlier rounds counted", () => {
    /** RONDE 661: zero — both sat in the deleted compose montage's tail pad. */
    expect((PIPE.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(0);
  });

  it("the moving-footage target stays where RONDE 161 put it", async () => {
    const { DEFAULT_TARGET_MOVING_SHARE } = await import("./visualMixPolicy");
    expect(DEFAULT_TARGET_MOVING_SHARE).toBe(0.8);
  });

  it("a photograph still lasts at most five seconds", async () => {
    const { stillImageMaxSec } = await import("./stillImagePolicy");
    expect(stillImageMaxSec()).toBe(5);
  });
});
