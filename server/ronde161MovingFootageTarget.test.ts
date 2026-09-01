/**
 * RONDE 161 — "gebruik zoveel mogelijk echte beelden in plaats van afbeeldingen".
 *
 * ── What render 553 measured ─────────────────────────────────────────────────────────────────
 *
 *     [Quality] Video 553: visual mix — 7/10 moving (70%), 3 still
 *
 * Three of ten clips were photographs panned with Ken Burns. That is the "afbeeldingen" in the
 * instruction, and it is a real number rather than an impression.
 *
 * ── Why nothing was pulling toward video ─────────────────────────────────────────────────────
 *
 * The mechanism to prefer moving footage exists and is wired: `movingShareDeficit` measures how
 * far the render is running below its target and the retrieval funnel scales a ranking bonus by
 * it. But the deficit is 0 the moment the share reaches the target, and the target was 0.45.
 * Render 553 passed 45% within its first few clips, so the bonus was dormant for the entire
 * render — the pipeline had a preference for video and never once applied it.
 *
 * Raising the target to 0.80 is what turns that bonus back on for exactly the renders the
 * instruction is about. It is not a new mechanism, a second ranker, or a quota.
 *
 * ── Why 0.80 and not 1.0 ─────────────────────────────────────────────────────────────────────
 *
 * This is a target the ranking leans toward, never a rule the selection must satisfy. A
 * photograph that is the only material matching its narration still wins, because the real
 * alternative is not better footage — it is a placeholder colour card. Match beats motion;
 * motion now wins every tie that is not about matching.
 *
 * For the same reason archiveMaxImageClipsPerVideo was deliberately NOT tightened: a hard cap on
 * photographs produces cards, not video.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TARGET_MOVING_SHARE,
  MIN_MIX_SAMPLE,
  classifyClipMixKind,
  movingShareDeficit,
  resolveTargetMovingShare,
} from "./visualMixPolicy";

afterEach(() => {
  delete process.env.TARGET_MOVING_SHARE;
});

describe("RONDE 161 — the preference for moving footage is actually applied", () => {
  it("render 553's own mix now produces pressure, where it produced none", () => {
    // 7 moving of 10 — the measured mix of the render that prompted the instruction.
    const underOldTarget = movingShareDeficit(7, 10, 0.45);
    const underNewTarget = movingShareDeficit(7, 10, DEFAULT_TARGET_MOVING_SHARE);
    expect(underOldTarget).toBe(0); // dormant: the bonus never fired all render
    expect(underNewTarget).toBeGreaterThan(0);
  });

  it("the target says what the instruction says", () => {
    expect(DEFAULT_TARGET_MOVING_SHARE).toBe(0.8);
    expect(resolveTargetMovingShare()).toBe(0.8);
  });

  it("it is a target, not a quota — the deficit is bounded and fades as video arrives", () => {
    /**
     * The bonus must not become a rule. It scales down to nothing as the render catches up, so a
     * beat whose only matching material is a photograph is never starved into a colour card.
     */
    const all = movingShareDeficit(0, 10);
    const most = movingShareDeficit(7, 10);
    const met = movingShareDeficit(8, 10);
    expect(all).toBeLessThanOrEqual(1);
    expect(all).toBeGreaterThan(most);
    expect(most).toBeGreaterThan(0);
    expect(met).toBe(0);
  });

  it("too few clips is still 'too early to tell', not 'maximum pressure'", () => {
    // One still out of one clip must not hand the next candidate the whole bonus on no evidence.
    expect(movingShareDeficit(0, MIN_MIX_SAMPLE - 1)).toBe(0);
    expect(movingShareDeficit(0, MIN_MIX_SAMPLE)).toBeGreaterThan(0);
  });

  it("an operator can still set it, and nonsense is refused", () => {
    process.env.TARGET_MOVING_SHARE = "0.5";
    expect(resolveTargetMovingShare()).toBe(0.5);
    process.env.TARGET_MOVING_SHARE = "not a number";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
    process.env.TARGET_MOVING_SHARE = "4";
    expect(resolveTargetMovingShare()).toBe(DEFAULT_TARGET_MOVING_SHARE);
  });
});

describe("RONDE 161 — what counts as a photograph is unchanged", () => {
  /**
   * The measurement has to stay honest, or raising the target just moves the lie. These are the
   * filename shapes render 553 actually produced.
   */
  it("an archive photograph panned into a clip is still a photograph", () => {
    expect(classifyClipMixKind("scene_1_b6_inet_img_ov_openverse_82ae6b1.mp4")).toBe("photo");
    expect(classifyClipMixKind("scene_0_b1_inet_img_wiki_wiki_0__pid_wikimedia.mp4")).toBe("photo");
    expect(classifyClipMixKind("scene_2_b3_curated_a56153_still.mp4")).toBe("photo");
  });

  it("real archive footage counts as moving", () => {
    expect(classifyClipMixKind("scene_1_b1_curated_a56099.mp4")).toBe("real_video");
    expect(classifyClipMixKind("scene_0_b0_ia_archive_0.mp4")).toBe("real_video");
  });

  it("stock and generated material are neither, and are counted as themselves", () => {
    expect(classifyClipMixKind("scene_0_b2_pex_vid39055591.mp4")).toBe("stock");
    expect(classifyClipMixKind("scene_1_b2_ai_fallback.mp4")).toBe("motion_graphics");
  });
});

describe("RONDE 161 — no hard cap was added", () => {
  it("a render made entirely of photographs is still a render, not a wall of cards", async () => {
    /**
     * The failure mode this round must not create: starving beats of the only material that
     * matches them. archiveMaxImageClipsPerVideo is the cap that would do it, and it is untouched
     * — the preference lives in the ranking, where a photograph can still win.
     */
    const { archiveMaxImageClipsPerVideo, archiveStillsPerMinute } = await import("./sourcingPolicy");
    expect(archiveStillsPerMinute()).toBe(2.5);
    expect(archiveMaxImageClipsPerVideo("1")).toBeGreaterThanOrEqual(2);
    expect(archiveMaxImageClipsPerVideo("8-10")).toBeGreaterThanOrEqual(20);
  });

  it("the archive route already offers video before photographs", async () => {
    const { orderCuratedCandidatesForBeat } = await import("./curatedMediaSourcing");
    const pick = (id: number, mediaType: "image" | "video") =>
      ({ asset: { id, mediaType } }) as unknown as Parameters<
        typeof orderCuratedCandidatesForBeat
      >[0][number];
    const ordered = orderCuratedCandidatesForBeat([
      pick(1, "image"),
      pick(2, "video"),
      pick(3, "image"),
    ]);
    expect(ordered.map((c) => c.asset.mediaType)).toEqual(["video", "image", "image"]);
  });
});
