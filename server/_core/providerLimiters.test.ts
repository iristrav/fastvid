import { describe, expect, it, afterEach } from "vitest";
import { providerLimiter } from "./providerLimiters";

describe("providerLimiter", () => {
  afterEach(() => {
    delete process.env.PROVIDER_CONCURRENCY_TESTPROV;
  });

  it("returns the same Semaphore instance for the same provider name", () => {
    const a = providerLimiter("pexels-test");
    const b = providerLimiter("pexels-test");
    expect(a).toBe(b);
  });

  it("returns independent limiters per provider", () => {
    const a = providerLimiter("wikimedia-test");
    const b = providerLimiter("pixabay-test");
    expect(a).not.toBe(b);
  });

  it("caps concurrent runs at the configured env limit", async () => {
    process.env.PROVIDER_CONCURRENCY_TESTPROV = "2";
    const sem = providerLimiter("testprov");
    let active = 0;
    let maxActive = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
      });
    await Promise.all([task(), task(), task(), task()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
