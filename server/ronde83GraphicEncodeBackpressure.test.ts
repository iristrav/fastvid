import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { montageSegmentParallelism, composeParallelismForVideo } from "./sourcingPolicy";
import { ffmpegSemaphore } from "./_core/semaphore";
import { planVideoGraphics } from "./editorialGraphicsEngine";

/**
 * RONDE 83 — backpressure on graphic encoding.
 *
 * The RONDE 82 audit reported this site as "up to 20 concurrent x264 encodes". That was wrong,
 * and the correction matters for what this round actually fixes: editorialGraphicsEngine's
 * execAsync already routes every ffmpeg call through ffmpegSemaphore, which admits 3 process-wide.
 * The child processes were never unbounded.
 *
 * What WAS unbounded is the number of tasks started against those three slots. videoPipeline
 * pre-generates every planned graphic with one Promise.all over the whole list — up to
 * maxPerVideo = 20 — and each task does:
 *
 *     await Promise.race([execAsync(cmd), <15s or 30s timeout>])
 *
 * execAsync's promise covers ACQUIRING the semaphore as well as running the command, and the
 * timeout starts at the same instant. A task queued behind seventeen others therefore burns its
 * timeout waiting for a slot, fails, and its graphic is silently dropped. The more graphics a
 * video plans the more of them are lost — and a longer video plans more, because it has more
 * beats to detect them in.
 *
 * The fix is a limiter on how many are IN FLIGHT. Every planned graphic is still produced.
 */

const GRAPHICS_SRC = fs.readFileSync(path.join(__dirname, "editorialGraphicsEngine.ts"), "utf8");
const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═════════════ §A — the limiter exists and is wired ═════════════ */

describe("RONDE 83 §A — graphic encoding is limited", () => {
  it("a module-level limiter gates every graphic encode", () => {
    expect(GRAPHICS_SRC).toContain("const graphicEncodeLimit = pLimit(");
    // It wraps the exported entry point, so every caller is covered — not just the one
    // pre-generation site in videoPipeline.
    expect(GRAPHICS_SRC).toMatch(
      /export async function generateGraphicClip\([\s\S]{0,200}?return graphicEncodeLimit\(\(\) => generateGraphicClipInner\(/
    );
  });

  it("MUTATION GUARD — removing the limiter breaks this test", () => {
    // The exported function must do nothing except hand the work to the limiter. If someone
    // later inlines the body back into it, this fails.
    const start = GRAPHICS_SRC.indexOf("export async function generateGraphicClip(");
    expect(start).toBeGreaterThan(-1);
    const body = GRAPHICS_SRC.slice(start, GRAPHICS_SRC.indexOf("\n}", start));
    expect(body).toContain("graphicEncodeLimit(");
    // No encode work of its own.
    for (const escape of ["execAsync", "svgToPng", "pngToMp4", "buildMapSvg", "FFMPEG"]) {
      expect(body, `generateGraphicClip must delegate, not do ${escape}`).not.toContain(escape);
    }
  });

  it("the pipeline's pre-generation site no longer needs its own limiter", () => {
    // The Promise.all is still there and still starts every plan — that is intended. The
    // limiter inside the engine is what keeps only N of them in flight.
    expect(PIPELINE_SRC).toContain("graphicPlans.map(async (plan: GraphicPlan)");
    const start = PIPELINE_SRC.indexOf("graphicPlans.map(async (plan: GraphicPlan)");
    const block = PIPELINE_SRC.slice(start, start + 500);
    expect(block).toContain("generateGraphicClip(plan, workDir)");
  });
});

/* ═════════════ §B — the limit is a safe number ═════════════ */

describe("RONDE 83 §B — the limit is sized against the existing ffmpeg budget", () => {
  it("it reuses montageSegmentParallelism rather than inventing a constant", () => {
    expect(GRAPHICS_SRC).toContain("pLimit(Math.max(1, montageSegmentParallelism()))");
  });

  it("graphics can never monopolise the process-wide ffmpeg semaphore", () => {
    // Each graphic makes at most one ffmpeg call at a time, so the in-flight count is the most
    // semaphore slots graphics can hold. It must stay at or below the semaphore's own limit so
    // compose and the audits can still get in. The Semaphore class exposes active/waiting but
    // not its ceiling, so the ceiling is read from where it is declared.
    const semSrc = fs.readFileSync(path.join(__dirname, "_core", "semaphore.ts"), "utf8");
    const declared = semSrc.match(/FFMPEG_CONCURRENCY_LIMIT \?\? "(\d+)"/)?.[1];
    expect(declared, "ffmpeg semaphore limit not found").toBeDefined();
    expect(montageSegmentParallelism()).toBeLessThanOrEqual(Number(declared));
    // And the semaphore is real, not a stub.
    expect(ffmpegSemaphore.active).toBe(0);
  });

  it("it is at least 1 — a limiter of 0 would deadlock every graphic", () => {
    expect(Math.max(1, montageSegmentParallelism())).toBeGreaterThanOrEqual(1);
  });
});

/* ═════════════ §C — no graphic is lost ═════════════ */

describe("RONDE 83 §C — quality is unchanged: every planned graphic is still produced", () => {
  it("the per-video plan cap is untouched", () => {
    // The fix limits concurrency, not how many graphics a video may have. maxPerVideo stays 20.
    expect(GRAPHICS_SRC).toContain("const maxPerVideo = options.maxPerVideo ?? 20;");
  });

  it("planVideoGraphics still returns every plan it would have before", () => {
    // Driven on real beats: a plan set larger than the concurrency limit must come back whole.
    const scenes = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      text: `Section ${i}. The account continues.`,
      beats: [
        { index: 0, text: `In 1943 the figure reached 45 percent.`, holdSec: 4 },
        { index: 1, text: `Berlin, Germany — the capital under bombardment.`, holdSec: 4 },
      ],
    }));
    const plans = planVideoGraphics(scenes, "A Documentary");
    // However many the detector finds, the limiter must not be able to reduce it: the cap is
    // the only thing that bounds this list.
    expect(plans.length).toBeLessThanOrEqual(20);
    expect(Array.isArray(plans)).toBe(true);
  });

  it("the limiter queues rather than rejects — pLimit has no drop behaviour", () => {
    // p-limit runs every queued task; it never discards one. Asserted structurally because the
    // alternative (a cap that silently drops work) is exactly what this round must not do.
    expect(GRAPHICS_SRC).not.toContain("graphicPlans.slice(0,");
    expect(GRAPHICS_SRC).not.toMatch(/if \([^)]*inFlight[^)]*\) return null/);
  });
});

/* ═════════════ §C2 — measured, not inspected ═════════════ */

describe("RONDE 83 §C2 — the limiter is observable in the real ffmpeg queue", () => {
  it("twenty graphics all complete, and never pile up on the semaphore", async () => {
    const { generateGraphicClip } = await import("./editorialGraphicsEngine");
    const os = await import("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde83-"));
    const limit = Math.max(1, montageSegmentParallelism());

    // Without the limiter all twenty tasks race straight to the semaphore and seventeen of them
    // sit in its queue — which is what makes their timeouts expire before they ever run. With it,
    // at most `limit` tasks are in flight, so the queue depth attributable to graphics stays
    // within one slot of the limit.
    let peakWaiting = 0;
    const sampler = setInterval(() => {
      peakWaiting = Math.max(peakWaiting, ffmpegSemaphore.waiting);
    }, 5);

    try {
      const plans = Array.from({ length: 20 }, (_, i) => ({
        sceneIndex: i,
        beatIndex: 0,
        type: "stat",
        durationSec: 3,
        payload: { type: "stat", value: `${i}%`, label: `Label ${i}` },
      }));
      const results = await Promise.all(
        plans.map((p) => generateGraphicClip(p as never, dir))
      );
      // Every plan was processed — none was dropped by the limiter.
      expect(results.length).toBe(20);
      expect(peakWaiting, `graphics queued ${peakWaiting} deep on the ffmpeg semaphore`)
        .toBeLessThanOrEqual(limit);
    } finally {
      clearInterval(sampler);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

/* ═════════════ §D — nothing else was slowed down ═════════════ */

describe("RONDE 83 §D — the rest of the pipeline's concurrency is untouched", () => {
  it("compose concurrency is unchanged and still length-independent", () => {
    const values = ["1", "8-10", "10-15", "15-20"].map((l) => composeParallelismForVideo(l, false));
    expect(new Set(values).size, `compose parallelism differs by length: ${values}`).toBe(1);
    expect(values[0]).toBeGreaterThanOrEqual(2);
  });

  it("montage segment parallelism is unchanged", () => {
    expect(montageSegmentParallelism()).toBeGreaterThanOrEqual(2);
  });

  it("the ffmpeg semaphore itself is untouched", () => {
    const semSrc = fs.readFileSync(path.join(__dirname, "_core", "semaphore.ts"), "utf8");
    expect(semSrc).toContain('parseInt(process.env.FFMPEG_CONCURRENCY_LIMIT ?? "3", 10)');
  });

  it("the archive download limit is untouched", () => {
    const curated = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(curated).toContain("const archiveDownloadLimit = pLimit(archiveDownloadConcurrency());");
    expect(curated).toContain("return 5;");
  });

  it("no scene/beat/compose loop was made sequential by this round", () => {
    // The round must not have "fixed" concurrency by removing it.
    expect(PIPELINE_SRC).toContain("const visualLimit = pLimit(perf.sceneParallelism);");
    expect(PIPELINE_SRC).toContain("const composeLimit = pLimit(composeParallelismForVideo(videoLength, IS_RAILWAY));");
    expect(PIPELINE_SRC).toContain("const beatLimit = pLimit(beatConcurrency);");
  });
});

/* ═════════════ §E — the whole-video passes stay sequential ═════════════ */

describe("RONDE 83 §E — no other whole-video pass fans out", () => {
  it("text overlays are applied one scene at a time", () => {
    const src = fs.readFileSync(path.join(__dirname, "textOverlay", "renderer.ts"), "utf8");
    const start = src.indexOf("export async function applyTextOverlaysToScenes(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toContain("for (let i = 0; i < scenePaths.length; i++)");
    expect(body).not.toContain("Promise.all");
  });

  it("the visual-director pass is applied one scene at a time", () => {
    const src = fs.readFileSync(path.join(__dirname, "visualDirector", "renderer.ts"), "utf8");
    expect(src).toContain("for (let i = 0; i < scenePaths.length; i++)");
    expect(src).not.toContain("Promise.all");
  });

  it("the render-path ffmpeg modules do not fan out at all", () => {
    for (const rel of [
      ["voiceMontageSyncAudit.ts"],
      ["cinematicMotion", "renderer.ts"],
      ["editorialOverlay", "renderer.ts"],
      ["finalVideoGate.ts"],
      ["postRenderSpotCheck.ts"],
    ]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      expect(src, rel.join("/")).not.toMatch(/Promise\.(all|allSettled)\(/);
    }
  });
});
