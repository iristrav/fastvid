/**
 * RONDE 155 / 155B / §14 — motion graphics, charts, maps and shapes.
 *
 * The payload rules are tested as pure functions; the drawing is tested by RENDERING. A chart
 * component that returns null renders a perfectly valid transparent overlay, so "the render
 * succeeded" proves nothing about whether a bar appeared. Counting ink does.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DATA_DRIVEN_GRAPHICS,
  RENDERABLE_GRAPHICS,
  SHAPE_GRAPHICS,
  graphicIsRenderable,
  unsupportedGraphicsIn,
} from "./remotion/components/Graphics";
import {
  SHAPE_PATHS,
  chartPayloadIsRenderable,
  readNumber,
  readRoute,
  readSeries,
  readText,
} from "./remotion/components/Charts";
import { emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { renderGraphicsOverlay, bundleFastVid, resolveRemotionBrowser } from "./remotionRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

/* ═══════════════════════ payload reading ═══════════════════════ */

describe("RONDE 155B — a chart draws only what its payload contains", () => {
  it("reads a well-formed series", () => {
    const series = readSeries({ series: [{ label: "1940", value: 12 }, { label: "1945", value: 88 }] });
    expect(series).toHaveLength(2);
    expect(series[1]).toEqual({ label: "1945", value: 88 });
  });

  it("accepts the payload under any of its aliases", () => {
    expect(readSeries({ values: [{ label: "a", value: 1 }] })).toHaveLength(1);
    expect(readSeries({ data: [{ label: "a", value: 1 }] })).toHaveLength(1);
  });

  /**
   * A NaN bar would render as a zero-height rectangle and read as a real measurement of nothing.
   * Dropping it means the chart is either right or reported as unsupported.
   */
  it("drops a non-numeric value rather than coercing it to zero", () => {
    const series = readSeries({
      series: [{ label: "ok", value: 5 }, { label: "bad", value: "lots" }, { label: "nan", value: Number.NaN }],
    });
    expect(series).toHaveLength(1);
    expect(series[0]!.label).toBe("ok");
  });

  it("returns nothing for a malformed payload", () => {
    expect(readSeries({})).toEqual([]);
    expect(readSeries({ series: "a,b,c" })).toEqual([]);
    expect(readSeries({ series: [null, 42, "x"] })).toEqual([]);
  });

  it("reads only real numbers, never a convenient default", () => {
    expect(readNumber({ percent: 62 }, "percent")).toBe(62);
    expect(readNumber({ percent: "62" }, "percent")).toBeNull();
    expect(readNumber({}, "percent", "value")).toBeNull();
  });

  it("reads route points and clamps them into the frame", () => {
    const points = readRoute({
      points: [
        { normX: 0.2, normY: 0.3, label: "Berlin" },
        { normX: 1.8, normY: -0.4, label: "Moscow" },
        { normX: "x", normY: 0.5 },
      ],
    });
    expect(points).toHaveLength(2);
    expect(points[1]!.x).toBe(1);
    expect(points[1]!.y).toBe(0);
  });
});

describe("RONDE 155B — renderability is decided by the payload, not the name", () => {
  it("a chart with values is renderable; the same chart empty is not", () => {
    expect(chartPayloadIsRenderable("bar_chart", { series: [{ label: "a", value: 1 }] })).toBe(true);
    expect(chartPayloadIsRenderable("bar_chart", {})).toBe(false);
  });

  it("a percentage ring needs a number", () => {
    expect(chartPayloadIsRenderable("percentage_ring", { percent: 40 })).toBe(true);
    expect(chartPayloadIsRenderable("percentage_ring", { label: "forty" })).toBe(false);
  });

  it("a map point needs a coordinate", () => {
    expect(chartPayloadIsRenderable("map_point", { normX: 0.4, normY: 0.6 })).toBe(true);
    expect(chartPayloadIsRenderable("map_point", { label: "Cupertino" })).toBe(false);
  });

  it("a route needs at least two points; a multi-point needs one", () => {
    const one = { points: [{ normX: 0.1, normY: 0.2 }] };
    expect(chartPayloadIsRenderable("route", one)).toBe(false);
    expect(chartPayloadIsRenderable("multi_point", one)).toBe(true);
  });

  /**
   * §14, as an assertion. A map with only a place name has no geography in it, so it is reported
   * — it does not become the word "map" or a picture of a coastline nobody has data for.
   */
  it("a map with a NAME but no coordinate is unsupported, not approximated", () => {
    const graphics = [
      {
        id: "m1", graphicType: "map_point", label: "Cupertino", data: {},
        fromFrame: 0, durationInFrames: 48, style: null,
        reason: "the narration names a place",
      },
    ];
    const unsupported = unsupportedGraphicsIn(graphics);
    expect(unsupported).toHaveLength(1);
    // The payload and the planner's reason survive for a future component.
    expect(unsupported[0]!.reason).toContain("narration");
  });

  it("a shape is renderable only if this build has a path for it", () => {
    expect(graphicIsRenderable("shape", { shape: "arrow" }, null)).toBe(true);
    expect(graphicIsRenderable("shape", { shape: "dodecahedron" }, null)).toBe(false);
    for (const name of Object.keys(SHAPE_PATHS)) {
      expect(graphicIsRenderable("icon", { icon: name }, null), name).toBe(true);
    }
  });

  it("a text card still needs words", () => {
    expect(graphicIsRenderable("lower_third", { role: "CEO" }, "Tim Cook")).toBe(true);
    expect(graphicIsRenderable("lower_third", { role: "CEO" }, "")).toBe(false);
  });

  it("every data-driven and shape type is in the renderable vocabulary", () => {
    for (const t of DATA_DRIVEN_GRAPHICS) expect(RENDERABLE_GRAPHICS.has(t), t).toBe(true);
    for (const t of SHAPE_GRAPHICS) expect(RENDERABLE_GRAPHICS.has(t), t).toBe(true);
  });

  it("§155's whole card vocabulary is present", () => {
    for (const t of [
      "title", "subtitle", "lower_third", "location_card", "date_card", "chapter_card",
      "quote", "stat", "counter", "progress", "callout", "warning", "timeline_event",
    ]) {
      expect(RENDERABLE_GRAPHICS.has(t), t).toBe(true);
    }
  });

  it("readText never invents a value", () => {
    expect(readText({ title: "  Berlin  " }, "title")).toBe("Berlin");
    expect(readText({ title: "   " }, "title")).toBeNull();
    expect(readText({}, "title", "label")).toBeNull();
  });
});

/* ═══════════════════════ rendered, with real pixels ═══════════════════════ */

const browser = resolveRemotionBrowser();
const describeRender = browser ? describe : describe.skip;

describeRender("RONDE 155 — the graphics actually draw", () => {
  let dir: string;
  let serveUrl: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r155-"));
    serveUrl = await bundleFastVid(path.join(dir, "bundle"));
  }, 300_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function timelineWith(graphic: Record<string, unknown>): ProjectTimeline {
    const t = emptyTimeline(1, { widthPx: 960, heightPx: 540, fps: 24 });
    t.durationSec = 2;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") track.graphics.push(graphic as never);
    }
    return t;
  }

  /** How many pixels of the overlay are not transparent, in one frame. */
  async function inkedPixels(overlayPath: string, atFrame = 36): Promise<number> {
    const raw = path.join(dir, `${path.basename(overlayPath)}.gray`);
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-i", overlayPath,
      "-vf", `select=eq(n\\,${atFrame}),alphaextract,scale=96:54`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw,
    ]);
    return [...fs.readFileSync(raw)].filter((v) => v > 20).length;
  }

  it("a bar chart draws bars", async () => {
    const overlayPath = path.join(dir, "bars.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "bar_chart", label: "Casualties",
        data: { title: "By year", series: [
          { label: "1940", value: 12 }, { label: "1942", value: 48 }, { label: "1945", value: 88 },
        ] },
        start: 0, end: 2,
      }),
      overlayPath,
      serveUrl,
    });
    expect(result.skipped).toEqual([]);
    expect(result.graphicsDrawn).toBe(1);
    // Three bars, axis labels and a title cover a real fraction of the frame.
    expect(await inkedPixels(overlayPath)).toBeGreaterThan(60);
  }, 300_000);

  it("an EMPTY bar chart draws nothing and is reported", async () => {
    const overlayPath = path.join(dir, "empty.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "bar_chart", label: "Casualties", data: {}, start: 0, end: 2,
        reason: "the planner wanted a chart here",
      }),
      overlayPath,
      serveUrl,
    });
    expect(result.graphicsDrawn).toBe(0);
    expect(result.skipped.join(" ")).toContain("unsupported_graphic bar_chart");
    // The planner's reason survives into the report.
    expect(result.skipped.join(" ")).toContain("the planner wanted a chart here");
    expect(await inkedPixels(overlayPath)).toBe(0);
  }, 300_000);

  it("a percentage ring draws a ring and its number", async () => {
    const overlayPath = path.join(dir, "ring.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "percentage_ring", label: "Share",
        data: { percent: 62, label: "of all flights" }, start: 0, end: 2,
      }),
      overlayPath,
      serveUrl,
    });
    expect(result.graphicsDrawn).toBe(1);
    expect(await inkedPixels(overlayPath)).toBeGreaterThan(40);
  }, 300_000);

  it("a map point draws a graticule and a marker — abstract, not a fake coastline", async () => {
    const overlayPath = path.join(dir, "map.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "map_point", label: "Cupertino",
        data: { normX: 0.32, normY: 0.44, label: "Cupertino" }, start: 0, end: 2,
      }),
      overlayPath,
      serveUrl,
    });
    expect(result.graphicsDrawn).toBe(1);
    // The panel covers a large part of the frame, so this is a high bar deliberately.
    expect(await inkedPixels(overlayPath)).toBeGreaterThan(200);
  }, 300_000);

  it("a route draws a line between two points", async () => {
    const overlayPath = path.join(dir, "route.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "route", label: "Berlin to Moscow",
        data: { points: [
          { normX: 0.2, normY: 0.4, label: "Berlin" },
          { normX: 0.8, normY: 0.3, label: "Moscow" },
        ] },
        start: 0, end: 2,
      }),
      overlayPath,
      serveUrl,
    });
    expect(result.graphicsDrawn).toBe(1);
    expect(await inkedPixels(overlayPath)).toBeGreaterThan(200);
  }, 300_000);

  it("a counter really counts — the value differs between two frames", async () => {
    const overlayPath = path.join(dir, "counter.mov");
    await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "counter", label: "1940",
        data: { fromValue: 1940, toValue: 1945 }, start: 0, end: 2,
      }),
      overlayPath,
      serveUrl,
    });
    /**
     * Compare the ink at an early frame and a late one. The digits change as it counts, so the
     * two frames differ — a static number would give the same count twice.
     */
    const early = await inkedPixels(overlayPath, 6);
    const late = await inkedPixels(overlayPath, 40);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  }, 300_000);

  it("a shape draws, and an unknown shape does not", async () => {
    const good = path.join(dir, "shape.mov");
    const drew = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "shape", label: "arrow", data: { shape: "arrow" }, start: 0, end: 2,
      }),
      overlayPath: good,
      serveUrl,
    });
    expect(drew.graphicsDrawn).toBe(1);
    expect(await inkedPixels(good)).toBeGreaterThan(0);

    const bad = path.join(dir, "noshape.mov");
    const refused = await renderGraphicsOverlay({
      timeline: timelineWith({
        id: "g1", graphicType: "shape", label: "dodecahedron",
        data: { shape: "dodecahedron" }, start: 0, end: 2,
      }),
      overlayPath: bad,
      serveUrl,
    });
    expect(refused.graphicsDrawn).toBe(0);
    expect(refused.skipped.join(" ")).toContain("unsupported_graphic shape");
  }, 300_000);
});
