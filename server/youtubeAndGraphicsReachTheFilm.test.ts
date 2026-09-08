/**
 * TWO ROUTES THAT CONTRIBUTED NOTHING, AND THE TWO REASONS NOBODY COULD SEE.
 *
 * ── Graphics ────────────────────────────────────────────────────────────────────────────────
 *
 *     [Graphics] lifecycle planned=6 translated=5 renderInput=0 drawn=0
 *
 * `graphicsLifecycle` declares four stages — PLANNED → TRANSLATED → RENDER_INPUT → DRAWN — and
 * takes `inputIds`/`drawnIds` to reach the last two. Nothing could supply either:
 * `renderGraphicsOverlay` returned `graphicsDrawn: number`, `GraphicsOverlayFile` kept a path and a
 * skip list, and `RenderedTimeline` carried neither. Two declared stages with no possible writer,
 * so every render stopped at TRANSLATED — which reads as a renderer that refused five graphics and
 * was in fact a question nobody put to it.
 *
 * ── YouTube ─────────────────────────────────────────────────────────────────────────────────
 *
 *     [VisualFunnel] youtube_cc retrieved=35 downloadStarted=17 downloadSucceeded=2 adopted=0
 *     [ProviderFunnel] provider=youtube_cc judged=1 fits=0 refused=1 accepted=0%
 *     [YouTubeUsage] used=0
 *
 * Twelve percent of downloads survived and none reached the film. The cause WAS knowable:
 * `[YouTubeDownload]` prints a classified status and a per-route trail for every attempt. It prints
 * it in the retrieval phase, thousands of lines before the summary block — so a log captured from
 * the end of a render shows the failure and not the reason. `DOWNLOAD_UNAVAILABLE` (no route
 * configured), `DOWNLOAD_TIMEOUT` and `DOWNLOAD_UNSUPPORTED` are three different operator actions
 * and were indistinguishable from `downloadSucceeded=2`.
 *
 * Neither fix forces anything past a gate. A graphic still has to pass `graphicIsRenderable`; a
 * YouTube clip still has to pass the picture editor. What changes is that both routes can now be
 * seen failing, at the place a reader looks.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { createSourcingCache, providerMetrics, logSourcingMetrics } from "./videoPipeline";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("the renderer reports WHICH graphics it received and drew, not how many", () => {
  const RENDERER = read("remotionRenderer.ts");

  it("the result carries both id lists", () => {
    expect(RENDERER).toContain("graphicInputIds: string[];");
    expect(RENDERER).toContain("graphicDrawnIds: string[];");
  });

  it("the drawn list is the same predicate the count uses, so the two cannot disagree", () => {
    const at = RENDERER.indexOf("graphicsDrawn: props.graphics.filter");
    expect(at).toBeGreaterThan(-1);
    const region = RENDERER.slice(at, at + 700);
    expect(region).toContain("graphicInputIds: props.graphics.map((g) => g.id)");
    expect(region).toContain("graphicIsRenderable(g.graphicType, g.data, g.label)");
    /** Input is every graphic the props carried — not a filtered subset. */
    expect(region).not.toContain("graphicInputIds: props.graphics.filter");
  });

  it("the count is unchanged — this adds the ids beside it, it does not redefine it", () => {
    expect(RENDERER).toContain("graphicsDrawn: props.graphics.filter((g) =>");
  });
});

describe("the ids survive every hand-off between the renderer and the log", () => {
  it("GraphicsOverlayFile carries them", () => {
    const TL = read("timelineRenderer.ts");
    expect(TL).toContain("graphicInputIds?: string[];");
    expect(TL).toContain("graphicDrawnIds?: string[];");
  });

  it("productionGraphicsOverlay stops dropping them on the way out", () => {
    const DEPS = read("graphicsOverlayDeps.ts");
    const at = DEPS.indexOf("return {");
    expect(at).toBeGreaterThan(-1);
    const region = DEPS.slice(at, at + 400);
    expect(region).toContain("graphicInputIds: result.graphicInputIds");
    expect(region).toContain("graphicDrawnIds: result.graphicDrawnIds");
  });

  it("RenderedTimeline distinguishes 'no overlay ran' from 'an empty list'", () => {
    /**
     * `graphicsLifecycle` already treats an absent report as "stop at TRANSLATED" rather than as a
     * refusal, so null and [] must not be run together here either.
     */
    const TL = read("timelineRenderer.ts");
    expect(TL).toContain("graphicRenderIds: { input: string[]; drawn: string[] } | null;");
    const at = TL.indexOf("graphicRenderIds:\n");
    expect(at).toBeGreaterThan(-1);
    expect(TL.slice(at, at + 300)).toContain(": null,");
  });

  it("the worker prints the two stages, and names what was received and not drawn", () => {
    const W = read("renderJobWorker.ts");
    const at = W.indexOf("if (rendered.graphicRenderIds) {");
    expect(at).toBeGreaterThan(-1);
    const region = W.slice(at, at + 900);
    expect(region).toContain("renderInput=${input.length} drawn=${drawn.length}");
    expect(region).toContain("receivedNotDrawn=");
  });

  it("no graphic is forced past the predicate to make the number look better", () => {
    const RENDERER = read("remotionRenderer.ts");
    const DEPS = read("graphicsOverlayDeps.ts");
    for (const src of [RENDERER, DEPS]) {
      expect(src).not.toContain("graphicIsRenderable = () => true");
      expect(src).not.toContain("|| true");
    }
  });
});

describe("a YouTube download failure states its reason where the summaries are", () => {
  it("the tally is bumped at the one place that knows the status", () => {
    const PIPE = read("videoPipeline.ts");
    const at = PIPE.indexOf("const line = formatYoutubeDownloadLine({");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 1_200);
    expect(region).toContain('countDownloadOutcome(sourcingCache, "youtube_cc", status)');
    /**
     * Through a helper, not inline: `reportDownload` is the single exit point that
     * `youtubeDownloadIsRecordable` measures by byte offset, and a block inserted here pushes the
     * replay-fact write out of its 1400-character window.
     */
    const helper = PIPE.indexOf("function countDownloadOutcome(");
    expect(helper).toBeGreaterThan(-1);
    expect(PIPE.slice(helper, helper + 400)).toContain(
      "m.downloadOutcomes[status] = (m.downloadOutcomes[status] ?? 0) + 1"
    );
  });

  it("every status is counted, success included — a rate needs both halves", () => {
    const PIPE = read("videoPipeline.ts");
    const at = PIPE.indexOf("const line = formatYoutubeDownloadLine({");
    const region = PIPE.slice(at, at + 1_200);
    /** No `if (status !== "DOWNLOAD_SUCCESS")` guard around the tally. */
    expect(region).not.toContain('if (status !== "DOWNLOAD_SUCCESS")');
  });

  it("it counts by status and keeps the counts apart", () => {
    const cache = createSourcingCache(573);
    const m = providerMetrics(cache, "youtube_cc");
    for (const s of ["DOWNLOAD_TIMEOUT", "DOWNLOAD_TIMEOUT", "DOWNLOAD_UNSUPPORTED", "DOWNLOAD_SUCCESS"]) {
      m.downloadOutcomes[s] = (m.downloadOutcomes[s] ?? 0) + 1;
    }
    expect(m.downloadOutcomes).toEqual({
      DOWNLOAD_TIMEOUT: 2,
      DOWNLOAD_UNSUPPORTED: 1,
      DOWNLOAD_SUCCESS: 1,
    });
  });

  it("a fresh provider has no outcomes at all — a zero nobody wrote is not a measurement", () => {
    const cache = createSourcingCache(1);
    expect(providerMetrics(cache, "pexels").downloadOutcomes).toEqual({});
  });

  it("the summary prints them most frequent first, and prints nothing when there are none", () => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const cache = createSourcingCache(573);
      const m = providerMetrics(cache, "youtube_cc");
      m.searchCount = 5;
      m.downloadOutcomes = { DOWNLOAD_TIMEOUT: 9, DOWNLOAD_UNAVAILABLE: 6, DOWNLOAD_SUCCESS: 2 };
      providerMetrics(cache, "pexels").searchCount = 3;
      logSourcingMetrics(cache, 573);
    } finally {
      console.log = real;
    }
    const outcome = lines.find((l) => l.includes("downloadOutcomes"));
    expect(outcome).toContain("youtube_cc");
    expect(outcome).toContain("DOWNLOAD_TIMEOUT=9 DOWNLOAD_UNAVAILABLE=6 DOWNLOAD_SUCCESS=2");
    /** pexels classified nothing, so it gets no line rather than an empty one. */
    expect(lines.filter((l) => l.includes("downloadOutcomes"))).toHaveLength(1);
  });

  it("metrics never cost a render — the whole block stays inside its guard", () => {
    const PIPE = read("videoPipeline.ts");
    const at = PIPE.indexOf("export function logSourcingMetrics");
    const body = PIPE.slice(at, at + 7_000);
    expect(body).toContain("downloadOutcomes");
    expect(body).toContain("/* metrics must never affect a render */");
  });
});
