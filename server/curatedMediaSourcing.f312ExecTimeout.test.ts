import { describe, expect, it, afterEach } from "vitest";

// F3-12 finding 3.1: curatedMediaSourcing.ts's own exec() wrapper had no timeout at all — a hung
// ffmpeg/ffprobe child process left its ffmpegSemaphore slot permanently held (Semaphore.run only
// releases in a `finally` once the wrapped call settles), and was never registered with any
// watchdog. exec() now passes Node's own child_process.exec `timeout` option (the same
// already-proven mechanism F3-06 established for execFile's ffprobe duration probe) — Node itself
// sends killSignal (default SIGTERM) to the child once it runs past timeoutMs, so the wrapped
// promise actually settles and the semaphore slot is freed instead of leaking forever.
//
// FFMPEG_CONCURRENCY_LIMIT is read once at module-load time by server/_core/semaphore.ts's
// module-level ffmpegSemaphore singleton, so it must be set to "1" before curatedMediaSourcing.ts
// (which imports that singleton) is ever imported — this lets Test 3 prove slot-reuse
// deterministically (with the default of 3 slots, one leaked slot wouldn't visibly block a second
// command).
process.env.FFMPEG_CONCURRENCY_LIMIT = "1";

import { exec } from "./curatedMediaSourcing";
import { ffmpegSemaphore } from "./_core/semaphore";

async function waitForSemaphoreIdle(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ffmpegSemaphore.active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("curatedMediaSourcing exec() timeout (F3-12 finding 3.1)", () => {
  afterEach(async () => {
    await waitForSemaphoreIdle();
  });

  it("Test 1 — a normal, fast command still resolves correctly and releases its semaphore slot", async () => {
    expect(ffmpegSemaphore.active).toBe(0);

    const { stdout } = await exec("echo test123", 5_000);

    expect(stdout.trim()).toBe("test123");
    await waitForSemaphoreIdle();
    expect(ffmpegSemaphore.active).toBe(0);
  });

  it("Test 2 — a genuinely hung command is killed by the timeout, not left as an orphan", async () => {
    const start = Date.now();

    // Same shell-builtin infinite loop used by the existing F3-07 hang test (no subprocess
    // spawn) — SIGTERM to the shell itself terminates it immediately, unlike e.g. `sleep 5`,
    // where killing the /bin/sh wrapper orphans the `sleep` grandchild.
    await expect(exec("while :; do :; done", 300)).rejects.toThrow();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000); // killed well before it would ever finish on its own

    // SIGTERM delivery + process reap is a real async OS event — the semaphore's own `finally`
    // fires the instant execRaw's promise rejects, but that rejection itself lands a beat after
    // the kill signal is actually delivered and reaped.
    await waitForSemaphoreIdle();
    expect(ffmpegSemaphore.active).toBe(0);
  });

  it("Test 3 — the semaphore slot freed by a killed command is usable by the next command", async () => {
    // FFMPEG_CONCURRENCY_LIMIT=1 — command B can only succeed if command A's slot was actually
    // released (not merely abandoned) once A's timeout fires. A is started first, so it
    // synchronously claims the single slot before B's call is ever made; B then queues behind it.
    const a = exec("while :; do :; done", 300).catch((err) => err as Error);
    const b = exec("echo ok", 5_000);

    const [aResult, bResult] = await Promise.all([a, b]);

    expect(aResult).toBeInstanceOf(Error);
    expect(bResult.stdout.trim()).toBe("ok");
    await waitForSemaphoreIdle();
    expect(ffmpegSemaphore.active).toBe(0);
  });
});
