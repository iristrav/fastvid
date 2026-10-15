/**
 * VIDEO 659 — FIX B AND C: EVERY STOCK VIDEO HAS A DEADLINE, AND AT MOST SIX DOWNLOADS RUN AT ONCE.
 *
 * Production, 15 October: 4WQ_6t2QC9s, 4RrSvbeipjE and x650v9y4uZk downloaded their approved
 * sections and were never heard from again — twenty minutes "still downloading", their shots never
 * offered, and nothing said which step hung. Now every step logs its start, end, duration and
 * outcome; a video gets `STOCK_VIDEO_DEADLINE_MS` for its whole life; past it the video is failed
 * naming the step it hangs in, its waiters are released, its files removed, its download slot given
 * back, and a late answer can neither mark it ready nor add shots. The other videos go on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SHARP_MAX_FRAMES, sharpCandidateSeconds } from "./youtubePreviewSheet";
import {
  createSlots,
  releaseYoutubeShotStock,
  startYoutubeShotStock,
  STOCK_CONCURRENCY,
  STOCK_DOWNLOADS_AT_ONCE,
  STOCK_VIDEO_DEADLINE_MS,
  stockSummary,
  stockVideoState,
  takeStockShots,
  youtubeStockSettled,
  type StockDeps,
} from "./youtubeShotStock";

const dirs: string[] = [];
const films: number[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const f of films.splice(0)) releaseYoutubeShotStock(f);
});

const workDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "v659-stock-"));
  dirs.push(d);
  return d;
};
const film = (id: number) => (films.push(id), id);
const candidate = (videoId: string) => ({ videoId, title: `Title ${videoId}`, durationSec: 600, serves: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A promise that only settles when the test says so. */
const gate = <T>() => {
  let open!: (v: T) => void;
  const p = new Promise<T>((r) => (open = r));
  return { p, open };
};
const cutInto = (n: number): StockDeps["cut"] => async (_file, dir) =>
  Array.from({ length: n }, (_, i) => {
    const p = path.join(dir, `shot_${i + 1}.mp4`);
    fs.writeFileSync(p, "x");
    return { path: p, startSec: i * 6, endSec: i * 6 + 5 };
  });
const writes: StockDeps["download"] = async (_id, _s, _d, out) => {
  fs.writeFileSync(out, "x");
  return true;
};

describe("VIDEO 659 fix B — the deadline itself", () => {
  it("four minutes by default, for the whole life of one video", () => {
    expect(STOCK_VIDEO_DEADLINE_MS).toBe(240_000);
  });
});

describe("VIDEO 659 fix B — a normal download: every step written down, ready with its shots", () => {
  it("look → download → cut, each with start and 'done in Xs — outcome'; ready; shots offered", async () => {
    const id = film(965_901);
    const lines: string[] = [];
    startYoutubeShotStock(id, [candidate("okVideo0001")], {
      workDir: workDir(),
      startFor: () => 0,
      download: writes,
      cut: cutInto(3),
      look: async () => ({ kind: "approved", windows: [{ startSec: 30, durationSec: 12 }] }),
      log: (l) => lines.push(l),
    });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "okVideo0001")?.status).toBe("ready");
    const said = lines.join("\n");
    for (const step of ["look", "download@30s", "cut@30s"]) {
      expect(said).toContain(`video=okVideo0001 step=${step} start`);
      expect(said).toMatch(new RegExp(`video=okVideo0001 step=${step} done in \\d+\\.\\ds — `));
    }
    expect(said).toMatch(/step=look done in [\d.]+s — approved \(1 section\(s\)\)/);
    expect(said).toMatch(/step=download@30s done in [\d.]+s — file arrived/);
    expect(said).toMatch(/step=cut@30s done in [\d.]+s — 3 shot\(s\)/);
    expect(said).toMatch(/video=okVideo0001 ready in \d+s — 3 shot\(s\)/);
    expect(said).not.toContain("TIMEOUT");
    const took = await takeStockShots(id, "okVideo0001", 0, () => false, 3);
    expect(took.shots.map((s) => s.sourceStartSec)).toEqual([30, 36, 42]);
  });
});

describe("VIDEO 659 fix B — a video that hangs is stopped at its deadline", () => {
  it("a hanging download: failed naming the step, waiters released, never ready, the next video still goes", async () => {
    const id = film(965_902);
    const lines: string[] = [];
    const hang = gate<boolean>();
    const dir = workDir();
    startYoutubeShotStock(id, [candidate("hangVideo01"), candidate("nextVideo01")], {
      workDir: dir,
      startFor: () => 0,
      download: async (videoId, s, d, out, title) => (videoId === "hangVideo01" ? hang.p : writes(videoId, s, d, out, title)),
      cut: cutInto(2),
      look: async () => ({ kind: "approved", windows: [{ startSec: 60, durationSec: 12 }] }),
      log: (l) => lines.push(l),
      videoDeadlineMs: 150,
    });
    /** A beat that waits for it is released by the deadline, not left waiting. */
    const t0 = Date.now();
    const took = await takeStockShots(id, "hangVideo01", 5_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(took).toEqual({ shots: [], reason: "download_failed" });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "hangVideo01")?.status).toBe("failed");
    expect(stockVideoState(id, "nextVideo01")?.status).toBe("ready");
    const said = lines.join("\n");
    expect(said).toMatch(/video=hangVideo01 TIMEOUT after 0s — stuck in download@60s for [\d.]+s; stopped and cleaned up/);
    expect(said).toMatch(/video=hangVideo01 failed in \d+s — took longer than 0s — stuck in download@60s/);
    hang.open(false);
  });

  it("a look that hangs is named as the stuck step", async () => {
    const id = film(965_903);
    const lines: string[] = [];
    startYoutubeShotStock(id, [candidate("lookHangs01")], {
      workDir: workDir(),
      startFor: () => 0,
      download: writes,
      cut: cutInto(1),
      look: () => new Promise(() => undefined),
      log: (l) => lines.push(l),
      videoDeadlineMs: 100,
    });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "lookHangs01")?.status).toBe("failed");
    expect(lines.join("\n")).toMatch(/video=lookHangs01 TIMEOUT .* stuck in look for [\d.]+s/);
  });

  it("cleanup: the late download and cut neither add shots nor mark it ready, and its files are removed", async () => {
    const id = film(965_904);
    const lines: string[] = [];
    const late = gate<boolean>();
    const dir = workDir();
    let cuts = 0;
    startYoutubeShotStock(id, [candidate("lateVideo01")], {
      workDir: dir,
      startFor: () => 0,
      download: async (_id, _s, _d, out) => {
        fs.writeFileSync(out, "partial");
        return late.p;
      },
      cut: async (f, d) => {
        cuts++;
        return cutInto(4)(f, d);
      },
      log: (l) => lines.push(l),
      videoDeadlineMs: 100,
    });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "lateVideo01")?.status).toBe("failed");
    /** The partly written file is gone at the timeout. */
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("ytstock_lateVideo01"))).toEqual([]);
    /** Now the download "finishes" late, with a file. */
    fs.writeFileSync(path.join(dir, "ytstock_lateVideo01_0.mp4"), "late");
    late.open(true);
    await sleep(30);
    expect(cuts).toBe(0);
    expect(stockVideoState(id, "lateVideo01")?.status).toBe("failed");
    expect(stockSummary(id)).toMatchObject({ ready: 0, failed: 1, shots: 0 });
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("ytstock_lateVideo01"))).toEqual([]);
    /** Logged once as failed: no second outcome after the late answer. */
    expect(lines.filter((l) => /video=lateVideo01 (ready|failed) in/.test(l))).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/video=lateVideo01 step=download@0s done/);
  });

  it("a hanging cut is stopped too; no shots reach the stock", async () => {
    const id = film(965_905);
    const lines: string[] = [];
    startYoutubeShotStock(id, [candidate("cutHangs001")], {
      workDir: workDir(),
      startFor: () => 0,
      download: writes,
      cut: () => new Promise(() => undefined),
      log: (l) => lines.push(l),
      videoDeadlineMs: 100,
    });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "cutHangs001")?.status).toBe("failed");
    expect(lines.join("\n")).toMatch(/video=cutHangs001 TIMEOUT .* stuck in cut@0s/);
    expect(stockSummary(id).shots).toBe(0);
  });
});

describe("VIDEO 659 fix C — at most six downloads at once, for the whole stock", () => {
  it("the counting gate never runs more than n, and runs them all", async () => {
    const slots = createSlots(6);
    let now = 0;
    let most = 0;
    const done = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        slots.run(async () => {
          now++;
          most = Math.max(most, now);
          await sleep(2 + (i % 3));
          now--;
          return i;
        })
      )
    );
    expect(most).toBe(6);
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(slots.active()).toBe(0);
  });

  it("three videos with three approved sections each: never more than six downloads at the same moment", async () => {
    expect(STOCK_DOWNLOADS_AT_ONCE).toBe(6);
    expect(STOCK_CONCURRENCY).toBe(3);
    const id = film(965_906);
    let now = 0;
    let most = 0;
    const seen: string[] = [];
    startYoutubeShotStock(id, ["multiSect01", "multiSect02", "multiSect03"].map(candidate), {
      workDir: workDir(),
      startFor: () => 0,
      download: async (videoId, s, _d, out) => {
        seen.push(`${videoId}@${s}`);
        now++;
        most = Math.max(most, now);
        await sleep(15);
        now--;
        fs.writeFileSync(out, "x");
        return true;
      },
      cut: cutInto(1),
      look: async () => ({ kind: "approved", windows: [0, 100, 200].map((startSec) => ({ startSec, durationSec: 10 })) }),
      log: () => {},
    });
    await youtubeStockSettled(id);
    expect(most).toBe(6);
    /** Nine sections, each downloaded once, none twice, each into its own video's file. */
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(stockSummary(id)).toMatchObject({ ready: 3, shots: 9 });
    for (const v of ["multiSect01", "multiSect02", "multiSect03"]) {
      const took = await takeStockShots(id, v, 0, () => false, 3);
      expect(took.shots.map((s) => s.videoId)).toEqual([v, v, v]);
      expect(took.shots.every((s) => s.path.includes(`ytstock_${v}_shots`))).toBe(true);
    }
  });

  it("partial failures: a section that fails leaves the others; a video that fails leaves the other videos", async () => {
    const id = film(965_907);
    startYoutubeShotStock(id, ["partVideo01", "deadVideo01"].map(candidate), {
      workDir: workDir(),
      startFor: () => 0,
      download: async (videoId, s, _d, out) => {
        if (videoId === "deadVideo01") return false;
        if (s === 100) throw new Error("proxy reset");
        fs.writeFileSync(out, "x");
        return true;
      },
      cut: cutInto(2),
      look: async () => ({ kind: "approved", windows: [0, 100, 200].map((startSec) => ({ startSec, durationSec: 10 })) }),
      log: () => {},
    });
    await youtubeStockSettled(id);
    expect(stockVideoState(id, "partVideo01")?.status).toBe("ready");
    expect(stockVideoState(id, "deadVideo01")?.status).toBe("failed");
    const took = await takeStockShots(id, "partVideo01", 0, () => false, 4);
    expect(took.shots.map((s) => s.sourceStartSec).sort((a, b) => a - b)).toEqual([0, 6, 200, 206]);
  });

  it("videos that timed out give their download slots back: the next videos still get six at once", async () => {
    const id = film(965_908);
    let now = 0;
    let most = 0;
    const order: string[] = [];
    /** Two videos hang in their downloads (all six slots), a third hangs in its look; the free ones come after. */
    const stuck = ["stuckDown01", "stuckDown02", "stuckLook01"];
    const free = ["freeVideo01", "freeVideo02", "freeVideo03"];
    startYoutubeShotStock(id, [...stuck.map((v) => ({ ...candidate(v), serves: 9 })), ...free.map(candidate)], {
      workDir: workDir(),
      startFor: () => 0,
      download: async (videoId, _s, _d, out) => {
        if (videoId.startsWith("stuckDown")) return new Promise<boolean>(() => undefined);
        now++;
        most = Math.max(most, now);
        await sleep(20);
        now--;
        fs.writeFileSync(out, "x");
        return true;
      },
      cut: cutInto(1),
      look: async (c) => {
        order.push(c.videoId);
        if (c.videoId === "stuckLook01") return new Promise(() => undefined);
        return { kind: "approved", windows: [0, 100, 200].map((startSec) => ({ startSec, durationSec: 10 })) };
      },
      log: () => {},
      videoDeadlineMs: 120,
    });
    await youtubeStockSettled(id);
    expect(order.slice(0, 3).sort()).toEqual([...stuck].sort());
    for (const v of stuck) expect(stockVideoState(id, v)?.status).toBe("failed");
    /** Without the slots given back the free videos would wait for the hung downloads forever. */
    for (const v of free) expect(stockVideoState(id, v)?.status).toBe("ready");
    expect(most).toBe(6);
  });
});

describe("VIDEO 659 fix C — eight sharp frames per video, four minutes for the whole stock", () => {
  it("at most eight sharp frames, one per sentence first", () => {
    expect(SHARP_MAX_FRAMES).toBe(8);
    const many = Array.from({ length: 30 }, (_, i) => ({ sec: i * 10, sentences: [i % 10] }));
    const secs = sharpCandidateSeconds(many);
    expect(secs).toHaveLength(8);
    expect(new Set(secs).size).toBe(8);
  });

  it("the picture stage waits at most four minutes for the stock — the same as one video's deadline", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("export const YOUTUBE_STOCK_WAIT_MAX_MS = 240_000;");
    expect(STOCK_VIDEO_DEADLINE_MS).toBe(240_000);
  });
});
