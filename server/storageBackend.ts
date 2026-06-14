/**
 * Object storage backend selection.
 * Priority: S3/R2 (optional env) → Manus Forge → local disk (free default on Railway).
 */

export type StorageBackend = "s3" | "forge" | "local";

export function isS3StorageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(
    env.S3_BUCKET?.trim() &&
    env.S3_ACCESS_KEY_ID?.trim() &&
    env.S3_SECRET_ACCESS_KEY?.trim()
  );
}

export function hasForgeStorageConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const forgeUrl = env.BUILT_IN_FORGE_API_URL?.trim();
  return !!(forgeUrl && env.BUILT_IN_FORGE_API_KEY?.trim());
}

export function getStorageBackend(env: NodeJS.ProcessEnv = process.env): StorageBackend {
  if (isS3StorageEnabled(env)) return "s3";
  if (hasForgeStorageConfig(env)) return "forge";
  return "local";
}

/** App-relative URL stored in the database for object-storage files. */
export function objectStorageUrl(key: string): string {
  return `/manus-storage/${key.replace(/^\/+/, "")}`;
}

export function normalizeStorageKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export function prefixStorageKey(relKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = normalizeStorageKey(relKey);
  const prefix = env.S3_KEY_PREFIX?.trim().replace(/\/+$/, "");
  if (!prefix) return key;
  return `${prefix}/${key}`;
}
