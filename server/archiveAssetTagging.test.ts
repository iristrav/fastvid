import { describe, expect, it } from "vitest";
import { mergeArchiveTags } from "./archiveAssetTagging";

describe("archiveAssetTagging", () => {
  it("mergeArchiveTags combines user and AI tags without duplicates", () => {
    const merged = mergeArchiveTags(["titanic", "dek"], ["Titanic", "passagiers", "1912"]);
    expect(merged).toContain("titanic");
    expect(merged).toContain("passagiers");
    expect(merged).toContain("1912");
    expect(merged.filter((t) => t === "titanic")).toHaveLength(1);
  });
});
