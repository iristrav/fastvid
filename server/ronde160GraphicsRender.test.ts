/**
 * RONDE 160 §7 — every graphic type, rendered for real, verified by its pixels.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────────────────────
 *
 * `RENDERABLE_GRAPHICS` is a Set of strings. `graphicIsRenderable` reads that Set and answers
 * "yes". Every unit test in RONDE 155 asks that function the question and believes the answer.
 *
 * None of that proves a component exists. A type can sit in the Set, pass `graphicIsRenderable`,
 * be counted in `graphicsDrawn`, and render as an EMPTY frame — because the component's switch has
 * no case for it and falls through to null. The whole chain reports success and the video has
 * nothing on it. That is the exact "fake success" §21 forbids, and no amount of unit testing can
 * see it, because the thing that went missing is a pixel.
 *
 * So this renders one real overlay — real Remotion, real chrome-headless-shell, real ProRes 4444
 * with alpha — containing EVERY member of `RENDERABLE_GRAPHICS`, each alone in its own one-second
 * window, and then reads the ALPHA CHANNEL back at the midpoint of each window. A type that drew
 * nothing has an all-zero alpha plane there, and this test fails naming it.
 *
 * ── Why alpha and not colour ─────────────────────────────────────────────────────────────────
 *
 * The overlay is transparent by construction: everywhere nothing was drawn, alpha is 0. So "did
 * this type draw anything at all" is exactly "is any alpha non-zero in this frame", independent of
 * what colour the component chose. It is the one measurement that cannot be satisfied by accident.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import {
  bundleFastVid,
  renderGraphicsOverlay,
  resolveRemotionBrowser,
} from "./remotionRenderer";
import { RENDERABLE_GRAPHICS, graphicIsRenderable } from "./remotion/components/Graphics";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

/* ═══════════════════════ one payload per type ═══════════════════════ */

/**
 * A payload for every renderable type, written to satisfy that type's OWN requirement.
 *
 * Deliberately not a single generic `{ label: "x" }` for all of them: a chart needs a series, a
 * map point needs a coordinate, a shape needs a name that is in `SHAPE_PATHS`. Using one payload
 * shape for everything would mean the data-driven types were skipped rather than drawn, and the
 * test would prove nothing about them. A test below asserts this table covers the Set exactly, so
 * a type added to `RENDERABLE_GRAPHICS` without a component cannot slip past by being forgotten
 * here.
 */
const SERIES = { series: [{ label: "A", value: 4 }, { label: "B", value: 9 }, { label: "C", value: 6 }] };
const ROUTE = { points: [{ normX: 0.2, normY: 0.3, label: "Start" }, { normX: 0.7, normY: 0.6, label: "End" }] };

const PAYLOADS: Readonly<Record<string, { label: string | null; data: Record<string, unknown> }>> = {
  location_card: { label: "Cupertino", data: { country: "United States" } },
  date_card: { label: "April 2017", data: {} },
  chapter_card: { label: "Chapter One", data: {} },
  chapter_title: { label: "The Ring", data: {} },
  lower_third: { label: "Tim Cook", data: { role: "CEO, Apple" } },
  headline: { label: "A Campus In A Circle", data: {} },
  title: { label: "Apple Park", data: {} },
  subtitle: { label: "Five billion dollars", data: {} },
  quote: { label: "It just works.", data: { attribution: "Steve Jobs" } },
  statistic: { label: "5 billion", data: {} },
  callout: { label: "Look here", data: {} },
  emphasis: { label: "Everything changed", data: {} },
  name: { label: "Steve Jobs", data: {} },
  label: { label: "Main entrance", data: {} },
  badge: { label: "NEW", data: {} },
  counter: { label: "Cost", data: { fromValue: 0, toValue: 5, suffix: "B" } },
  text: { label: "Plain words on screen", data: {} },
  stat: { label: "2,800 trees", data: {} },
  progress: { label: "Complete", data: { toValue: 72, suffix: "%" } },
  warning: { label: "Estimate only", data: {} },
  timeline_event: { label: "Opened", data: { year: "2017" } },
  bar_chart: { label: "Revenue", data: SERIES },
  horizontal_bar: { label: "Share", data: SERIES },
  line_chart: { label: "Growth", data: SERIES },
  pie_chart: { label: "Split", data: SERIES },
  donut_chart: { label: "Split", data: SERIES },
  percentage_ring: { label: "Done", data: { percent: 64 } },
  map_point: { label: "Cupertino", data: { normX: 0.18, normY: 0.42 } },
  route: { label: "The journey", data: ROUTE },
  multi_point: { label: "Sites", data: ROUTE },
  shape: { label: null, data: { shape: "circle" } },
  icon: { label: null, data: { icon: "camera" } },
};

/** Every type in the Set, in a stable order, so a failure names the same slot every run. */
const TYPES = [...RENDERABLE_GRAPHICS].sort();

const SLOT_SEC = 1;
const FPS = 12;
const WIDTH = 640;
const HEIGHT = 360;

function timelineWithEveryGraphic(): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = TYPES.length * SLOT_SEC;
  const track = t.tracks.find((x) => x.kind === "GRAPHICS");
  if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");
  TYPES.forEach((graphicType, i) => {
    const payload = PAYLOADS[graphicType];
    if (!payload) throw new Error(`no payload for "${graphicType}" — add one to PAYLOADS`);
    track.graphics.push({
      id: `g_${i}_${graphicType}`,
      graphicType,
      label: payload.label,
      data: payload.data,
      start: i * SLOT_SEC,
      end: i * SLOT_SEC + SLOT_SEC,
    } as never);
  });
  return t;
}

/* ═══════════════════════ reading alpha back ═══════════════════════ */

/**
 * The alpha plane of one frame, as raw bytes.
 *
 * `alphaextract` turns the alpha channel into a greyscale picture, so a byte here is "how opaque
 * was this pixel". Full resolution rather than scaled to one pixel: a thin shape — the `line`
 * path is a single stroke — averages down to nearly nothing, and a rounding error would then read
 * as "drew nothing" on a graphic that drew correctly.
 */
async function alphaPlaneAt(overlayPath: string, atSec: number, outPath: string): Promise<Buffer> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", atSec.toFixed(3),
    "-i", overlayPath,
    "-vf", "alphaextract",
    "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "gray",
    outPath,
  ]);
  return fs.readFileSync(outPath);
}

function coverage(plane: Buffer): { maxAlpha: number; opaquePixels: number } {
  let maxAlpha = 0;
  let opaquePixels = 0;
  for (const byte of plane) {
    if (byte > maxAlpha) maxAlpha = byte;
    if (byte > 8) opaquePixels++;
  }
  return { maxAlpha, opaquePixels };
}

/* ═══════════════════════ the contract, without a render ═══════════════════════ */

describe("R160 §7 — the payload table covers exactly what the renderer claims to draw", () => {
  /**
   * The guard that keeps this file honest as the codebase grows. Adding a string to
   * `RENDERABLE_GRAPHICS` without adding a component is precisely the bug this file exists to
   * catch — and it would be invisible if the new type were simply missing from `PAYLOADS`, because
   * the render below would never include it.
   */
  it("has a payload for every renderable type and no extras", () => {
    const missing = TYPES.filter((t) => !PAYLOADS[t]);
    expect(missing, "types in RENDERABLE_GRAPHICS with no payload here").toEqual([]);
    const extra = Object.keys(PAYLOADS).filter((t) => !RENDERABLE_GRAPHICS.has(t));
    expect(extra, "payloads here for types the renderer does not claim").toEqual([]);
  });

  it("every payload passes the renderer's own renderability check", () => {
    const refused = TYPES.filter((t) => !graphicIsRenderable(t, PAYLOADS[t]!.data, PAYLOADS[t]!.label));
    expect(refused, "types this test's payload does not satisfy").toEqual([]);
  });

  /** A sanity check on the check: an empty payload must NOT be renderable for any type. */
  it("an empty payload is refused for every type", () => {
    const accepted = TYPES.filter((t) => graphicIsRenderable(t, {}, null));
    expect(accepted, "types that claim to be drawable with no data at all").toEqual([]);
  });

  /**
   * The specific bug the render below found, pinned so it cannot come back.
   *
   * `progress` is drawn as a percentage ring. A ring with no number draws nothing, so a `progress`
   * carrying only a label must be REFUSED — not accepted, counted, and rendered blank.
   */
  it("a `progress` with words but no number is refused, not silently drawn blank", () => {
    expect(graphicIsRenderable("progress", {}, "Complete")).toBe(false);
    expect(graphicIsRenderable("progress", { label: "Complete" }, null)).toBe(false);
  });

  it("a `progress` is accepted for each name this codebase gives that number", () => {
    for (const key of ["percent", "value", "toValue"]) {
      expect(graphicIsRenderable("progress", { [key]: 72 }, "Complete"), key).toBe(true);
      expect(graphicIsRenderable("percentage_ring", { [key]: 72 }, null), key).toBe(true);
    }
  });

  /**
   * `toValue` is not a field invented to make this pass — it is what the motion graphics planner
   * already writes for a percentage progress bar. If that ever changes, this test says so.
   */
  it("the planner's own progress payload is the shape the ring reads", () => {
    const fromPlanner = { toValue: 72, suffix: "%", label: "Complete" };
    expect(graphicIsRenderable("progress", fromPlanner, null)).toBe(true);
  });
});

/* ═══════════════════════ the render ═══════════════════════ */

const browser = resolveRemotionBrowser();
const describeRender = browser ? describe : describe.skip;

describeRender("R160 §7 — every graphic type puts ink on a real frame", () => {
  let workDir: string;
  let overlayPath: string;
  let drawn: { graphicsDrawn: number; skipped: string[] };

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "r160-gfx-"));
    const serveUrl = await bundleFastVid(path.join(workDir, "bundle"));
    overlayPath = path.join(workDir, "all-graphics.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineWithEveryGraphic(),
      overlayPath,
      serveUrl,
    });
    drawn = { graphicsDrawn: result.graphicsDrawn, skipped: result.skipped };
  }, 900_000);

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("accepts all of them — nothing was skipped", () => {
    expect(drawn.skipped).toEqual([]);
    expect(drawn.graphicsDrawn).toBe(TYPES.length);
  });

  it("produced a real ProRes 4444 file with an alpha channel", async () => {
    expect(fs.existsSync(overlayPath)).toBe(true);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt,width,height", "-of", "default=nw=1", overlayPath,
    ]);
    expect(stdout).toMatch(/pix_fmt=yuva/);
    expect(stdout).toContain(`width=${WIDTH}`);
    expect(stdout).toContain(`height=${HEIGHT}`);
  });

  /**
   * The measurement this file is for. One frame per type, taken at the middle of that type's own
   * second so no entrance or exit animation is still in flight, and the alpha plane read back in
   * full.
   *
   * Reported as one list rather than one assertion per type on purpose: when a component breaks it
   * usually breaks for a family of types at once, and seeing all of them at once is the difference
   * between "the chart component is gone" and "bar_chart failed".
   */
  it("draws visible ink for every single type", async () => {
    const blank: string[] = [];
    const measured: Array<{ type: string; maxAlpha: number; opaquePixels: number }> = [];

    for (let i = 0; i < TYPES.length; i++) {
      const type = TYPES[i]!;
      const plane = await alphaPlaneAt(
        overlayPath,
        i * SLOT_SEC + SLOT_SEC / 2,
        path.join(workDir, `a${i}.gray`)
      );
      expect(plane.length, `${type}: alpha plane is not a full frame`).toBe(WIDTH * HEIGHT);
      const c = coverage(plane);
      measured.push({ type, ...c });
      if (c.opaquePixels === 0) blank.push(`${type} (maxAlpha=${c.maxAlpha})`);
    }

    expect(blank, "graphic types that rendered an EMPTY frame").toEqual([]);
    /** Every type must also be more than a stray pixel — a real mark, not an artefact. */
    const faint = measured.filter((m) => m.opaquePixels < 40).map((m) => `${m.type}=${m.opaquePixels}px`);
    expect(faint, "graphic types whose mark is too small to be real").toEqual([]);
  }, 600_000);

  /**
   * The other half of the same proof: the overlay must be TRANSPARENT where nothing was planned.
   *
   * Without this, a component that painted an opaque background over the whole frame would pass
   * every assertion above — and would hide the entire film once composited.
   */
  it("is fully transparent in the gap after the last graphic ends", async () => {
    const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
    t.durationSec = 2;
    const track = t.tracks.find((x) => x.kind === "GRAPHICS");
    if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");
    track.graphics.push({
      id: "g_only",
      graphicType: "lower_third",
      label: "Tim Cook",
      data: { role: "CEO" },
      start: 0,
      end: 0.5,
    } as never);

    const gapPath = path.join(workDir, "gap.mov");
    await renderGraphicsOverlay({
      timeline: t,
      overlayPath: gapPath,
      serveUrl: await bundleFastVid(path.join(workDir, "bundle")),
    });

    const plane = await alphaPlaneAt(gapPath, 1.5, path.join(workDir, "gap.gray"));
    expect(coverage(plane).opaquePixels, "the overlay is not transparent where nothing was drawn").toBe(0);
  }, 900_000);
});
