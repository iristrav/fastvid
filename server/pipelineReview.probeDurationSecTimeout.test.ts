import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { reviewAssembledScenes, type SceneReviewInput } from "./pipelineReview";
import { ffmpegSemaphore } from "./_core/semaphore";

// F3-06: probeDurationSec's execFile(ffprobe, [...]) call now carries { timeout: 15_000 }, so a
// hung ffprobe child is SIGTERM'd by Node itself instead of leaking the ffmpegSemaphore slot it
// holds forever (Semaphore.run only releases once the wrapped fn settles). probeDurationSec
// itself stays module-private, so these tests drive it through the exported
// reviewAssembledScenes, which calls it once per scene when the assembly file exists.
//
// child_process is mocked at the promisify.custom boundary (the exact shape Node's real
// child_process.execFile exposes, and the one promisify(execFileCb) in pipelineReview.ts
// actually resolves to) so the "hang" can be simulated deterministically with vi.useFakeTimers()
// instead of a real 15-second wait, while still asserting the real { timeout: 15_000 } option is
// what reaches execFile.
const execFilePromiseMock = vi.fn();

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify: nodePromisify } = await import("util");
  const execFileFn = () => {
    throw new Error("callback-style execFile should not be invoked directly in this mock");
  };
  (execFileFn as unknown as Record<symbol, unknown>)[nodePromisify.custom] = (
    file: string,
    args: string[],
    options: unknown
  ) => execFilePromiseMock(file, args, options);
  return { ...actual, execFile: execFileFn };
});

function timeoutError(): Error {
  return Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
}

describe("probeDurationSec timeout (F3-06)", () => {
  let dir: string;
  let assemblyPath: string;
  let scenes: SceneReviewInput[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f306-test-"));
    assemblyPath = path.join(dir, "scene_0.mp4");
    fs.writeFileSync(assemblyPath, Buffer.alloc(2000, "v")); // > 1000 bytes so reviewAssembledScenes probes it
    scenes = [{ index: 0, text: "Test", duration: 6, clipPaths: [] }];
    execFilePromiseMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("returns duration 0 once the 15s execFile timeout fires on a hung ffprobe", async () => {
    vi.useFakeTimers();
    execFilePromiseMock.mockImplementation((_file, _args, options) => {
      expect(options).toEqual({ timeout: 15_000 });
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(timeoutError()), (options as { timeout: number }).timeout);
      });
    });

    const resultPromise = reviewAssembledScenes(scenes, [assemblyPath]);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;

    // probeDurationSec's existing catch { return 0; } means a 0 duration is treated as
    // "unknown" (probed > 0 guard) rather than raising a DURATION_DRIFT warning.
    expect(result.issues.some((i) => i.code === "DURATION_DRIFT")).toBe(false);
    expect(result.ok).toBe(true);
    expect(execFilePromiseMock).toHaveBeenCalledTimes(1);
  });

  it("still returns a real probed duration for a normal, successful ffprobe call", async () => {
    execFilePromiseMock.mockImplementation((_file, _args, options) => {
      expect(options).toEqual({ timeout: 15_000 });
      return Promise.resolve({ stdout: "12.30\n", stderr: "" });
    });

    const result = await reviewAssembledScenes(scenes, [assemblyPath]);

    const drift = result.issues.find((i) => i.code === "DURATION_DRIFT");
    expect(drift).toBeDefined();
    expect(drift!.message).toContain("12.3s");
  });

  it("releases the ffmpegSemaphore slot once the timeout rejects the hung probe", async () => {
    vi.useFakeTimers();
    execFilePromiseMock.mockImplementation((_file, _args, options) => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(timeoutError()), (options as { timeout: number }).timeout);
      });
    });

    expect(ffmpegSemaphore.active).toBe(0);
    const resultPromise = reviewAssembledScenes(scenes, [assemblyPath]);
    await vi.advanceTimersByTimeAsync(15_000);
    await resultPromise;

    expect(ffmpegSemaphore.active).toBe(0);
  });
});
