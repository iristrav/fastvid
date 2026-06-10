import { describe, expect, it } from "vitest";
import { resolveAutoTitleAssetIds } from "./archiveBulkVisionTagging";

describe("archiveBulkVisionTagging", () => {
  it("resolveAutoTitleAssetIds is exported", () => {
    expect(typeof resolveAutoTitleAssetIds).toBe("function");
  });
});
