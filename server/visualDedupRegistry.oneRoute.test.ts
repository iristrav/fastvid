/**
 * ONE ROUTE — one writer and one reader for "has this video already used this picture?".
 */
import { describe, expect, it } from "vitest";
import {
  assetUsedInVideo,
  createVisualDedupStats,
  markAssetUsedInVideo,
  noteDuplicateAttempt,
  providerAssetIdentityKey,
  youtubeSecondsAlreadyUsed,
  type UsedAssetSets,
} from "./visualDedupRegistry";

const sets = (): UsedAssetSets => ({
  usedPaths: new Set(),
  usedContentKeys: new Set(),
  usedCuratedAssetIds: new Set(),
  usedCuratedStorageUrls: new Set(),
});

const fragment = (videoId: string, start: number, dur: number) =>
  `${providerAssetIdentityKey("youtube_cc", videoId)}@t${Math.round(start * 10)}d${Math.round(dur * 10)}`;

describe("visualDedupRegistry — one question over every identity", () => {
  it("a picture marked once is found under each identity it was marked with, and says which", () => {
    const s = sets();
    markAssetUsedInVideo(s, {
      path: "/w/a_curated_a7.mp4",
      contentKey: "archive:7",
      archiveAssetId: 7,
      storageUrl: "https://cdn/7.mp4",
    });
    expect(assetUsedInVideo(s, { path: "/w/a_curated_a7.mp4" })).toBe("path");
    expect(assetUsedInVideo(s, { contentKey: "archive:7" })).toBe("content_key");
    expect(assetUsedInVideo(s, { archiveAssetId: 7 })).toBe("archive_asset_id");
    /** Another archive row pointing at the same stored file is the same picture. */
    expect(assetUsedInVideo(s, { archiveAssetId: 8, storageUrl: "https://cdn/7.mp4" })).toBe("storage_url");
    expect(assetUsedInVideo(s, { archiveAssetId: 9, storageUrl: "https://cdn/9.mp4" })).toBeNull();
  });

  it("a provider identity lives where the suppliers' pre-download check reads it", () => {
    const s = sets();
    markAssetUsedInVideo(s, { provider: "Wikimedia", providerAssetId: "File:A.webm" });
    expect(s.usedContentKeys.has(providerAssetIdentityKey("wikimedia", "File:A.webm"))).toBe(true);
    expect(assetUsedInVideo(s, { provider: "wikimedia", providerAssetId: "File:A.webm" })).toBe("provider_asset_id");
  });

  it("segment identity: overlapping seconds of one YouTube source are the same picture", () => {
    const s = sets();
    markAssetUsedInVideo(s, { contentKey: fragment("vidA", 100, 4) });
    expect(assetUsedInVideo(s, { contentKey: fragment("vidA", 102, 4) })).toBe("segment_overlap");
    expect(assetUsedInVideo(s, { contentKey: fragment("vidA", 104.1, 4) })).toBeNull();
    expect(assetUsedInVideo(s, { contentKey: fragment("vidB", 100, 4) })).toBeNull();
    expect(youtubeSecondsAlreadyUsed(s.usedContentKeys, "vidA", 98, 3)).toBe(true);
  });

  it("asking counts nothing; a refused duplicate is counted by identity", () => {
    const stats = createVisualDedupStats();
    noteDuplicateAttempt(stats, "segment_overlap");
    expect(stats.duplicateAttempts).toBe(1);
    expect(stats.byMatch.segment_overlap).toBe(1);
  });
});
