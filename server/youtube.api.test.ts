import { describe, it, expect } from "vitest";

describe("YouTube Data API v3 key validation", () => {
  it("should return CC-licensed search results for a test query", async () => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    expect(apiKey, "YOUTUBE_API_KEY must be set").toBeTruthy();

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("key", apiKey!);
    url.searchParams.set("q", "nature documentary");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoLicense", "creativeCommon");
    url.searchParams.set("maxResults", "3");
    url.searchParams.set("part", "snippet");

    const resp = await fetch(url.toString());
    expect(resp.status, `YouTube API returned ${resp.status}`).toBe(200);

    const data = await resp.json() as { items?: unknown[] };
    expect(Array.isArray(data.items), "Response should have items array").toBe(true);
    expect((data.items ?? []).length).toBeGreaterThan(0);
  }, 15_000);
});
