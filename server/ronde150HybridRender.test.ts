/**
 * RONDE 150 §21 — the hybrid, proven end to end.
 *
 * The claim this round makes is "FFmpeg + Remotion, not FFmpeg OF Remotion": ffmpeg draws the
 * picture, Remotion draws the graphics on a transparent background, ffmpeg composites the two into
 * one MP4. That claim is only worth anything if a real video comes out, so the last describe block
 * renders one — real ffmpeg, real chrome-headless-shell, real ProRes 4444 with alpha, real
 * `overlay` filter — and then reads PIXELS back out of the result.
 *
 * It reads pixels rather than checking that a file exists because the interesting failure mode
 * here is silent: an overlay whose alpha channel was dropped renders fine, plays fine, looks
 * correct in any player showing it on black, and composites as an opaque rectangle that hides the
 * entire film. Only a pixel where the film should be showing through can tell the difference.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_TEXT_STYLE,
  emptyTimeline,
  type ProjectTimeline,
} from "./projectTimeline";
import {
  formatRemotionProps,
  missingEditorialFields,
  timelineToRemotionProps,
  toFrames,
} from "./remotionProps";
import {
  bundleFastVid,
  hasGraphicsLayer,
  remotionBrowserCandidates,
  remotionUnsupported,
  renderGraphicsOverlay,
  resolveRemotionBrowser,
  RemotionUnavailableError,
} from "./remotionRenderer";
import { RENDERABLE_GRAPHICS, CAPTION_CLEARANCE } from "./remotion/components/Graphics";
import { renderTimeline } from "./timelineRenderer";
import { RENDER_PHASES, progressForPhase } from "./renderJobs";
import { graphicsOverlayAvailable, productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

/* ═══════════════════════ fixtures ═══════════════════════ */

function timelineWith(
  overrides: {
    graphics?: Array<Record<string, unknown>>;
    captions?: Array<Record<string, unknown>>;
    texts?: Array<Record<string, unknown>>;
    durationSec?: number;
    widthPx?: number;
    heightPx?: number;
    fps?: number;
  } = {}
): ProjectTimeline {
  const t = emptyTimeline(1, {
    widthPx: overrides.widthPx ?? 1920,
    heightPx: overrides.heightPx ?? 1080,
    fps: overrides.fps ?? 24,
  });
  t.durationSec = overrides.durationSec ?? 2;
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS") track.graphics.push(...((overrides.graphics ?? []) as never[]));
    if (track.kind === "CAPTIONS") track.captions.push(...((overrides.captions ?? []) as never[]));
    if (track.kind === "TEXT") track.texts.push(...((overrides.texts ?? []) as never[]));
  }
  return t;
}

const LOWER_THIRD = {
  id: "g1",
  graphicType: "lower_third",
  label: "Tim Cook",
  data: { role: "CEO, Apple" },
  start: 0.2,
  end: 1.8,
};

const A_CAPTION = {
  id: "c1",
  text: "Apple introduced the Vision Pro.",
  start: 0.1,
  end: 1.9,
  style: DEFAULT_CAPTION_STYLE,
};

/* ═══════════════════════ §5 — the props are graphics-only ═══════════════════════ */

describe("RONDE 150 §5 — Remotion receives the graphics layer and nothing else", () => {
  it("carries every enabled caption, text and graphic", () => {
    const t = timelineWith({
      graphics: [LOWER_THIRD],
      captions: [A_CAPTION],
      texts: [{ id: "t1", text: "1984", start: 0, end: 1, style: DEFAULT_TEXT_STYLE }],
    });
    const props = timelineToRemotionProps({ timeline: t });
    expect(props.graphics.map((g) => g.id)).toEqual(["g1"]);
    expect(props.captions.map((c) => c.id)).toEqual(["c1"]);
    expect(props.texts.map((x) => x.id)).toEqual(["t1"]);
    expect(missingEditorialFields(t, props)).toEqual([]);
  });

  /**
   * §26, as a property of the SHAPE rather than of a helper someone has to remember to call.
   *
   * The props are serialised into a bundle a browser loads. An earlier design carried clips with
   * their media URLs and stripped credentials on the way through; this one has no field a URL
   * could travel in, which is a much harder thing to get wrong later.
   */
  it("has no field a media URL or credential could travel in", () => {
    const t = timelineWith({ graphics: [LOWER_THIRD], captions: [A_CAPTION] });
    const props = timelineToRemotionProps({ timeline: t });
    const keys = Object.keys(props);
    expect(keys).not.toContain("clips");
    expect(keys).not.toContain("audio");
    const asText = JSON.stringify(props);
    expect(asText).not.toMatch(/https?:\/\//);
    expect(asText).not.toContain("file://");
  });

  it("is exactly as long as the timeline, not as long as its last caption", () => {
    const t = timelineWith({ captions: [A_CAPTION], durationSec: 30 });
    const props = timelineToRemotionProps({ timeline: t });
    // The overlay must cover the whole picture; ending at the last caption leaves the tail bare.
    expect(props.durationInFrames).toBe(toFrames(30, 24));
  });

  it("converts seconds to frames and leaves seconds on the timeline", () => {
    const t = timelineWith({ captions: [{ ...A_CAPTION, start: 1, end: 2 }] });
    const props = timelineToRemotionProps({ timeline: t, words: [] });
    expect(props.captions[0]!.fromFrame).toBe(24);
    expect(props.captions[0]!.durationInFrames).toBe(24);
    expect(t.tracks.find((x) => x.kind === "CAPTIONS")).toBeDefined();
  });

  it("passes the planner's graphic payload through untouched", () => {
    const t = timelineWith({
      graphics: [{ ...LOWER_THIRD, data: { role: "CEO, Apple", normX: 0.3, normY: 0.7 } }],
    });
    const props = timelineToRemotionProps({ timeline: t });
    expect(props.graphics[0]!.data).toEqual({ role: "CEO, Apple", normX: 0.3, normY: 0.7 });
  });

  it("leaves disabled elements out, and does not report them as lost", () => {
    const t = timelineWith({
      graphics: [LOWER_THIRD, { ...LOWER_THIRD, id: "g2", disabled: true }],
    });
    const props = timelineToRemotionProps({ timeline: t });
    expect(props.graphics.map((g) => g.id)).toEqual(["g1"]);
    expect(missingEditorialFields(t, props)).toEqual([]);
  });

  it("missingEditorialFields NAMES a loss rather than only counting one", () => {
    const t = timelineWith({ graphics: [LOWER_THIRD], captions: [A_CAPTION] });
    const props = timelineToRemotionProps({ timeline: t });
    const mutilated = { ...props, captions: [], graphics: props.graphics.map((g) => ({ ...g, label: null })) };
    const lost = missingEditorialFields(t, mutilated);
    expect(lost.join(" ")).toContain("c1");
    expect(lost.join(" ")).toContain("g1");
  });

  it("the log line has counts and no payload", () => {
    const t = timelineWith({ graphics: [LOWER_THIRD], captions: [A_CAPTION] });
    const line = formatRemotionProps(timelineToRemotionProps({ timeline: t }));
    expect(line).toContain("[RemotionGraphics]");
    expect(line).toContain("graphics=1");
    expect(line).toContain("captions=1");
    expect(line).not.toContain("Tim Cook");
    expect(line).not.toMatch(/https?:/);
  });
});

/* ═══════════════════════ §12 — a map is never faked ═══════════════════════ */

describe("RONDE 150 §12 — an undrawable graphic is reported, never substituted", () => {
  it("a map is not in the renderable set — deliberately", () => {
    expect(RENDERABLE_GRAPHICS.has("map")).toBe(false);
    expect(RENDERABLE_GRAPHICS.has("route")).toBe(false);
    expect(RENDERABLE_GRAPHICS.has("lower_third")).toBe(true);
  });

  it("reports a map with the planner's own reason, and keeps its payload", () => {
    const t = timelineWith({
      graphics: [
        {
          id: "m1",
          graphicType: "map",
          label: "Cupertino",
          data: { normX: 0.31, normY: 0.44 },
          start: 0,
          end: 2,
          reason: "the narration names a place the viewer cannot place",
        },
      ],
    });
    const props = timelineToRemotionProps({ timeline: t });
    const unsupported = remotionUnsupported(props);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("unsupported_graphic map");
    expect(unsupported[0]).toContain("the narration names a place");
    // §12: the coordinates survive, so a real map component can be dropped in later.
    expect(props.graphics[0]!.data).toEqual({ normX: 0.31, normY: 0.44 });
  });

  it("reports a card whose payload has no words, rather than drawing its type name", () => {
    const t = timelineWith({
      graphics: [{ id: "g9", graphicType: "location_card", label: "", data: {}, start: 0, end: 1 }],
    });
    const unsupported = remotionUnsupported(timelineToRemotionProps({ timeline: t }));
    expect(unsupported[0]).toContain("no text in its payload");
    // The failure §12 names by hand: never the word "location_card" on screen.
    expect(unsupported[0]).not.toMatch(/drawn as/);
  });

  it("says nothing about a graphic it can draw", () => {
    const t = timelineWith({ graphics: [LOWER_THIRD] });
    expect(remotionUnsupported(timelineToRemotionProps({ timeline: t }))).toEqual([]);
  });
});

/* ═══════════════════════ when the layer is worth its cost ═══════════════════════ */

describe("RONDE 150 — the overlay is only rendered when it is worth it", () => {
  it("says no for a timeline with nothing to draw", () => {
    expect(hasGraphicsLayer(timelineWith())).toBe(false);
  });

  it("says yes for a caption, a text or a graphic alone", () => {
    expect(hasGraphicsLayer(timelineWith({ captions: [A_CAPTION] }))).toBe(true);
    expect(hasGraphicsLayer(timelineWith({ graphics: [LOWER_THIRD] }))).toBe(true);
    expect(
      hasGraphicsLayer(
        timelineWith({ texts: [{ id: "t1", text: "1984", start: 0, end: 1, style: DEFAULT_TEXT_STYLE }] })
      )
    ).toBe(true);
  });

  it("says no when every element is disabled", () => {
    expect(hasGraphicsLayer(timelineWith({ graphics: [{ ...LOWER_THIRD, disabled: true }] }))).toBe(
      false
    );
  });

  it("names the env var to set when no browser is found", () => {
    const err = new RemotionUnavailableError("tried: nowhere");
    expect(err.message).toContain("REMOTION_BROWSER_EXECUTABLE");
    expect(err.message).toContain("chrome-headless-shell");
    expect(remotionBrowserCandidates().length).toBeGreaterThan(0);
  });

  /**
   * The wiring returns null WITHOUT touching a browser when there is nothing to draw. If it did
   * not, every plain documentary would pay for a webpack bundle to render an empty layer.
   */
  it("does not reach for a browser when the timeline has no graphics layer", async () => {
    const overlay = productionGraphicsOverlay({ workDir: "/nonexistent-on-purpose" });
    await expect(overlay(timelineWith())).resolves.toBeNull();
  });

  it("returns null rather than throwing when no browser is available", async () => {
    if (graphicsOverlayAvailable()) return; // this environment has one; the hybrid block covers it
    const overlay = productionGraphicsOverlay({ workDir: "/nonexistent-on-purpose" });
    await expect(overlay(timelineWith({ captions: [A_CAPTION] }))).resolves.toBeNull();
  });
});

/* ═══════════════════════ §18 — the render job's phases ═══════════════════════ */

describe("RONDE 150 §18 — compositing is a phase of its own", () => {
  it("sits between rendering and uploading, where it actually happens", () => {
    const i = RENDER_PHASES.indexOf("compositing");
    expect(i).toBeGreaterThan(RENDER_PHASES.indexOf("rendering"));
    expect(i).toBeLessThan(RENDER_PHASES.indexOf("uploading"));
  });

  it("moves the progress bar forward, and completed is still 100", () => {
    expect(progressForPhase("compositing")).toBeGreaterThan(progressForPhase("rendering"));
    expect(progressForPhase("compositing")).toBeLessThan(100);
    expect(progressForPhase("completed")).toBe(100);
  });

  /**
   * §18 lists an "audio" phase too, and its absence is a decision rather than an omission: mixing
   * happens inside `renderTimeline` with no boundary the worker can observe, so a phase for it
   * would move the progress bar on a guess. This test states that so the next reader does not
   * "fix" it by adding one.
   */
  it("has no phase the worker cannot actually observe", () => {
    expect(RENDER_PHASES).not.toContain("audio");
  });
});

/* ═══════════════════════ §21 — the hybrid, with real media ═══════════════════════ */

const browser = resolveRemotionBrowser();
const describeHybrid = browser ? describe : describe.skip;

describeHybrid("RONDE 150 §5 — FFmpeg picture + Remotion graphics → one MP4", () => {
  let workDir: string;
  let serveUrl: string;
  let sourceClip: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "r150-hybrid-"));
    /**
     * A solid RED source clip, so a pixel read back from the finished video answers a real
     * question: red means the film is showing through, black means the overlay covered it.
     */
    sourceClip = path.join(workDir, "source.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:d=3:r=24",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceClip,
    ]);
    serveUrl = await bundleFastVid(path.join(workDir, "bundle"));
  }, 300_000);

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("renders a transparent overlay that really carries an alpha channel", async () => {
    const t = timelineWith({
      graphics: [LOWER_THIRD],
      captions: [A_CAPTION],
      widthPx: 640,
      heightPx: 360,
    });
    const overlayPath = path.join(workDir, "alpha.mov");
    const result = await renderGraphicsOverlay({ timeline: t, overlayPath, serveUrl });

    expect(fs.existsSync(overlayPath)).toBe(true);
    expect(result.graphicsDrawn).toBe(1);
    expect(result.captionsDrawn).toBe(1);
    expect(result.skipped).toEqual([]);

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt,width,height", "-of", "default=nw=1", overlayPath,
    ]);
    /**
     * The `a` in `yuva…` is the whole point. Without it the file still plays, still looks right on
     * black, and composites as an opaque rectangle over the film.
     */
    expect(stdout).toMatch(/pix_fmt=yuva/);
    expect(stdout).toContain("width=640");
    expect(stdout).toContain("height=360");
  }, 300_000);

  it("composites onto the ffmpeg picture — the film shows through where nothing was drawn", async () => {
    const timeline = timelineWith({
      graphics: [LOWER_THIRD],
      captions: [A_CAPTION],
      widthPx: 640,
      heightPx: 360,
      durationSec: 2,
    });
    const videoTrackRef = timeline.tracks.find((x) => x.kind === "VIDEO");
    if (videoTrackRef && videoTrackRef.kind === "VIDEO") {
      videoTrackRef.clips.push({
        id: "vc1",
        kind: "video",
        source: { provider: "pexels", providerAssetId: "1" },
        sourceIn: 0,
        sourceOut: 2,
        timelineStart: 0,
        timelineEnd: 2,
        motion: "none",
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
      } as never);
    }

    const renderDir = path.join(workDir, "render");
    const outputPath = path.join(workDir, "hybrid.mp4");
    const result = await renderTimeline({
      timeline,
      workDir: renderDir,
      outputPath,
      resolveMedia: async () => sourceClip,
      graphicsOverlay: async (t) => {
        const overlayPath = path.join(renderDir, "overlay.mov");
        const r = await renderGraphicsOverlay({ timeline: t, overlayPath, serveUrl });
        return { overlayPath: r.overlayPath, skipped: r.skipped };
      },
    });

    /** The report must say Remotion drew the graphics — not leave the reader to guess. */
    expect(result.graphicsRenderer).toBe("remotion");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(2048);

    /**
     * The pixel that proves it. The top-left corner is a part of the frame no graphic touches, so
     * in the FINISHED video it must still be the source clip's red. A dropped alpha channel makes
     * it black, and every other assertion in this test would still pass.
     */
    const corner = path.join(workDir, "corner.raw");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-i", outputPath,
      "-vf", "select=eq(n\\,24),crop=16:16:0:0,scale=1:1",
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", corner,
    ]);
    const [r, g, b] = fs.readFileSync(corner);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  }, 300_000);

  it("falls back to libass when the overlay cannot be made, and SAYS so", async () => {
    const timeline = timelineWith({ captions: [A_CAPTION], widthPx: 640, heightPx: 360 });
    const videoTrackRef = timeline.tracks.find((x) => x.kind === "VIDEO");
    if (videoTrackRef && videoTrackRef.kind === "VIDEO") {
      videoTrackRef.clips.push({
        id: "vc1",
        kind: "video",
        source: { provider: "pexels", providerAssetId: "1" },
        sourceIn: 0,
        sourceOut: 2,
        timelineStart: 0,
        timelineEnd: 2,
        motion: "none",
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
      } as never);
    }

    const result = await renderTimeline({
      timeline,
      workDir: path.join(workDir, "fallback"),
      outputPath: path.join(workDir, "fallback.mp4"),
      resolveMedia: async () => sourceClip,
      graphicsOverlay: async () => {
        throw new RemotionUnavailableError("no browser in this test");
      },
    });

    // §2: a fallback is allowed. A SILENT fallback is not.
    expect(result.graphicsRenderer).toBe("ffmpeg_ass");
    expect(result.skipped.join(" ")).toContain("fell back to the libass route");
    expect(result.captionsDrawn).toBe(1);
    expect(fs.existsSync(result.outputPath)).toBe(true);
  }, 300_000);

  /**
   * The clearance is a layout rule, so the honest test of it is a rendered pixel, not the constant.
   * The band between the caption and the lifted lower third must contain neither.
   */
  it("lifts a lower third clear of the caption instead of striking through it", async () => {
    const t = timelineWith({
      graphics: [LOWER_THIRD],
      captions: [A_CAPTION],
      widthPx: 640,
      heightPx: 360,
    });
    const lifted = path.join(workDir, "lifted.mov");
    await renderGraphicsOverlay({ timeline: t, overlayPath: lifted, serveUrl });

    const alone = timelineWith({ graphics: [LOWER_THIRD], widthPx: 640, heightPx: 360 });
    const unlifted = path.join(workDir, "unlifted.mov");
    await renderGraphicsOverlay({ timeline: alone, overlayPath: unlifted, serveUrl });

    /**
     * Compare where the card's ink actually is in the two renders. With a caption present it must
     * sit HIGHER; with no caption it must stay exactly where the planner put it.
     */
    const inkRow = async (file: string): Promise<number> => {
      const raw = path.join(workDir, `${path.basename(file)}.gray`);
      await execFileAsync(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-i", file,
        // One column through the left edge, where the card is and the centred caption is not.
        "-vf", "select=eq(n\\,24),crop=40:360:60:0,scale=1:360",
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw,
      ]);
      const rows = fs.readFileSync(raw);
      for (let y = 0; y < rows.length; y++) if (rows[y]! > 24) return y;
      return rows.length;
    };

    const withCaption = await inkRow(lifted);
    const without = await inkRow(unlifted);
    expect(without).toBeLessThan(360);
    expect(withCaption).toBeLessThan(without);
    expect(without - withCaption).toBeGreaterThan(Math.round(360 * CAPTION_CLEARANCE * 0.6));
  }, 300_000);
});
