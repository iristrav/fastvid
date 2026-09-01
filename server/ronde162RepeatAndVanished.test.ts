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

describe("RONDE 162 §1 — a scene that loses footage to validation asks for more", () => {
  it("the shortfall is measured against what the montage needs, not against zero", () => {
    expect(PIPE).toContain("const lostToValidation = clipsBeforeValidation - safeClips.length;");
    expect(PIPE).toContain("safeClips.length < requiredMontageClipsForDuration(duration)");
  });

  it("replacements come from the rescue that already existed, not a new engine", () => {
    const block = replacementBlock();
    expect(block).toContain("rescueFastShortComposeClips(");
    // One rescue, the same one the all-clips-failed branch uses.
    expect((PIPE.match(/await rescueFastShortComposeClips\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("a replacement is validated like any other clip before it is used", () => {
    const block = replacementBlock();
    expect(block).toContain("await requireValidClip(");
  });

  it("a replacement that duplicates what is already there is skipped", () => {
    const block = replacementBlock();
    expect(block).toContain("if (safeClips.some((c) => clipContentKey(c) === key)) continue;");
  });

  it("it stops as soon as the scene has what it needs — no forced variety", () => {
    const block = replacementBlock();
    expect(block).toContain("if (safeClips.length >= requiredMontageClipsForDuration(duration)) break;");
  });

  it("no colour card is added to make the count look better", () => {
    /**
     * The brief's rule, and the right one: a card is not footage. Padding the montage with one to
     * avoid a repeat trades a repeat for something worse.
     */
    const block = replacementBlock();
    expect(block).not.toContain("generateGuaranteedBeatClip");
    expect(block).not.toContain("generateColorFallback");
    expect(block).toContain("Deliberately not done here: adding a colour card");
  });

  it("it only runs when something was actually lost", () => {
    // A scene that passed validation intact must not start a rescue it does not need.
    const block = replacementBlock();
    expect(block).toContain("lostToValidation > 0");
    expect(block).toContain("safeClips.length > 0");
  });

  it("it respects the compose network block, including RONDE 159's per-scene exemption", () => {
    const block = replacementBlock();
    expect(block).toContain("!isComposeNetworkBlocked(composeOptions.dedup, scene.index)");
  });
});

describe("RONDE 162 §2 — every drop names its reason", () => {
  it("all three validation refusals file an outcome", () => {
    const body = validationBody();
    expect(body).toContain("`invalid_file:s${sceneIndex}`");
    expect(body).toContain("`unusable_stream:s${sceneIndex}`");
    expect(body).toContain("`mostly_black:s${sceneIndex}`");
    expect(body).toContain('lineage?.recordEventForPath(clipPath, "REMOVED"');
  });

  it("a placeholder gets a reason too — RONDE 159's assumption was wrong", () => {
    const body = validationBody();
    expect(body).toContain("`placeholder_rejected:s${sceneIndex}`");
    // ...and at the other silent site, the compose filter.
    expect(PIPE).toContain("`placeholder_not_used:s${sceneIndex}`");
    expect(PIPE).not.toContain("A placeholder is not an asset; it has no lineage record to settle.");
  });

  it("the reasons are distinct, so a log says which check refused the clip", () => {
    const reasons = [
      "invalid_file:s",
      "unusable_stream:s",
      "mostly_black:s",
      "placeholder_rejected:s",
      "placeholder_not_used:s",
      "compose_gate:s",
      "duplicate_content:s",
    ];
    for (const r of reasons) expect(PIPE, r).toContain(r);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("both validation call sites hand over the ledger, or nothing is recorded", () => {
    const calls = PIPE.match(/await requireValidClip\([\s\S]{0,180}?\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call, call).toContain("lineage");
    }
  });

  it("nothing is marked processed to silence the warning", () => {
    /**
     * The brief's explicit prohibition. Every reason above corresponds to a real refusal that
     * really happened; none of them is applied to a clip that survived.
     */
    const body = validationBody();
    // The successful path returns the clip and files nothing.
    expect(body.trimEnd().endsWith("return clipPath;\n}")).toBe(true);
  });
});

describe("RONDE 162 — what this round did not touch", () => {
  it("RONDE 157's replay and RONDE 158's net are intact", () => {
    expect(PIPE).toContain("export async function extendMontageForCoverage(");
    expect(PIPE).toContain("export async function repairShortSceneVideo(");
    expect(PIPE).toContain('headChain = montageTailPadVF("0:v", montageDur, outDur);');
  });

  it("the hold sites are still the two earlier rounds counted", () => {
    expect((PIPE.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(2);
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
