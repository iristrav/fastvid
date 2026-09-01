/**
 * RONDE 136 — the Wikimedia imageinfo batch, called for real.
 *
 * Separate from ronde136SourcingRepair.test.ts because it has to replace node-fetch for the whole
 * module graph: `fetch` is a module binding (`import fetch from "node-fetch"`), not globalThis, so
 * it cannot be spied on per-test — and the URL is Commons' own, so a local server cannot stand in.
 *
 * What is being proven is the measurable claim behind the fix: 25 titles cost ONE request. In
 * video 558 the same 25 titles cost 25, Commons answered 429 thirty-two times, the provider was
 * stood down 34 times, and the render ended with 38 Wikimedia results and zero downloads.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  calls: [] as string[],
  respond: null as null | ((url: string) => { status: number; body: unknown }),
}));

vi.mock("node-fetch", () => ({
  default: async (url: string) => {
    hoisted.calls.push(String(url));
    const r = hoisted.respond?.(String(url)) ?? { status: 200, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "",
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  },
}));

import { fetchWikimediaImageInfoBatch, WIKIMEDIA_IMAGEINFO_BATCH_SIZE } from "./videoPipeline";

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.respond = null;
});

describe("RONDE 136 — one request for a whole batch of titles", () => {
  it("THE FIX: 25 titles cost ONE request, and every title resolves", async () => {
    const titles = Array.from({ length: 25 }, (_, i) => `File:Test_${i}.jpg`);
    hoisted.respond = () => {
      const pages: Record<string, unknown> = {};
      titles.forEach((t, i) => {
        pages[String(i)] = {
          title: t,
          imageinfo: [{ url: `https://upload.wikimedia.org/${i}.jpg`, mime: "image/jpeg", size: 200_000 }],
        };
      });
      return { status: 200, body: { query: { pages } } };
    };

    const map = await fetchWikimediaImageInfoBatch(titles, 0);

    expect(hoisted.calls.length, "25 titles must not cost 25 requests").toBe(1);
    expect(hoisted.calls[0]).toContain("prop=imageinfo");
    // The pipe-separated multi-title form, URL-encoded.
    expect(decodeURIComponent(hoisted.calls[0]!)).toContain("File:Test_0.jpg|File:Test_1.jpg");
    for (const t of titles) {
      expect(map.get(t)?.url, `no imageinfo for ${t}`).toBeTruthy();
    }
  });

  it("MediaWiki's own normalisation is applied back, so the caller's key still finds it", async () => {
    /**
     * MediaWiki rewrites underscores to spaces and capitalises the first letter, reporting what it
     * changed in `query.normalized`. Skipping that mapping would make every batched answer
     * unfindable under the name the caller holds — a quieter version of the bug being replaced,
     * and one that would look exactly like "Wikimedia returned nothing" all over again.
     */
    hoisted.respond = () => ({
      status: 200,
      body: {
        query: {
          normalized: [{ from: "File:bundesarchiv_bild.jpg", to: "File:Bundesarchiv bild.jpg" }],
          pages: {
            "1": {
              title: "File:Bundesarchiv bild.jpg",
              imageinfo: [{ url: "https://upload.wikimedia.org/x.jpg", mime: "image/jpeg", size: 300_000 }],
            },
          },
        },
      },
    });

    const map = await fetchWikimediaImageInfoBatch(["File:bundesarchiv_bild.jpg"], 0);
    expect(map.get("File:bundesarchiv_bild.jpg")?.url).toBe("https://upload.wikimedia.org/x.jpg");
    // ...and under the normalised name too, so either form works.
    expect(map.get("File:Bundesarchiv bild.jpg")?.url).toBe("https://upload.wikimedia.org/x.jpg");
  });

  it("a 429 yields nothing rather than a guessed URL", async () => {
    hoisted.respond = () => ({ status: 429, body: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const map = await fetchWikimediaImageInfoBatch(["File:A.jpg", "File:B.jpg"], 0);
      expect(map.size).toBe(0);
      expect(hoisted.calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("more titles than the API cap are split into chunks, not truncated", async () => {
    // MediaWiki accepts 50 titles per call; asking for 120 must be three requests, not one
    // silently-truncated one.
    const titles = Array.from({ length: 120 }, (_, i) => `File:T${i}.jpg`);
    hoisted.respond = () => ({ status: 200, body: { query: { pages: {} } } });
    await fetchWikimediaImageInfoBatch(titles, 0);
    expect(hoisted.calls.length).toBe(Math.ceil(120 / WIKIMEDIA_IMAGEINFO_BATCH_SIZE));
  });

  it("an empty list makes no request at all", async () => {
    const map = await fetchWikimediaImageInfoBatch([], 0);
    expect(hoisted.calls.length).toBe(0);
    expect(map.size).toBe(0);
  });

  it("a page without imageinfo is skipped, not stored as undefined", async () => {
    hoisted.respond = () => ({
      status: 200,
      body: { query: { pages: { "-1": { title: "File:Missing.jpg" } } } },
    });
    const map = await fetchWikimediaImageInfoBatch(["File:Missing.jpg"], 0);
    expect(map.has("File:Missing.jpg")).toBe(false);
  });
});
