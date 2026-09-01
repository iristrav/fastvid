/**
 * GRAPHICS — the planner's OWN output becomes real pixels.
 *
 * ── The link no existing test covers ────────────────────────────────────────────────────────
 *
 * R160 renders every member of `RENDERABLE_GRAPHICS` and measures real alpha ink, which proves the
 * COMPONENTS draw. It does that from a hand-written payload table, chosen to satisfy each
 * component's own requirement — so it proves the renderer, not the planner.
 *
 * R207 proves the planner's types reach a component, by name.
 *
 * Neither proves the thing that actually ships: that a payload `planMotionGraphics` PRODUCES, from
 * a beat's intent, survives translation and puts ink on a frame. A planner could emit a perfectly
 * reasonable-looking `{ name, label }` that the component ignores, and both existing tests would
 * stay green while the render came out empty. That is exactly the shape of the R178 defect —
 * `timeline` graphics were planned for months and drew nothing, because the words were nested one
 * level deeper than `graphicLabel` looked.
 *
 * So this file starts at a beat, runs the real planner, translates with the real EDL translation,
 * renders with real Remotion, and reads the alpha plane back. Nothing here writes a payload.
 *
 * ── Why the four new types specifically ─────────────────────────────────────────────────────
 *
 * They were added this round, and a type added on the same day it is tested is the one most likely
 * to have a payload the component cannot read.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planMotionGraphics } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { graphicLabel, rendererGraphicType } from "./edlToTimeline";
import { emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { bundleFastVid, renderGraphicsOverlay, resolveRemotionBrowser } from "./remotionRenderer";
import { graphicIsRenderable } from "./remotion/components/Graphics";
import { resolveFFmpegBin } from "./ffmpegBinary";
import type { VisualIntent } from "./visualMatchingV2/types";

const execFileAsync = promisify(execFile);

const SLOT_SEC = 1;
const FPS = 12;
const WIDTH = 640;
const HEIGHT = 360;

function intent(over: Partial<VisualIntent>): VisualIntent {
  return {
    beatId: "s0b0", spokenText: "", visualSubject: "", visualAction: "", visualLocation: "",
    visualTime: "", historicalContext: "", emotion: "neutral", visualDescription: "",
    primaryKeyword: "", secondaryKeyword: "", negativeKeywords: [], secondaryVisualSubjects: [],
    objects: [], brands: [], companies: [], people: [], countries: [], events: [],
    intentHash: "h", cacheHit: false, ...over,
  } as VisualIntent;
}

/**
 * One beat per type, each written so that ONLY the type under test is planned — the planner's own
 * guards (a date card needs no timeline to have fired, a location card needs the map not to know
 * the place) are what make that possible, and relying on them here means a guard that breaks shows
 * up as a wrong type rather than as a silent extra graphic.
 */
const BEATS: ReadonlyArray<{ type: string; intent: VisualIntent; mustContain: string }> = [
  {
    type: "lower_third",
    intent: intent({ people: ["Elon Musk"], companies: ["SpaceX"], spokenText: "Elon Musk founded SpaceX." }),
    mustContain: "Elon Musk",
  },
  {
    type: "date_card",
    intent: intent({ visualTime: "2002", spokenText: "The company was founded in 2002." }),
    mustContain: "2002",
  },
  {
    type: "location_card",
    intent: intent({ visualLocation: "Cape Canaveral", spokenText: "The launch site at Cape Canaveral." }),
    mustContain: "Cape Canaveral",
  },
  {
    type: "quote",
    intent: intent({ spokenText: 'Kennedy said "we choose to go to the Moon in this decade".' }),
    mustContain: "we choose to go to the Moon",
  },
];

/** The planner's instruction for one beat, narrowed to the type that beat is testing. */
function plannedFor(entry: (typeof BEATS)[number]) {
  const planned = planMotionGraphics(entry.intent, undefined, 0, 4);
  const found = planned.find((g) => g.graphicType === entry.type);
  expect(found, `the planner produced no ${entry.type} for its own beat — got ${planned.map((p) => p.graphicType).join(", ") || "nothing"}`).toBeTruthy();
  return found!;
}

/* ═══════════════════════ before rendering: the payload is readable ═══════════════════════ */

describe("GRAPHICS — the planner's payload is one the component can read", () => {
  /**
   * The R178 check, applied to the planner's OWN data rather than a fixture. `graphicIsRenderable`
   * is the renderer's own answer, so a payload that fails here is a graphic the render would drop.
   */
  for (const entry of BEATS) {
    it(`${entry.type}: the planner's payload is renderable`, () => {
      const g = plannedFor(entry);
      const type = rendererGraphicType(g.graphicType);
      const label = graphicLabel(type, g.data);
      expect(
        graphicIsRenderable(type, g.data, label ?? null),
        `${entry.type} payload ${JSON.stringify(g.data)} is not drawable`
      ).toBe(true);
    });

    /** And the words on screen are the BEAT's words, not a default the component fell back to. */
    it(`${entry.type}: carries the beat's own words`, () => {
      const g = plannedFor(entry);
      const label = graphicLabel(rendererGraphicType(g.graphicType), g.data);
      expect(`${label ?? ""} ${JSON.stringify(g.data)}`).toContain(entry.mustContain);
    });
  }
});

/* ═══════════════════════ the render itself ═══════════════════════ */

async function alphaPlaneAt(overlayPath: string, atSec: number, outPath: string): Promise<Buffer> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", atSec.toFixed(3), "-i", overlayPath,
    "-vf", "alphaextract", "-frames:v", "1", "-pix_fmt", "gray", outPath,
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

/** One slot per type, built ENTIRELY from planner output. */
function timelineFromPlanner(): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = BEATS.length * SLOT_SEC;
  const track = t.tracks.find((x) => x.kind === "GRAPHICS");
  if (track?.kind !== "GRAPHICS") throw new Error("no GRAPHICS track");
  BEATS.forEach((entry, i) => {
    const g = plannedFor(entry);
    const type = rendererGraphicType(g.graphicType);
    track.graphics.push({
      id: `gfx-${i}`,
      graphicType: type,
      /** The planner's payload, verbatim. Nothing added to make it render. */
      data: g.data,
      start: i * SLOT_SEC,
      end: (i + 1) * SLOT_SEC,
      label: graphicLabel(type, g.data),
      reason: g.reason,
    });
  });
  return t;
}

const browser = resolveRemotionBrowser();
const describeRender = browser ? describe : describe.skip;

describeRender("GRAPHICS — planner output puts real ink on a real frame", () => {
  let workDir = "";
  let overlayPath = "";
  let drawn: { graphicsDrawn: number; skipped: string[] };

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-planner-"));
    const serveUrl = await bundleFastVid(path.join(workDir, "bundle"));
    overlayPath = path.join(workDir, "planner-graphics.mov");
    const result = await renderGraphicsOverlay({
      timeline: timelineFromPlanner(),
      overlayPath,
      serveUrl,
    });
    drawn = { graphicsDrawn: result.graphicsDrawn, skipped: result.skipped };
  }, 900_000);

  afterAll(() => {
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it("the renderer skipped none of the planner's graphics", () => {
    expect(drawn.skipped, `skipped: ${drawn.skipped.join(", ")}`).toEqual([]);
    expect(drawn.graphicsDrawn).toBe(BEATS.length);
  });

  it("produced a real alpha overlay", async () => {
    expect(fs.existsSync(overlayPath)).toBe(true);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt,width,height", "-of", "default=nw=1", overlayPath,
    ]);
    expect(stdout).toMatch(/pix_fmt=yuva/);
    expect(stdout).toContain(`width=${WIDTH}`);
  });

  /**
   * The measurement. A frame from the middle of each type's own slot — past the entrance animation
   * and before the exit — with the alpha plane read back in full.
   *
   * Reported as one list rather than one assertion per type: when a component breaks it usually
   * breaks for a family at once, and seeing all four is the difference between "the card component
   * is gone" and "quote failed".
   */
  it("every type the planner asked for has visible ink", async () => {
    const empty: string[] = [];
    const measured: string[] = [];
    for (let i = 0; i < BEATS.length; i++) {
      const at = i * SLOT_SEC + SLOT_SEC / 2;
      const plane = await alphaPlaneAt(overlayPath, at, path.join(workDir, `a${i}.pgm`));
      const { maxAlpha, opaquePixels } = coverage(plane);
      measured.push(`${BEATS[i]!.type}: maxAlpha=${maxAlpha} opaque=${opaquePixels}`);
      /** A card that draws covers far more than a few stray antialiased pixels. */
      if (maxAlpha < 32 || opaquePixels < 200) empty.push(BEATS[i]!.type);
    }
    expect(empty, `blank at render time — ${measured.join(" | ")}`).toEqual([]);
  }, 300_000);
}, 900_000);
