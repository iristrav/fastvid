/**
 * VIDEO 638 — REAL FOOTAGE FIRST, GRAPHICS OVER IT; A GRAPHIC IS THE WHOLE PICTURE ONLY AS A FALLBACK.
 *
 *   1  a sentence WITH an approved clip keeps it; its graphics are drawn over the video
 *   2  a graphic becomes the sentence's picture only when the sentence has no clip, and only in the hole
 *   3  every graphic-only sentence says why: `[GRAPHIC_ONLY_REASON] … reason=<cause>`
 *   4  the dark ground (PRIMARY_GROUND) is drawn only under a full-frame graphic, never over video
 *   5  the generated image (Stability) is asked only for a sentence with no picture, after the last
 *      placement of late approved real footage — it can never replace an approved clip
 */
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCinematicSceneInputs, type AdoptionFacts, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { isGraphicBackdrop, placePrimaryGraphics } from "./edlToTimeline";
import { generatedImageDecision } from "./generatedImageFallback";
import type { Scene } from "./pipeline/types";
import type { ProjectTimeline, TimelineGraphic, TimelineVideoClip } from "./projectTimeline";
import { createRejectionRegistry, registerRejection } from "./rejectionRegistry";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
  graphicOnlyReasonFor,
  noteApprovedNotPlaced,
  noteApprovedPickForBeat,
} from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const GRAPHICS = fs.readFileSync(path.join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");
const LINEAGE = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");
afterEach(() => vi.restoreAllMocks());

const EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};
const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4,
  visualDescription: "", voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});
const scene = (texts: string[]): Scene => ({
  index: 0, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: texts.length * 4,
} as Scene);
const adoption = (i: number): AdoptionFacts => ({
  provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`,
  assetTitle: "archive shot", query: "archive shot",
});
function facts(texts: string[], pictured: boolean[]): SceneFacts {
  const beats = texts.map((t, i) => beat(i, t));
  return {
    scene: scene(texts),
    beats,
    clips: beats.map((_, i) =>
      pictured[i]
        ? { facts: { localPath: `/tmp/rf-s0b${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 }, adoption: adoption(i) }
        : null
    ) as SceneFacts["clips"],
  };
}
const videoClips = (t: ProjectTimeline): TimelineVideoClip[] => {
  const track = t.tracks.find((k) => k.kind === "VIDEO");
  return track && track.kind === "VIDEO" ? track.clips : [];
};
const graphicsOf = (t: ProjectTimeline): TimelineGraphic[] => {
  const track = t.tracks.find((k) => k.kind === "GRAPHICS");
  return track && track.kind === "GRAPHICS" ? track.graphics : [];
};
const TEXTS = [
  "The economy grew slowly through the decade.",
  "Inflation reached 10% in 2022.",
  "Families felt it in every shop.",
];
function plan(pictured: boolean[], reason?: (s: number, b: number) => string) {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  const built = buildCinematicSceneInputs({
    scenes: [facts(TEXTS, pictured)],
    extractors: EXTRACTORS,
    ...(reason ? { graphicOnlyReason: reason } : {}),
  });
  const timeline = runCinematicPipeline({
    videoId: 1,
    scenes: built.scenes,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
  }).timeline as ProjectTimeline;
  vi.restoreAllMocks();
  return { built, timeline, logs };
}

describe("1/5 — real footage first: a sentence with an approved clip keeps it, graphics go over it", () => {
  it("the statistic sentence WITH a clip: its clip is on screen over its window, no graphic replaces it", () => {
    const { built, timeline, logs } = plan([true, true, true]);
    expect(built.primaryGraphics ?? []).toEqual([]);
    const under = videoClips(timeline).filter((c) => !c.disabled && c.timelineStart < 8 && c.timelineEnd > 4);
    expect(under.length).toBeGreaterThan(0);
    expect(under.every((c) => !isGraphicBackdrop(c) && (c.transform?.opacity ?? 1) > 0)).toBe(true);
    expect(graphicsOf(timeline).every((g) => g.data?.primaryVisual !== true)).toBe(true);
    expect(logs.some((l) => l.startsWith("[GRAPHIC_ONLY_REASON]"))).toBe(false);
  });

  it("the same sentence WITHOUT a clip: the graphic is its picture, and the log says why", () => {
    const { built, logs } = plan([true, false, true], (s, b) => `REASON_FOR_s${s}b${b}`);
    expect(built.primaryGraphics?.map((p) => p.beatId)).toEqual(["s0b1"]);
    const line = logs.find((l) => l.startsWith("[GRAPHIC_ONLY_REASON]"));
    expect(line).toMatch(/^\[GRAPHIC_ONLY_REASON\] s0b1 4\.00s graphic=\S+ reason=REASON_FOR_s0b1$/);
  });

  it("no reason supplied: the line still names the plain cause instead of saying nothing", () => {
    const { logs } = plan([true, false, true]);
    expect(logs.find((l) => l.startsWith("[GRAPHIC_ONLY_REASON]"))).toMatch(/reason=NO_ADOPTED_CLIP$/);
  });
});

describe("2/4 — a full-frame graphic only fills a hole; it never covers video", () => {
  const shot = (id: string, start: number, end: number) =>
    ({ id, source: { provider: "youtube", archiveAssetId: 1 }, timelineStart: start, timelineEnd: end, sourceIn: 0, sourceOut: end - start }) as TimelineVideoClip;
  const slot = (start: number, end: number) => ({
    beatId: "s0b1", startSec: start, endSec: end,
    graphic: { graphicType: "chapter_card", data: { text: "Elon Musk" }, reason: "CHAPTER_CARD_FALLBACK" },
  });

  it("a sentence fully covered by video gets no full-frame graphic", () => {
    const clips = [shot("a", 0, 8)];
    const graphics: TimelineGraphic[] = [];
    expect(placePrimaryGraphics(clips, graphics, [slot(4, 8)] as never)).toEqual([]);
    expect(graphics).toEqual([]);
  });

  it("partly covered: the graphic takes only the uncovered seconds; the video keeps its own", () => {
    const clips = [shot("a", 0, 6)];
    const graphics: TimelineGraphic[] = [];
    const placed = placePrimaryGraphics(clips, graphics, [slot(4, 8)] as never);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.graphic.start).toBe(6);
    expect(placed[0]!.graphic.end).toBe(8);
    expect(clips.find((c) => c.id === "a")!.timelineEnd).toBe(6);
  });

  it("the dark ground is drawn only by the full-frame stage, never by an overlay graphic", () => {
    expect(GRAPHICS.match(/background: PRIMARY_GROUND/g)?.length).toBe(1);
    const stage = GRAPHICS.slice(GRAPHICS.indexOf("const PrimaryStage"), GRAPHICS.indexOf("const GraphicBody"));
    expect(stage).toContain("background: PRIMARY_GROUND");
    expect(GRAPHICS.slice(GRAPHICS.indexOf("const GraphicBody"))).not.toContain("PRIMARY_GROUND");
    expect(GRAPHICS).toContain("if (g.data?.primaryVisual === true) {");
  });
});

describe("3 — GRAPHIC_ONLY_REASON: the cause, read from what the render recorded", () => {
  const dedup = () => ({ rejections: createRejectionRegistry() });

  it("approved after the window closed → PLACEMENT_WINDOW_CLOSED", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = dedup();
    noteApprovedNotPlaced(d, 2, 2, "approved after scene closed — not placed");
    expect(graphicOnlyReasonFor(d, 2, 2)).toBe("PLACEMENT_WINDOW_CLOSED");
  });

  it("approved, refused at the push (638 s1b2: 2.09 s < 3 s archive) → APPROVED_REFUSED_AT_PUSH with the push's reason", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = dedup();
    registerRejection(d.rejections, 1, 2, "/w/a.mp4", "archive not ready (ARCHIVE_INGEST_REFUSED:REJECTED)");
    noteApprovedNotPlaced(d, 1, 2, "refused at the push (reason logged by [PushTrace])");
    expect(graphicOnlyReasonFor(d, 1, 2)).toBe("APPROVED_REFUSED_AT_PUSH (archive not ready (ARCHIVE_INGEST_REFUSED:REJECTED):1)");
  });

  it("everything refused (638 s1b3) → ALL_REJECTED with the top refusals", () => {
    const d = dedup();
    registerRejection(d.rejections, 1, 3, "/w/a.mp4", "hard_mismatch");
    registerRejection(d.rejections, 1, 3, "/w/b.mp4", "hard_mismatch");
    registerRejection(d.rejections, 1, 3, "/w/c.mp4", "baked_edit_text_before_vision");
    expect(graphicOnlyReasonFor(d, 1, 3)).toBe("ALL_REJECTED (hard_mismatch:2,baked_edit_text_before_vision:1)");
  });

  it("candidates arrived and nobody judged them (638 s0b0) → CANDIDATES_NOT_REVIEWED", () => {
    expect(graphicOnlyReasonFor(dedup(), 0, 0, new Map([["0:0", 9]]))).toBe("CANDIDATES_NOT_REVIEWED (9)");
  });

  it("an approval with no named loss → APPROVED_NOT_PLACED; nothing at all → NO_CANDIDATES", () => {
    const d = dedup();
    noteApprovedPickForBeat(d, 0, 1, "archive:1");
    expect(graphicOnlyReasonFor(d, 0, 1)).toBe("APPROVED_NOT_PLACED");
    expect(graphicOnlyReasonFor(dedup(), 0, 2)).toBe("NO_CANDIDATES");
  });

  it("wired into the plan: the render passes its own reasons, with the never-judged count from the lineage", () => {
    expect(PIPE).toContain("graphicOnlyReason: (() => {");
    expect(PIPE).toContain("neverJudged = neverJudgedCountsBySentence(lineage.allRecords(), lineage.allEvents());");
    expect(LINEAGE).toContain('if (a.terminalStatus !== "DOWNLOADED_NEVER_JUDGED") continue;');
    expect(PIPE).toContain("return (sceneIndex: number, beatIndex: number) => graphicOnlyReasonFor(visualDedup, sceneIndex, beatIndex, neverJudged);");
  });
});

describe("5 — Stability is a fallback and cannot replace approved real footage", () => {
  it("a sentence with a picture is never generated; a data graphic that can stand in wins too", () => {
    const base = { people: [], budgetLeft: 3 };
    expect(generatedImageDecision({ ...base, hasPicture: true, graphicCanStandIn: false })).toEqual({ generate: false, reason: "has_picture" });
    expect(generatedImageDecision({ ...base, hasPicture: false, graphicCanStandIn: true })).toEqual({ generate: false, reason: "graphic_stands_in" });
  });

  it("asked only for sentences without a picture, and only after the last placement of late approved footage", () => {
    const gen = PIPE.slice(PIPE.indexOf("async function generateMissingBeatImages("), PIPE.indexOf("async function generateMissingBeatImages(") + 1400);
    expect(gen).toContain("for (const beat of beatsWithoutPicture(beats, result?.clipBeatIndices ?? [])) {");
    const lastPlacement = PIPE.indexOf("for (let si = 0; si < scenes.length; si++) await placeLate(si, true);");
    expect(lastPlacement).toBeGreaterThan(0);
    expect(lastPlacement).toBeLessThan(PIPE.indexOf("await generateMissingBeatImages(scenes, sceneVisualResults"));
  });
});
