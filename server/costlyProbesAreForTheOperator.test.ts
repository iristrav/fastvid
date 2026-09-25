import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { operatorKeyMatches, requireOperator } from "./_core/operatorOnly";
import {
  API_RATE_LIMIT_PER_MIN_DEFAULT,
  apiRateLimit,
  apiRateLimitPerMinute,
  isRateLimitedApiPath,
} from "./_core/apiRateLimit";

/**
 * RONDE 652 — `/api/health/youtube-probe` spent one of the day's 100 YouTube searches per
 * anonymous request; the Stability and LLM probes spent money the same way.
 */
const CORE = fs.readFileSync(path.join(__dirname, "_core/index.ts"), "utf8");
const WORKER = fs.readFileSync(path.join(__dirname, "worker.ts"), "utf8");

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
  };
  return res;
}

describe("the probes that cost quota or money ask who is calling", () => {
  it.each(["/api/health/youtube-probe", "/api/health/stability-probe", "/api/health/llm-smoke"])(
    "%s runs requireOperator before its handler",
    (route) => {
      expect(CORE).toContain(`app.get("${route}", requireOperator, async`);
    }
  );

  it("an anonymous request is refused before anything is spent", async () => {
    const next = vi.fn();
    const res = fakeRes();
    await requireOperator({ headers: {} } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("an external monitor may pass with the operator key, and only with the exact key", async () => {
    const key = "k".repeat(32);
    const prev = process.env.OPERATOR_PROBE_KEY;
    process.env.OPERATOR_PROBE_KEY = key;
    try {
      const next = vi.fn();
      await requireOperator({ headers: { "x-operator-key": key } } as never, fakeRes() as never, next);
      expect(next).toHaveBeenCalledTimes(1);

      const refused = vi.fn();
      const res = fakeRes();
      await requireOperator({ headers: { "x-operator-key": key.slice(1) + "x" } } as never, res as never, refused);
      expect(refused).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.OPERATOR_PROBE_KEY;
      else process.env.OPERATOR_PROBE_KEY = prev;
    }
  });

  it("a short or missing key never opens the door", () => {
    expect(operatorKeyMatches("abc", "abc")).toBe(false);
    expect(operatorKeyMatches("", undefined)).toBe(false);
    expect(operatorKeyMatches(undefined, "x".repeat(40))).toBe(false);
    expect(operatorKeyMatches("x".repeat(40), "x".repeat(40))).toBe(true);
  });
});

describe("every /api request has a per-client ceiling", () => {
  it("is mounted before the routes", () => {
    const at = CORE.indexOf("app.use(apiRateLimit);");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(CORE.indexOf("registerStripeWebhook(app);"));
    expect(at).toBeLessThan(CORE.indexOf('app.get("/api/health/youtube-probe"'));
  });

  it("leaves video bytes, event streams and the liveness probe alone", () => {
    expect(isRateLimitedApiPath("/api/trpc/video.list")).toBe(true);
    expect(isRateLimitedApiPath("/api/health/youtube-probe")).toBe(true);
    expect(isRateLimitedApiPath("/api/stream/video/12")).toBe(false);
    expect(isRateLimitedApiPath("/api/download/video/12")).toBe(false);
    expect(isRateLimitedApiPath("/api/events/video/12")).toBe(false);
    expect(isRateLimitedApiPath("/api/health/live")).toBe(false);
    expect(isRateLimitedApiPath("/dashboard")).toBe(false);
  });

  it("answers 429 once one client passes the ceiling", () => {
    const limit = apiRateLimitPerMinute({});
    expect(limit).toBe(API_RATE_LIMIT_PER_MIN_DEFAULT);
    const req = { path: "/api/trpc/x", ip: "203.0.113.77", headers: {} };
    let passed = 0;
    let last = fakeRes();
    for (let i = 0; i < limit + 5; i++) {
      last = fakeRes();
      apiRateLimit(req as never, last as never, () => {
        passed++;
      });
    }
    expect(passed).toBe(limit);
    expect(last.statusCode).toBe(429);
    expect(last.headers["Retry-After"]).toBe("60");
  });

  it("reads API_RATE_LIMIT_PER_MIN, bounded", () => {
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: "1200" })).toBe(1200);
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: "5" })).toBe(60);
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MIN: "many" })).toBe(API_RATE_LIMIT_PER_MIN_DEFAULT);
  });
});

describe("the worker's storage probe no longer names the storage account", () => {
  it("reports that an endpoint is configured, not which one", () => {
    const at = WORKER.indexOf('path === "/api/health/r2"');
    const handler = WORKER.slice(at, at + 2000);
    expect(handler).toContain("endpointConfigured: true");
    expect(handler).not.toMatch(/JSON\.stringify\(\{ status: "done", endpoint,/);
  });
});
