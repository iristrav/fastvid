import { describe, expect, it } from "vitest";
import { getStorageBackend, isS3StorageEnabled } from "./storageBackend";

describe("storage backend", () => {
  it("defaults to local without S3 env", () => {
    expect(getStorageBackend({})).toBe("local");
    expect(isS3StorageEnabled({})).toBe(false);
  });

  it("selects s3 when bucket credentials are set", () => {
    const env = {
      S3_BUCKET: "fastvid-media",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    };
    expect(isS3StorageEnabled(env)).toBe(true);
    expect(getStorageBackend(env)).toBe("s3");
  });

  it("prefers s3 over forge when both configured", () => {
    const env = {
      S3_BUCKET: "fastvid-media",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      BUILT_IN_FORGE_API_KEY: "forge-key",
      BUILT_IN_FORGE_API_URL: "https://forge.example.com",
    };
    expect(getStorageBackend(env)).toBe("s3");
  });
});
