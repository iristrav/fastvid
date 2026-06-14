import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfiguredAppUrl, resolveAppOrigin } from "./_core/appUrl";

describe("appUrl", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.APP_URL;
    delete process.env.PUBLIC_APP_URL;
  });

  afterEach(() => {
    process.env = env;
  });

  it("normalizes APP_URL without scheme", () => {
    process.env.APP_URL = "fastvid.app";
    expect(getConfiguredAppUrl()).toBe("https://fastvid.app");
  });

  it("prefers configured APP_URL over request headers", () => {
    process.env.APP_URL = "https://fastvid.app";
    const origin = resolveAppOrigin(
      { headers: { host: "fastvid-production-dd68.up.railway.app" }, protocol: "https" },
      "https://fastvid-production-dd68.up.railway.app"
    );
    expect(origin).toBe("https://fastvid.app");
  });

  it("falls back to request origin in dev", () => {
    const origin = resolveAppOrigin(
      { headers: { origin: "http://localhost:3000", host: "localhost:3000" }, protocol: "http" },
      null
    );
    expect(origin).toBe("http://localhost:3000");
  });
});
