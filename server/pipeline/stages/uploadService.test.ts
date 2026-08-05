import { describe, expect, it, vi } from "vitest";
import { uploadVideo } from "./uploadService";

vi.mock("../../storage", () => ({
  storagePut: vi.fn(),
}));

describe("Upload Service stage", () => {
  it("uploads the given bytes and returns the resulting URL", async () => {
    const { storagePut } = await import("../../storage");
    vi.mocked(storagePut).mockResolvedValue({ key: "videos/42/final.mp4", url: "/manus-storage/videos/42/final.mp4" });

    const result = await uploadVideo({
      key: "videos/42/final.mp4",
      data: Buffer.from("fake video bytes"),
      contentType: "video/mp4",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.url).toBe("/manus-storage/videos/42/final.mp4");
    }
  });

  it("returns a structured error instead of throwing when the upload fails", async () => {
    const { storagePut } = await import("../../storage");
    vi.mocked(storagePut).mockRejectedValue(new Error("S3 upload timed out"));

    const result = await uploadVideo({ key: "x", data: "y", contentType: "video/mp4" });

    expect(result.ok).toBe(false);
  });
});
