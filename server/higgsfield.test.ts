/**
 * Higgsfield API credentials validation test
 */
import { describe, it, expect } from "vitest";

// RONDE 30: live credential check — skips without credentials instead of failing. See the note
// in youtube.api.test.ts.
//
// Worth knowing before anyone reconfigures this: the Higgsfield helpers this file imports
// (generateImage, isHiggsfieldAvailable) have no callers in production code at all — the
// dead-code sweep found the whole provider unwired. So even with credentials set, nothing in a
// render would use it. The test is kept rather than deleted because the decision to drop the
// provider entirely has not been made.
const hasCreds = Boolean(
  process.env.HIGGSFIELD_API_KEY?.trim() && process.env.HIGGSFIELD_API_SECRET?.trim()
);

describe.skipIf(!hasCreds)("Higgsfield API Credentials", () => {
  it("should have Higgsfield API credentials set", () => {
    expect(process.env.HIGGSFIELD_API_KEY).toBeDefined();
    expect(process.env.HIGGSFIELD_API_SECRET).toBeDefined();
  });

  it("should have valid API key format", () => {
    const apiKey = process.env.HIGGSFIELD_API_KEY;
    // Higgsfield API keys are typically UUIDs
    expect(apiKey).toMatch(/^[a-f0-9\-]{36}$/i);
  });

  it("should have valid API secret format", () => {
    const apiSecret = process.env.HIGGSFIELD_API_SECRET;
    // Higgsfield API secrets are typically hex strings
    expect(apiSecret).toMatch(/^[a-f0-9]{64}$/i);
  });

  it("should be able to import Higgsfield helpers", async () => {
    const { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo, isHiggsfieldAvailable } =
      await import("./_core/higgsfieldVideo");

    expect(generateHiggsfieldTextToVideo).toBeDefined();
    expect(generateHiggsfieldImageToVideo).toBeDefined();
    expect(isHiggsfieldAvailable).toBeDefined();
  });

  it("should report Higgsfield as available with credentials", async () => {
    const { isHiggsfieldAvailable } = await import("./_core/higgsfieldVideo");
    expect(isHiggsfieldAvailable()).toBe(true);
  });
});
