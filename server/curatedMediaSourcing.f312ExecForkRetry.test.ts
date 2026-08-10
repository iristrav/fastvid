import { describe, expect, it, vi, beforeEach } from "vitest";

// F3-12 finding 3.1 (regression check): adding a timeout to exec() must not disturb its existing
// withForkRetry composition (EAGAIN/fork-pressure retry) — that behavior is explicitly required
// to stay intact. child_process is mocked at the promisify.custom boundary (same technique F3-06
// already used for execFile) so a transient EAGAIN can be simulated deterministically instead of
// needing a real fork-pressure condition, while also asserting the new `timeout` option is passed
// through on every retry attempt, not just the first.
const execPromiseMock = vi.fn();

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify: nodePromisify } = await import("util");
  const execFn = () => {
    throw new Error("callback-style exec should not be invoked directly in this mock");
  };
  (execFn as unknown as Record<symbol, unknown>)[nodePromisify.custom] = (
    command: string,
    options: unknown
  ) => execPromiseMock(command, options);
  return { ...actual, exec: execFn };
});

import { exec } from "./curatedMediaSourcing";

function eagainError(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn /bin/sh EAGAIN"), { code: "EAGAIN" });
}

describe("curatedMediaSourcing exec() retains withForkRetry (F3-12 regression check)", () => {
  beforeEach(() => {
    execPromiseMock.mockReset();
  });

  it("still retries on EAGAIN and eventually succeeds, with the timeout option passed through on every attempt", async () => {
    execPromiseMock
      .mockRejectedValueOnce(eagainError())
      .mockRejectedValueOnce(eagainError())
      .mockResolvedValueOnce({ stdout: "ok\n", stderr: "" });

    const result = await exec("echo ok", 5_000);

    expect(result.stdout).toBe("ok\n");
    expect(execPromiseMock).toHaveBeenCalledTimes(3);
    for (const call of execPromiseMock.mock.calls) {
      expect(call[1]).toMatchObject({ timeout: 5_000 });
    }
  }, 10_000); // withForkRetry sleeps 1500ms then 3000ms between the two retries
});
