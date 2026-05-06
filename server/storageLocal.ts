/**
 * Local file storage fallback for Railway deployments.
 * When BUILT_IN_FORGE_API_URL / BUILT_IN_FORGE_API_KEY are not set,
 * files are stored in UPLOADS_DIR (default: /app/uploads or ./uploads)
 * and served via Express at /local-storage/<key>.
 *
 * NOTE: Railway volumes are ephemeral across redeploys unless you attach a
 * persistent volume at UPLOADS_DIR. For production use, attach a Railway
 * Volume at /app/uploads to persist files across deploys.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Resolve uploads directory: prefer UPLOADS_DIR env, then /app/uploads (Railway), then ./uploads
export const LOCAL_UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (fs.existsSync("/app") ? "/app/uploads" : path.resolve(process.cwd(), "uploads"));

// Ensure the directory exists
try {
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
} catch {
  // ignore
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * Save a file locally and return a URL that can be served by Express.
 * The URL format is /local-storage/<key> — register the static middleware in index.ts.
 */
export async function localStoragePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  // Flatten any subdirectory structure into the uploads dir
  const safeFileName = key.replace(/\//g, "_");
  const filePath = path.join(LOCAL_UPLOADS_DIR, safeFileName);

  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as any);
  fs.writeFileSync(filePath, buf);

  console.log(`[LocalStorage] Saved ${(buf.length / 1024).toFixed(0)}KB → ${filePath}`);
  return { key, url: `/local-storage/${safeFileName}` };
}

export async function localStorageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const safeFileName = key.replace(/\//g, "_");
  return { key, url: `/local-storage/${safeFileName}` };
}
