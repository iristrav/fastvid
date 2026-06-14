/**
 * Local file storage fallback for Railway deployments.
 * When BUILT_IN_FORGE_API_URL / BUILT_IN_FORGE_API_KEY are not set,
 * files are stored in UPLOADS_DIR (default: /app/uploads or ./uploads)
 * and served via Express at /local-storage/<key>.
 *
 * NOTE: Attach a Railway Volume and set UPLOADS_DIR=/data/uploads so files
 * survive redeploys. Without a volume, completed videos disappear after deploy.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

function resolveUploadsDir(): string {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  // Railway injects this when a volume is attached to the service
  const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.replace(/\/$/, "");
  if (volumeMount) return path.join(volumeMount, "uploads");
  if (fs.existsSync("/data")) return "/data/uploads";
  if (fs.existsSync("/app")) return "/app/uploads";
  return path.resolve(process.cwd(), "uploads");
}

export const LOCAL_UPLOADS_DIR = resolveUploadsDir();

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

/** Resolve a /local-storage/... URL to an on-disk path, or null if missing. */
export function resolveLocalVideoPath(videoUrl: string): string | null {
  if (!videoUrl.startsWith("/local-storage/")) return null;
  const fileName = videoUrl.replace(/^\/local-storage\//, "");
  const filePath = path.join(LOCAL_UPLOADS_DIR, fileName);
  return fs.existsSync(filePath) ? filePath : null;
}

export function localVideoFileExists(videoUrl: string): boolean {
  return resolveLocalVideoPath(videoUrl) !== null;
}

/** Resolve on-disk path for a locally stored object (archive asset, video, voice sample). */
export function resolveLocalStorageFilePath(opts: {
  storageUrl?: string | null;
  storageKey?: string | null;
}): string | null {
  if (opts.storageUrl?.startsWith("/local-storage/")) {
    const fromUrl = resolveLocalVideoPath(opts.storageUrl);
    if (fromUrl) return fromUrl;
  }
  if (opts.storageKey) {
    const fromKey = path.join(LOCAL_UPLOADS_DIR, opts.storageKey.replace(/\//g, "_"));
    if (fs.existsSync(fromKey)) return fromKey;
  }
  return null;
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

export { guessMimeType as localStorageGuessMimeType };
