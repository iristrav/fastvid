import { describe, expect, it, vi } from "vitest";

// Beeldkwaliteit vervolgpatch — Fase 4 (providerText compleet maken) + Fase 12 (dedup
// correctness: same ASSET blocks, same QUERY/topic never does).
//
// adoptClip now fills dedup.clipAnnotationMeta.providerText from a generic, read-only lookup:
//   dedup.sourcingCache.assets.get(clipContentKey(path))?.providerText
// clipContentKey(path) on a tagPathWithProviderAsset-tagged path is, by construction, the exact
// same string as providerAssetKey(provider, id) — that equality is the entire mechanism, so it
// is pinned down directly here rather than only exercised indirectly through adoptClip (which is
// unexported and side-effecting: real ffprobe/ffmpeg/CLIP calls).
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

describe("Fase 4 — providerText is recoverable via the same key clipContentKey produces", () => {
  it("a provider-tagged path's contentKey equals providerAssetKey — the invariant the lookup depends on", async () => {
    const { clipContentKey, providerAssetKey, tagPathWithProviderAsset } = await freshPipeline();
    const outPath = tagPathWithProviderAsset("/tmp/scene_0_nara_0.mp4", "nara", "https://example.com/reel.mp4");
    expect(clipContentKey(outPath)).toBe(providerAssetKey("nara", "https://example.com/reel.mp4"));
  });

  it("putCachedProviderAsset(providerText) is retrievable from sourcingCache.assets under that exact key", async () => {
    const { clipContentKey, tagPathWithProviderAsset, putCachedProviderAsset } = await freshPipeline();
    const sourcingCache = {
      queries: new Map(), assets: new Map(), metrics: new Map(),
      totals: {
        queryCacheHits: 0, assetCacheHits: 0, duplicateCandidatesSkipped: 0,
        duplicateDownloadsPrevented: 0, visionCacheHits: 0,
      },
      visionHitBaseline: 0,
    } as unknown as Parameters<typeof putCachedProviderAsset>[0];

    const outPath = tagPathWithProviderAsset("/tmp/scene_0_ccc_0.mp4", "media_ccc", "https://media.ccc.de/v/talk123.mp4");
    putCachedProviderAsset(sourcingCache, "media_ccc", "https://media.ccc.de/v/talk123.mp4", {
      providerText: { title: "A real conference talk title" },
    });

    const contentKey = clipContentKey(outPath);
    expect(sourcingCache.assets.get(contentKey)?.providerText?.title).toBe("A real conference talk title");
  });

  it("Pixabay/Pexels stock keys (stock:vid:ID) are a different, still-stable identity — no collision with provider:hash keys", async () => {
    const { clipContentKey } = await freshPipeline();
    const pixabayPath = "/tmp/scene_0_pixabay_vid555.mp4";
    expect(clipContentKey(pixabayPath)).toBe("stock:vid:555");
  });
});

describe("Fase 12 — dedup blocks the same asset, never the same query/topic", () => {
  it("the SAME provider + SAME id always produces the same key regardless of query text", async () => {
    const { providerAssetKey } = await freshPipeline();
    const keyFromQueryA = providerAssetKey("wikimedia", "File:Elon_Musk_2015.webm");
    const keyFromQueryB = providerAssetKey("wikimedia", "File:Elon_Musk_2015.webm");
    expect(keyFromQueryA).toBe(keyFromQueryB);
  });

  it("the SAME provider + a DIFFERENT id (same topic/query) produces a DIFFERENT key — must stay adoptable", async () => {
    const { providerAssetKey } = await freshPipeline();
    const keyAssetOne = providerAssetKey("wikimedia", "File:Elon_Musk_2015.webm");
    const keyAssetTwo = providerAssetKey("wikimedia", "File:Elon_Musk_Tesla_2022.webm");
    expect(keyAssetOne).not.toBe(keyAssetTwo);
  });

  it("a DIFFERENT provider with the SAME native id is a DIFFERENT asset (no cross-provider collision)", async () => {
    const { providerAssetKey } = await freshPipeline();
    const wikiKey = providerAssetKey("wikimedia", "12345");
    const iaKey = providerAssetKey("internet_archive", "12345");
    expect(wikiKey).not.toBe(iaKey);
  });

  it("GDELT: two different segments of the SAME archive.org broadcast are different assets", async () => {
    const { providerAssetKey } = await freshPipeline();
    const segmentOne = providerAssetKey("gdelt_tv", "CNN_20200101@100");
    const segmentTwo = providerAssetKey("gdelt_tv", "CNN_20200101@340");
    expect(segmentOne).not.toBe(segmentTwo);
  });
});
