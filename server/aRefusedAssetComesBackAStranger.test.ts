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
 * so it returns a stranger. The refusal WAS written down — in `clipRejectAudit`, whose header says
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
  FILE_LEVEL_REJECT_REASONS,
  assetRefusedForRender,
  createClipRejectAudit,
  noteAssetRefusedForRender,
} from "./clipRejectAudit";
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
  it("A WRITTEN-OFF ASSET IS RECOGNISED THE NEXT ROUND", () => {
    const audit = createClipRejectAudit();
    for (const id of R598) noteAssetRefusedForRender(audit, id, "baked_text");
    for (const id of R598) expect(assetRefusedForRender(audit, id)).toBe("baked_text");
  });

  it("and an asset nobody refused is still a stranger, as it should be", () => {
    const audit = createClipRejectAudit();
    noteAssetRefusedForRender(audit, R598[0]!, "baked_text");
    expect(assetRefusedForRender(audit, R598[1]!)).toBeNull();
    expect(assetRefusedForRender(audit, "internet_archive:something-else")).toBeNull();
  });

  it("the first reason wins — a later refusal does not rewrite the record", () => {
    const audit = createClipRejectAudit();
    noteAssetRefusedForRender(audit, R598[0]!, "baked_text");
    noteAssetRefusedForRender(audit, R598[0]!, "baked_text");
    expect(audit.refusedAssets.size).toBe(1);
  });

  it("a fresh render starts with nothing written off", () => {
    expect(createClipRejectAudit().refusedAssets.size).toBe(0);
  });
});

/* ═══════════ §2 — THE LINE: a verdict may not travel ═══════════ */

describe("§2 — only a fact about the file writes an asset off", () => {
  it("BAKED TEXT DOES — it is in the pixels, on every beat", () => {
    expect(FILE_LEVEL_REJECT_REASONS.has("baked_text")).toBe(true);
  });

  it("A VISION VERDICT DOES NOT — it belongs to a (picture, narration) pair", () => {
    const audit = createClipRejectAudit();
    for (const reason of ["vision_gate", "beat_image_gate", "hard_mismatch", "off_subject"]) {
      noteAssetRefusedForRender(audit, R598[0]!, reason);
      expect(
        assetRefusedForRender(audit, R598[0]!),
        `${reason} wrote an asset off for the whole render`
      ).toBeNull();
    }
  });

  it("nor does a budget — shortlist_full and still_cap are about the moment", () => {
    const audit = createClipRejectAudit();
    for (const reason of ["shortlist_full", "still_cap", "documentary_beat_gate"]) {
      noteAssetRefusedForRender(audit, R598[0]!, reason);
    }
    expect(audit.refusedAssets.size).toBe(0);
  });

  it("THE SET HAS ONE MEMBER, and that is the point", () => {
    /**
     * Each entry stops a candidate being offered again for a whole render, so the bar is that the
     * same asset could not possibly pass it later. If this number grows, someone decided that on
     * purpose and this assertion is where they say so.
     */
    expect([...FILE_LEVEL_REJECT_REASONS]).toEqual(["baked_text"]);
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

  it("and the pipeline only writes off a canonical key", () => {
    expect(SRC).toContain("if (isCanonicalAssetKey(assetIdentity)) {");
    expect(SRC).toContain('noteAssetRefusedForRender(dedup.clipRejectAudit, assetIdentity, "baked_text");');
  });

  it("an empty identity writes nothing off", () => {
    const audit = createClipRejectAudit();
    noteAssetRefusedForRender(audit, "   ", "baked_text");
    expect(audit.refusedAssets.size).toBe(0);
    expect(assetRefusedForRender(audit, "")).toBeNull();
    expect(assetRefusedForRender(undefined, R598[0]!)).toBeNull();
  });
});

/* ═══════════ §4 — the pipeline asks before it spends ═══════════ */

describe("§4 — the question is asked before the work, not after", () => {
  it("THE CHECK RUNS BEFORE THE DETECTOR", () => {
    const check = SRC.indexOf("const writtenOff = isCanonicalAssetKey(assetIdentity)");
    const detector = SRC.indexOf("const hasBakedText = await beatClipHasBakedText(clipPath);");
    expect(check).toBeGreaterThan(-1);
    expect(detector).toBeGreaterThan(-1);
    expect(check, "the write-off must be consulted before the probe").toBeLessThan(detector);
  });

  it("a re-offer is still counted and still says why, once", () => {
    /** The refusal stays in the per-beat tally; only the repetition is quiet. */
    expect(SRC).toContain("recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, writtenOff, queryLabel);");
    expect(SRC).toContain("`WRITTEN_OFF:${writtenOff}`");
    expect(SRC).toContain("was refused for ${writtenOff} earlier in this render");
  });

  it("and it refuses rather than adopting — this round removes work, not a gate", () => {
    const at = SRC.indexOf("const writtenOff = isCanonicalAssetKey(assetIdentity)");
    const body = SRC.slice(at, at + 1400);
    expect(body).toContain("return { pass: false");
  });
});
