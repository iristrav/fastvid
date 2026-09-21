/**
 * AN EFFECT MAY NOT RESIZE THE FRAME — RONDE 601.
 *
 * ── The two pixels that cost render 596 its delivery ────────────────────────────────────────
 *
 *     [Parsed_xfade_6] First input link main parameters (size 1920x1078) do not match the
 *       corresponding second input link xfade parameters (size 1920x1080)
 *     Error reinitializing filters!
 *     Failed to inject frame into filter network: Invalid argument
 *
 *     [DeliveryGate] DELIVERY_GATE_FAIL video=596 AUTHORITATIVE_RENDER_FAILED
 *
 * The `letterbox` effect multiplied the height by 0.836 and divided it back. The crop in between
 * is a whole number of rows, so the trip did not return:
 *
 *     crop : 1080 x 0.836 = 902.88  -> 902
 *     pad  : 902 / 0.836  = 1078.94 -> 1078
 *
 * A shot with the effect came out two pixels shorter than a shot without it. Nothing notices until
 * those two meet in a transition — and then there is no degraded picture, there is no file.
 *
 * ── Why the existing tests could not have caught it ─────────────────────────────────────────
 *
 * Every effect in this codebase was proven by reading its FILTER STRING: "the chain contains
 * `crop=iw:ih*0.836`". It did. The string was exactly what its author intended and the arithmetic
 * inside it was wrong, which is a distinction no string assertion can make. RONDE 160's file says
 * this in its own header and measures pixels for the same reason; this measures GEOMETRY, which is
 * the property that ends a render rather than spoiling a frame.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 * A clip's filter chain may change every pixel in the frame. It may not change the size of the
 * frame. Not the effects, not the camera, not the transforms — the renderer normalises geometry at
 * the START of the chain and the joiners demand it at the END, so anything in between that moves
 * it has broken the render for every clip it is not applied to.
 *
 * Stated over the whole vocabulary rather than over letterbox, because the defect is not about
 * letterbox: `scanlines` halves the height and doubles it back by the same kind of arithmetic, and
 * the next effect someone writes will reach for crop-and-restore too. This asks all of them, by
 * rendering, so the answer cannot be a reading.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { buildVideoFilter, effectChain } from "./timelineFilters";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/**
 * 320x180 rather than 1920x1080: the arithmetic fails identically and a frame renders in a
 * fraction of the time. The old letterbox loses two rows here too — 180 x 0.836 = 150.48 -> 150,
 * and 150 / 0.836 = 179.42 -> 179 — which the first test below measures rather than assumes.
 */
const FMT = { widthPx: 320, heightPx: 180, fps: 24 } as const;

/** The chain `letterbox` carried until this round, kept verbatim as the thing being guarded against. */
const LETTERBOX_BEFORE_RONDE_601 =
  "crop=iw:ih*0.836:0:ih*0.082,pad=iw:ih/0.836:0:(oh-ih)/2:color=black";

/**
 * Every effectType `effectChain` answers. Listed rather than imported from `RENDERABLE_EFFECTS`,
 * which holds only the seven the EDL may request — `buildVideoFilter` executes ANY effect the
 * chain builder has a filter for, so the honest set to guard is the one it can execute.
 */
const EVERY_EXECUTABLE_EFFECT = [
  "film_grain", "noise", "vignette", "letterbox", "glow", "bloom", "chromatic_aberration",
  "blur", "sharpen", "exposure", "contrast", "saturation", "temperature", "tint",
  "monochrome", "sepia", "scanlines",
] as const;

let dir = "";
let source = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r601-"));
  source = path.join(dir, "src.mp4");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "smptebars=size=640x360:rate=24:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", source,
  ]);
}, 300_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** The size ffmpeg actually produces for a filter chain — the measurement this file is built on. */
async function renderedSize(vf: string, tag: string): Promise<{ w: number; h: number }> {
  const out = path.join(dir, `${tag.replace(/\W+/g, "_")}.mp4`);
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", source, "-vf", vf, "-frames:v", "1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
  ]);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", out,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number) as [number, number];
  return { w, h };
}

function clip(over: Partial<TimelineVideoClip> & { id: string }): TimelineVideoClip {
  return {
    kind: "video",
    source: { provider: "pexels", providerAssetId: over.id },
    sourceIn: 0,
    sourceOut: 2,
    timelineStart: 0,
    timelineEnd: 2,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    ...over,
  } as TimelineVideoClip;
}

/* ═══════════ §1 — the defect, reproduced ═══════════ */

describe("§1 — the chain that ended render 596", () => {
  it("THE DEFECT: the old letterbox does not give back the height it was handed", async () => {
    const base = buildVideoFilter(clip({ id: "plain" }), FMT, 2);
    const size = await renderedSize(`${base},${LETTERBOX_BEFORE_RONDE_601}`, "old-letterbox");
    expect(size.w, "the width was never the problem").toBe(FMT.widthPx);
    /**
     * HOW MUCH it loses is not a constant, which is part of why this went unseen: the shortfall
     * depends on the frame's own height and then on yuv420p, which cannot store an odd one.
     * 1080 comes back as 1078 in production; 180 comes back as 178 here, because 150 / 0.836 =
     * 179.42 rounds to 179 and the encode then drops it to the next even row. What matters is the
     * inequality — a frame that is not the frame it started as cannot be joined to one that is.
     */
    expect(size.h, "the round trip through 0.836 did not return").toBeLessThan(FMT.heightPx);
  }, 300_000);

  it("and a plain clip beside it is the full height — which is the whole failure", async () => {
    const plain = await renderedSize(buildVideoFilter(clip({ id: "plain" }), FMT, 2), "plain");
    expect(plain).toEqual({ w: FMT.widthPx, h: FMT.heightPx });
  }, 300_000);

  it("THE REPAIR: the letterbox now leaves the frame exactly as it found it", async () => {
    const vf = buildVideoFilter(
      clip({ id: "lb", effects: [{ effectType: "letterbox", intensity: 1 }] }),
      FMT,
      2
    );
    expect(await renderedSize(vf, "new-letterbox")).toEqual({ w: FMT.widthPx, h: FMT.heightPx });
  }, 300_000);

  it("it paints bars instead of cropping, so no arithmetic is left that could round", () => {
    const chain = effectChain({ effectType: "letterbox", intensity: 1 } as never)!;
    expect(chain).toContain("drawbox");
    expect(chain, "a crop-and-restore is the shape that failed").not.toContain("crop=");
    expect(chain, "a pad back to a re-derived height is the other half of it").not.toContain("pad=");
  });
});

/* ═══════════ §2 — the rule, over the whole vocabulary ═══════════ */

describe("§2 — no effect this renderer can execute changes the frame's size", () => {
  for (const effectType of EVERY_EXECUTABLE_EFFECT) {
    /**
     * Both ends of the intensity range: an effect whose geometry depends on `intensity` would pass
     * at one and fail at the other, and a guard that only asks the middle would not know.
     */
    for (const intensity of [0.15, 1]) {
      it(`${effectType} @ ${intensity}`, async () => {
        const vf = buildVideoFilter(
          clip({ id: effectType, effects: [{ effectType, intensity } as never] }),
          FMT,
          2
        );
        expect(await renderedSize(vf, `${effectType}-${intensity}`)).toEqual({
          w: FMT.widthPx,
          h: FMT.heightPx,
        });
      }, 300_000);
    }
  }

  it("nor does the camera", async () => {
    const vf = buildVideoFilter(
      clip({ id: "cam", camera: { startScale: 1, endScale: 1.18, startX: 0.4, endX: 0.6 } as never }),
      FMT,
      2
    );
    expect(await renderedSize(vf, "camera")).toEqual({ w: FMT.widthPx, h: FMT.heightPx });
  }, 300_000);

  it("nor do the transforms, in either direction", async () => {
    const cases: Array<[string, Partial<TimelineVideoClip>]> = [
      ["contain", { transform: { fit: "contain" } as never }],
      ["cover", { transform: { fit: "cover" } as never }],
      ["crop", { transform: { fit: "crop", crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 } } as never }],
      ["scale-up", { transform: { fit: "cover", scale: 1.35 } as never }],
      ["scale-down", { transform: { fit: "cover", scale: 0.62 } as never }],
      ["opacity", { transform: { fit: "cover", opacity: 0.5 } as never }],
    ];
    for (const [name, over] of cases) {
      const vf = buildVideoFilter(clip({ id: name, ...over }), FMT, 2);
      expect(await renderedSize(vf, `t-${name}`), name).toEqual({
        w: FMT.widthPx,
        h: FMT.heightPx,
      });
    }
  }, 300_000);

  it("and stacking several of them still does not", async () => {
    const vf = buildVideoFilter(
      clip({
        id: "stack",
        transform: { fit: "cover", scale: 0.8 } as never,
        camera: { startScale: 1, endScale: 1.1 } as never,
        effects: [
          { effectType: "letterbox", intensity: 1 },
          { effectType: "scanlines", intensity: 0.6 },
          { effectType: "glow", intensity: 0.4 },
        ] as never,
      }),
      FMT,
      2
    );
    expect(await renderedSize(vf, "stack")).toEqual({ w: FMT.widthPx, h: FMT.heightPx });
  }, 300_000);
});

/* ═══════════ §3 — render 596's exact shape, end to end ═══════════ */

describe("§3 — a shot with an effect can be dissolved into one without it", () => {
  it("THE PRODUCTION FAILURE: letterbox, then a dissolve into a plain shot, delivers a file", async () => {
    /**
     * This is the combination render 596 died on, and the one no test had: the effect on SOME
     * shots, absent on others, with a transition between exactly those two. A single-clip render
     * cannot see it, and a render that grades every clip alike cannot either.
     */
    const timeline: ProjectTimeline = emptyTimeline(1, {
      widthPx: FMT.widthPx,
      heightPx: FMT.heightPx,
      fps: FMT.fps,
    });
    timeline.durationSec = 4;
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind !== "VIDEO") throw new Error("no VIDEO track");
    track.clips.push(
      clip({
        id: "with-letterbox",
        timelineStart: 0,
        timelineEnd: 2,
        effects: [{ effectType: "letterbox", intensity: 1 }],
      }),
      clip({
        id: "without",
        timelineStart: 2,
        timelineEnd: 4,
        sourceIn: 0.8,
        sourceOut: 2.8,
        transitionIn: "dissolve",
        transitionInSec: 0.4,
      } as never)
    );

    const outputPath = path.join(dir, "e2e.mp4");
    const result = await renderTimeline({
      timeline,
      workDir: path.join(dir, "e2e"),
      outputPath,
      resolveMedia: async () => source,
    });

    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath), "the render produced no file at all").toBe(true);
    expect(fs.statSync(outputPath).size, "a zero-byte file is the failure this guards").toBeGreaterThan(1024);

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", outputPath,
    ]);
    expect(stdout.trim()).toBe(`${FMT.widthPx}x${FMT.heightPx}`);
  }, 600_000);
});
