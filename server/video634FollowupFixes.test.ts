/**
 * VIDEO 634 — FOLLOW-UP FIXES BEFORE THE NEXT PRODUCTION TEST.
 *
 *   B1   a sentence that names nothing of its own ("How did one mistake topple…") and has no clip
 *        gets a card of the film's main subject — not s0b1's shot held 4.43 s under it
 *   #8   an archive_first FIT is registered as the sentence's approval, so the late route places it
 *   Z1   the text director never switches off a graphic that IS a sentence's picture
 *   BLK  black is reported where it is: blackdetect spans and BLACK_BY_TIMELINE (never refused)
 *   #9   a failed scene names every approved sentence it loses
 *   Z3   a failed ink probe keeps ffmpeg's own words
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { blackByTimelineSpans, isGraphicBackdrop } from "./edlToTimeline";
import { directOnScreenText } from "./onScreenTextDirector";
import { parseBlackSpans } from "./postRenderSpotCheck";
import { probeOverlayInk } from "./graphicsOverlayInk";
import { emptyTimeline, DEFAULT_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════ B1 ═══════════════════════ */

const TEXTS = [
  "A mundane typo during a chaotic press conference triggered the fall of the Berlin Wall.",
  "How did one mistake topple a seemingly unbreakable symbol?",
  "Crowds gathered at the checkpoints of Berlin that same night.",
];
const beat = (index: number, text: string): ProductionBeat => ({
  index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
  voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
});
function facts(noPicture: ReadonlySet<number>): SceneFacts {
  const beats = TEXTS.map((t, i) => beat(i, t));
  return {
    scene: { index: 0, text: TEXTS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 12 },
    beats,
    clips: beats.map((_, i) =>
      noPicture.has(i)
        ? null
        : {
            facts: { localPath: `/tmp/b1-${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
            adoption: { provider: "internet_archive", providerAssetId: `ia-${i}`, sourceUrl: `https://archive.invalid/${i}.mp4`, assetTitle: "shot", query: "shot" },
          }
    ) as SceneFacts["clips"],
  };
}
function plan(opts: { filmSubject?: string | null; fillerFits?: (c: TimelineVideoClip, s: number, e: number) => boolean }) {
  const built = buildCinematicSceneInputs({ scenes: [facts(new Set([1]))], filmSubject: opts.filmSubject ?? null });
  const { timeline } = runCinematicPipeline({
    videoId: 634,
    scenes: built.scenes,
    includeSubtitles: false,
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
    ...(opts.fillerFits ? { fillerFits: opts.fillerFits } : {}),
  });
  return { built, timeline: timeline as ProjectTimeline };
}
const video = (t: ProjectTimeline) => {
  const v = t.tracks.find((x) => x.kind === "VIDEO");
  return v && v.kind === "VIDEO" ? v.clips : [];
};
/** Seconds of s0b0's own asset (ia-0) visible inside s0b1's window [4, 8). */
const borrowedUnderS0b1 = (t: ProjectTimeline) =>
  video(t)
    .filter((c) => !isGraphicBackdrop(c) && (c.transform?.opacity ?? 1) > 0 && c.source.providerAssetId === "ia-0")
    .reduce((sum, c) => sum + Math.max(0, Math.min(c.timelineEnd, 8) - Math.max(c.timelineStart, 4)), 0);
const gfx = (t: ProjectTimeline) => {
  const g = t.tracks.find((x) => x.kind === "GRAPHICS");
  return g && g.kind === "GRAPHICS" ? g.graphics : [];
};

describe("B1 — a sentence that names nothing gets the film's subject card, not a held borrowed shot", () => {
  it("the null path today: without a film subject there is no card, and s0b0's shot is held over s0b1 (the 634 bug)", () => {
    const { built, timeline } = plan({ filmSubject: null, fillerFits: () => false });
    expect(built.primaryGraphics?.find((p) => p.beatId === "s0b1")).toBeUndefined();
    expect(borrowedUnderS0b1(timeline), "s0b0's shot runs across the whole of s0b1").toBeCloseTo(4, 2);
  });

  it("with the film's subject: a card for s0b1, on an invisible ground; s0b0's shot is not held under it", () => {
    const { built, timeline } = plan({ filmSubject: "Berlin Wall", fillerFits: () => false });
    const slot = built.primaryGraphics?.find((p) => p.beatId === "s0b1");
    expect(slot?.graphic.graphicType).toBe("chapter_card");
    expect(slot?.graphic.data.title).toBe("Berlin Wall");
    expect(slot?.onlyWithoutApprovedFiller).toBe(true);

    const card = gfx(timeline).find((g) => g.graphicType === "chapter_card" && g.data?.primaryVisual === true)!;
    expect(card).toBeDefined();
    expect(card.start).toBeCloseTo(4, 2);
    expect(card.end).toBeCloseTo(8, 2);
    const ground = video(timeline).find(isGraphicBackdrop)!;
    expect(ground.transform?.opacity).toBe(0);
    expect(borrowedUnderS0b1(timeline), "no second of s0b0's shot under s0b1").toBeCloseTo(0, 3);
    expect(blackByTimelineSpans(timeline), "no black on the plan").toEqual([]);
  });

  it("a shot the picture editor approved for s0b1 still comes first: the subject card yields to the approved filler", () => {
    const { timeline } = plan({ filmSubject: "Berlin Wall", fillerFits: (c) => c.source.providerAssetId === "ia-2" });
    expect(gfx(timeline).some((g) => g.data?.primaryVisual === true)).toBe(false);
    expect(video(timeline).some(isGraphicBackdrop)).toBe(false);
  });

  it("a sentence with its own visual never gets a card", () => {
    const { built } = plan({ filmSubject: "Berlin Wall", fillerFits: () => false });
    expect(built.primaryGraphics?.map((p) => p.beatId)).toEqual(["s0b1"]);
  });

  it("a sentence that names its own subject keeps its own card, not the film's", () => {
    const built = buildCinematicSceneInputs({
      scenes: [{ ...facts(new Set([0])), beats: facts(new Set([0])).beats }],
      filmSubject: "Berlin Wall",
    });
    const slot = built.primaryGraphics?.find((p) => p.beatId === "s0b0");
    expect(slot?.graphic.graphicType).toBe("chapter_card");
    expect(slot?.graphic.data.title).not.toBe("Berlin Wall");
    /** W4 (video 636) — the sentence's own drawn card now yields to an approved real shot as well. */
    expect(slot?.onlyWithoutApprovedFiller).toBe(true);
  });
});

/* ═══════════════════════ #8 ═══════════════════════ */

describe("#8 — an archive_first FIT is an approval", () => {
  it("FIT → registered → the late route hands it back as approved", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    const clip = "/tmp/scene_1_b3_curated_a60188.mp4";
    const key = vp.clipContentKey(clip);
    vp.noteLadderForBeat(dedup, 1, 3, 0, (async () => { await wait(10); return clip; })());
    expect(vp.noteArchiveFirstFit(dedup, { verdict: "fits", evaluated: true }, key, 1, 3)).toBe(true);
    expect(vp.approvedPicksForBeat(dedup, 1, 3)).toBe(1);
    await wait(30);
    expect(await vp.takeLateApprovedPicks(dedup, 1, 0)).toEqual([{ beatIndex: 3, clip, approved: true }]);
  });

  it("an unknown or refused archive verdict is no approval", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    expect(vp.noteArchiveFirstFit(dedup, { verdict: "unknown", evaluated: false }, "archive:1", 0, 0)).toBe(false);
    expect(vp.noteArchiveFirstFit(dedup, { verdict: "does_not_fit", evaluated: true }, "archive:1", 0, 0)).toBe(false);
    expect(vp.noteArchiveFirstFit(dedup, null, "archive:1", 0, 0)).toBe(false);
    expect(vp.approvedPicksForBeat(dedup, 0, 0)).toBe(0);
  });

  it("the archive_first hit path registers it before it returns", () => {
    const start = PIPE.indexOf("    if (!archiveHitRefused) {");
    const ret = PIPE.indexOf("      return ownArchiveClip;", start);
    const reg = PIPE.indexOf("noteArchiveFirstFit(", start);
    expect(start).toBeGreaterThan(-1);
    expect(reg).toBeGreaterThan(start);
    expect(reg).toBeLessThan(ret);
  });
});

/* ═══════════════════════ Z1 ═══════════════════════ */

describe("Z1 — the text director never switches off a sentence's picture", () => {
  const timelineWith = (graphics: TimelineGraphic[], texts: Array<{ id: string; text: string; start: number; end: number }>) => {
    const t = emptyTimeline(1);
    t.durationSec = 10;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
      if (track.kind === "TEXT") track.texts.push(...texts.map((x) => ({ ...x, role: "date", style: { ...DEFAULT_TEXT_STYLE, position: "center" as const } })) as never);
    }
    return t;
  };
  const card = (over: Partial<TimelineGraphic> = {}): TimelineGraphic => ({
    id: "gfx_card", graphicType: "chapter_card", data: { title: "Berlin Wall", label: "Berlin Wall", primaryVisual: true },
    start: 2, end: 6, label: "Berlin Wall", style: { ...DEFAULT_TEXT_STYLE, position: "center" }, ...over,
  } as TimelineGraphic);

  it("a primary card under a centred year text in the same place stays on", () => {
    const t = timelineWith([card()], [{ id: "t1", text: "9 November 1989", start: 3, end: 5 }]);
    directOnScreenText(t);
    const g = gfx(t).find((x) => x.id === "gfx_card")!;
    expect(g.disabled).not.toBe(true);
    expect(blackByTimelineSpans({ ...t, tracks: t.tracks } as ProjectTimeline).some((b) => b.startSec < 6 && b.endSec > 2)).toBe(false);
  });

  it("the same card WITHOUT primaryVisual is still governed by the rules as before", () => {
    const t = timelineWith([card({ data: { title: "Berlin Wall", label: "Berlin Wall" } })], [{ id: "t1", text: "9 November 1989", start: 3, end: 5 }]);
    directOnScreenText(t);
    expect(gfx(t).find((x) => x.id === "gfx_card")!.disabled).toBe(true);
  });

  it("a primary map without geography becomes a location card that is STILL the sentence's picture", () => {
    const map = card({ id: "gfx_map", graphicType: "map_point", data: { locationName: "Berlin", label: "Berlin", primaryVisual: true }, label: "Berlin" });
    const t = timelineWith([map], []);
    directOnScreenText(t);
    const loc = gfx(t).find((x) => x.id === "gfx_map_loc")!;
    expect(loc.graphicType).toBe("location_card");
    expect(loc.data?.primaryVisual).toBe(true);
    expect(loc.style?.position).toBe("center");
  });

  it("a primary map with neither geography nor a place name stays on (off would be black)", () => {
    const map = card({ id: "gfx_map", graphicType: "map_point", data: { primaryVisual: true }, label: "" });
    const t = timelineWith([map], []);
    directOnScreenText(t);
    expect(gfx(t).find((x) => x.id === "gfx_map")!.disabled).not.toBe(true);
  });
});

/* ═══════════════════════ BLACK — observability only ═══════════════════════ */

describe("BLACK — where the black is, never a refusal", () => {
  it("blackdetect lines become spans with their length", () => {
    const stderr = [
      "[blackdetect @ 0x1] black_start:5.78 black_end:11.96 black_duration:6.18",
      "[blackdetect @ 0x1] black_start:32.89 black_end:35.39 black_duration:2.5",
      "[blackdetect @ 0x1] black_start:37.89 black_end:39.33 black_duration:1.44",
    ].join("\n");
    expect(parseBlackSpans(stderr)).toEqual([
      { startSec: 5.78, endSec: 11.96 }, { startSec: 32.89, endSec: 35.39 }, { startSec: 37.89, endSec: 39.33 },
    ]);
  });

  it("BLACK_BY_TIMELINE: the 634 hole — an invisible ground with no card over it — is found; a covered one is not", () => {
    const t = emptyTimeline(1);
    t.durationSec = 12;
    const v = t.tracks.find((x) => x.kind === "VIDEO")!;
    const g = t.tracks.find((x) => x.kind === "GRAPHICS")!;
    if (v.kind === "VIDEO") {
      v.clips.push(
        { id: "vc_graphic1", source: { provider: "youtube" }, timelineStart: 0, timelineEnd: 8, transform: { opacity: 0 } } as TimelineVideoClip,
        { id: "vc", source: { provider: "youtube" }, timelineStart: 8, timelineEnd: 12 } as TimelineVideoClip,
      );
    }
    if (g.kind === "GRAPHICS") g.graphics.push({ id: "c", graphicType: "chapter_card", data: { primaryVisual: true }, start: 0, end: 5, label: "x" } as TimelineGraphic);
    expect(blackByTimelineSpans(t)).toEqual([{ startSec: 5, endSec: 8 }]);
  });

  it("nothing here refuses a render: the spot check's black warning stays informational", async () => {
    const { isInformationalSpotWarning } = await import("./postRenderSpotCheck");
    expect(isInformationalSpotWarning("blackdetect: 3 dark/black segment(s) (total 10.12s: 5.78–11.96) in final video (expected for dark archive scenes)")).toBe(true);
    const cine = fs.readFileSync(path.join(__dirname, "cinematicPipeline.ts"), "utf8");
    expect(cine).toContain("[BLACK_BY_TIMELINE]");
    expect(cine.indexOf("blackByTimelineSpans(timeline)")).toBeGreaterThan(cine.indexOf("directOnScreenText(timeline"));
  });
});

/* ═══════════════════════ #9 ═══════════════════════ */

describe("#9 — a failed scene names every approved sentence it loses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the approved sentences of one scene are listed, and only those", async () => {
    const vp = await import("./videoPipeline");
    const dedup = {};
    vp.noteApprovedPickForBeat(dedup, 2, 0, "a");
    vp.noteApprovedPickForBeat(dedup, 2, 3, "b");
    vp.noteApprovedPickForBeat(dedup, 1, 1, "c");
    expect(vp.approvedBeatsInScene(dedup, 2)).toEqual([0, 3]);
    expect(vp.approvedBeatsInScene(dedup, 0)).toEqual([]);
  });

  it("the scene's catch names them with the scene's own failure, and changes nothing else", () => {
    const at = PIPE.indexOf("visuals failed — the scene has no picture:`,");
    const block = PIPE.slice(at, at + 900);
    expect(block).toContain("approvedBeatsInScene(visualDedup, scene.index)");
    expect(block).toContain("noteApprovedNotPlaced(");
    expect(block).toContain("result = { clips: [], beatDurations: [] };");
  });
});

/* ═══════════════════════ Z3 ═══════════════════════ */

describe("Z3 — a failed ink probe keeps ffmpeg's own words", () => {
  it("stderr's last lines become the reason, not the command line", async () => {
    const err = Object.assign(new Error("Command failed: /usr/bin/ffmpeg -hide_banner -nostats -i overlay.mov -vf alphaextract,…"), {
      stderr: "Input #0, mov\n[Parsed_alphaextract_0 @ 0x1] Requested planes not available.\nError reinitializing filters!",
    });
    const r = await probeOverlayInk("/tmp/graphics_overlay.mov", "ffmpeg", async () => { throw err; });
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("probe failed");
    expect(r.reason).toContain("Requested planes not available");
    expect(r.reason).not.toContain("-hide_banner");
  });
});
