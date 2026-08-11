import { describe, expect, it, vi } from "vitest";
import { withSceneFetchTimeout, exec } from "./videoPipeline";

// F3-22: production evidence showed 12x "[withSceneFetchTimeout] Killed 1 orphaned child
// process(es) for: luma <file>@<t>[:<region>]" — logged by probeClipMeanLuma/
// probeClipRegionMeanLuma (local ffmpeg black-bar/luminance probing, not third-party "Luma AI"),
// each wrapped in withSceneFetchTimeout(..., 10_000, "luma ..."). Code inspection traced the full
// mechanism: execFileRaw (used by the luma probes) and execRaw (used by exec()) both register
// their spawned ChildProcess into the active scope's `children` Set synchronously, right after
// spawn, and remove it again in the exec callback on natural completion. On scope timeout,
// hardAbortScope() SIGKILLs every still-registered child and logs exactly this line. That log
// line firing IS this mechanism working as designed (catching a child that hadn't finished by
// the deadline) — not evidence that registration, ownership, or cleanup is broken. Per the task's
// explicit instruction, no production code fix was made; these tests exist to prove invariants
// A-E hold for the existing mechanism.
//
// execFileRaw itself is module-private, but it registers/cleans up through the exact same
// scope.children Set and hardAbortScope() as execRaw (which backs the exported exec()) — so
// exercising exec() here exercises the identical registration/cancellation/cleanup mechanism the
// luma probes depend on, just via the shell-string spawn path instead of execFile. Real child
// processes and real timing throughout, no mocking of the scope/cancellation machinery itself.
describe("scene-fetch-scope child-process registration and cleanup (F3-22)", () => {
  it("Test A/B — a started child process is registered with the active scope, and scene timeout kills it (logged exactly like production)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        withSceneFetchTimeout(() => exec("sleep 5"), 250, "luma test-clip.mp4@1.5")
      ).rejects.toThrow(/exceeded/);

      const killLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("[withSceneFetchTimeout] Killed"));
      expect(killLines).toHaveLength(1);
      // Same shape as the real production log line, proving the child was registered (killedCount
      // can only be >0 if it was found in scope.children) and that the kill path ran.
      expect(killLines[0]).toBe("[withSceneFetchTimeout] Killed 1 orphaned child process(es) for: luma test-clip.mp4@1.5");
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("Test C — cleanup is idempotent: two children in the same timed-out scope are each killed exactly once, not double-counted or double-logged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        withSceneFetchTimeout(async () => {
          // Two independent, overlapping child processes registered into the same scope.
          const a = exec("sleep 5").catch(() => {});
          const b = exec("sleep 5").catch(() => {});
          await Promise.all([a, b]);
        }, 250, "luma test-clip-two.mp4@2.0")
      ).rejects.toThrow(/exceeded/);

      const killLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("[withSceneFetchTimeout] Killed"));
      // Exactly one summary log, reporting exactly 2 kills — not 1 (undercount/leak) and not >2
      // (double-kill/double-count of the same child).
      expect(killLines).toHaveLength(1);
      expect(killLines[0]).toBe("[withSceneFetchTimeout] Killed 2 orphaned child process(es) for: luma test-clip-two.mp4@2.0");
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("Test D — a normal, successful run within budget is not prematurely killed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await withSceneFetchTimeout(
        () => exec("echo luma-probe-ok"),
        5_000,
        "luma test-clip-ok.mp4@0.5"
      );
      expect(result.stdout.trim()).toBe("luma-probe-ok");
      const killLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("[withSceneFetchTimeout] Killed"));
      expect(killLines).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, 10_000);

  it("Test E — no orphaned child-process reference lingers after natural completion: a child that finished before an enclosing scope times out is not re-reported as killed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        withSceneFetchTimeout(async () => {
          // This child finishes quickly and naturally — execRaw's callback removes it from
          // scope.children on completion, well before the outer 300ms deadline below.
          await exec("echo done-early");
          // Now hang past the outer scope's deadline with no further children registered.
          await new Promise((r) => setTimeout(r, 1_000));
        }, 300, "luma test-clip-early.mp4@0.1")
      ).rejects.toThrow(/exceeded/);

      const killLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("[withSceneFetchTimeout] Killed"));
      // The already-completed child must not still be sitting in scope.children waiting to be
      // (incorrectly) "killed" when the scope times out — zero kills expected, not one.
      expect(killLines).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);
});
