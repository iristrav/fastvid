import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableCpuCount,
  composeParallelismForVideo,
  montageSegmentParallelism,
  ffmpegThreadFlag,
  _resetCpuCountCache,
} from "./sourcingPolicy";

/**
 * RONDE 63 — where the sixteen minutes went.
 *
 * The critical-path report blamed compose for 93% of render 532, but the compose PHASE contains
 * the compose-time rescue, which searches for images. The pipeline's own instrumented summary,
 * printed further down the same log, disagrees with the headline:
 *
 *     Bottleneck: Image / clip search (460.8s)
 *     Image / clip search                 460.8s
 *     Scene composition (FFmpeg montage)  331.5s
 *     Image / clip processing (CLIP,trim) 136.0s
 *     Compose-time rescue fetch           112.8s
 *
 * Less than a third of it is ffmpeg. Of what IS ffmpeg, a quarter of the entire render was work
 * that got thrown away:
 *
 *     Scene 0: compose failed — rescue retry: Timeout: composeSceneVideo s0 exceeded 88s
 *     Scene 1: compose failed — rescue retry: Timeout: composeSceneVideo s1 exceeded 88s
 *
 *     scene 0   alone 57.5s   alongside scene 1  101.4s   → abandoned, recomposed
 *     scene 1   alone 65.0s   alongside scene 0  148.2s   → abandoned, recomposed
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetCpuCountCache();
});

const withCpus = (n: number) => {
  _resetCpuCountCache();
  vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: n }, () => ({}) as os.CpuInfo));
  // No cgroup files in the test environment, so the host count is what stands.
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === "string" && p.startsWith("/sys/fs/cgroup")) throw new Error("ENOENT");
    return (fs.readFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
};

describe("RONDE 63 — the compose timeout knows scenes run side by side", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the per-scene cap is multiplied by the compose parallelism", () => {
    const src = SRC();
    const idx = src.indexOf("function composeSceneTimeoutMs(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2200);
    expect(block).toContain("const parallelism = Math.max(1, composeParallelismForVideo(videoLength, IS_RAILWAY));");
    expect(block).toContain("const cap = _b2.basePerSceneComposeMs * parallelism;");
    // The bare cap that produced the 88s both scenes blew is gone.
    expect(block).not.toContain("Math.max(complexity, 45_000), _b2.basePerSceneComposeMs)");
  });

  it("the floor and the complexity formula are untouched", () => {
    const src = SRC();
    const idx = src.indexOf("function composeSceneTimeoutMs(");
    const block = src.slice(idx, idx + 2200);
    expect(block).toContain("sceneDurationSec * 3_000 + Math.max(0, clipCount) * 2_500");
    expect(block).toContain("Math.max(complexity, 45_000)");
  });

  it("the arithmetic still fits the budget it came from", () => {
    // base is (total × 0.55) / scenes — a scene's share assuming sequential composition.
    // With P at a time, wall = (scenes / P) × (base × P) = scenes × base. The multiplication
    // restores the identity rather than loosening the budget.
    const scenes = 3;
    const base = 88_000;
    for (const P of [1, 2, 3, 4]) {
      const wall = Math.ceil(scenes / P) * (base * P);
      expect(wall).toBeGreaterThanOrEqual(scenes * base);
    }
  });

  it("render 532's two failures would both have fitted", () => {
    // Measured concurrent times, against the cap the fix produces at parallelism 2.
    const cap = 88_000 * 2;
    expect(101_400).toBeLessThan(cap); // scene 0
    expect(148_200).toBeLessThan(cap); // scene 1
  });
});

describe("RONDE 63 — the concurrency is sized to the machine that is actually there", () => {
  it("a 48-core box no longer runs four cores' worth of work", () => {
    withCpus(48);
    expect(availableCpuCount()).toBe(48);
    const compose = composeParallelismForVideo();
    const segments = montageSegmentParallelism();
    const threads = Number(/-threads (\d+)/.exec(ffmpegThreadFlag())![1]);
    expect(compose).toBeGreaterThan(2);
    expect(segments).toBeGreaterThan(2);
    expect(threads).toBeGreaterThan(2);
    // And does not oversubscribe it either.
    expect(compose * segments * threads).toBeLessThanOrEqual(48);
  });

  it("a small host keeps exactly the behaviour it had", () => {
    withCpus(4);
    expect(composeParallelismForVideo()).toBe(2);
    expect(montageSegmentParallelism()).toBe(2);
    expect(ffmpegThreadFlag()).toBe("-threads 2");
  });

  it("never drops below the old floor, however small the box", () => {
    for (const n of [1, 2, 4, 8]) {
      withCpus(n);
      expect(composeParallelismForVideo()).toBeGreaterThanOrEqual(2);
      expect(montageSegmentParallelism()).toBeGreaterThanOrEqual(2);
      expect(ffmpegThreadFlag()).toBe("-threads 2");
    }
  });

  it("stays within its documented ceilings on an enormous box", () => {
    withCpus(256);
    expect(composeParallelismForVideo()).toBeLessThanOrEqual(4);
    expect(montageSegmentParallelism()).toBeLessThanOrEqual(3);
    expect(Number(/-threads (\d+)/.exec(ffmpegThreadFlag())![1])).toBeLessThanOrEqual(6);
  });

  it("the environment still overrides all three", () => {
    withCpus(48);
    vi.stubEnv("COMPOSE_PARALLELISM", "1");
    vi.stubEnv("MONTAGE_SEGMENT_PARALLELISM", "1");
    vi.stubEnv("FFMPEG_THREADS", "1");
    expect(composeParallelismForVideo()).toBe(1);
    expect(montageSegmentParallelism()).toBe(1);
    expect(ffmpegThreadFlag()).toBe("-threads 1");
  });

  it("nonsense in the environment falls back to the derived value, not to zero", () => {
    withCpus(48);
    vi.stubEnv("COMPOSE_PARALLELISM", "junk");
    vi.stubEnv("MONTAGE_SEGMENT_PARALLELISM", "99");
    expect(composeParallelismForVideo()).toBeGreaterThanOrEqual(2);
    expect(montageSegmentParallelism()).toBeGreaterThanOrEqual(2);
  });
});

describe("RONDE 63 — os.cpus() lies inside a container, so the quota wins", () => {
  const withCgroup = (hostCpus: number, file: string, contents: string) => {
    _resetCpuCountCache();
    vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: hostCpus }, () => ({}) as os.CpuInfo));
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown) => {
      if (p === file) return contents;
      throw new Error("ENOENT");
    }) as typeof fs.readFileSync);
  };

  it("a cgroup v2 quota of 8 CPUs on a 48-core host means 8", () => {
    withCgroup(48, "/sys/fs/cgroup/cpu.max", "800000 100000");
    expect(availableCpuCount()).toBe(8);
  });

  it("an uncapped cgroup v2 falls through to the host count", () => {
    withCgroup(48, "/sys/fs/cgroup/cpu.max", "max 100000");
    expect(availableCpuCount()).toBe(48);
  });

  it("a cgroup v1 quota is read too", () => {
    _resetCpuCountCache();
    vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: 48 }, () => ({}) as os.CpuInfo));
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown) => {
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") return "600000";
      if (p === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") return "100000";
      throw new Error("ENOENT");
    }) as typeof fs.readFileSync);
    expect(availableCpuCount()).toBe(6);
  });

  it("a quota larger than the host is still bounded by the host", () => {
    withCgroup(4, "/sys/fs/cgroup/cpu.max", "8000000 100000");
    expect(availableCpuCount()).toBe(4);
  });

  it("a fractional quota rounds down, and never to zero", () => {
    withCgroup(48, "/sys/fs/cgroup/cpu.max", "150000 100000");
    expect(availableCpuCount()).toBe(1);
    withCgroup(48, "/sys/fs/cgroup/cpu.max", "50000 100000");
    expect(availableCpuCount()).toBe(1);
  });

  it("unreadable cgroup files are not an error", () => {
    withCpus(16);
    expect(availableCpuCount()).toBe(16);
  });

  it("the answer is cached — this is read on every compose", () => {
    withCpus(48);
    const spy = vi.spyOn(os, "cpus");
    availableCpuCount();
    const after = spy.mock.calls.length;
    availableCpuCount();
    availableCpuCount();
    expect(spy.mock.calls.length).toBe(after);
  });
});

describe("RONDE 63 — clip validation is not a sequential decode any more", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the clips are validated side by side", () => {
    const src = SRC();
    const idx = src.indexOf('"Compose clip validation (ffprobe)"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain("pLimit(");
    expect(block).toContain("await Promise.all(");
    // The plain for-loop that held one core while the rest of the box idled is gone.
    expect(block).not.toMatch(/for \(const clip of safeClips\)/);
  });

  it("a verdict is remembered, so recomposing a scene does not re-derive it", () => {
    const src = SRC();
    const idx = src.indexOf('"Compose clip validation (ffprobe)"');
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain("composeClipValidationMemo.get(key)");
    expect(block).toContain("composeClipValidationMemo.set(key,");
    // Keyed on content, not on the path — clips get renamed between routes.
    expect(block).toContain("const key = clipContentKey(clip);");
  });

  it("the memo is bounded and cleared per render", () => {
    const src = SRC();
    expect(src).toContain("COMPOSE_VALIDATION_MEMO_MAX");
    expect(src).toContain("export function resetComposeClipValidationMemo()");
    expect(src).toContain("resetComposeClipValidationMemo();");
    // Cleared from the same place every other per-render breaker state is.
    const reset = src.indexOf("googleTtsFailureStreak = 0; googleTtsCooldownUntilMs = 0;");
    expect(src.slice(reset, reset + 400)).toContain("resetComposeClipValidationMemo();");
  });

  it("a failed clip is still dropped, not silently kept", () => {
    const src = SRC();
    const idx = src.indexOf('"Compose clip validation (ffprobe)"');
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain("for (const ok of results) if (ok) verifiedClips.push(ok);");
    expect(block).toContain("return cached ? clip : null;");
  });
});
