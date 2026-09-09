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

import {
  bindTasteModelContext,
  createClipAdoptAudit,
  recordClipAdopt,
} from "./clipAdoptAudit";
import type { TasteModelContext } from "./documentaryTasteModel";
import type { CandidateMeta } from "./assetDirector";

/** The render's own shape, as `createVisualDedupState` builds it. */
const emptyTasteContext = (): TasteModelContext => ({
  clipUsageCount: new Map(),
  recentShotHistory: [],
  recentEmotions: [],
  activeEntity: null,
  activeEra: null,
  beatText: "",
});

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 1. every route enters the montage's memory ═══════════ */

describe("R201 §1 — the memory is written where every route passes", () => {
  const withMemory = () => {
    const audit = createClipAdoptAudit();
    const ctx = emptyTasteContext();
    const meta = new Map<string, CandidateMeta>();
    bindTasteModelContext(audit, ctx, meta);
    return { audit, ctx, meta };
  };

  it("a rescue adoption is remembered, not only a funnel one", () => {
    const { audit, ctx } = withMemory();
    recordClipAdopt(audit, 0, 0, "beat", "/w/rescue.mp4", "rescue_wikimedia");
    expect(ctx.recentShotHistory).toHaveLength(1);
    expect(ctx.clipUsageCount.get("/w/rescue.mp4")).toBe(1);
  });

  it.each([
    "archive",
    "rescue_stock",
    "subject_fallback",
    "guaranteed",
    "ai",
    "script_image",
  ])("%s reaches the shot history", (source) => {
    const { audit, ctx } = withMemory();
    recordClipAdopt(audit, 0, 0, "beat", `/w/${source}.mp4`, source);
    expect(ctx.recentShotHistory, `${source} adopted in silence`).toHaveLength(1);
  });

  it("the history is in adoption order, which is what 'after the last one' means", () => {
    const { audit, ctx, meta } = withMemory();
    const shot = (t: string): CandidateMeta =>
      ({ annotation: { cinematography: { shotType: t } } }) as unknown as CandidateMeta;
    meta.set("/w/a.mp4", shot("wide"));
    meta.set("/w/b.mp4", shot("medium"));
    meta.set("/w/c.mp4", shot("close"));
    recordClipAdopt(audit, 0, 0, "beat", "/w/a.mp4", "archive");
    recordClipAdopt(audit, 0, 1, "beat", "/w/b.mp4", "rescue_archive");
    recordClipAdopt(audit, 0, 2, "beat", "/w/c.mp4", "subject_fallback");
    expect(ctx.recentShotHistory).toEqual(["wide", "medium", "close"]);
  });

  it("a clip used twice is counted twice — that is what fatigue means", () => {
    const { audit, ctx } = withMemory();
    recordClipAdopt(audit, 0, 0, "beat", "/w/same.mp4", "archive");
    recordClipAdopt(audit, 1, 0, "beat", "/w/same.mp4", "extend");
    expect(ctx.clipUsageCount.get("/w/same.mp4")).toBe(2);
  });

  it("an unbound audit records nothing and throws nothing", () => {
    // A caller outside a render has no memory to write to; that must not be an error.
    const audit = createClipAdoptAudit();
    expect(() => recordClipAdopt(audit, 0, 0, "beat", "/w/x.mp4", "archive")).not.toThrow();
  });

  it("adoptClip no longer records it a second time", () => {
    /**
     * The two calls it used to make are gone. Keeping them would double this route's pictures in
     * the fatigue count and the shot history the NEXT beat is scored against — the same picture
     * would read as two, and a progression step as a repeat.
     */
    expect(PIPE).not.toContain("recordTasteModelAdoption(p, dedup.tasteModelCtx");
    expect(PIPE).not.toContain("recordTasteModelAdoption(transformed, dedup.tasteModelCtx");
  });

  it("and it is bound once, beside the other three render bindings", () => {
    expect(PIPE).toContain(
      "bindTasteModelContext(state.clipAdoptAudit, state.tasteModelCtx, state.clipAnnotationMeta)"
    );
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

  it("the documentary look no longer swallows the captions", () => {
    /**
     * The second defect, in the line under the first: `documentaryStyleEnabled() ? colorGrade : …`
     * dropped the subtitle fragment whenever the documentary grade was on. The grade and the
     * subtitles are different things and both now reach the chain.
     */
    expect(PIPE).not.toContain(
      "const fadeFilter = documentaryStyleEnabled() ? colorGrade : `${colorGrade}${subtitleDrawtext}`;"
    );
    expect((PIPE.match(/const fadeFilter = `\$\{colorGrade\}\$\{subtitleDrawtext\}`;/g) ?? []).length)
      .toBe(2);
  });

  it("both compose paths build the filter from the render's own beat record", () => {
    const uses = [...PIPE.matchAll(/writeSceneCaptionFilter\(\{/g)];
    expect(uses.length, "one compose path still draws nothing").toBe(2);
    expect(PIPE).toContain("sceneBeatsBySceneIndex?.get(scene.index)");
  });

  it("captions are drawn only when the operator asked for them", () => {
    for (const m of PIPE.matchAll(/writeSceneCaptionFilter\(\{/g)) {
      const before = PIPE.slice(Math.max(0, m.index! - 120), m.index!);
      expect(before, "a caption filter is built without checking the switch").toContain(
        "enableSubtitles"
      );
    }
  });

  it("the two paths are mutually exclusive, so a scene is never captioned twice", () => {
    // `phase === "effects"` returns before the full compose path is reached.
    const at = PIPE.indexOf('if (composeOptions?.phase === "effects" && composeOptions.assemblyPath) {');
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 700);
    expect(block).toContain("return r;");
  });

  it("what the render drew, or could not, is printed per scene", () => {
    expect(PIPE).toContain("[Captions] scene ${scene.index}");
    expect(PIPE).toContain("no beat carried a measured voice window");
  });
});
