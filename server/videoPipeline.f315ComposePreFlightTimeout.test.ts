import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { logComposePreFlight } from "./videoPipeline";
import { ffmpegSemaphore } from "./_core/semaphore";

// F3-15 finding 3.4: logComposePreFlight used to call execRaw() directly, bypassing
// ffmpegSemaphore entirely, wrapped in a bare Promise.race()/setTimeout "timeout" that gave up
// waiting after 5s without ever sending any kill signal. It now routes through the existing
// withSceneFetchTimeout(() => exec(...), 5_000, label) pattern (the same one already used at
// ~90 other call sites in this file), so the probe genuinely participates in ffmpegSemaphore's
// concurrency accounting and the call is genuinely bounded to ~5s instead of only the *caller*
// giving up while the work keeps running unbounded in the background.
//
// A named pipe (FIFO) with no writer is used to force a real, portable, OS-level block (open()
// on a FIFO for reading blocks until a writer appears) — this exercises the real ffprobe binary
// exactly as production does, without needing a mocked/replaced "ffprobe". This test asserts on
// what the F3-15 diff actually guarantees (semaphore participation, bounded completion time, no
// throw) and does not assert that the underlying OS process is provably reaped, since that is a
// property of execRaw's own spawn/kill model (shared by ~90 other pre-existing call sites) and
// explicitly out of scope for this finding.
describe("logComposePreFlight timeout + semaphore participation (F3-15 finding 3.4)", () => {
  let dir: string;
  let fifoPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f315-test-"));
    fifoPath = path.join(dir, "clip.mp4");
    execSync(`mkfifo "${fifoPath}"`);
  });

  afterAll(() => {
    // Best-effort: unblock any leftover reader still waiting on the FIFO so it can exit, instead
    // of leaving an orphaned background process after the test run.
    try {
      const fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.closeSync(fd);
    } catch { /* no reader left waiting — nothing to unblock */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("participates in ffmpegSemaphore while probing a blocked clip (no longer bypasses it) and resolves within the bounded ~5s budget instead of hanging indefinitely", async () => {
    expect(ffmpegSemaphore.active).toBe(0);
    const start = Date.now();
    const promise = logComposePreFlight(0, [fifoPath], path.join(dir, "out.mp4"), "-preset veryfast -crf 18 -c:v libx264");

    // Give the probe a moment to actually spawn and acquire its ffmpegSemaphore slot.
    await new Promise((r) => setTimeout(r, 500));
    expect(ffmpegSemaphore.active).toBeGreaterThan(0);

    await expect(promise).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    // Bounded near the existing 5s budget, not left hanging for as long as the FIFO stays
    // unopened (which, without this fix, would be indefinite).
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);
});
