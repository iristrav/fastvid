/**
 * RONDE 150 §5/§6 — Remotion renders the GRAPHICS LAYER, on a transparent background.
 *
 * ── The architecture, in one picture ─────────────────────────────────────────────────────────
 *
 *     ProjectTimeline (one document, §4)
 *         ├── VIDEO / VOICE / MUSIC / SFX / AMBIENT  → ffmpeg  → the picture and the mix
 *         └── GRAPHICS / TEXT / CAPTIONS             → Remotion → a transparent overlay
 *                                                              → ffmpeg composites the two
 *
 * §5 is "FFmpeg + Remotion", not "FFmpeg OF Remotion". Each engine does the job it is actually
 * better at: ffmpeg owns pixels, seeking, sidechain ducking and the tuned documentary grade;
 * a browser owns layout — a lower third with a role under a name, a counter that counts, text that
 * wraps — which the bundled ffmpeg-static cannot draw at all, having no `drawtext` filter.
 *
 * ── FINDING 1: the full Chrome binary does not work ──────────────────────────────────────────
 *
 * MEASURED, not assumed. Pointing Remotion at `chromium-1194/chrome-linux/chrome` fails with:
 *
 *     "Old Headless mode has been removed from the Chrome binary."
 *
 * Remotion drives the browser through the old headless protocol, which modern Chrome dropped.
 * `chrome-headless-shell` is the standalone implementation of exactly that mode, and pointing at
 * `chromium_headless_shell-1194/chrome-linux/headless_shell` renders first time.
 *
 * ── FINDING 2: Remotion downloads its own browser, and that download can be blocked ──────────
 *
 * With no `browserExecutable` it fetches from remotion.media, which this environment's egress proxy
 * refuses with a 403. That is not a bug — it is what a locked-down production network looks like
 * too. So the browser is RESOLVED from a list of known locations and, when none is found, the
 * render fails with a message naming the env var to set rather than with a network error four
 * layers down.
 *
 * ── OCTOBER 2026 — PNG frames, packed into the .mov without re-encoding ─────────────────────
 *
 * Measured on 4 cores, same composition and props: ProRes 4444 encoding was half the cost of the
 * whole layer — 9.1 frames/s with it, 21.4 frames/s writing the browser's PNG frames — and it
 * applied to every frame, because the captions are on screen for all of them (3600 of 3600 in the
 * 2-minute test), so rendering only the frames that carry a graphic would save nothing. The frames
 * are now written as PNG and stream-copied into the same .mov (codec png, rgba): lossless, alpha
 * intact, one file at the same path for every reader (the ink probe, the composite, the tests).
 * The section below explains the original choice; the container is unchanged, the codec is not.
 *
 * ── Why ProRes 4444 and not WebM ─────────────────────────────────────────────────────────────
 *
 * The overlay has to carry an alpha channel or there is nothing to composite. ProRes 4444 in a
 * .mov does that in `yuva444p10le`, is intra-frame so ffmpeg can seek it, and both ffmpeg builds in
 * this repo decode it. VP9-with-alpha would be a smaller file and a slower, lossier round trip for
 * a layer that is mostly empty pixels; the overlay is a render intermediate that is deleted after
 * compositing, so size is the wrong thing to optimise and fidelity is the right one.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { resolveFFmpegBin } from "./ffmpegBinary";

import type { ProjectTimeline } from "./projectTimeline";
import { captionTrack, graphicsTrack, textTrackOf } from "./projectTimeline";
import {
  formatRemotionProps,
  missingEditorialFields,
  timelineToRemotionProps,
  type RemotionGraphicsProps,
  type RemotionWordTiming,
} from "./remotionProps";
import {
  graphicIsRenderable,
  RENDERABLE_GRAPHICS as RENDERABLE_GRAPHIC_TYPES,
} from "./remotion/components/Graphics";

/* ═══════════════════════ the browser ═══════════════════════ */

/**
 * Where a usable headless shell might live, most specific first.
 *
 * `REMOTION_BROWSER_EXECUTABLE` is checked first so a deployment can name its own without a code
 * change — the same shape `FFMPEG_PATH` already has in this codebase.
 */
export function remotionBrowserCandidates(): string[] {
  return [
    process.env.REMOTION_BROWSER_EXECUTABLE,
    "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
    "/usr/bin/chrome-headless-shell",
    "/usr/bin/chromium-headless-shell",
  ].filter(Boolean) as string[];
}

export function resolveRemotionBrowser(): string | null {
  for (const candidate of remotionBrowserCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* an unreadable path is the same as an absent one */
    }
  }
  /**
   * A glob for the Playwright layout, whose version number changes with every image rebuild.
   * Hard-coding 1194 above and stopping there would make this break on the next base image.
   */
  try {
    const root = "/opt/pw-browsers";
    if (fs.existsSync(root)) {
      for (const dir of fs.readdirSync(root)) {
        if (!dir.startsWith("chromium_headless_shell")) continue;
        const p = path.join(root, dir, "chrome-linux", "headless_shell");
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export class RemotionUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(
      "REMOTION_BROWSER_NOT_AVAILABLE: no chrome-headless-shell was found. " +
        "Remotion needs the OLD headless mode, which the full Chrome binary no longer provides. " +
        "Set REMOTION_BROWSER_EXECUTABLE to a chrome-headless-shell binary, or allow " +
        "remotion.media through the egress proxy so Remotion can fetch its own. " +
        detail
    );
    this.name = "RemotionUnavailableError";
  }
}

/* ═══════════════════════ what the graphics layer is asked to draw ═══════════════════════ */

/**
 * Does this timeline have anything for Remotion to draw?
 *
 * Asked BEFORE bundling, because bundling and launching a browser is by far the most expensive
 * step in a render and a documentary with no cards and no burned-in captions needs neither. A
 * video that answers false renders exactly as it did before this round existed.
 */
export function hasGraphicsLayer(timeline: ProjectTimeline): boolean {
  return (
    graphicsTrack(timeline).some((g) => !g.disabled) ||
    textTrackOf(timeline, "TEXT").some((t) => !t.disabled) ||
    captionTrack(timeline).some((c) => !c.disabled)
  );
}

/**
 * Everything the plan asked for that this layer cannot execute.
 *
 * Computed from the PROPS rather than during rendering, so it is known before a single frame is
 * drawn and can be reported even when the render then fails for another reason. §34: never a
 * silent substitution, always the planner's original reason.
 *
 * §12 is the important case. A `map` is not in `RENDERABLE_GRAPHICS`, so it lands here — its
 * payload (normX, normY, the location name, the planner's reason) stays on the timeline for a real
 * map component to pick up later. What must never happen is the graphic being "handled" by drawing
 * the word "map" on screen, which is a visual lie about what the video is showing.
 */
export function remotionUnsupported(props: RemotionGraphicsProps): string[] {
  const out: string[] = [];
  for (const g of props.graphics) {
    /**
     * RONDE 155 — the SAME function the component uses to decide.
     *
     * This used to ask a narrower question (is the type known, and does it have a label), which
     * was right when every graphic was words on screen. A chart is not: it needs values, a map
     * needs a coordinate, a shape needs a path this build has. When the two questions drifted
     * apart, an empty bar chart with a label counted as drawn and appeared nowhere.
     */
    if (graphicIsRenderable(g.graphicType, g.data, g.label)) continue;
    const known = RENDERABLE_GRAPHIC_TYPES.has(g.graphicType);
    out.push(
      `unsupported_graphic ${g.graphicType} (${g.id})` +
        (known ? " — its payload has nothing to draw" : " — no component draws this type") +
        (g.reason ? ` — planner's reason: ${g.reason}` : "") +
        " — payload kept on the timeline, nothing drawn in its place"
    );
  }
  return out;
}

/* ═══════════════════════ the render ═══════════════════════ */

export type RemotionOverlayResult = {
  /** A .mov carrying an alpha channel, for ffmpeg to composite. Never a finished video. */
  overlayPath: string;
  durationInFrames: number;
  fps: number;
  widthPx: number;
  heightPx: number;
  textsDrawn: number;
  captionsDrawn: number;
  graphicsDrawn: number;
  /**
   * WHICH GRAPHICS, NOT HOW MANY — the two stages `graphicsLifecycle` could never reach.
   *
   * That module joins the plan to the renderer by the id `translateEdl` computes, and declares four
   * stages: PLANNED → TRANSLATED → RENDER_INPUT → DRAWN. It takes `inputIds` and `drawnIds` to make
   * the join. This result carried `graphicsDrawn: number` and nothing else, so no caller could
   * supply either list, and `RENDER_INPUT` and `DRAWN` were two declared stages with no possible
   * writer. Render 573's sibling published the consequence:
   *
   *     [Graphics] lifecycle planned=6 translated=5 renderInput=0 drawn=0
   *
   * Five graphics reaching the timeline and stopping there — not because the renderer refused them,
   * but because nothing ever asked it. The renderer holds both answers in `props.graphics` and threw
   * the ids away to keep a length.
   *
   * `graphicDrawnIds` is the same predicate `graphicsDrawn` counts, so the number and the list can
   * never disagree; it remains the renderer's own count and not a frame inspection, exactly as
   * `graphicsLifecycle` says. `graphicsOverlayInk` is still the only thing that reads pixels back.
   */
  graphicInputIds: string[];
  graphicDrawnIds: string[];
  /** §34 — everything the plan asked for that this layer did not draw, with the planner's reason. */
  skipped: string[];
  browserExecutable: string;
};

export type RemotionOverlayParams = {
  timeline: ProjectTimeline;
  /** Where to write the alpha .mov. A render intermediate; the caller deletes it after compositing. */
  overlayPath: string;
  words?: RemotionWordTiming[];
  /** Where the webpack bundle is cached between renders. */
  cacheDir?: string;
  onProgress?: (fraction: number) => void;
  /** Injected in tests so a bundle can be reused; production builds one per render. */
  serveUrl?: string;
};

/**
 * Build the webpack bundle Remotion serves the composition from.
 *
 * Separated so a caller can build once and render many times — bundling is by far the slowest part
 * of a first render and it does not depend on the timeline at all.
 */
export async function bundleFastVid(cacheDir?: string): Promise<string> {
  const { bundle } = await import("@remotion/bundler");
  return bundle({
    entryPoint: path.join(import.meta.dirname ?? __dirname, "remotion", "index.ts"),
    outDir: cacheDir,
  });
}

/**
 * Render the graphics layer as a transparent video.
 *
 * OCTOBER 2026 — the alpha now travels as the PNG frames' own RGBA channel, copied unchanged into
 * the .mov (pix_fmt rgba). The danger the old note named is the same one: a layer without alpha
 * still renders and composites as an opaque rectangle over the whole film. `imageFormat: "png"` is
 * what carries it — JPEG frames have no alpha — and the render test reads the pix_fmt back.
 */
/**
 * OCTOBER 2026 — the frames `renderFrames` wrote (`element-000.png`, …, zero-padded to one width),
 * stream-copied into a .mov in order: no decode, no encode, the pixels exactly as the browser drew
 * them. Throws when ffmpeg fails or the folder holds no frames, like the encoder it replaces.
 */
export async function packPngFramesIntoMov(framesDir: string, fps: number, outPath: string): Promise<void> {
  const frames = fs.readdirSync(framesDir).filter((f) => /^element-\d+\.png$/.test(f)).sort();
  if (frames.length === 0) throw new Error(`no overlay frames were written to ${framesDir}`);
  const digits = frames[0]!.match(/\d+/)![0].length;
  const first = Number(frames[0]!.match(/\d+/)![0]);
  await promisify(execFile)(
    resolveFFmpegBin(),
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", String(fps),
      "-start_number", String(first),
      "-i", path.join(framesDir, `element-%0${digits}d.png`),
      "-c:v", "copy",
      "-an",
      outPath,
    ],
    { maxBuffer: 1024 * 1024 * 16 }
  );
}

export async function renderGraphicsOverlay(
  params: RemotionOverlayParams
): Promise<RemotionOverlayResult> {
  const browserExecutable = resolveRemotionBrowser();
  if (!browserExecutable) {
    throw new RemotionUnavailableError(`tried: ${remotionBrowserCandidates().join(", ")}`);
  }

  const props = timelineToRemotionProps({ timeline: params.timeline, words: params.words });

  /**
   * §5 — the losslessness check runs on the REAL timeline, every render.
   *
   * A test proves the adapter was lossless for the cases someone thought of; this catches the
   * combination nobody tested, on the video where it actually happened.
   */
  const lost = missingEditorialFields(params.timeline, props);
  /**
   * RONDE 152 — a caption the layout engine could not place without an overlap is REPORTED here.
   *
   * It is still drawn: a crowded caption beats a missing one. What §152 forbids is the overlap
   * going unmentioned, and `unresolvedCollisions` names the caption and what it clashes with.
   */
  const skipped = [
    ...remotionUnsupported(props),
    ...props.unresolvedCollisions,
    ...lost.map((l) => `LOST: ${l}`),
  ];
  console.log(formatRemotionProps(props));

  const serveUrl = params.serveUrl ?? (await bundleFastVid(params.cacheDir));
  const { selectComposition, renderFrames } = await import("@remotion/renderer");
  const inputProps = props as unknown as Record<string, unknown>;

  const composition = await selectComposition({
    serveUrl,
    id: "FastVidGraphics",
    inputProps,
    browserExecutable,
  });

  /**
   * OCTOBER 2026 — the browser's own PNG frames (alpha included), then one lossless stream copy into
   * the .mov. See the header: ProRes encoding was half the layer's time on every frame.
   */
  const framesDir = `${params.overlayPath}.frames`;
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  try {
    await renderFrames({
      composition,
      serveUrl,
      imageFormat: "png",
      outputDir: framesDir,
      inputProps,
      browserExecutable,
      onStart: () => undefined,
      onFrameUpdate: (rendered) => params.onProgress?.(rendered / Math.max(1, composition.durationInFrames)),
    });
    await packPngFramesIntoMov(framesDir, composition.fps, params.overlayPath);
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }

  return {
    overlayPath: params.overlayPath,
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    widthPx: props.width,
    heightPx: props.height,
    textsDrawn: props.texts.length,
    captionsDrawn: props.captions.length,
    graphicsDrawn: props.graphics.filter((g) =>
      graphicIsRenderable(g.graphicType, g.data, g.label)
    ).length,
    /** Every graphic the props carried, and the subset the predicate passed — see the type's note. */
    graphicInputIds: props.graphics.map((g) => g.id),
    graphicDrawnIds: props.graphics
      .filter((g) => graphicIsRenderable(g.graphicType, g.data, g.label))
      .map((g) => g.id),
    skipped,
    browserExecutable,
  };
}
