import { describe, expect, it, vi } from "vitest";

// FASTVID — FINAL PRODUCTION IMAGE QUALITY HARDENING (round 2)
//
// Extends the production-render-fix round (videoPipeline.productionRenderFix.test.ts) with:
//   - Point 3: the relevance floor now applies to every candidate with real providerText, not
//     only opts.scriptImageFallback ones — tested here via the pure, provider-agnostic function
//     itself (it never looked at opts to begin with, so "universal" is purely an adoptClip
//     wiring change already covered by typecheck + the existing round-1 tests still passing).
//   - Point 4: isOffTopicVisualForPersonTopic now takes an optional providerTitle and
//     corroborates a query that trivially "mentions" primaryPerson against it when available.
//   - Point 5: dedup identity (providerAssetKey/clipContentKey) stays asset-based — the same
//     physical asset found via a different query, route, or cascade is still the same key;
//     different assets are still different keys. adoptClip's own accept loop (unexported,
//     side-effecting) is not re-invoked here — see videoPipeline.p0p1ImageQuality.test.ts's
//     precedent for why these identity properties are tested directly instead.
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: (...args: unknown[]) => nodeFetchMock(...args) };
});

async function freshPipeline() {
  vi.resetModules();
  return import("./videoPipeline");
}

describe("Point 5 — dedup identity stays asset-based across route/query/cascade", () => {
  it("the same physical asset found via two different queries produces the same key -> second lookup is a duplicate", async () => {
    const { providerAssetKey } = await freshPipeline();
    const usedContentKeys = new Set<string>();
    const keyFromQueryA = providerAssetKey("wikimedia", "File:Adolf_Hitler_1934.ogv");
    usedContentKeys.add(keyFromQueryA);
    // A second cascade searches a totally different query string but resolves to the same
    // underlying Commons file — identity is provider+id, never the query that found it.
    const keyFromQueryB = providerAssetKey("wikimedia", "File:Adolf_Hitler_1934.ogv");
    expect(usedContentKeys.has(keyFromQueryB)).toBe(true);
  }, 30_000); // first freshPipeline() import of the whole videoPipeline.ts module is slow (cold ffmpeg-binary detection etc.) when this file runs in isolation

  it("the same physical asset found via a different cascade/provider-route still collides on identity", async () => {
    const { providerAssetKey, tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    const usedContentKeys = new Set<string>();
    const firstPath = tagPathWithProviderAsset("/tmp/scene_0_hist_ia_0.mp4", "internet_archive", "HitlerSpeech1934");
    usedContentKeys.add(clipContentKey(firstPath));
    // Different cascade (e.g. the emergency-finish tier vs. the normal historical tier),
    // different local filename, same provider+id.
    const secondPath = tagPathWithProviderAsset("/tmp/scene_2_emergency_ia_1.mp4", "internet_archive", "HitlerSpeech1934");
    expect(usedContentKeys.has(clipContentKey(secondPath))).toBe(true);
    expect(providerAssetKey("internet_archive", "HitlerSpeech1934")).toBe(clipContentKey(secondPath));
  });

  it("two genuinely different assets from the same provider never collide -> both stay adoptable", async () => {
    const { tagPathWithProviderAsset, clipContentKey } = await freshPipeline();
    const usedContentKeys = new Set<string>();
    const a = clipContentKey(tagPathWithProviderAsset("/tmp/a.mp4", "internet_archive", "ClipOne"));
    const b = clipContentKey(tagPathWithProviderAsset("/tmp/b.mp4", "internet_archive", "ClipTwo"));
    usedContentKeys.add(a);
    expect(usedContentKeys.has(b)).toBe(false);
    usedContentKeys.add(b);
    expect(usedContentKeys.size).toBe(2);
  });
});

describe("Point 3 — relevance floor is provider-agnostic (applies wherever providerText exists)", () => {
  it("Hitler beat + Stallman provider title -> reject, regardless of which candidate path supplied it", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    const ok = scriptImageFallbackPassesRelevanceFloor(
      "An open letter to remove Richard M. Stallman from all leadership positions",
      "Adolf Hitler bunker Berlin 1945",
      "Hitler and Eva Braun died together in the bunker.",
      "Why Hitler Killed Himself and His Wife"
    );
    expect(ok).toBe(false);
  });

  it("Hitler beat + Hitler provider title -> passes through to the remaining gates", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    const ok = scriptImageFallbackPassesRelevanceFloor(
      "Adolf Hitler bunker footage",
      "Adolf Hitler bunker Berlin 1945",
      "Hitler and Eva Braun died together in the bunker.",
      "Why Hitler Killed Himself and His Wife"
    );
    expect(ok).toBe(true);
  });

  it("a generic beat with no entity rule and no providerText is never unnecessarily rejected", async () => {
    const { scriptImageFallbackPassesRelevanceFloor } = await freshPipeline();
    expect(
      scriptImageFallbackPassesRelevanceFloor(undefined, "quiet countryside road", "A calm drive through the hills", "")
    ).toBe(true);
  });
});

describe("Point 4 — isOffTopicVisualForPersonTopic corroborates a self-referential query against providerText", () => {
  it("query trivially mentions primaryPerson but the provider title is real wildlife/nature B-roll -> off-topic", async () => {
    const { isOffTopicVisualForPersonTopic } = await freshPipeline();
    // Query was built FROM primaryPerson (e.g. "Elon Musk speaking"), so the old query/filename
    // check alone would call this safe. The provider's own title is generic zoo/safari B-roll
    // that never mentions Musk at all — PERSON_OFFTOPIC_VISUAL_RE's existing wildlife blocklist
    // now gets to see that instead of being overruled by the self-referential query.
    const result = isOffTopicVisualForPersonTopic(
      "Elon Musk speaking",
      "/tmp/scene_0_clip.mp4",
      "Elon Musk",
      "Safari wildlife documentary with zebras and giraffes"
    );
    expect(result).toBe(true);
  });

  it("query mentions primaryPerson AND the provider title also mentions them -> stays safe (corroborated, not just self-referential)", async () => {
    const { isOffTopicVisualForPersonTopic } = await freshPipeline();
    const result = isOffTopicVisualForPersonTopic(
      "Elon Musk speaking",
      "/tmp/scene_0_clip.mp4",
      "Elon Musk",
      "Elon Musk visits a safari wildlife park"
    );
    expect(result).toBe(false);
  });

  it("no providerText available -> existing query/filename-based behavior is unchanged (person mentioned in query -> not off-topic)", async () => {
    const { isOffTopicVisualForPersonTopic } = await freshPipeline();
    expect(isOffTopicVisualForPersonTopic("Elon Musk Tesla factory", "/tmp/clip.mp4", "Elon Musk")).toBe(false);
  });

  it("providerText present but doesn't match any existing off-topic pattern and doesn't mention the person -> still not blocked (no new false rejects)", async () => {
    const { isOffTopicVisualForPersonTopic } = await freshPipeline();
    const result = isOffTopicVisualForPersonTopic(
      "Elon Musk announcement",
      "/tmp/clip.mp4",
      "Elon Musk",
      "quarterly earnings report press conference"
    );
    expect(result).toBe(false);
  });
});
