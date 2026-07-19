import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  console.log(`[S3Storage] Uploaded ${(body.length / 1024).toFixed(0)}KB → s3://${bucket}/${key}`);
  return { bucket, key };
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
