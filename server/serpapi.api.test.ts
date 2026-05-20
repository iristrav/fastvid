import { describe, it, expect } from "vitest";

describe("SerpAPI key validation", () => {
  it("should have SERPAPI_KEY set and return results from Google Images", async () => {
    const apiKey = process.env.SERPAPI_KEY;
    expect(apiKey, "SERPAPI_KEY must be set").toBeTruthy();

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_images");
    url.searchParams.set("q", "Kylie Jenner");
    url.searchParams.set("num", "3");
    url.searchParams.set("safe", "active");
    url.searchParams.set("api_key", apiKey!);

    const resp = await fetch(url.toString());
    expect(resp.status, `SerpAPI returned ${resp.status}`).toBe(200);

    const data = await resp.json() as { images_results?: unknown[] };
    expect(Array.isArray(data.images_results), "images_results should be an array").toBe(true);
    expect((data.images_results ?? []).length, "should return at least 1 image result").toBeGreaterThan(0);
  }, 20_000);
});
