import { describe, it, expect } from "vitest";
import "dotenv/config";

/**
 * Pixabay API key validation test.
 * Makes a lightweight search request to confirm the key is valid.
 */
describe("Pixabay API", () => {
  it("should have PIXABAY_API_KEY set", () => {
    expect(process.env.PIXABAY_API_KEY).toBeTruthy();
  });

  it("should return video results for a test query", async () => {
    const key = process.env.PIXABAY_API_KEY;
    if (!key) {
      console.warn("[Test] PIXABAY_API_KEY not set — skipping live test");
      return;
    }

    const url = `https://pixabay.com/api/videos/?key=${key}&q=nature&per_page=3&video_type=film`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { totalHits?: number; hits?: unknown[] };
    expect(data).toHaveProperty("totalHits");
    expect(data).toHaveProperty("hits");
    expect(Array.isArray(data.hits)).toBe(true);
    console.log(`[Test] Pixabay API: totalHits=${data.totalHits}, returned ${data.hits?.length ?? 0} clips`);
  }, 15_000);
});
