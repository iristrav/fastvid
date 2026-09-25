import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  activeRenders,
  handBackInterruptedRenders,
  registerActiveRender,
  unregisterActiveRender,
} from "./interruptedRenderRecovery";

/**
 * RONDE 653 — Railway's default draining time is 0 s: SIGTERM, then SIGKILL. The worker's own 25 s
 * drain never ran, so a deploy left the render lock held for its 40-minute lease and the video in
 * `generating` until the stall sweep found it.
 */
describe("the worker knows which render locks it holds", () => {
  it("registers on take and forgets on release, holder-scoped", () => {
    registerActiveRender(901, "r-a");
    expect(activeRenders()).toContainEqual({ videoId: 901, productionRenderId: "r-a" });
    unregisterActiveRender(901, "r-other");
    expect(activeRenders()).toContainEqual({ videoId: 901, productionRenderId: "r-a" });
    unregisterActiveRender(901, "r-a");
    expect(activeRenders().some((r) => r.videoId === 901)).toBe(false);
  });
});

describe("a render still running when the drain ends is handed back", () => {
  it("re-queues first, then releases its lock, and says so", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    registerActiveRender(902, "r-b");
    const out = await handBackInterruptedRenders(
      "worker SIGTERM (deploy or restart)",
      {
        requeue: async (id) => {
          order.push(`requeue:${id}`);
          return "requeued";
        },
        releaseLock: async (id, renderId) => {
          order.push(`release:${id}:${renderId}`);
          return true;
        },
        log: (l) => lines.push(l),
      },
      [{ videoId: 902, productionRenderId: "r-b" }]
    );
    expect(order).toEqual(["requeue:902", "release:902:r-b"]);
    expect(out).toEqual([{ videoId: 902, requeue: "requeued", lockReleased: true }]);
    expect(lines[0]).toContain("[Shutdown] video=902 render=r-b handed back");
    expect(activeRenders().some((r) => r.videoId === 902)).toBe(false);
  });

  it("still releases the lock when the re-queue fails, and never throws", async () => {
    const released: number[] = [];
    const out = await handBackInterruptedRenders(
      "x",
      {
        requeue: async () => {
          throw new Error("db down");
        },
        releaseLock: async (id) => {
          released.push(id);
          return true;
        },
        log: () => {},
      },
      [{ videoId: 903, productionRenderId: "r-c" }]
    );
    expect(released).toEqual([903]);
    expect(out[0]!.requeue).toContain("db down");
  });
});

describe("the wiring", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const WORKER = fs.readFileSync(path.join(__dirname, "worker.ts"), "utf8");
  const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
  const RAILWAY = JSON.parse(fs.readFileSync(path.join(__dirname, "../railway.worker.json"), "utf8"));

  it("the platform gives the worker time to drain and hand back", () => {
    expect(Number(RAILWAY.deploy.drainingSeconds)).toBeGreaterThanOrEqual(60);
    expect(WORKER).toContain('WORKER_SHUTDOWN_DRAIN_MS ?? "45000"');
    expect(WORKER).toContain("const SHUTDOWN_HANDBACK_MS = 8_000;");
  });

  it("the pipeline registers the lock it takes and unregisters it in the same finally", () => {
    expect(PIPE).toContain("registerActiveRender(videoId, productionRenderId);");
    const fin = PIPE.indexOf("unregisterActiveRender(videoId, productionRenderId);");
    expect(fin).toBeGreaterThan(-1);
    expect(PIPE.slice(fin, fin + 400)).toContain("releaseRenderLock(dbRenderLockStore, videoId, productionRenderId)");
  });

  it("the drain deadline hands renders back instead of exiting with them", () => {
    const at = WORKER.indexOf("Drain window (");
    const body = WORKER.slice(at, at + 1200);
    expect(body).toContain("handBackInterruptedRenders(");
    expect(body).toContain("requeueInterruptedVideo(id, reason)");
    expect(body).toContain("releaseRenderLock(dbRenderLockStore, id, renderId)");
  });

  it("re-queueing bumps the generation attempt first, so the dying run writes nothing", () => {
    const at = DB.indexOf("export async function requeueInterruptedVideo");
    const body = DB.slice(at, at + 1400);
    expect(body.indexOf("bumpGenerationAttempt(videoId)")).toBeLessThan(body.indexOf("requeueStalledPipeline("));
    expect(body).toContain("pipelineMaxStallRecoveries()");
  });
});
