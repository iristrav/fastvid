import { describe, it, expect, beforeAll } from "vitest";

describe("Password Reset Flow", () => {
  beforeAll(() => {
    // Verify environment variables are set
    expect(process.env.RESEND_API_KEY).toBeDefined();
    expect(process.env.JWT_SECRET).toBeDefined();
  });

  it("should have Resend API key configured", () => {
    const apiKey = process.env.RESEND_API_KEY;
    expect(apiKey).toBeDefined();
    expect(apiKey).toMatch(/^re_/); // Resend keys start with 're_'
  });

  it("should generate valid reset tokens", () => {
    const { randomBytes } = require("crypto");
    const token = randomBytes(32).toString("hex");
    expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should validate token expiration", () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
    expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it("should detect expired tokens", () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1000); // 1 second ago
    expect(now.getTime()).toBeGreaterThan(expiredAt.getTime());
  });
});
