/**
 * RONDE 201 — TWO ROUTES REMEMBERED THE MONTAGE; THIRTY-FIVE BUILT IT.
 *
 * ── The finding ─────────────────────────────────────────────────────────────────────────────
 *
 * `documentaryTasteModel` is the only part of this pipeline that judges a picture against the ones
 * BEFORE it. It scores shot progression — four identical framings in a row is 10 out of 100 — plus
 * clip fatigue and an emotional arc across a scene. It is wired and it runs.
 *
 * Its memory was not. `recordTasteModelAdoption` had exactly two callers, both inside `adoptClip`.
 * Every other route that puts a picture on a beat — the rescue ladder, the curated archive, the
 * forced still, the guaranteed ladder, the AI tiers — adopted in silence. So the model scored the
 * next candidate against a history with holes in it, and the pictures those routes adopted were
 * never scored for how they sit after the previous shot at all.
 *
 * That is RONDE 94's shape (a rule 35 routes must follow, registered by two) and it gets RONDE
 * 94's answer: record it where every route already passes.
 *
 * ── And the same round's parity gap ─────────────────────────────────────────────────────────
 *
 * The render contract names it: "compose burns in no captions at all. The only route that carries
 * them is the cinematic one." Which of the two delivery routes ran decided whether a viewer got
 * the subtitles they had switched on. Both routes now draw them, from the same beats.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const AUDIT = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
const TASTE = fs.readFileSync(path.join(__dirname, "documentaryTasteModel.ts"), "utf8");

/* ═══════════ 1. one owner for shot variety and for usage ═══════════ */

describe("R201 §1 — the montage memory nobody wrote is gone, its questions have one owner each", () => {
  /**
   * The memory was written only by `recordClipAdopt`, whose two callers went with the scene pool.
   * From then on clip fatigue and shot progression scored every candidate alike. Shot variety is
   * the AssetDirector's; how often an asset was used is the usage history's.
   */
  it("the taste model no longer scores clip fatigue or shot progression", () => {
    expect(TASTE).not.toContain("clipFatigueScore");
    expect(TASTE).not.toContain("scoreShotProgression");
    expect(TASTE).not.toContain("clipUsageCount");
    expect(TASTE).not.toContain("export function recordTasteModelAdoption");
  });

  it("no binding for a memory that is never read", () => {
    expect(PIPE).not.toContain("bindTasteModelContext(");
    expect(AUDIT).not.toContain("tasteByAudit");
  });
});

/* ═══════════ 2. captions: the switch now reaches a filter ═══════════ */

describe("R201 §2 — both delivery routes draw the subtitles", () => {
  it("neither dead assignment survives", () => {
    expect(PIPE, "the ternary with two empty branches is still there").not.toContain(
      'const subtitleDrawtext = enableSubtitles ? "" : "";'
    );
    expect(PIPE, "the hardcoded empty string is still there").not.toContain(
      "const subtitleDrawtext = '';"
    );
  });

  it("captions are drawn only when the operator asked for them", () => {
    for (const m of PIPE.matchAll(/writeSceneCaptionFilter\(\{/g)) {
      const before = PIPE.slice(Math.max(0, m.index! - 120), m.index!);
      expect(before, "a caption filter is built without checking the switch").toContain(
        "enableSubtitles"
      );
    }
  });
});
