/**
 * VIDEO 663, ROUND 4 — render 73, measured by the test session and confirmed by its own report
 * (`[ViewerReport] … stillSec=5.5 (7.2%) … verdict=NOT_YET`). The owner: "Er mag geen vastgehouden
 * beeld in de video", the opening map card "ziet er niet goed uit", "de tekst moet altijd links
 * onderin", and "opnieuw afgespeeld … dat mag ook niet".
 *
 *   1  no held frame: a shot that cannot fill its slot gives the rest to the shot beside it;
 *   2  the same source at nearly the same seconds under another sentence is a repeat;
 *   3  a map is a whole picture or nothing — never a card over footage;
 *   4  every text over the picture bottom left;
 *   5  no purple: one grade (the renderer's), and neutral colour on a dark source.
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDocumentaryColorGradeVF } from "./documentaryStyle";
import { gradeChain } from "./timelineFilters";
import { giveHeldSecondsToNeighbours, ownSeconds, shortenSlowShots, SLOW_SHOT_MAX_SEC } from "./noHeldFrames";
import { directOnScreenText, MAP_OVER_PICTURE } from "./onScreenTextDirector";
import { isPrimaryGroundPixel } from "./postRenderSpotCheck";
import { CONTENT_GROUNDS, contentGroundFor } from "./remotion/components/Graphics";
import { cameraStartFor, MAP_LOOKS, mapLookFor } from "./remotion/components/GeoMap";
import { planYoutubePieces } from "./youtubeShotLimit";
import { placeTextBottomLeft } from "./onScreenWords";
import { emptyTimeline, timelineElementId, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { probeMeanChroma, probeMotion, purpleCastCorrection, renderTimeline, SLOW_MOTION_DIFF, SLOW_SHOT_PUSH } from "./timelineRenderer";
import { formatViewerReport, viewerReport } from "./viewerReport";
import { measureFilmPicture, readPicture, SAMPLE_H, SAMPLE_W } from "./measuredPicture";
import { findVisualRepeats, sourceWindowsNear, SAME_SOURCE_NEAR_SEC } from "./visualRepeatCheck";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-663d-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const clip = (id: string, start: number, end: number, extra: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id, kind: "video", source: { provider: "youtube_cc", archiveAssetId: Number(id.replace(/\D/g, "") || 1) },
    sourceIn: 0, timelineStart: start, timelineEnd: end, transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", ...extra,
  }) as TimelineVideoClip;

/* ═══════════ 1 — no held frame ═══════════ */

describe("1 — a shot that cannot fill its slot gives the rest to the shot beside it", () => {
  it("own seconds: from the in-point to the file's end, or to the out-point of a shot planned to stop there", () => {
    expect(ownSeconds(clip("a1", 0, 5, { sourceIn: 1 }), 4)).toBe(3);
    expect(ownSeconds(clip("a2", 0, 5, { sourceIn: 1, sourceOut: 2.5, holdAtSourceOut: true }), 10)).toBe(1.5);
    expect(ownSeconds(clip("a3", 0, 5, { kind: "image" }), 4)).toBe(Infinity);
  });

  it("render 73's vc_b1498e1cc4_p2 (4.49 s slot, 2.5 s of file): the next shot starts earlier", () => {
    const a = clip("c1", 10, 14.49, { sourceIn: 0 });
    const b = clip("c2", 14.49, 18, { sourceIn: 0 });
    const files: Record<string, number> = { c1: 2.54, c2: 12 };
    const r = giveHeldSecondsToNeighbours([a, b], (c) => files[c.id]!);
    expect(a.timelineEnd).toBeCloseTo(12.54, 2);
    expect(b.timelineStart).toBeCloseTo(12.54, 2);
    expect(r.stillHeld).toEqual([]);
    expect(r.notes[0]).toMatch(/c2 starts that much earlier/);
  });

  it("when the next shot has nothing to spare, the one before runs on; when neither can, it says HELD", () => {
    const p = clip("p1", 0, 3, { sourceIn: 0 });
    const c = clip("p2", 3, 7, { sourceIn: 0 });
    const n = clip("p3", 7, 10, { sourceIn: 0 });
    const files: Record<string, number> = { p1: 9, p2: 2.5, p3: 3 };
    giveHeldSecondsToNeighbours([p, c, n], (x) => files[x.id]!);
    expect(p.timelineEnd).toBeCloseTo(4.5, 2);
    expect(c.timelineStart).toBeCloseTo(4.5, 2);

    const q = clip("q1", 0, 3, { sourceIn: 0 });
    const r2 = clip("q2", 3, 7, { sourceIn: 0 });
    const out = giveHeldSecondsToNeighbours([q, r2], (x) => ({ q1: 3, q2: 2 })[x.id as "q1" | "q2"]!);
    expect(out.stillHeld).toEqual([{ clipId: "q2", sec: 2 }]);
  });

  it("a neighbour never takes the time with seconds another shot of the film already shows", () => {
    /** b's next seconds (4–6) are what d shows later: b may not run on into them */
    const a = clip("r1", 0, 4, { sourceIn: 0 });
    const b = clip("r2", 4, 8, { source: { provider: "youtube_cc", archiveAssetId: 900 }, sourceIn: 0, sourceOut: 4 });
    const d = clip("r3", 8, 10, { source: { provider: "youtube_cc", archiveAssetId: 900 }, sourceIn: 4.5, sourceOut: 6.5 });
    const out = giveHeldSecondsToNeighbours([a, b, d], (x) => ({ r1: 2, r2: 20, r3: 20 })[x.id as "r1" | "r2" | "r3"]!);
    expect(b.timelineStart).toBe(4);
    expect(out.stillHeld).toEqual([{ clipId: "r1", sec: 2 }]);
  });

  it("R2 — first its own file: a late in-point reads earlier, no cut moves", () => {
    /** 4 s slot, file 10 s, in-point at 8: 2 s short — it starts at 6 instead */
    const a = clip("w1", 0, 4, { sourceIn: 8 });
    const b = clip("w2", 4, 8, { sourceIn: 0 });
    const out = giveHeldSecondsToNeighbours([a, b], (x) => (x.id === "w1" ? 10 : 30));
    expect(a.sourceIn).toBe(6);
    expect(a.timelineEnd).toBe(4);
    expect(out.stillHeld).toEqual([]);
    expect(out.notes[0]).toMatch(/starts 2\.00s earlier in its own source/);
  });

  it("R2 — never into seconds another shot of the same footage shows", () => {
    const a = clip("x1", 0, 4, { source: { provider: "youtube_cc", archiveAssetId: 77 }, sourceIn: 8, sourceOut: 10 });
    const d = clip("x2", 4, 6, { source: { provider: "youtube_cc", archiveAssetId: 77 }, sourceIn: 5, sourceOut: 7 });
    const out = giveHeldSecondsToNeighbours([a, d], () => 10);
    /** 7–8 is free; 5–7 is x2's own */
    expect(a.sourceIn).toBe(7);
    expect(out.stillHeld.length).toBe(0);
  });

  it("R2 — the next shot starts earlier with its own unshown seconds before its in-point", () => {
    const a = clip("y1", 0, 4, { sourceIn: 0 });
    const b = clip("y2", 4, 8, { sourceIn: 5, holdAtSourceOut: true, sourceOut: 9 });
    const out = giveHeldSecondsToNeighbours([a, b], (x) => (x.id === "y1" ? 2 : 9));
    expect(a.timelineEnd).toBe(2);
    expect(b.timelineStart).toBe(2);
    expect(b.sourceIn).toBe(3);
    expect(out.stillHeld).toEqual([]);
  });

  it("R2 — what nothing can fill is an ERROR, and the renderer moves the held frame", () => {
    const a = clip("z1", 0, 4, { sourceIn: 0 });
    const out = giveHeldSecondsToNeighbours([a], () => 1.5);
    expect(out.stillHeld).toEqual([{ clipId: "z1", sec: 2.5 }]);
    expect(out.notes.at(-1)).toMatch(/ERROR 2\.50s HELD/);
    expect(SRC("timelineRenderer.ts")).toContain("[HeldFrame] ERROR clip=");
  });

  it("a real render: the short file's slot is taken by the next shot — no held frame, PROFESSIONAL", async () => {
    const short = path.join(dir, "short.mp4");
    const long = path.join(dir, "long.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1.5:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", short]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", long]);
    const t: ProjectTimeline = emptyTimeline(663, { widthPx: 320, heightPx: 180, fps: 25 });
    t.durationSec = 5;
    const a = clip("s1", 0, 3, { id: timelineElementId("vc", "s1"), source: { provider: "pexels", providerAssetId: "1", contentApproval: "judge_fit" } });
    const b = clip("s2", 3, 5, { id: timelineElementId("vc", "s2"), source: { provider: "pexels", providerAssetId: "2", contentApproval: "judge_fit" } });
    for (const tr of t.tracks) if (tr.kind === "VIDEO") tr.clips.push(a, b);
    const rendered = await renderTimeline({
      timeline: t, workDir: path.join(dir, "w"), outputPath: path.join(dir, "out.mp4"),
      resolveMedia: async (c) => (c.id === a.id ? short : long),
    });
    const cut = rendered.renderedClips!.find((c) => c.id === a.id)!;
    expect(cut.timelineEnd).toBeLessThan(1.6);
    expect(a.timelineEnd, "the timeline handed in is unchanged").toBe(3);
    expect(rendered.heldFrames ?? []).toEqual([]);
    expect(viewerReport(t, rendered.heldFrames ?? []).professional).toBe(true);
    expect(rendered.durationSec).toBeGreaterThan(4.9);
  }, 120_000);

  it("the renderer measures every file and moves the cuts before it encodes", () => {
    const r = SRC("timelineRenderer.ts");
    expect(r.indexOf("giveHeldSecondsToNeighbours(clips")).toBeGreaterThan(-1);
    expect(r.indexOf("giveHeldSecondsToNeighbours(clips")).toBeLessThan(r.indexOf("const media = mediaOf.get(clip.id) ?? null;"));
  });
});

/* ═══════════ 1b — a shot that hardly moves is kept short, and made to move ═══════════ */

describe("1b — a shot that hardly moves", () => {
  it("measured: a still picture hardly moves, real footage does", async () => {
    const still = path.join(dir, "still.mp4");
    const moving = path.join(dir, "moving.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4a6a8a:s=320x180:d=4:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", still]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", moving]);
    expect((await probeMotion(still, 0, 4))!).toBeLessThan(SLOW_MOTION_DIFF);
    expect((await probeMotion(moving, 0, 4))!).toBeGreaterThan(SLOW_MOTION_DIFF);
  }, 60_000);

  it(`render 73's 5.9 s aerial: kept to ${SLOW_SHOT_MAX_SEC} s, the rest to the shot before it`, () => {
    const before = clip("t1", 64.5, 70.4, { sourceIn: 0 });
    const aerial = clip("t2", 70.4, 76.3, { sourceIn: 0 });
    const notes = shortenSlowShots([before, aerial], (c) => (c.id === "t1" ? 30 : 30), (c) => c.id === "t2");
    expect(aerial.timelineEnd - aerial.timelineStart).toBeCloseTo(SLOW_SHOT_MAX_SEC, 2);
    expect(before.timelineEnd).toBeCloseTo(76.3 - SLOW_SHOT_MAX_SEC, 2);
    expect(notes[0]).toMatch(/hardly moves — shortened by 2\.40s — t1 runs that much longer/);
  });

  it("a slow neighbour never grows past the same limit", () => {
    const a = clip("u1", 0, 3, { sourceIn: 0 });
    const b = clip("u2", 3, 9, { sourceIn: 0 });
    shortenSlowShots([a, b], () => 30, () => true);
    expect(a.timelineEnd - a.timelineStart).toBeLessThanOrEqual(SLOW_SHOT_MAX_SEC + 0.001);
  });

  it("a real render: a still shot is shortened and the rest moves with a slow push", async () => {
    const still = path.join(dir, "still2.mp4");
    const moving = path.join(dir, "moving2.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4a6a8a:s=320x180:d=8:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", still]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", moving]);
    const t: ProjectTimeline = emptyTimeline(663, { widthPx: 320, heightPx: 180, fps: 25 });
    t.durationSec = 9;
    const a = clip("v1", 0, 3, { id: timelineElementId("vc", "v1"), source: { provider: "pexels", providerAssetId: "m", contentApproval: "judge_fit" } });
    const b = clip("v2", 3, 9, { id: timelineElementId("vc", "v2"), source: { provider: "pexels", providerAssetId: "s", contentApproval: "judge_fit" } });
    for (const tr of t.tracks) if (tr.kind === "VIDEO") tr.clips.push(a, b);
    const rendered = await renderTimeline({ timeline: t, workDir: path.join(dir, "w2"), outputPath: path.join(dir, "out2.mp4"), resolveMedia: async (c) => (c.id === a.id ? moving : still) });
    const cut = rendered.renderedClips!.find((c) => c.id === b.id)!;
    expect(cut.timelineEnd - cut.timelineStart).toBeCloseTo(SLOW_SHOT_MAX_SEC, 2);
    expect(cut.camera).toEqual(SLOW_SHOT_PUSH);
    expect(b.camera, "the timeline handed in is unchanged").toBeUndefined();
  }, 120_000);
});

/* ═══════════ 2 — the same source, nearly the same seconds, under another sentence ═══════════ */

describe("2 — a repeat is decided on the source too, not only on pixels", () => {
  it(`render 73's Venice walk: one video, seconds under ${SAME_SOURCE_NEAR_SEC} s apart, two sentences — the second is a repeat`, () => {
    expect(sourceWindowsNear({ start: 100, end: 104 }, { start: 110, end: 114 })).toBe(true);
    expect(sourceWindowsNear({ start: 100, end: 104 }, { start: 130, end: 134 })).toBe(false);
    const walk = "youtube:VeniceWalk01";
    const repeats = findVisualRepeats([
      { id: "s0#0", prints: null, family: walk, window: { start: 100, end: 104 }, sentence: "0:1" },
      { id: "s1#0", prints: null, family: walk, window: { start: 108, end: 112 }, sentence: "1:2" },
      { id: "s1#1", prints: null, family: walk, window: { start: 300, end: 304 }, sentence: "1:3" },
    ]);
    expect(repeats).toEqual([{ id: "s1#0", sameAs: "s0#0" }]);
  });

  it("under the SAME sentence the next moment of the scene is its continuation, not a repeat", () => {
    const walk = "youtube:VeniceWalk01";
    expect(
      findVisualRepeats([
        { id: "a", prints: null, family: walk, window: { start: 100, end: 104 }, sentence: "0:1" },
        { id: "b", prints: null, family: walk, window: { start: 104.5, end: 108 }, sentence: "0:1" },
      ])
    ).toEqual([]);
  });

  it("the pipeline hands each clip's seconds and sentence to the check", () => {
    const pipe = SRC("videoPipeline.ts");
    expect(pipe).toContain("window: clipSourceWindow(dedup, clipPath),");
    expect(pipe).toContain("sentence: beatIndex != null ? `${scene.index}:${beatIndex}` : null,");
  });
});

/* ═══════════ 3 + 4 — maps and text ═══════════ */

const gfxTimeline = (graphics: TimelineGraphic[]): ProjectTimeline => {
  const t = emptyTimeline(663);
  t.durationSec = 30;
  for (const tr of t.tracks) if (tr.kind === "GRAPHICS") tr.graphics.push(...graphics);
  return t;
};
const graphicsOf = (t: ProjectTimeline) => t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : []));

describe("3 — an animation is a whole picture, never a card over footage", () => {
  it("render 73's opening map over a boulevard shot becomes the full frame; two maps in a row wear different looks", () => {
    const t = gfxTimeline([
      { id: "open", graphicType: "map_point", label: "Los Angeles", start: 0.3, end: 4.2, data: { locationName: "Los Angeles", lon: -118.24, lat: 34.05 } },
      { id: "full", graphicType: "map_point", label: "Brussels", start: 10, end: 14, data: { locationName: "Brussels", lon: 4.35, lat: 50.85, primaryVisual: true } },
    ]);
    directOnScreenText(t);
    const g = Object.fromEntries(graphicsOf(t).map((x) => [x.id, x]));
    expect(g.open!.disabled).toBeFalsy();
    expect(g.open!.data).toMatchObject({ primaryVisual: true, lookVariant: 0 });
    expect(g.full!.data).toMatchObject({ primaryVisual: true, lookVariant: 1 });
    expect(mapLookFor(0).name).not.toBe(mapLookFor(1).name);
    expect(cameraStartFor({ cx: 100, cy: 100, zoom: 4 }, 0)).not.toEqual(cameraStartFor({ cx: 100, cy: 100, zoom: 4 }, 1));
  });

  it("a chart over footage becomes the full frame; one without its numbers is switched off, not shown as a card", () => {
    const t = gfxTimeline([
      { id: "gdp", graphicType: "bar_chart", label: "GDP", start: 2, end: 6, data: { series: [{ label: "2010", value: 1 }, { label: "2020", value: 2 }] } },
      { id: "empty", graphicType: "line_chart", label: "Growth", start: 12, end: 15, data: {} },
    ]);
    directOnScreenText(t);
    const g = Object.fromEntries(graphicsOf(t).map((x) => [x.id, x]));
    expect(g.gdp!.data?.primaryVisual).toBe(true);
    expect(g.empty).toMatchObject({ disabled: true, disabledReason: MAP_OVER_PICTURE });
  });

  it("the colour grounds are outside the delivery check's slate palette, bright enough, and never violet", () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const grounds = [...CONTENT_GROUNDS.flatMap((g) => [g.centre, g.edge]), ...MAP_LOOKS.map((l) => l.ocean)];
    for (const c of grounds) {
      const [r, g, b] = hex(c);
      expect(isPrimaryGroundPixel(r, g, b), c).toBe(false);
      expect(0.299 * r + 0.587 * g + 0.114 * b, c).toBeGreaterThan(22);
      expect(r > g + 20 && b > g + 20, `${c} is violet`).toBe(false);
    }
    expect(new Set(CONTENT_GROUNDS.map((g) => g.name)).size).toBe(CONTENT_GROUNDS.length);
    expect(contentGroundFor(0).name).not.toBe(contentGroundFor(1).name);
  });
});

describe("4 — every text over the picture stands bottom left", () => {
  it("render 73's 'BELGIUM' (bottom centre, no place of its own) moves bottom left; a full-frame card keeps its place", () => {
    const t = gfxTimeline([
      { id: "be", graphicType: "location_card", label: "Belgium", start: 26, end: 29, data: {} },
      { id: "card", graphicType: "chapter_card", label: "Brussels", start: 5, end: 9, data: { primaryVisual: true }, style: { fontSizePx: 86, color: "white", backgroundOpacity: 0, position: "center" } },
      { id: "chart", graphicType: "bar_chart", label: "GDP", start: 12, end: 15, data: {} },
    ]);
    expect(placeTextBottomLeft(t)).toBe(1);
    const g = Object.fromEntries(graphicsOf(t).map((x) => [x.id, x]));
    expect(g.be!.style).toMatchObject({ position: "bottom_left", align: "left", fontSizePx: 64 });
    expect(g.card!.style?.position).toBe("center");
    expect(g.chart!.style).toBeUndefined();
  });

  it("the director applies it, and Remotion draws a text with no place of its own bottom left", () => {
    expect(SRC("onScreenTextDirector.ts")).toContain("const movedLeft = placeTextBottomLeft(timeline);");
    expect(SRC("remotion/components/Graphics.tsx")).toContain('g.style?.position ?? (textOverPicture ? "bottom_left"');
  });
});

/* ═══════════ 5 — no purple ═══════════ */

describe("5 — no purple haze", () => {
  it("a dark source is lifted with neutral colour; no source gets a colour push (\"maak hem neutraal\")", () => {
    expect(buildDocumentaryColorGradeVF("stock", { darkSource: true })).toBe("eq=contrast=1.15:saturation=0.82:brightness=0:gamma=1.08");
    for (const kind of ["stock", "archive", "ai_generated", undefined] as const) {
      expect(buildDocumentaryColorGradeVF(kind)).not.toContain("colorbalance");
    }
    expect(gradeChain({ grade: "documentary", strength: 0.6 }, "stock")).not.toContain("colorbalance");
    expect(gradeChain({ grade: "documentary" }, "stock")).not.toContain("colorbalance");
  });

  it("measured: a mid-grey frame through the full documentary grade keeps U and V at neutral", () => {
    const vf = gradeChain({ grade: "documentary" }, "stock")!;
    const stats = spawnSync("ffmpeg", [
      "-hide_banner", "-f", "lavfi", "-i", "color=c=0x808080:s=64x36:d=0.1",
      "-vf", `${vf},format=yuv420p,crop=16:16:24:10,signalstats,metadata=print`, "-f", "null", "-",
    ]).stderr.toString();
    const u = Number(/UAVG=([0-9.]+)/.exec(stats)?.[1]);
    const v = Number(/VAVG=([0-9.]+)/.exec(stats)?.[1]);
    expect(Math.abs(u - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(v - 128)).toBeLessThanOrEqual(1);
  });

  it("measured: a dark grey frame through the dark-source grade keeps U and V at neutral", () => {
    const stats = spawnSync("ffmpeg", [
      "-hide_banner", "-f", "lavfi", "-i", "color=c=0x3c3c3c:s=64x36:d=0.1",
      "-vf", `${buildDocumentaryColorGradeVF("stock", { darkSource: true })},format=yuv420p,signalstats,metadata=print`, "-f", "null", "-",
    ]).stderr.toString();
    const u = Number(/UAVG=([0-9.]+)/.exec(stats)?.[1]);
    const v = Number(/VAVG=([0-9.]+)/.exec(stats)?.[1]);
    expect(Math.abs(u - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(v - 128)).toBeLessThanOrEqual(1);
  });

  it("the fair-use transform reframes only — the renderer grades once", () => {
    const pipe = SRC("videoPipeline.ts");
    const body = pipe.slice(pipe.indexOf("async function transformClipForFairUse("), pipe.indexOf("async function transformClipForFairUse(") + 2000);
    expect(body).toContain("let filterChain = zoomCrop;");
    expect(body).not.toContain("saturation: 1.20");
  });
});

describe("5b — a purple cast in the source is measured and taken out", () => {
  it("a neutral or warm source is left alone; a violet one is pulled back toward neutral", () => {
    expect(purpleCastCorrection(128, 128)).toBeNull();
    expect(purpleCastCorrection(118, 140)).toBeNull(); // warm: V up, U down
    expect(purpleCastCorrection(null, null)).toBeNull();
    expect(purpleCastCorrection(150, 140)).toBe("lutyuv=u='clip(val-11,0,255)':v='clip(val-11.9,0,255)'");
  });

  it("measured: the uploaded film's violet (U 150, V 140) comes out close to neutral", async () => {
    const src = path.join(dir, "violet.mp4");
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x8a5fa8:s=320x180:d=3:r=12", "-pix_fmt", "yuv420p", src]);
    const before = await probeMeanChroma(src);
    expect(before!.u).toBeGreaterThan(136);
    expect(before!.v).toBeGreaterThan(130);
    const fix = purpleCastCorrection(before!.u, before!.v)!;
    const stats = spawnSync("ffmpeg", ["-hide_banner", "-i", src, "-vf", `${fix},signalstats,metadata=print`, "-frames:v", "1", "-f", "null", "-"]).stderr.toString();
    const u = Number(/UAVG=([0-9.]+)/.exec(stats)?.[1]);
    const v = Number(/VAVG=([0-9.]+)/.exec(stats)?.[1]);
    expect(u - 128).toBeLessThan((before!.u - 128) * 0.6);
    expect(v - 126).toBeLessThan((before!.v - 126) * 0.3);
  });

  it("the renderer measures every segment and hands the correction to the one grade", () => {
    const r = SRC("timelineRenderer.ts");
    expect(r).toContain("purpleCastCorrection(chroma?.u ?? null, chroma?.v ?? null)");
    expect(r).toContain("...(unpurple ? { chroma: unpurple } : {}),");
    expect(SRC("timelineFilters.ts")).toContain("if (source?.chroma) parts.push(source.chroma);");
  });
});

describe("6 — pieces of one YouTube shot follow each other, no jump back or ahead", () => {
  it("a 14 s slot from a 30 s walk: three pieces that continue one another from the planner's moment", () => {
    const { pieces } = planYoutubePieces({ inSec: 6, durationSec: 14, facts: { sourceDurationSec: 30, cutsSec: [], measured: true } });
    expect(pieces.length).toBe(3);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.inSec).toBeCloseTo(pieces[i - 1]!.inSec + pieces[i - 1]!.durationSec, 2);
    }
    expect(pieces[0]!.inSec).toBeCloseTo(6, 2);
  });

  it("when its shot ends, the next piece starts the next shot, never seconds already shown", () => {
    const { pieces } = planYoutubePieces({ inSec: 2, durationSec: 12, facts: { sourceDurationSec: 30, cutsSec: [10], measured: true } });
    const spans = pieces.map((p) => [p.inSec, p.inSec + p.durationSec] as const);
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) expect(Math.min(spans[i]![1], spans[j]![1]) - Math.max(spans[i]![0], spans[j]![0])).toBeLessThanOrEqual(0.01);
    expect(pieces.some((p) => p.inSec >= 10)).toBe(true);
  });
});

describe("7 — R2: the made film is measured — still, slow and repeated picture", () => {
  const flat = (v: number) => new Uint8Array(SAMPLE_W * SAMPLE_H).fill(v);
  const textured = (seed: number, shift = 0) =>
    Uint8Array.from({ length: SAMPLE_W * SAMPLE_H }, (_, i) => (((i * 37 + seed * 101) % 211) + shift) & 0xff);

  it("pure reading: two seconds of one frame are still; a cut away and back is a repeat", () => {
    const a = textured(1);
    const samples = [textured(5), textured(6), a, a, a, a, a, textured(7), textured(8), textured(9), textured(10), textured(11), a, a, a];
    const m = readPicture(samples, 2);
    expect(m.still[0]).toEqual({ fromSec: 1, toSec: 3 });
    expect(m.repeats.length).toBe(1);
    expect(m.repeats[0]).toMatchObject({ fromSec: 6, firstSeenSec: 1 });
  });

  it("a black stretch or a colour field is not a repeat, and a drawn graphic's window is left out", () => {
    const samples = [flat(0), flat(0), textured(2), textured(3), textured(4), textured(5), textured(6), flat(0), flat(0), flat(0)];
    expect(readPicture(samples, 2).repeatSec).toBe(0);
    const still = [textured(1), textured(1), textured(1), textured(1), textured(2)];
    expect(readPicture(still, 2).stillSec).toBe(1.5);
    expect(readPicture(still, 2, [{ fromSec: 0, toSec: 2 }]).stillSec).toBe(0);
  });

  it("the night walk of the uploaded film: two shots in a row from one source that jump inside it are named", () => {
    const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 25 });
    t.durationSec = 12;
    const yt = { provider: "youtube_cc" as const, archiveAssetId: 55, contentApproval: "judge_fit" as const };
    const walk = [
      clip("j1", 0, 3, { source: yt, sourceIn: 10, sourceOut: 13 }),
      clip("j2", 3, 6, { source: yt, sourceIn: 18, sourceOut: 21 }),
      clip("j3", 6, 9, { source: yt, sourceIn: 21, sourceOut: 24 }),
      clip("j4", 9, 12, { source: yt, sourceIn: 24.5, sourceOut: 27.5 }),
    ];
    for (const tr of t.tracks) if (tr.kind === "VIDEO") tr.clips.push(...walk);
    const r = viewerReport(t);
    /** 13 → 18 jumps; 21 → 21 continues; 24 → 24.5 steps over one cut in the source */
    expect(r.jumpCuts).toEqual(["j1→j2 (13.0s → 18.0s)"]);
    expect(formatViewerReport(1, r)).toMatch(/jumpCuts=1 .*NOT_YET — .*1 jump\(s\) inside one source/);
  });

  it("measured on a real file: the held seconds and the shot that comes back are found; the line says NOT_YET", async () => {
    const film = path.join(dir, "measured.mp4");
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:d=3:r=25",
      "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=25",
      "-filter_complex",
      "[0:v]split=2[a][b];[a]trim=0:2,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[held];" +
        "[1:v]trim=0:3,setpts=PTS-STARTPTS,format=yuv420p[m];[b]trim=0:2,setpts=PTS-STARTPTS[again];" +
        "[held][m][again]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", film,
    ]);
    const m = (await measureFilmPicture(film))!;
    expect(m.sampledSec).toBeGreaterThan(8);
    expect(m.stillSec).toBeGreaterThanOrEqual(1.5);
    expect(m.still[0]!.fromSec).toBeGreaterThanOrEqual(1.5);
    expect(m.still[0]!.fromSec).toBeLessThanOrEqual(2.5);
    expect(m.repeatSec).toBeGreaterThanOrEqual(1);
    expect(m.repeats[0]!.fromSec).toBeGreaterThanOrEqual(6.5);
    const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 25 });
    t.durationSec = 9;
    const line = formatViewerReport(1, viewerReport(t, [], m));
    expect(line).toMatch(/measured=still \d/);
    expect(line).toMatch(/NOT_YET — .*the picture stands still.*a picture comes back/);
  }, 120_000);

  it("a file that cannot be read says so; the worker measures every made film", () => {
    const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 25 });
    expect(formatViewerReport(1, viewerReport(t, [], null))).toContain("measured=UNREADABLE");
    expect(SRC("renderJobWorker.ts")).toContain("const measured = await measureFilmPicture(rendered.outputPath, drawn);");
  });
});
