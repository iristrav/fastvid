import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
  it("caps concurrent execution at the configured limit", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("releases the slot when the wrapped function throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // If the slot wasn't released, this would hang until the test times out.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("releases the slot when the wrapped function rejects after an async delay (simulates a cancelled/timed-out ffmpeg call)", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("cancelled");
      })
    ).rejects.toThrow("cancelled");

    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("queues callers past the limit and runs them once a slot frees up", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = sem.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const second = sem.run(async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });
});
