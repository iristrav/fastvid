/**
 * OCTOBER 2026 — the owner's two rules for text in the made video:
 *
 *   1  subtitles are off by default: planned (so the editor can show them), switched off unless the
 *      video's own setting asks for them
 *   2  at the start of the video one word may stand big in the picture: the film's main subject,
 *      over real footage only, as the text director's highest-ranked title
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { OPENING_WORD_FONT_PX, openingWordText, runCinematicPipeline } from "./cinematicPipeline";
import { captionTrack, emptyTimeline, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";

const TEXTS = [
  "Tesla began as a small company with a bold plan for electric cars.",
  "Its first car, the Roadster, proved electric cars could be fast.",
];
const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
  voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});
function facts(): SceneFacts {
  const beats = TEXTS.map((t, i) => beat(i, t));
  return {
    scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 },
    beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/ow-${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
      adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
    })) as SceneFacts["clips"],
  };
}
function plan(opts: { showSubtitles?: boolean; openingWord?: string | null }) {
  const built = buildCinematicSceneInputs({ scenes: [facts()] });
  return runCinematicPipeline({
    videoId: 9001,
    scenes: built.scenes,
    includeSubtitles: true,
    ...(opts.showSubtitles !== undefined ? { showSubtitles: opts.showSubtitles } : {}),
    ...(opts.openingWord !== undefined ? { openingWord: opts.openingWord } : {}),
  }).timeline as ProjectTimeline;
}
const texts = (t: ProjectTimeline) => {
  const track = t.tracks.find((x) => x.kind === "TEXT");
  return track?.kind === "TEXT" ? track.texts : [];
};

describe("1 — subtitles off by default, still planned", () => {
  it("the video's setting off: every subtitle is on the timeline, switched off, with its reason", () => {
    const caps = captionTrack(plan({ showSubtitles: false }));
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.disabled).toBe(true);
      expect(c.disabledReason).toBe("subtitles_off");
    }
  });

  it("the video's setting on: the subtitles are drawn", () => {
    const caps = captionTrack(plan({ showSubtitles: true }));
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => !c.disabled)).toBe(true);
  });

  it("production hands the video's own setting (off unless switched on) to the pipeline", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("includeSubtitles: true,\n          showSubtitles: enableSubtitles,");
    expect(src).toContain("enableSubtitles = false,  // Subtitles disabled by default");
  });
});

describe("2 — one word big at the start", () => {
  it("the film's main subject, upper case, centred, big, as a title over the first picture", () => {
    const t = plan({ openingWord: "Tesla" });
    const w = texts(t).find((x) => x.id === "txt_opening_word")!;
    expect(w).toBeDefined();
    expect(w.text).toBe("TESLA");
    expect(w.role).toBe("title");
    expect(w.style.position).toBe("center");
    expect(w.style.fontSizePx).toBe(OPENING_WORD_FONT_PX);
    expect(w.style.backgroundOpacity).toBe(0);
    expect(w.start).toBeLessThan(1);
    expect(w.disabled).not.toBe(true);
  });

  it("no word without a subject, or with one longer than two words", () => {
    expect(texts(plan({ openingWord: null })).some((x) => x.id === "txt_opening_word")).toBe(false);
    expect(texts(plan({ openingWord: "The Rise Of Tesla Motors" })).some((x) => x.id === "txt_opening_word")).toBe(false);
  });

  it("no word over a sentence's card or where the opening has no picture", () => {
    const base = emptyTimeline(1);
    base.durationSec = 10;
    const shot = { id: "vc_a", source: { provider: "x" }, timelineStart: 0, timelineEnd: 5, sourceIn: 0, sourceOut: 5 } as TimelineVideoClip;
    const withShot = (t: ProjectTimeline) => {
      for (const tr of t.tracks) if (tr.kind === "VIDEO") tr.clips.push(shot);
      return t;
    };
    expect(openingWordText(withShot(structuredClone(base)), "Tesla")).not.toBeNull();
    expect(openingWordText(structuredClone(base), "Tesla")).toBeNull();
    const carded = withShot(structuredClone(base));
    for (const tr of carded.tracks) {
      if (tr.kind === "GRAPHICS") {
        tr.graphics.push({ id: "g", graphicType: "chapter_card", data: { title: "X", primaryVisual: true }, start: 0, end: 4 } as TimelineGraphic);
      }
    }
    expect(openingWordText(carded, "Tesla")).toBeNull();
  });
});
