import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import {
  RENDER_ABANDONED_MESSAGE,
  RENDER_CANCEL_GRACE_MS_DEFAULT,
  renderCancelGraceMs,
  watchForAbandonedRender,
} from "./cancelledRenderRelease";
import {
  clearVideoGenerationCancel,
  runWithActiveVideoId,
  throwIfActiveRenderCancelled,
  type RenderRunToken,
} from "./videoGenerationCancel";
import { createRenderWatchdog } from "./renderWatchdog";

/**
 * RONDE 652 — render 607's first attempt was cancelled at 17:47:17 and never settled, so the lock
 * it held was released only by its 40-minute lease and the second attempt started at 18:17.
 */
describe("a cancelled render that does not stop by itself is abandoned", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing while no cancel has been requested", async () => {
    const onAbandon = vi.fn();
    const watch = watchForAbandonedRender({
      videoId: 1,
      isCancelled: () => false,
      graceMs: 10_000,
      onAbandon,
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onAbandon).not.toHaveBeenCalled();
    watch.stop();
  });

  it("gives a cancelled render its grace period, then abandons it and rejects", async () => {
    let cancelled = false;
    const onAbandon = vi.fn();
    const lines: string[] = [];
    const watch = watchForAbandonedRender({
      videoId: 607,
      isCancelled: () => cancelled,
      graceMs: 60_000,
      onAbandon,
      log: (l) => lines.push(l),
    });
    const hung = new Promise<string>(() => {});
    let outcome: unknown = null;
    Promise.race([hung, watch.abandoned]).catch((e) => (outcome = e));

    await vi.advanceTimersByTimeAsync(10_000);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onAbandon).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("cancel seen"))).toBe(true);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(String((outcome as Error)?.message)).toContain(RENDER_ABANDONED_MESSAGE);
  });

  it("stays quiet when the render stops by itself inside the grace period", async () => {
    let cancelled = false;
    const onAbandon = vi.fn();
    const watch = watchForAbandonedRender({
      videoId: 2,
      isCancelled: () => cancelled,
      graceMs: 60_000,
      onAbandon,
      log: () => {},
    });
    cancelled = true;
    await vi.advanceTimersByTimeAsync(20_000);
    watch.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("reads its grace period from RENDER_CANCEL_GRACE_MS, bounded", () => {
    expect(renderCancelGraceMs({})).toBe(RENDER_CANCEL_GRACE_MS_DEFAULT);
    expect(renderCancelGraceMs({ RENDER_CANCEL_GRACE_MS: "30000" })).toBe(30_000);
    expect(renderCancelGraceMs({ RENDER_CANCEL_GRACE_MS: "1" })).toBe(5_000);
    expect(renderCancelGraceMs({ RENDER_CANCEL_GRACE_MS: "999999999" })).toBe(600_000);
    expect(renderCancelGraceMs({ RENDER_CANCEL_GRACE_MS: "soon" })).toBe(RENDER_CANCEL_GRACE_MS_DEFAULT);
  });
});

describe("an abandoned run keeps throwing after the video's own flag is cleared", () => {
  it("marks the run, not the video: a fresh attempt for the same video is not affected", () => {
    const abandonedRun: RenderRunToken = { abandoned: true };
    const freshRun: RenderRunToken = { abandoned: false };
    clearVideoGenerationCancel(607);
    expect(() => runWithActiveVideoId(607, () => throwIfActiveRenderCancelled(), null, abandonedRun)).toThrow(
      "Video generation cancelled"
    );
    expect(() => runWithActiveVideoId(607, () => throwIfActiveRenderCancelled(), null, freshRun)).not.toThrow();
    expect(() => runWithActiveVideoId(607, () => throwIfActiveRenderCancelled())).not.toThrow();
  });
});

describe("the watchdog kills an abandoned render's children and refuses new ones", () => {
  it("SIGKILLs what it tracks, and anything tracked afterwards", () => {
    const fakeChild = () => {
      const cp = new EventEmitter() as EventEmitter & { killed: boolean; kill: (s: string) => boolean };
      cp.killed = false;
      cp.kill = vi.fn(() => {
        cp.killed = true;
        return true;
      });
      return cp;
    };
    const watchdog = createRenderWatchdog(607, 60_000);
    const running = fakeChild();
    watchdog.trackChild(running as never);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(watchdog.abandon("test")).toBe(1);
    expect(running.kill).toHaveBeenCalledWith("SIGKILL");
    const late = fakeChild();
    watchdog.trackChild(late as never);
    expect(late.kill).toHaveBeenCalledWith("SIGKILL");
    errors.mockRestore();
  });
});

describe("the production render races its own abandonment and releases the lock either way", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const block = SRC.slice(SRC.indexOf("const renderRun: RenderRunToken"), SRC.indexOf("async function _runVideoPipelineInner("));

  it("races the pipeline against the abandon watch, then releases the lock in the finally", () => {
    expect(block).toContain("return await Promise.race([pipelineRun, cancelWatch.abandoned]);");
    expect(block).toContain("cancelWatch.stop();");
    expect(block).toContain("releaseRenderLock(dbRenderLockStore, videoId, productionRenderId)");
    expect(block.indexOf("Promise.race")).toBeLessThan(block.indexOf("releaseRenderLock("));
  });

  it("marks the run, kills its children and passes the run token into the render's context", () => {
    expect(block).toContain("renderRun.abandoned = true;");
    expect(block).toContain("renderCtx.watchdog?.abandon(reason);");
    expect(block).toContain("ownerUserId, renderRun)");
    expect(block).toContain("isCancelled: () => isVideoGenerationCancelRequested(videoId)");
  });
});
