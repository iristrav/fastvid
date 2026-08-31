/**
 * RONDE 150 — the Remotion render, and the two things about it that are environment-specific.
 *
 * ── FINDING 1: the full Chrome binary does not work ──────────────────────────────────────────
 *
 * MEASURED, not assumed. Pointing Remotion at `chromium-1194/chrome-linux/chrome` fails with:
 *
 *     "Old Headless mode has been removed from the Chrome binary."
 *
 * Remotion drives the browser through the old headless protocol, which modern Chrome dropped.
 * `chrome-headless-shell` is the standalone implementation of exactly that mode, and pointing at
 * `chromium_headless_shell-1194/chrome-linux/headless_shell` renders a real MP4 first time.
 *
 * ── FINDING 2: Remotion downloads its own browser, and that download can be blocked ──────────
 *
 * With no `browserExecutable` it fetches from remotion.media, which this environment's egress proxy
 * refuses with a 403. That is not a bug — it is what a locked-down production network looks like
 * too. So the browser is RESOLVED from a list of known locations and, when none is found, the
 * render fails with a message that says which env var to set rather than with a network error four
 * layers down.
 *
 * ── Why the audio still goes through ffmpeg ──────────────────────────────────────────────────
 *
 * Remotion mixes audio in the browser, which can apply a gain but cannot sidechain: ducking needs
 * the voice as a CONTROL signal for a compressor on the music. `cinematicAudio` already has that
 * filter, tuned. So Remotion renders the PICTURE plus any straightforward audio, and when the
 * timeline asks for ducking the mix is handed to the existing ffmpeg audio graph. Two engines, one
 * per job they are each good at — not two engines doing the same job differently.
 */
import * as fs from "fs";
import * as path from "path";

import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";
import { audioTrackOf } from "./projectTimeline";
import {
  formatRemotionProps,
  missingEditorialFields,
  timelineToRemotionProps,
  type RemotionRenderProps,
  type RemotionWordTiming,
} from "./remotionProps";
import { REMOTION_EFFECTS } from "./remotion/components/Effects";
import { REMOTION_TRANSITIONS } from "./remotion/components/Transitions";
import { RENDERABLE_GRAPHICS } from "./remotion/components/Graphics";

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

/* ═══════════════════════ what a render reports ═══════════════════════ */

export type RemotionRenderResult = {
  outputPath: string;
  durationInFrames: number;
  fps: number;
  widthPx: number;
  heightPx: number;
  clipsRendered: number;
  textsDrawn: number;
  captionsDrawn: number;
  graphicsDrawn: number;
  audioTracks: number;
  /** §34 — everything the plan asked for that this renderer did not do, with the planner's reason. */
  skipped: string[];
  browserExecutable: string;
};

/**
 * Everything the plan asked for that Remotion cannot execute.
 *
 * Computed from the PROPS rather than during rendering, so it is known before a single frame is
 * drawn and can be reported even when the render then fails for another reason. §34: never a
 * silent substitution, always the original reason.
 */
export function remotionUnsupported(props: RemotionRenderProps): string[] {
  const out: string[] = [];
  for (const clip of props.clips) {
    for (const e of clip.effects) {
      if (!REMOTION_EFFECTS.has(e.effectType)) {
        out.push(
          `unsupported_effect ${e.effectType} on clip ${clip.id}` +
            (e.reason ? ` (${e.reason})` : "") +
            " — kept on the timeline, not executed"
        );
      }
    }
    if (!REMOTION_TRANSITIONS.has(clip.transitionIn)) {
      out.push(`unsupported_transition ${clip.transitionIn} on clip ${clip.id}`);
    }
    if (!clip.asset) out.push(`clip ${clip.id}: no media was recovered`);
  }
  for (const g of props.graphics) {
    const hasWords = Boolean(g.label?.trim());
    if (!RENDERABLE_GRAPHICS.has(g.graphicType) || !hasWords) {
      out.push(
        `unsupported_graphic ${g.graphicType} (${g.id})` +
          (g.reason ? ` — ${g.reason}` : "") +
          " — payload kept, not drawn"
      );
    }
  }
  return out;
}

/**
 * Does this timeline need ffmpeg for its audio?
 *
 * Only ducking forces it. A video whose music simply sits at a fixed gain can be mixed by Remotion
 * in the same pass as the picture, which is one process instead of two.
 */
export function needsFfmpegAudioMix(timeline: ProjectTimeline): boolean {
  for (const kind of ["MUSIC", "AMBIENT"] as const) {
    if (audioTrackOf(timeline, kind).some((c) => !c.disabled && c.duckUnderVoice)) return true;
  }
  return false;
}

/* ═══════════════════════ the render ═══════════════════════ */

export type RemotionRenderParams = {
  timeline: ProjectTimeline;
  outputPath: string;
  /** clip → a local file the rehydrator produced. */
  resolveMedia: (clip: TimelineVideoClip) => string | null;
  resolveAudio?: (id: string) => string | null;
  words?: RemotionWordTiming[];
  /** Where the webpack bundle is cached between renders. */
  cacheDir?: string;
  onProgress?: (fraction: number) => void;
  /** Injected in tests so a bundle can be reused; production builds one per render. */
  serveUrl?: string;
};

/** A local path becomes a URL the browser can load. Remotion accepts file:// for local media. */
export function toBrowserUrl(localPath: string | null): string | null {
  if (!localPath) return null;
  if (/^(https?|file):/i.test(localPath)) return localPath;
  return `file://${path.resolve(localPath)}`;
}

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

export async function renderWithRemotion(params: RemotionRenderParams): Promise<RemotionRenderResult> {
  const browserExecutable = resolveRemotionBrowser();
  if (!browserExecutable) throw new RemotionUnavailableError(`tried: ${remotionBrowserCandidates().join(", ")}`);

  const props = timelineToRemotionProps({
    timeline: params.timeline,
    resolveMedia: (clip) => toBrowserUrl(params.resolveMedia(clip)),
    resolveAudio: params.resolveAudio ? (id) => toBrowserUrl(params.resolveAudio!(id)) : undefined,
    words: params.words,
  });

  /**
   * §5 — the losslessness check runs on the REAL timeline, every render.
   *
   * A test proves the adapter was lossless for the cases someone thought of; this catches the
   * combination nobody tested, on the video where it actually happened.
   */
  const lost = missingEditorialFields(params.timeline, props);
  const skipped = [...remotionUnsupported(props), ...lost.map((l) => `LOST: ${l}`)];
  console.log(formatRemotionProps(props));

  const serveUrl = params.serveUrl ?? (await bundleFastVid(params.cacheDir));
  const { selectComposition, renderMedia } = await import("@remotion/renderer");

  const composition = await selectComposition({
    serveUrl,
    id: "FastVid",
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: params.outputPath,
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable,
    onProgress: params.onProgress ? ({ progress }) => params.onProgress!(progress) : undefined,
  });

  return {
    outputPath: params.outputPath,
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    widthPx: props.width,
    heightPx: props.height,
    clipsRendered: props.clips.filter((c) => c.asset).length,
    textsDrawn: props.texts.length,
    captionsDrawn: props.captions.length,
    graphicsDrawn: props.graphics.filter(
      (g) => RENDERABLE_GRAPHICS.has(g.graphicType) && Boolean(g.label?.trim())
    ).length,
    audioTracks: props.audio.filter((a) => a.src).length,
    skipped,
    browserExecutable,
  };
}
