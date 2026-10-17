/**
 * VIDEO 660 — the owner's four asks after the Remotion check:
 *
 *   A  text in the picture stands bottom LEFT at a NORMAL size (not 86/150 px in the middle);
 *   B  the render log names every graphic it drew, by type;
 *   C  the typing sound reaches the film (Freesound 434572 answered HTTP 404 in jobs 55–61);
 *   D  at least one animation in every started minute.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

import { translateEdl } from "./edlToTimeline";
import { emptyTimeline, ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic } from "./projectTimeline";
import { anchorGeometry, boxForPosition } from "./captionLayout";
import { assAlignment, assMarginL } from "./timelineRenderer";
import { OPENING_WORD_FONT_PX } from "./cinematicPipeline";
import { graphicDrawnLines } from "./graphicsOverlayDeps";
import { makeSyntheticSfx, syntheticSfxArgs, SYNTHETIC_SFX_PROVIDER, typewriterSfxClips, typingSoundsOnlyUnderTypingText } from "./typewriterSound";
import { MUSIC_BED_GAIN } from "./cinematicPipeline";
import { levelledGain } from "./timelineFilters";
import { soundEffectIsDeliverable } from "./audioAssetSource";
import { resolveSoundEffect } from "./audioAssetSource";
import { ensureAnimationEveryMinute, keyWordsIn, nameIn, yearIn } from "./animationFloor";
import type { EditDecision, CaptionInstruction } from "./cinematicEditingEngine/types";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const FRAME = { widthPx: 1920, heightPx: 1080 };

function decision(captions: CaptionInstruction[]): EditDecision {
  return {
    beatId: "s0b0",
    sceneIndex: 0,
    clip: {
      candidateId: "loc:a", assetType: "video", localPath: null, remoteUrl: "https://x/a.mp4",
      trimStartSec: 0, trimEndSec: 6, startSec: 0, endSec: 6, timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "none", intensity: 0, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions,
    motionGraphics: [],
    effects: [] as never,
    sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  };
}
const caption = (captionType: CaptionInstruction["captionType"], position: CaptionInstruction["position"]): CaptionInstruction => ({
  captionType, text: captionType === "subtitle" ? "The war began." : "1939", startSec: 1, endSec: 3, animation: "fade", position, reason: "r",
});

/* ═══════════════════════ A — bottom left, normal size ═══════════════════════ */

describe("A — text in the picture stands bottom left, at a normal size", () => {
  it("every editorial text the planner places — whatever position it asked for — is bottom left at 64 px (VIDEO 663, was 52)", () => {
    for (const position of ["center", "top", "lower-third", "bottom"] as const) {
      const { timeline } = translateEdl({
        videoId: 1,
        inputs: [{ decision: decision([caption("date", position)]), sceneOffsetSec: 0, identity: { provider: "loc", providerAssetId: "i/1", mediaUrl: "https://x/a.mp4" } }],
      });
      const text = timeline.tracks.flatMap((t) => (t.kind === "TEXT" ? t.texts : []))[0];
      expect(text, position).toBeDefined();
      expect(text!.style.position, position).toBe("bottom_left");
      expect(text!.style.fontSizePx, position).toBe(64);
      expect(text!.style.align, position).toBe("left");
    }
  });

  it("subtitles keep their own place and size", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision([caption("subtitle", "bottom")]), sceneOffsetSec: 0, identity: { provider: "loc", providerAssetId: "i/1", mediaUrl: "https://x/a.mp4" } }],
    });
    const sub = timeline.tracks.flatMap((t) => (t.kind === "CAPTIONS" ? t.captions : []))[0];
    expect(sub!.style.position).toBe("bottom");
    expect(sub!.style.fontSizePx).toBe(46);
  });

  it("the opening word is the same normal size, not 150 px", () => {
    expect(OPENING_WORD_FONT_PX).toBe(ON_SCREEN_TEXT_STYLE.fontSizePx);
    expect(OPENING_WORD_FONT_PX).toBeLessThan(86);
  });

  it("bottom_left is the lower-left corner in the layout engine and both renderers", () => {
    const anchor = anchorGeometry("bottom_left");
    expect(anchor.leftPct).not.toBeNull();
    const box = boxForPosition("bottom_left", { width: 300, height: 70 }, FRAME);
    expect(box.x).toBeLessThan(FRAME.widthPx * 0.1);
    expect(box.y + box.height).toBeGreaterThan(FRAME.heightPx * 0.85);
    // libass: alignment 1 is bottom-left, and its left margin is the anchor's.
    expect(assAlignment("bottom_left")).toBe(1);
    expect(assMarginL("bottom_left", FRAME.widthPx)).toBe(Math.round(FRAME.widthPx * anchor.leftPct!));
    expect(assMarginL("bottom", FRAME.widthPx)).toBe(40);
  });

  it("a text the person adds in the editor starts bottom left too", () => {
    const src = read("../client/src/components/VideoEditor.tsx");
    const block = src.slice(src.indexOf("const NEW_TEXT_STYLE"), src.indexOf("};", src.indexOf("const NEW_TEXT_STYLE")));
    expect(block).toContain('position: "bottom_left"');
    expect(block).toContain("fontSizePx: 64");
  });
});

/* ═══════════════════════ B — one log line per graphic ═══════════════════════ */

const gfx = (id: string, graphicType: string, start: number, extra: Partial<TimelineGraphic> = {}): TimelineGraphic => ({
  id, graphicType, start, end: start + 3, label: "x", data: {}, ...extra,
});

describe("B — the render log names each drawn graphic by type", () => {
  it("one line per DRAWN graphic, in time order, with its type", () => {
    const t = emptyTimeline(7);
    for (const tr of t.tracks) {
      if (tr.kind === "GRAPHICS") {
        tr.graphics.push(
          gfx("g2", "chapter_card", 20, { data: { primaryVisual: true, beatIndex: 3 } }),
          gfx("g1", "map_point", 5),
          gfx("g3", "date_card", 40),
        );
      }
    }
    const lines = graphicDrawnLines(t, ["g1", "g2"]);
    expect(lines).toEqual([
      "[GraphicDrawn] video=7 type=map_point id=g1 5.00-8.00s overlay",
      "[GraphicDrawn] video=7 type=chapter_card id=g2 beat=3 20.00-23.00s picture",
    ]);
  });

  it("is printed by the production overlay after the totals line", () => {
    const src = read("graphicsOverlayDeps.ts");
    expect(src).toContain("for (const line of graphicDrawnLines(timeline, result.graphicDrawnIds)) console.log(line);");
  });
});

/* ═══════════════════════ C — the typing sound reaches the film ═══════════════════════ */

describe("C — the typing sound is drawn by the render, not downloaded", () => {
  it("typing clips no longer name the removed Freesound recording", () => {
    const clips = typewriterSfxClips([{ id: "t1", start: 2, text: "1939" }]);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.source.provider).toBe(SYNTHETIC_SFX_PROVIDER);
    expect(JSON.stringify(clips)).not.toContain("434572");
  });

  it("an unknown synthetic id is refused rather than drawn as something else", () => {
    expect(syntheticSfxArgs("explosion", "/tmp/x.mp3")).toBeNull();
  });

  it("the bundled ffmpeg really draws an audible, eight-second sound", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v660-sfx-"));
    const out = path.join(dir, "type.mp3");
    expect(await makeSyntheticSfx("typewriter", out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(10_000);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
    expect(Number(probe.trim())).toBeGreaterThan(7.5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the render worker draws a synthetic sound before it ever asks a resolver", () => {
    const src = read("renderJobWorker.ts");
    const draw = src.indexOf("if (clip.source.provider === SYNTHETIC_SFX_PROVIDER)");
    const resolve = src.indexOf("audioDeps.providerResolver?.(clip.source)");
    expect(draw).toBeGreaterThan(0);
    expect(draw).toBeLessThan(resolve);
  });
});

/* ═══════════════════════ D — an animation in every started minute ═══════════════════════ */

function film(durationSec: number, sentences: Array<[number, number, string]>, graphics: TimelineGraphic[] = [], texts: Array<[number, number]> = []): ProjectTimeline {
  const t = emptyTimeline(1);
  t.durationSec = durationSec;
  t.sentences = sentences.map(([s, e, text], i) => ({ sceneIndex: 0, beatIndex: i, startSec: s, endSec: e, timingBasis: "measured", text }));
  for (const tr of t.tracks) {
    if (tr.kind === "GRAPHICS") tr.graphics.push(...graphics);
    if (tr.kind === "TEXT") {
      tr.texts.push(...texts.map(([s, e], i) => ({ id: `txt${i}`, text: "x", start: s, end: e, style: { ...ON_SCREEN_TEXT_STYLE } })));
    }
  }
  return t;
}
const drawn = (t: ProjectTimeline) => t.tracks.flatMap((tr) => (tr.kind === "GRAPHICS" ? tr.graphics.filter((g) => !g.disabled) : []));

describe("D — at least one animation in every started minute", () => {
  it("a 2.5-minute film with no graphics gets one in each of its three minutes, from its own sentences", () => {
    const t = film(150, [
      [2, 9, "The empire was founded in 1871 after a short war."],
      [70, 78, "Otto von Bismarck held the new state together."],
      [125, 133, "industry and railways changed everyday life completely"],
    ]);
    const r = ensureAnimationEveryMinute(t);
    /**
     * VIDEO 663 — one or two words, and the video's own: the name is "von Bismarck"; minute 3's
     * sentence says no year, no name and no word the film says twice, so it draws nothing rather
     * than "railways changed everyday" (it was a 3-word line of the sentence's longest words).
     */
    expect(r.missing).toEqual([2]);
    expect(r.added.map((a) => [a.minute, a.graphicType, a.label])).toEqual([
      [0, "date_card", "1871"],
      [1, "label", "von Bismarck"],
    ]);
    for (const g of drawn(t)) {
      expect(g.style?.position).toBe("bottom_left");
      expect(g.start).toBeGreaterThanOrEqual(0);
    }
    // the year types, and its keys are heard
    expect(r.typewriter.map((x) => x.text)).toEqual(["1871"]);
  });

  it("a minute that already has a graphic gets nothing extra", () => {
    const t = film(60, [[5, 12, "In 1914 the war began."]], [gfx("map", "map_point", 20)]);
    expect(ensureAnimationEveryMinute(t).added).toEqual([]);
  });

  it("a sentence's full-frame card counts as the minute's animation", () => {
    const t = film(60, [[5, 12, "In 1914 the war began."]], [gfx("card", "chapter_card", 30, { data: { primaryVisual: true } })]);
    expect(ensureAnimationEveryMinute(t).added).toEqual([]);
  });

  it("the planner's own graphic, switched off only for crowding, comes back first", () => {
    const t = film(60, [[5, 12, "In 1914 the war began."]], [
      gfx("chart", "bar_chart", 30, { disabled: true, disabledReason: "too_much_text_at_once" }),
      gfx("dup", "location_card", 40, { disabled: true, disabledReason: "same_place_same_time" }),
    ]);
    const r = ensureAnimationEveryMinute(t);
    expect(r.revived.map((x) => x.id)).toEqual(["chart"]);
    expect(r.added).toEqual([]);
    expect(drawn(t).map((g) => g.id)).toEqual(["chart"]);
  });

  it("never on top of a text already on screen; a minute with no free moment is reported", () => {
    const t = film(60, [[5, 12, "In 1914 the war began."]], [], [[4, 14]]);
    const r = ensureAnimationEveryMinute(t);
    expect(r.added).toEqual([]);
    expect(r.missing).toEqual([0]);
  });

  it("words are the sentence's own: a year, a name, or its key words — never invented", () => {
    expect(yearIn("It ended in 1945.")).toBe("1945");
    expect(yearIn("About 300 soldiers.")).toBeNull();
    expect(nameIn("Then Winston Churchill spoke.")).toBe("Winston Churchill");
    expect(nameIn("The war began.")).toBeNull();
    expect(nameIn("Otto von Bismarck held the state together.")).toBe("Otto von Bismarck");
    expect(keyWordsIn("de economie groeide snel")).toBe("economie groeide snel");
  });

  it("is wired in after the text director and its typing joins the typing sound", () => {
    const src = read("cinematicPipeline.ts");
    const director = src.indexOf("const textDirection = directOnScreenText(");
    const floor = src.indexOf("const floor = ensureAnimationEveryMinute(timeline);");
    const sound = src.indexOf("typewriterSfxClips(textDirection.typewriter");
    expect(director).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(director);
    expect(sound).toBeGreaterThan(floor);
    expect(src).toContain("textDirection.typewriter.push(...floor.typewriter");
  });
});

/* ═══════════════════════ E — typing is heard only with text that types ═══════════════════════ */

describe("E — a typing sound only where text types on screen", () => {
  const withSfx = (sfx: Array<{ id: string; start: number; end: number; provider: string; asset: string }>) => {
    const t = emptyTimeline(1);
    t.durationSec = 30;
    for (const tr of t.tracks) {
      if (tr.kind === "SFX") {
        tr.clips.push(...sfx.map((x) => ({ id: x.id, source: { provider: x.provider, providerAssetId: x.asset }, start: x.start, end: x.end, gain: 0.08 })));
      }
    }
    return t;
  };
  const sfxIds = (t: ProjectTimeline) => t.tracks.flatMap((tr) => (tr.kind === "SFX" ? tr.clips.map((c) => c.id) : []));

  it("a sentence that only SAYS someone typed gets no key sound from the planner", () => {
    expect(soundEffectIsDeliverable("typing")).toBe(false);
    expect(soundEffectIsDeliverable("keyboard")).toBe(false);
    expect(resolveSoundEffect("typing").ok).toBe(false);
  });

  it("keys under a typing year card stay; keys with nothing typing are taken off; other sounds are untouched", () => {
    const t = withSfx([
      { id: "keys_card", start: 2.3, end: 2.8, provider: SYNTHETIC_SFX_PROVIDER, asset: "typewriter" },
      { id: "keys_alone", start: 12, end: 13, provider: SYNTHETIC_SFX_PROVIDER, asset: "typewriter" },
      { id: "keyboard_old", start: 20, end: 22, provider: "freesound", asset: "392763" },
      { id: "camera", start: 12, end: 12.4, provider: "freesound", asset: "240432" },
    ]);
    for (const tr of t.tracks) if (tr.kind === "GRAPHICS") tr.graphics.push(gfx("year", "date_card", 2, { data: { typewriter: true } }));
    const removed = typingSoundsOnlyUnderTypingText(t);
    expect(removed.sort()).toEqual(["keyboard_old", "keys_alone"]);
    expect(sfxIds(t).sort()).toEqual(["camera", "keys_card"]);
  });

  it("a year card that waits for its word keeps its keys where it REALLY appears, after its planned window", () => {
    const t = withSfx([{ id: "late_keys", start: 9.6, end: 10.1, provider: SYNTHETIC_SFX_PROVIDER, asset: "typewriter" }]);
    for (const tr of t.tracks) if (tr.kind === "GRAPHICS") tr.graphics.push(gfx("year", "date_card", 6, { data: { typewriter: true } }));
    // planned 6–9 s; the voice says the year at 9.5 s, so it is drawn 9.5–12 s
    expect(typingSoundsOnlyUnderTypingText(t, () => ({ startSec: 9.5, endSec: 12 }))).toEqual([]);
    expect(typingSoundsOnlyUnderTypingText(t)).toEqual(["late_keys"]);
  });

  it("a card that does not type, or a typing text switched off, does not keep the keys", () => {
    const t = withSfx([{ id: "k", start: 2.3, end: 2.8, provider: SYNTHETIC_SFX_PROVIDER, asset: "typewriter" }]);
    for (const tr of t.tracks) {
      if (tr.kind === "GRAPHICS") tr.graphics.push(gfx("plain", "date_card", 2));
      if (tr.kind === "TEXT") tr.texts.push({ id: "off", text: "1939", start: 2, end: 4, style: { ...ON_SCREEN_TEXT_STYLE }, animation: "typewriter", disabled: true });
    }
    expect(typingSoundsOnlyUnderTypingText(t)).toEqual(["k"]);
  });

  it("runs after the typing sound is laid, as the last word on the SFX track", () => {
    const src = read("cinematicPipeline.ts");
    expect(src.indexOf("const silencedTyping = typingSoundsOnlyUnderTypingText(timeline, (g) => graphicOnScreenWindow(timeline, g, wordsOnScreen));")).toBeGreaterThan(
      src.indexOf("typewriterSfxClips(textDirection.typewriter")
    );
  });
});

/* ═══════════════════════ F — the music bed is very quiet ═══════════════════════ */

describe("F — background music very quiet", () => {
  it("the bed's gain is lower than before (0.22) and every music file is levelled first", () => {
    expect(MUSIC_BED_GAIN).toBeLessThan(0.22);
    const src = read("timelineRenderer.ts");
    expect(src).toContain('gain: kind === "AMBIENT" || kind === "MUSIC" ? levelledGain(c.gain, await measureIntegratedLufs(file)) : c.gain,');
    expect(read("cinematicPipeline.ts")).toContain("gain: MUSIC_BED_GAIN,");
  });

  /** A very quiet file is lifted at most 6 dB (MAX_LEVEL_BOOST_DB), so it stays a little quieter still. */
  it("a loud track (-10 LUFS) and a quiet one (-30 LUFS) both end up around -41 LUFS, far under a -16 LUFS voice", () => {
    const levelOf = (fileLufs: number) => fileLufs + 20 * Math.log10(levelledGain(MUSIC_BED_GAIN, fileLufs));
    expect(levelOf(-10)).toBeLessThan(-40);
    expect(levelOf(-30)).toBeLessThan(-40);
    expect(Math.abs(levelOf(-10) - levelOf(-30))).toBeLessThan(1.1);
    // before: an unlevelled -10 LUFS file at 0.22 played at about -23 LUFS — barely under the voice
    expect(-10 + 20 * Math.log10(0.22)).toBeGreaterThan(-24);
  });
});
