/**
 * RONDE 133 — a cache hit is held to the same technical standard as a download.
 *
 * ── The bug ───────────────────────────────────────────────────────────────────────────────────
 *
 * downloadAndTrimPoolCandidate had its byte floor INSIDE the download branch:
 *
 *     const fromCache = await tryRestoreFromMediaCache(candidate.remoteUrl, rawPath);
 *     if (!fromCache) {
 *       ...fetch...
 *       if (fs.statSync(rawPath).size < 50_000) return null;   ← only here
 *       void reportToMediaCache(...);
 *     }
 *
 * The media cache is keyed by SOURCE URL and is shared by every route in the pipeline, and the
 * routes do not agree on a floor. fetchWikimediaImages admits a Commons file at 10 000 bytes and
 * writes it straight into that cache. The same file, reached later through the pool route, came
 * back as a cache HIT — and skipped the 50 000-byte floor entirely.
 *
 * One asset, two technical standards, decided by nothing but which route happened to see it
 * first. That is question 10 of the round ("do all providers get the same technical treatment")
 * answered wrong by an `if`.
 *
 * ── How this is tested ────────────────────────────────────────────────────────────────────────
 *
 * The real cache needs S3 and a database, neither of which exists here, and
 * tryRestoreFromMediaCache returns false without them — so the buggy branch would never even be
 * entered. The module is therefore replaced with one that always HITS and writes a deliberately
 * undersized file, which is exactly the state the real cache can be in. Everything downstream is
 * the real, exported function.
 *
 * A positional assertion (is the check inside the if-block?) was tried first and proved too weak:
 * it survived a mutation that kept the line where it was and fed it a value that could not fail.
 * This calls the function and reads its answer.
 */
import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

const hoisted = vi.hoisted(() => ({
  /** Bytes the fake cache hands back for every restore. Set per test. */
  payload: null as Buffer | null,
  restores: 0,
}));

vi.mock("./mediaCache", () => ({
  tryRestoreFromMediaCache: async (_url: string, destPath: string) => {
    if (!hoisted.payload) return false;
    hoisted.restores++;
    const nodeFs = require("fs") as typeof import("fs");
    nodeFs.writeFileSync(destPath, hoisted.payload);
    return true;
  },
  reportToMediaCache: async () => {},
}));

import { downloadAndTrimPoolCandidate } from "./videoPipeline";
import type { PoolCandidate } from "./scenePool";

let dir = "";
let tinyJpg: Buffer;
let goodJpg: Buffer;

beforeAll(() => {
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r133-cache-seed-"));
  const tiny = path.join(seed, "tiny.jpg");
  const good = path.join(seed, "good.jpg");
  /**
   * The fixture has to isolate the BYTE floor, and a first attempt at it did not.
   *
   * A 220×165 thumbnail is both too small in bytes AND too narrow in pixels, so bypassing the byte
   * floor still left the resolution rule to catch it — the test passed while proving nothing about
   * the bypass. A mutation put the floor back inside `if (!fromCache)` and the test stayed green.
   *
   * This is a smooth 1600-pixel gradient: WIDE enough to clear the resolution rule outright, and
   * compressible enough to land under 50 000 bytes. The byte floor is then the only thing in the
   * pipeline that can refuse it.
   */
  execSync(`ffmpeg -y -f lavfi -i "gradients=s=1600x1200:n=2" -frames:v 1 -q:v 6 "${tiny}" 2>/dev/null`);
  execSync(`ffmpeg -y -f lavfi -i "nullsrc=s=1600x1200,geq=random(1)*255:128:128" -frames:v 1 -q:v 3 "${good}" 2>/dev/null`);
  tinyJpg = fs.readFileSync(tiny);
  goodJpg = fs.readFileSync(good);
  fs.rmSync(seed, { recursive: true, force: true });
});

afterEach(() => {
  hoisted.payload = null;
  hoisted.restores = 0;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function candidate(): PoolCandidate {
  return {
    id: "wikimedia:r133-cache",
    assetId: "r133-cached-still",
    source: "wikimedia",
    remoteUrl: "https://upload.wikimedia.org/never-fetched-in-this-test.jpg",
    thumbnailUrl: null,
    title: "cached still",
    description: null,
    tags: [],
    mediaType: "image",
    durationSec: null,
    license: null,
    width: 4000,
    height: 3000,
    clipSimilarity: null,
    embeddingSimilarity: null,
    rankingScore: null,
    visionScore: null,
    selectionScore: null,
  } as PoolCandidate;
}

describe("RONDE 133 — the media cache cannot smuggle a file past the technical gate", () => {
  it("the fixture isolates the byte floor: under 50 000 bytes, but 1600px wide", () => {
    /**
     * Measured rather than assumed, and it is the whole validity of the test below. Over the pool
     * floor and this stops testing the bypass; under the resolution threshold and the resolution
     * rule would catch the file regardless, which is how the first version of this test managed to
     * stay green against a mutation that restored the bug.
     */
    expect(tinyJpg.length).toBeGreaterThan(10_000); // a file fetchWikimediaImages would cache
    expect(tinyJpg.length).toBeLessThan(50_000); // ...and the pool route must refuse
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r133-width-"));
    const p = path.join(seed, "w.jpg");
    fs.writeFileSync(p, tinyJpg);
    const w = parseInt(
      execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${p}"`)
        .toString()
        .trim(),
      10
    );
    fs.rmSync(seed, { recursive: true, force: true });
    expect(w, "the fixture must clear the resolution rule on its own").toBeGreaterThanOrEqual(960);
  });

  it("THE BUG: an undersized file restored from cache is refused, not adopted", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-cache-tiny-"));
    hoisted.payload = tinyJpg;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let out: string | null;
    try {
      out = await downloadAndTrimPoolCandidate(candidate(), dir, 4, 0, 4);
    } finally {
      warn.mockRestore();
    }
    expect(hoisted.restores, "the cache branch was not exercised").toBe(1);
    expect(out, "a cache hit skipped the byte floor").toBeNull();
  }, 60_000);

  it("...and says so, with the same reason a fresh download would give", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-cache-log-"));
    hoisted.payload = tinyJpg;
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await downloadAndTrimPoolCandidate(candidate(), dir, 4, 0, 4);
    } finally {
      warn.mockRestore();
    }
    const reject = lines.find((l) => l.includes("[TechnicalGate] REJECT"));
    expect(reject, `no reject line in:\n${lines.join("\n")}`).toBeTruthy();
    expect(reject!).toContain("reason=file_too_small");
  }, 60_000);

  it("a cache hit that IS technically fine still produces a clip", async () => {
    /**
     * The fix must not turn the cache into a rejection machine — a cache hit is the fast path and
     * has to keep working. This is the other half of the guarantee.
     */
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-cache-good-"));
    hoisted.payload = goodJpg;
    const out = await downloadAndTrimPoolCandidate(candidate(), dir, 4, 0, 4);
    expect(hoisted.restores).toBe(1);
    expect(out, "a valid cache hit must still be usable").toBeTruthy();
    expect(fs.existsSync(out!)).toBe(true);
  }, 120_000);

  it("RONDE 134 — a cached VIDEO gets the same resolution rule as a fresh download", async () => {
    /**
     * Point 5 of RONDE 134: a file may not be judged differently because of the route it arrived
     * through. The video resolution check sits after the cache branch for the same reason the byte
     * floor now does — a cache hit is a file, and a file gets measured.
     */
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r134-cache-video-"));
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r134-cache-seed-"));
    const p = path.join(seed, "tiny.mp4");
    execSync(
      `ffmpeg -y -f lavfi -i "nullsrc=s=128x96,geq=random(1)*255:128:128" -t 4 -c:v libx264 -pix_fmt yuv420p "${p}" 2>/dev/null`
    );
    hoisted.payload = fs.readFileSync(p);
    fs.rmSync(seed, { recursive: true, force: true });
    // Above the byte floor, so only the RESOLUTION rule can refuse it.
    expect(hoisted.payload.length).toBeGreaterThan(50_000);

    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let out: string | null;
    try {
      out = await downloadAndTrimPoolCandidate(
        { ...candidate(), mediaType: "video", durationSec: 30 } as PoolCandidate,
        dir, 5, 0, 4
      );
    } finally {
      warn.mockRestore();
    }
    expect(hoisted.restores).toBe(1);
    expect(out, "a cache hit skipped the video resolution rule").toBeNull();
    const reject = lines.find((l) => l.includes("[TechnicalGate] REJECT"));
    expect(reject!).toContain("reason=video_too_low_res");
    expect(reject!).toContain("type=video");
  }, 120_000);

  it("a cached file that is big enough but too LOW-RES is refused on resolution, not size", async () => {
    /**
     * Both floors now apply to a cache hit, and they are distinguishable in the log — which is
     * what makes a render's technical rejections readable afterwards instead of a single
     * undifferentiated "candidate went away".
     */
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-cache-lowres-"));
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r133-lowres-seed-"));
    const p = path.join(seed, "lowres.jpg");
    execSync(`ffmpeg -y -f lavfi -i "nullsrc=s=320x240,geq=random(1)*255:128:128" -frames:v 1 -q:v 1 "${p}" 2>/dev/null`);
    hoisted.payload = fs.readFileSync(p);
    fs.rmSync(seed, { recursive: true, force: true });
    expect(hoisted.payload.length).toBeGreaterThan(50_000);

    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let out: string | null;
    try {
      out = await downloadAndTrimPoolCandidate(candidate(), dir, 4, 0, 4);
    } finally {
      warn.mockRestore();
    }
    expect(out).toBeNull();
    const reject = lines.find((l) => l.includes("[TechnicalGate] REJECT"));
    expect(reject!).toContain("reason=still_too_low_res");
  }, 60_000);
});
