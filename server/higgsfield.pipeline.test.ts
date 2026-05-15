/**
 * Integration tests for Higgsfield in the video pipeline
 */
import { describe, it, expect } from "vitest";

describe("Higgsfield Pipeline Integration", () => {
  it("should have Higgsfield API credentials configured", () => {
    expect(process.env.HIGGSFIELD_API_KEY).toBeDefined();
    expect(process.env.HIGGSFIELD_API_SECRET).toBeDefined();
  });

  it("should be able to import Higgsfield generators", async () => {
    const { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo } =
      await import("./_core/higgsfieldVideo");

    expect(generateHiggsfieldTextToVideo).toBeDefined();
    expect(generateHiggsfieldImageToVideo).toBeDefined();
  });

  it("should have Higgsfield text-to-video function callable", async () => {
    const { generateHiggsfieldTextToVideo } = await import("./_core/higgsfieldVideo");

    // Function should be callable
    expect(typeof generateHiggsfieldTextToVideo).toBe("function");
  });

  it("should have Higgsfield image-to-video function callable", async () => {
    const { generateHiggsfieldImageToVideo } = await import("./_core/higgsfieldVideo");

    // Function should be callable
    expect(typeof generateHiggsfieldImageToVideo).toBe("function");
  });

  it("should have proper API key format validation", () => {
    const apiKey = process.env.HIGGSFIELD_API_KEY || "";
    const apiSecret = process.env.HIGGSFIELD_API_SECRET || "";

    // API key should be a UUID
    expect(apiKey).toMatch(/^[a-f0-9\-]{36}$/i);

    // API secret should be a hex string
    expect(apiSecret).toMatch(/^[a-f0-9]{64}$/i);
  });

  it("should support both text-to-video and image-to-video modes", async () => {
    const { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo } =
      await import("./_core/higgsfieldVideo");

    // Both functions should be callable
    expect(typeof generateHiggsfieldTextToVideo).toBe("function");
    expect(typeof generateHiggsfieldImageToVideo).toBe("function");
  });

  it("should maintain backward compatibility with existing generators", async () => {
    // Verify that other generators are still importable
    const { generateGrokVideo } = await import("./_core/grokVideo");
    const { generateVeoVideo } = await import("./_core/veoVideo");
    const { generateMetaMovieGen } = await import("./_core/metaMovieGen");

    expect(generateGrokVideo).toBeDefined();
    expect(generateVeoVideo).toBeDefined();
    expect(generateMetaMovieGen).toBeDefined();
  });

  it("should have isHiggsfieldAvailable helper function", async () => {
    const { isHiggsfieldAvailable } = await import("./_core/higgsfieldVideo");

    expect(typeof isHiggsfieldAvailable).toBe("function");
    expect(isHiggsfieldAvailable()).toBe(true);
  });
});
