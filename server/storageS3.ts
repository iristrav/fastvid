import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
