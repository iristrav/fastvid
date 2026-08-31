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
 * ── Why ProRes 4444 and not WebM ─────────────────────────────────────────────────────────────
 *
 * The overlay has to carry an alpha channel or there is nothing to composite. ProRes 4444 in a
 * .mov does that in `yuva444p10le`, is intra-frame so ffmpeg can seek it, and both ffmpeg builds in
 * this repo decode it. VP9-with-alpha would be a smaller file and a slower, lossier round trip for
 * a layer that is mostly empty pixels; the overlay is a render intermediate that is deleted after
 * compositing, so size is the wrong thing to optimise and fidelity is the right one.
 */
import * as fs from "fs";
import * as path from "path";

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
 * The four settings below are ONE decision, not four, and changing any of them alone breaks
 * compositing:
 *
 *   codec "prores" + proResProfile "4444"  the only ProRes profile with an alpha channel
 *   pixelFormat "yuva444p10le"             the `a` is the alpha; yuv444p10le silently drops it
 *   imageFormat "png"                      MEASURED: Remotion refuses the combination without it,
 *                                          because its default JPEG frames cannot carry alpha
 *                                          ("Pixel format was set to 'yuva444p10le' but the image
 *                                          format is not PNG")
 *
 * The dangerous one is `pixelFormat`. Drop its alpha and the render still succeeds, still looks
 * correct in any player that shows it on black, and composites as an opaque rectangle that hides
 * the entire film. The other three fail loudly; this one fails as a finished, wrong video.
 */
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
  const { selectComposition, renderMedia } = await import("@remotion/renderer");
  const inputProps = props as unknown as Record<string, unknown>;

  const composition = await selectComposition({
    serveUrl,
    id: "FastVidGraphics",
    inputProps,
    browserExecutable,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "prores",
    proResProfile: "4444",
    pixelFormat: "yuva444p10le",
    imageFormat: "png",
    outputLocation: params.overlayPath,
    inputProps,
    browserExecutable,
    onProgress: params.onProgress ? ({ progress }) => params.onProgress!(progress) : undefined,
  });

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
    skipped,
    browserExecutable,
  };
}
