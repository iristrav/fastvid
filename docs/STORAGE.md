# Object Storage Backends

FastVid picks a storage backend at boot via `getStorageBackend()` (`server/storageBackend.ts`),
priority order **S3/R2 → Manus Forge → local disk**:

```ts
export function getStorageBackend(env): StorageBackend {
  if (isS3StorageEnabled(env)) return "s3";
  if (hasForgeStorageConfig(env)) return "forge";
  return "local";
}
```

## Local disk (default, no env vars set)

Files are written under `UPLOADS_DIR` (or a Railway volume at `/data/uploads`, or `./uploads`)
and served back at `/local-storage/<file>` (`server/storageLocal.ts`, `server/_core/index.ts`).
Fine for low-traffic/dev use; without an attached Railway Volume, files are lost on every
redeploy.

## S3-compatible object storage (S3, R2, B2, ...)

Set these env vars to switch on `server/storageS3.ts`:

| Var | Required | Notes |
|---|---|---|
| `S3_BUCKET` | yes | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | |
| `S3_ENDPOINT` | for R2/B2 | Custom endpoint URL. Omit entirely for real AWS S3. |
| `S3_REGION` | recommended for R2 | Use `auto` for Cloudflare R2. Defaults to `auto` when `S3_ENDPOINT` is set, `us-east-1` otherwise. |
| `S3_KEY_PREFIX` | optional | Prefixes every object key (e.g. `prod/`) — useful for sharing one bucket across environments. |

**`getClient()` (`server/storageS3.ts`) already sets `endpoint`/`forcePathStyle: true` whenever
`S3_ENDPOINT` is set — R2, Backblaze B2, and any other S3-compatible provider work with zero
code changes, purely by setting the env vars above.**

### Cloudflare R2 specifically

```
S3_BUCKET=<your-bucket>
S3_ACCESS_KEY_ID=<r2-access-key-id>
S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
```

Uploads (`s3PutObject`) retry up to 3 times with backoff on transient failures, so a brief
network hiccup against R2 doesn't silently drop a finished video.

### Backblaze B2 (S3-compatible API)

```
S3_BUCKET=<your-bucket>
S3_ACCESS_KEY_ID=<b2-key-id>
S3_SECRET_ACCESS_KEY=<b2-application-key>
S3_ENDPOINT=https://s3.<region>.backblazeb2.com
S3_REGION=<region>
```

## Manus Forge storage (fallback, no S3 configured)

Used automatically when `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` are set and no S3
vars are present — see `server/storageBackend.ts` `hasForgeStorageConfig()`.

## Switching backends

Switching is purely an env var change — no migration/downtime beyond whichever files were
already written under the previous backend needing `scripts/migrate-local-storage-to-s3.ts`
(or a Backblaze/R2 equivalent copy) if you want existing videos to move with you.
