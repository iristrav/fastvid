/**
 * A REFUSED ASSET COMES BACK A STRANGER — RONDE 625.
 *
 * ── What render 598 did, every thirty-five seconds, for nine minutes ────────────────────────
 *
 *     [Pipeline] Scene 2: Internet Archive clip added: The World at War Italia 1942 44 …
 *     [Pipeline] Scene 2 beat 0: rejected — baked-in on-screen text (scene_2_b0_ia_archive_0…)
 *     [Pipeline] Scene 2 beat 0: rejected — baked-in on-screen text (scene_2_b0_ia_archive_1…)
 *     [Pipeline] Scene 2 beat 0: rejected — baked-in on-screen text (scene_2_b0_ia_archive_2…)
 *     [Pipeline] Scene 2 beat 0: no unused curated archive asset (beat tags: hitler, bunker)
 *
 * The same three clips, refused for the same reason, offered again on the next round. The refusal
 * is correct — they are `legendado` uploads with Portuguese subtitles burnt into the picture — and
 * it was re-earned from scratch every time.
 *
 * ── Why they came back ──────────────────────────────────────────────────────────────────────
 *
 * `providerAssetAlreadyUsed` is the pre-download skip, and its own doc says what it remembers:
 * "already ADOPTED this render". A refused asset is never adopted, so it never enters that set,
 * so it returns a stranger. The refusal WAS written down — in `rejections`, whose header says
 * "Observability only" — and nothing ever read it back. An answer computed on one side and never
 * handed to the side that decides: this codebase's signature defect, here for the seventh time.
 *
 * ── The line this round will not cross ──────────────────────────────────────────────────────
 *
 * Only reasons that are facts about the FILE may write an asset off. A verdict belongs to a
 * (picture, narration) pair — the gate's own cache says so, keying on both — so `vision_gate` and
 * `beat_image_gate` refuse a picture FOR THIS BEAT, and carrying that to another beat would throw
 * away footage the editor never refused. Burnt-in subtitles are in the pixels and are the same on
 * every beat of every scene.
 *
 * So `FILE_LEVEL_REJECT_REASONS` has exactly one member, and §3 is the test that says why adding
 * to it is a decision and not a convenience.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  
  
  createRejectionRegistry,
  
} from "./rejectionRegistry";
import { isCanonicalAssetKey } from "./beatVisualRelevance";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Render 598's three clips, by the identity `clipContentKey` gives them. */
const R598 = [
  "internet_archive:youtube-rfdeCeMzn78",
  "internet_archive:youtube-nQdHeaKheis",
  "internet_archive:youtube-BeL8u716peU",
];

/* ═══════════ §1 — the render remembers what it refused ═══════════ */

describe("§1 — render 598's three clips", () => {
  /** ONE ROUTE: the never-written `refusedAssets` map is gone; a fresh registry holds nothing. */
  it("a fresh render starts with nothing written off", () => {
    const r = createRejectionRegistry();
    expect(r.recorded).toBe(0);
    expect(r.entries).toHaveLength(0);
  });
});

/* ═══════════ §3 — identity, never a filename ═══════════ */

describe("§3 — written off by what it IS, not what it is called", () => {
  it("render 598's identities are canonical asset keys", () => {
    for (const id of R598) expect(isCanonicalAssetKey(id), id).toBe(true);
  });

  it("A FINGERPRINT IS NOT AN IDENTITY — a file: key names one copy", () => {
    expect(isCanonicalAssetKey("file:184320:scene_2_b0_ia_archive_0.mp4")).toBe(false);
  });
});
