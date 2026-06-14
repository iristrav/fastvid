// Object storage: optional S3/R2 → Manus Forge → local disk (default, no extra cost).
// Enable R2 later by setting S3_* env vars — until then everything stays on disk/volume.

import { ENV } from "./_core/env";
import {
  getStorageBackend,
  hasForgeStorageConfig,
  isS3StorageEnabled,
  normalizeStorageKey,
  objectStorageUrl,
} from "./storageBackend";
import { s3GetSignedUrl, s3PutObject } from "./storageS3";
import { localStoragePut, localStorageGet } from "./storageLocal";

export { getStorageBackend, isS3StorageEnabled } from "./storageBackend";

function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;

  if (!forgeUrl || !forgeKey) {
    throw new Error(
      "Storage config missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY",
    );
  }

  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const backend = getStorageBackend();

  if (backend === "s3") {
    const key = appendHashSuffix(normalizeStorageKey(relKey));
    await s3PutObject(key, data, contentType);
    return { key, url: objectStorageUrl(key) };
  }

  if (backend === "forge") {
    const { forgeUrl, forgeKey } = getForgeConfig();
    const key = appendHashSuffix(normalizeStorageKey(relKey));

    const presignUrl = new URL("v1/storage/presign/put", forgeUrl + "/");
    presignUrl.searchParams.set("path", key);

    const presignResp = await fetch(presignUrl, {
      headers: { Authorization: `Bearer ${forgeKey}` },
    });

    if (!presignResp.ok) {
      const msg = await presignResp.text().catch(() => presignResp.statusText);
      throw new Error(`Storage presign failed (${presignResp.status}): ${msg}`);
    }

    const { url: s3Url } = (await presignResp.json()) as { url: string };
    if (!s3Url) throw new Error("Forge returned empty presign URL");

    const blob =
      typeof data === "string"
        ? new Blob([data], { type: contentType })
        : new Blob([data as BlobPart], { type: contentType });

    const uploadResp = await fetch(s3Url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });

    if (!uploadResp.ok) {
      throw new Error(`Storage upload to S3 failed (${uploadResp.status})`);
    }

    return { key, url: objectStorageUrl(key) };
  }

  return localStoragePut(relKey, data, contentType);
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const backend = getStorageBackend();
  const key = normalizeStorageKey(relKey);

  if (backend === "local") {
    return localStorageGet(relKey);
  }

  return { key, url: objectStorageUrl(key) };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const backend = getStorageBackend();
  const key = normalizeStorageKey(relKey);

  if (backend === "s3") {
    return s3GetSignedUrl(key);
  }

  if (backend === "forge") {
    const { forgeUrl, forgeKey } = getForgeConfig();
    const getUrl = new URL("v1/storage/presign/get", forgeUrl + "/");
    getUrl.searchParams.set("path", key);

    const resp = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${forgeKey}` },
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => resp.statusText);
      throw new Error(`Storage signed URL failed (${resp.status}): ${msg}`);
    }

    const { url } = (await resp.json()) as { url: string };
    return url;
  }

  const safeFileName = key.replace(/\//g, "_");
  return `/local-storage/${safeFileName}`;
}
