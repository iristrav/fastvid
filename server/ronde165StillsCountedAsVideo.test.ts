/**
 * RONDE 165 — the render measured 85% moving while shipping scanned photographs.
 *
 * ── The complaint, and the number that contradicted it ───────────────────────────────────────
 *
 * "Ik zie nog veel afbeeldingen in de clip staan." Render 554's own report said:
 *
 *     [Quality] Video 554: visual mix — 11/13 moving (85%), 2 still
 *
 * The owner was right and the number was wrong. One of the clips it counted as moving:
 *
 *     scene_2_b2_pool_loc_https___www_loc_gov_item_sn86089716_1941__pid_loc.mp4
 *
 * `sn86089716` is a Library of Congress Chronicling America serial — a scanned newspaper page.
 * A photograph of a newspaper, counted as real video.
 *
 * ── Why it counted as video ──────────────────────────────────────────────────────────────────
 *
 * classifyClipMixKind recognises stills from wikimedia, openverse, unsplash, serp and the curated
 * `_still` suffix. It has no rule for loc, nara, nasa, internet_archive or europeana, so an image
 * from any of those reached its last line — "ends in .mp4, therefore real video".
 *
 * The download knew better. `isVideo` is computed one line above the output path and was thrown
 * away: a film clip and a scanned photograph both came out as `..._pool_<source>_<id>.mp4`.
 *
 * ── Why this mattered more than a wrong number ───────────────────────────────────────────────
 *
 * RONDE 161 pushes the ranking toward moving footage, scaled by movingShareDeficit — which
 * returns 0 the moment the MEASURED share reaches the target. A render full of photographs that
 * measures 85% moving stops asking for video. The mis-count silently switched off the correction
 * for exactly the renders that needed it.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * The still marker `_still`, which the curated route has used all along and classifyClipMixKind
 * already reads. No new naming scheme and no second classifier: the one that exists is told the
 * truth at the one point that knows it.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TARGET_MOVING_SHARE,
  classifyClipMixKind,
  movingShareDeficit,
  summarizeMovingShare,
} from "./visualMixPolicy";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Verbatim from render 554's [RenderAsset] lines. */
const LOC_NEWSPAPER_SCAN =
  "scene_2_b2_pool_loc_https___www_loc_gov_item_sn86089716_1941__pid_loc";

describe("RONDE 165 — a scanned photograph is not real video", () => {
  it("the render 554 case: without the marker it counted as moving footage", () => {
    // The bug, reproduced on the exact filename production produced.
    expect(classifyClipMixKind(`${LOC_NEWSPAPER_SCAN}.mp4`)).toBe("real_video");
  });

  it("with the marker the same clip is counted as the photograph it is", () => {
    expect(classifyClipMixKind(`${LOC_NEWSPAPER_SCAN}_still.mp4`)).toBe("photo");
  });

  it("every provider whose images were miscounted is covered by the marker", () => {
    /**
     * loc, nara, nasa, internet_archive and europeana have no filename rule of their own — which
     * is why the marker, rather than five more patterns, is the fix.
     */
    for (const source of ["loc", "nara", "nasa", "internet_archive", "europeana"]) {
      expect(classifyClipMixKind(`scene_0_b0_pool_${source}_x1.mp4`), source).toBe("real_video");
      expect(classifyClipMixKind(`scene_0_b0_pool_${source}_x1_still.mp4`), source).toBe("photo");
    }
  });

  it("real footage from those same providers still counts as moving", () => {
    // Only the image path gets the marker, so a film clip is unaffected.
    expect(classifyClipMixKind("scene_1_b0_pool_internet_archive_reel7.mp4")).toBe("real_video");
    expect(classifyClipMixKind("scene_0_b1_curated_a56054.mp4")).toBe("real_video");
  });

  it("the stills that were already recognised still are", () => {
    expect(classifyClipMixKind("scene_2_guaranteed_wiki_s0_wiki_0__pid_wikimedia.mp4")).toBe("photo");
    expect(classifyClipMixKind("scene_0_b0_inet_img_ov_openverse_d0f8.mp4")).toBe("photo");
    expect(classifyClipMixKind("scene_2_b3_curated_a56153_still.mp4")).toBe("photo");
  });
});

describe("RONDE 165 — the mis-count was switching off the correction", () => {
  it("render 554's reported mix applied no pressure toward video", () => {
    // 11 of 13 measured as moving: above the 80% target, so the RONDE 161 bonus stayed dormant.
    expect(summarizeMovingShare(11, 2)).toBe("11/13 moving (85%), 2 still");
    expect(movingShareDeficit(11, 13, DEFAULT_TARGET_MOVING_SHARE)).toBe(0);
  });

  it("counted honestly, the same render would have pushed for more footage", () => {
    /**
     * Render 554 shipped at least one scanned newspaper and one Wikimedia still among the ten
     * clips its lineage names. Moving two of the eleven "moving" clips into the still column is
     * enough to reopen the deficit — which is the mechanism doing its job again.
     */
    expect(movingShareDeficit(9, 13, DEFAULT_TARGET_MOVING_SHARE)).toBeGreaterThan(0);
  });
});

describe("RONDE 165 — wired at the one place that knows", () => {
  it("the download stamps the marker from its own mediaType", () => {
    expect(PIPE).toContain('const stillSuffix = isVideo ? "" : "_still";');
    expect(PIPE).toContain(
      "`scene_${sceneIndex}_b${beatIndex}_pool_${candidate.source}_${safeId}${stillSuffix}.mp4`"
    );
  });

  it("it uses the marker the curated route already uses — no second scheme", () => {
    const policy = readFileSync(join(__dirname, "visualMixPolicy.ts"), "utf8");
    // classifyClipMixKind already reads `_still`; nothing was added to it.
    expect(policy).toContain("_still");
    const curated = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(curated).toContain("_still\\.mp4$");
  });

  it("the marker is applied before the provider tag, so both survive", () => {
    const idx = PIPE.indexOf('const stillSuffix = isVideo ? "" : "_still";');
    const block = PIPE.slice(idx, idx + 600);
    expect(block).toContain("tagPathWithProviderAsset(");
    expect(block).toContain("candidate.source,");
  });

  it("a still is now recognised by the blur-fill predicate too", async () => {
    // Same marker, so the existing still-handling paths pick it up without being told separately.
    const { isPipelineBlurFillStillClip } = await import("./curatedMediaSourcing");
    expect(isPipelineBlurFillStillClip(`${LOC_NEWSPAPER_SCAN}_still.mp4`)).toBe(true);
  });
});
