import { describe, expect, it } from "vitest";
import { stockClipKeyFromPath, scoreStockClipPreRank } from "./stockClipEmbedding";

describe("stockClipEmbedding", () => {
  it("stockClipKeyFromPath parses Pexels and Pixabay filenames", () => {
    expect(stockClipKeyFromPath("/tmp/scene_0_pexels_vid12345.mp4")).toBe("pexels:12345");
    expect(stockClipKeyFromPath("/tmp/scene_1_pixabay_vid99.mp4")).toBe("pixabay:99");
    expect(stockClipKeyFromPath("/tmp/scene_0_curated_a12.mp4")).toBeNull();
  });

  it("scoreStockClipPreRank returns no embeddings for unknown stock", () => {
    const pr = scoreStockClipPreRank("pexels:999999999", [0.1, 0.2, 0.3], 8);
    expect(pr.hasEmbeddings).toBe(false);
  });
});
