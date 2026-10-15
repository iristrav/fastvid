/**
 * RONDE 150 §5/§6 — the one place where ffmpeg and Remotion are wired together.
 *
 * `timelineRenderer.ts` takes a `graphicsOverlay` function and knows nothing about how it is
 * produced; `remotionRenderer.ts` produces an alpha overlay and knows nothing about who composites
 * it. This module is the wire, and it is a separate file for the same reason `rehydrationDeps.ts`
 * is: a test can render a real video without a browser, and a deployment without
 * chrome-headless-shell can simply not call this.
 *
 * ── When the overlay is worth its cost ───────────────────────────────────────────────────────
 *
 * Bundling and driving a browser is the most expensive step in a render by a wide margin. So this
 * asks two questions before spending it, and both must be yes:
 *
 *   1. Is there anything to draw?              `hasGraphicsLayer`
 *   2. Is a usable browser actually present?   `resolveRemotionBrowser`
 *
 * A "no" to either returns null, `renderTimeline` takes the libass route, and the video still gets
 * its captions — with plainer typography and a line in `skipped` saying so. §2 forbids a SILENT
 * fallback, not a fallback.
 */
import * as path from "path";

import type { ProjectTimeline } from "./projectTimeline";
import type { GraphicsOverlayFile } from "./timelineRenderer";
import { hasGraphicsLayer, renderGraphicsOverlay, resolveRemotionBrowser } from "./remotionRenderer";
import type { RemotionWordTiming } from "./remotionProps";

/**
 * Is the Remotion graphics route usable in this process?
 *
 * A named question rather than an inline check, so the render log can say WHY a video took the
 * libass route — "no browser" and "nothing to draw" are very different answers and an operator
 * looking at plain captions needs to know which one they got.
 */
export function graphicsOverlayAvailable(): boolean {
  return resolveRemotionBrowser() !== null;
}

/**
 * VIDEO 660 — one line per drawn graphic, naming what it IS (a map, a chapter card, a counter…).
 * The `[GraphicsOverlay]` total said "graphics=7" and nobody could tell from the log whether the
 * film had a map, a timeline or seven identical cards. `beat` is the sentence the graphic belongs
 * to when the planner recorded one.
 */
export function graphicDrawnLines(timeline: ProjectTimeline, drawnIds: readonly string[] | undefined): string[] {
  const drawn = new Set(drawnIds ?? []);
  return timeline.tracks
    .flatMap((t) => (t.kind === "GRAPHICS" ? t.graphics : []))
    .filter((g) => drawn.has(g.id))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
    .map((g) => {
      const beat = g.data?.beatIndex;
      return (
        `[GraphicDrawn] video=${timeline.videoId} type=${g.graphicType} id=${g.id}` +
        (typeof beat === "number" ? ` beat=${beat}` : "") +
        ` ${g.start.toFixed(2)}-${g.end.toFixed(2)}s` +
        (g.data?.primaryVisual === true ? " picture" : " overlay")
      );
    });
}

export type GraphicsOverlayDeps = {
  /** Where the alpha .mov is written. A render intermediate, inside the render's own workDir. */
  workDir: string;
  words?: RemotionWordTiming[];
  /** Reused across renders in a worker; bundling once is most of the saving. */
  cacheDir?: string;
  onProgress?: (fraction: number) => void;
};

/**
 * Build the `graphicsOverlay` function `renderTimeline` expects.
 *
 * Returns null when there is no reason or no way to run Remotion. It deliberately does NOT catch
 * a render failure: `renderTimeline` already catches, reports the reason in `skipped` and falls
 * back to libass, and swallowing the error here would hide the reason from that report.
 */
export function productionGraphicsOverlay(
  deps: GraphicsOverlayDeps
): (timeline: ProjectTimeline) => Promise<GraphicsOverlayFile | null> {
  return async (timeline: ProjectTimeline) => {
    if (!hasGraphicsLayer(timeline)) return null;
    if (!graphicsOverlayAvailable()) return null;

    const startedAt = Date.now();
    const result = await renderGraphicsOverlay({
      timeline,
      overlayPath: path.join(deps.workDir, "graphics_overlay.mov"),
      words: deps.words,
      cacheDir: deps.cacheDir,
      onProgress: deps.onProgress,
    });

    console.log(
      `[GraphicsOverlay] video=${timeline.videoId} ` +
        `graphics=${result.graphicsDrawn} captions=${result.captionsDrawn} ` +
        `texts=${result.textsDrawn} frames=${result.durationInFrames} ` +
        `skipped=${result.skipped.length}` +
        /** OCTOBER 2026 — how long the layer took, so a render log answers the performance question. */
        ` ms=${Date.now() - startedAt}`
    );

    for (const line of graphicDrawnLines(timeline, result.graphicDrawnIds)) console.log(line);

    /** The ids travel with the file — see `GraphicsOverlayFile` for the two stages they unlock. */
    return {
      overlayPath: result.overlayPath,
      skipped: result.skipped,
      graphicInputIds: result.graphicInputIds,
      graphicDrawnIds: result.graphicDrawnIds,
    };
  };
}
