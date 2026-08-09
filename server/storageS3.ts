import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import * as fs from "fs";
import { isS3StorageEnabled, prefixStorageKey } from "./storageBackend";

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    const endpoint = process.env.S3_ENDPOINT?.trim();
    _client = new S3Client({
      region: process.env.S3_REGION?.trim() || (endpoint ? "auto" : "us-east-1"),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!.trim(),
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!.trim(),
      },
    });
  }
  return _client;
}

/** Uploads (a final video can be hundreds of MB) get up to 6 attempts with backoff (capped at
 *  30s) so a transient network hiccup against S3/R2 doesn't silently drop the file — previously
 *  a single failed PutObjectCommand call threw immediately with no retry, and later only 3
 *  attempts, which a sustained multi-second outage could still exhaust. A failed upload here
 *  must not destroy an otherwise-finished render, so this is worth spending real wall-clock on
 *  before giving up. */
export async function s3PutObject(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType: string
): Promise<{ bucket: string; key: string }> {
  if (!isS3StorageEnabled()) {
    throw new Error("S3 storage is not configured");
  }
  const bucket = process.env.S3_BUCKET!.trim();
  const key = prefixStorageKey(relKey);
  const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);

  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
      console.log(
        `[S3Storage] Uploaded ${(body.length / 1024).toFixed(0)}KB → s3://${bucket}/${key}` +
          (attempt > 1 ? ` (succeeded on attempt ${attempt})` : "")
      );
      return { bucket, key };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
        console.warn(
          `[S3Storage] Upload attempt ${attempt}/${maxAttempts} failed for ${key}, retrying in ${delayMs}ms:`,
          (err as Error).message
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/** Uploads a file directly from disk, streaming it via multipart upload
 *  (@aws-sdk/lib-storage's Upload) instead of loading it into a single in-memory Buffer first.
 *  Existing large-file uploads (a rendered video can be hundreds of MB to low-GB) previously
 *  read the whole file with fs.promises.readFile and passed the resulting Buffer to
 *  PutObjectCommand, which the SDK then copied again internally (Buffer.from(existingBuffer)) —
 *  peak RAM for that single step was roughly 2x the file size. Streaming from a fresh
 *  fs.createReadStream on each attempt keeps memory usage bounded to the SDK's own part-size
 *  buffers (a few MB at a time) regardless of file size. Same 6-attempt retry/backoff (capped at
 *  30s) as s3PutObject, since a stream can't be replayed after a failed attempt consumes it —
 *  this is the path the final rendered video takes, so a transient outage here must not throw
 *  away a completed render. */
export async function s3PutObjectFromFile(
  relKey: string,
  filePath: string,
  contentType: string
): Promise<{ bucket: string; key: string }> {
  if (!isS3StorageEnabled()) {
    throw new Error("S3 storage is not configured");
  }
  const bucket = process.env.S3_BUCKET!.trim();
  const key = prefixStorageKey(relKey);
  const sizeBytes = (await fs.promises.stat(filePath)).size;

  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A fresh stream per attempt (can't rewind/replay one that already failed partway through).
    const bodyStream = fs.createReadStream(filePath);
    try {
      const upload = new Upload({
        client: getClient(),
        params: {
          Bucket: bucket,
          Key: key,
          Body: bodyStream,
          ContentType: contentType,
        },
      });
      await upload.done();
      console.log(
        `[S3Storage] Streamed ${(sizeBytes / 1024 / 1024).toFixed(1)}MB → s3://${bucket}/${key}` +
          (attempt > 1 ? ` (succeeded on attempt ${attempt})` : "")
      );
      return { bucket, key };
    } catch (err) {
      lastErr = err;
      // Belt-and-suspenders: make sure this attempt's file descriptor is released even if the
      // SDK didn't fully drain/destroy the stream before failing, so a retry loop can't leak an
      // open fd per attempt.
      if (!bodyStream.destroyed) bodyStream.destroy();
      if (attempt < maxAttempts) {
        const delayMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
        console.warn(
          `[S3Storage] Streamed upload attempt ${attempt}/${maxAttempts} failed for ${key}, retrying in ${delayMs}ms:`,
          (err as Error).message
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * List all object keys in the bucket under an optional prefix.
 * Returns relative keys (with the S3_KEY_PREFIX stripped) so they match what's stored in the DB.
 */
export async function s3ListAllKeys(prefix?: string): Promise<string[]> {
  if (!isS3StorageEnabled()) throw new Error("S3 storage is not configured");
  const bucket = process.env.S3_BUCKET!.trim();
  const keyPrefix = process.env.S3_KEY_PREFIX?.trim().replace(/\/+$/, "");
  const fullPrefix = keyPrefix
    ? prefix ? `${keyPrefix}/${prefix}` : `${keyPrefix}/`
    : prefix ?? "";

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: fullPrefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      // Strip the prefix so the key matches what's stored in the DB (storageKey column)
      const relKey = keyPrefix && obj.Key.startsWith(keyPrefix + "/")
        ? obj.Key.slice(keyPrefix.length + 1)
        : obj.Key;
      keys.push(relKey);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

export async function s3GetSignedUrl(relKey: string, expiresInSec = 3600): Promise<string> {
  if (!isS3StorageEnabled()) {
    throw new Error("S3 storage is not configured");
  }
  const bucket = process.env.S3_BUCKET!.trim();
  const key = prefixStorageKey(relKey);
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSec }
  );
}
