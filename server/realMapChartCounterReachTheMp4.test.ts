/**
 * OCTOBER 2026 — THE REAL MAP, THE CHART AND THE COUNTER REACH THE MP4.
 *
 * Through the production render (`renderTimeline` + `productionGraphicsOverlay`), like
 * mapsRoutesChartsReachTheMp4: a world map that moves in to Berlin with Germany highlighted, a
 * route Paris → Berlin → Warsaw on the real coastline, a line chart with title, axis and values,
 * a bar chart, and a counter to 3.5 billion. Each must put ink in its own slot; the map must change
 * while its camera travels; the slot after the last must be clean.
 *
 * Set KEEP_GRAPHICS_RENDER=<dir> to keep the MP4 and a still of every slot for a person to look at.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CAPTION_STYLE, emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { renderTimeline, type RenderedTimeline } from "./timelineRenderer";
import { resolveRemotionBrowser } from "./remotionRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
const SLOT = 3;

const GRAPHICS = [
  {
    id: "g-geo",
    graphicType: "map_point",
    data: { lon: 13.4, lat: 52.52, iso3: "DEU", locationName: "Berlin", normX: 0.525, normY: 0.255 },
  },
  {
    id: "g-georoute",
    graphicType: "route",
    data: {
      points: [
        { lon: 2.35, lat: 48.86, label: "Paris" },
        { lon: 13.4, lat: 52.52, label: "Berlin" },
        { lon: 21.01, lat: 52.23, label: "Warsaw" },
      ],
    },
  },
  {
    id: "g-line",
    graphicType: "line_chart",
    data: {
      title: "World population",
      suffix: "billion",
      decimals: 1,
      series: [
        { label: "1950", value: 2.5 },
        { label: "1975", value: 4.1 },
        { label: "2000", value: 6.1 },
        { label: "2023", value: 8.0 },
      ],
    },
  },
  {
    id: "g-bar",
    graphicType: "bar_chart",
    data: { title: "Cars sold", suffix: "million", decimals: 1, series: [{ label: "2021", value: 0.9 }, { label: "2022", value: 1.3 }, { label: "2023", value: 1.8 }] },
  },
  {
    id: "g-counter",
    graphicType: "counter",
    label: "3.5 billion",
    data: { fromValue: 0, toValue: 3.5, suffix: "billion", decimals: 1, caption: "Valuation" },
  },
].map((g, i) => ({ ...g, start: i * SLOT, end: (i + 1) * SLOT }));

/** OCTOBER 2026 — a short caption and one that wraps, on the default boxed style. */
const CAPTIONS = [
  { id: "c-short", text: "Kris Jenner built the empire." },
  { id: "c-long", text: "In 2007 a small reality show turned one family into a business worth billions of dollars." },
].map((c, i) => ({
  ...c,
  start: (GRAPHICS.length + i) * SLOT,
  end: (GRAPHICS.length + i + 1) * SLOT,
  style: { ...DEFAULT_CAPTION_STYLE },
}));

const SLOTS = GRAPHICS.length + CAPTIONS.length;
const DURATION = (SLOTS + 1) * SLOT;
const at = (i: number, f: number) => i * SLOT + SLOT * f;

function timeline(): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = DURATION;
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS") track.graphics.push(...(GRAPHICS as never[]));
    if (track.kind === "CAPTIONS") track.captions.push(...(CAPTIONS as never[]));
    if (track.kind === "VIDEO") {
      track.clips.push({
        id: "clip-1", kind: "video", source: { provider: "pexels", providerAssetId: "fixture" },
        sourceIn: 0, sourceOut: DURATION, timelineStart: 0, timelineEnd: DURATION,
        motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
      } as never);
    }
  }
  return t;
}

async function frameAt(file: string, atSec: number, out: string, format: "rawvideo" | "png"): Promise<void> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", atSec.toFixed(3), "-i", file,
    "-frames:v", "1", ...(format === "rawvideo" ? ["-f", "rawvideo", "-pix_fmt", "rgb24"] : []), out,
  ]);
}

/** Pixels that are no longer the dark-red source — what a graphic put there. */
function ink(rgb: Buffer): number {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    if (!(rgb[i]! > 100 && rgb[i]! < 140 && rgb[i + 1]! < 30 && rgb[i + 2]! < 30)) n++;
  }
  return n;
}

/**
 * Where a caption's plate and its letters are, horizontally, in the lower half of the frame.
 * Plate: the dark-red source under 45% black (≈ 66,0,0). Letters: near-white. Solid black: a plate
 * that ignored its opacity.
 */
function plateExtent(rgb: Buffer): { plateW: number; textW: number; solidBlack: number } {
  let pMin = WIDTH, pMax = -1, tMin = WIDTH, tMax = -1, solidBlack = 0;
  for (let y = Math.floor(HEIGHT / 2); y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      const r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
      if (r > 45 && r < 90 && g < 20 && b < 20) { pMin = Math.min(pMin, x); pMax = Math.max(pMax, x); }
      if (r > 200 && g > 200 && b > 200) { tMin = Math.min(tMin, x); tMax = Math.max(tMax, x); }
      if (r < 12 && g < 12 && b < 12) solidBlack++;
    }
  }
  return { plateW: pMax - pMin + 1, textW: tMax - tMin + 1, solidBlack };
}

const describeRender = resolveRemotionBrowser() ? describe : describe.skip;

describeRender("the real map, the chart and the counter in the production render", () => {
  let dir = "";
  let out = "";
  let result: RenderedTimeline;
  const inkMid: number[] = [];
  const captionPlates: Array<ReturnType<typeof plateExtent>> = [];
  let mapEarly: Buffer;
  let mapLate: Buffer;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-map-"));
    const source = path.join(dir, "red.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", `color=c=0x780000:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
    out = path.join(dir, "graphics.mp4");
    const workDir = path.join(dir, "work");
    result = await renderTimeline({
      timeline: timeline(),
      workDir,
      outputPath: out,
      resolveMedia: async () => source,
      graphicsOverlay: productionGraphicsOverlay({ workDir, cacheDir: path.join(dir, "bundle") }),
    });
    for (let i = 0; i <= SLOTS; i++) {
      const raw = path.join(dir, `m${i}.raw`);
      await frameAt(out, at(i, 0.8), raw, "rawvideo");
      inkMid.push(ink(fs.readFileSync(raw)));
    }
    for (let k = 0; k < CAPTIONS.length; k++) {
      const raw = path.join(dir, `c${k}.raw`);
      await frameAt(out, at(GRAPHICS.length + k, 0.6), raw, "rawvideo");
      captionPlates.push(plateExtent(fs.readFileSync(raw)));
    }
    await frameAt(out, at(0, 0.12), path.join(dir, "early.raw"), "rawvideo");
    await frameAt(out, at(0, 0.6), path.join(dir, "late.raw"), "rawvideo");
    mapEarly = fs.readFileSync(path.join(dir, "early.raw"));
    mapLate = fs.readFileSync(path.join(dir, "late.raw"));
    const keep = process.env.KEEP_GRAPHICS_RENDER;
    if (keep) {
      fs.mkdirSync(keep, { recursive: true });
      fs.copyFileSync(out, path.join(keep, "real-map-chart-counter.mp4"));
      for (let i = 0; i < GRAPHICS.length; i++) {
        for (const f of [0.15, 0.45, 0.85]) {
          await frameAt(out, at(i, f), path.join(keep, `${GRAPHICS[i]!.id}-${Math.round(f * 100)}.png`), "png");
        }
      }
      for (let k = 0; k < CAPTIONS.length; k++) {
        await frameAt(out, at(GRAPHICS.length + k, 0.6), path.join(keep, `${CAPTIONS[k]!.id}.png`), "png");
      }
    }
  }, 1_800_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("went through the normal overlay and nothing was refused or left undrawn", () => {
    expect(fs.existsSync(out)).toBe(true);
    expect(result.skipped.filter((s) => /unsupported_graphic|fell back|not drawn|no visible ink/.test(s))).toEqual([]);
  });

  it("every graphic has ink in its own slot", () => {
    const floor = Math.round(WIDTH * HEIGHT * 0.01);
    GRAPHICS.forEach((g, i) => expect(inkMid[i], `${g.graphicType} at ${at(i, 0.8)}s`).toBeGreaterThan(floor));
  });

  it("the map's camera moves: an early and a late frame of it differ widely", () => {
    let changed = 0;
    for (let i = 0; i < mapEarly.length; i += 3) {
      if (Math.abs(mapEarly[i]! - mapLate[i]!) + Math.abs(mapEarly[i + 1]! - mapLate[i + 1]!) + Math.abs(mapEarly[i + 2]! - mapLate[i + 2]!) > 60) changed++;
    }
    expect(changed).toBeGreaterThan(WIDTH * HEIGHT * 0.03);
  });

  it("the slot after the last caption is clean", () => {
    expect(inkMid[SLOTS]).toBeLessThan(Math.round(WIDTH * HEIGHT * 0.0005));
  });

  it("a caption's plate hugs its text: never wider than the longest line plus its padding", () => {
    /** 0.6em of padding on each side at 46px, and a few pixels for anti-aliasing and the shadow. */
    const padding = 2 * 0.6 * DEFAULT_CAPTION_STYLE.fontSizePx + 16;
    for (const [k, p] of captionPlates.entries()) {
      expect(p.textW, CAPTIONS[k]!.id).toBeGreaterThan(100);
      expect(p.plateW - p.textW, `${CAPTIONS[k]!.id}: plate ${p.plateW}px, text ${p.textW}px`).toBeLessThanOrEqual(padding);
    }
  });

  it("the wrapped caption's plate is narrower than the 84% maximum it used to stretch to", () => {
    expect(captionPlates[1]!.plateW).toBeLessThan(WIDTH * 0.84 - 40);
  });

  it("the plate keeps the style's 45% opacity — the picture shows through, it is not a black slab", () => {
    for (const p of captionPlates) expect(p.solidBlack).toBeLessThan(WIDTH * 4);
  });
});
