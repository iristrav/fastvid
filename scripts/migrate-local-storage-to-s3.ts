/**
 * Migrate files from local disk (/local-storage) to S3/R2.
 *
 * Prerequisites:
 *   - S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (+ S3_ENDPOINT for R2)
 *   - DATABASE_URL
 *   - Files present under UPLOADS_DIR (or Railway volume)
 *
 * Usage:
 *   npx tsx scripts/migrate-local-storage-to-s3.ts --dry-run
 *   npx tsx scripts/migrate-local-storage-to-s3.ts
 *   npx tsx scripts/migrate-local-storage-to-s3.ts --only=archive
 *   npx tsx scripts/migrate-local-storage-to-s3.ts --delete-local
 */
import "dotenv/config";
import * as fs from "fs";
import path from "path";
import { eq, like, or } from "drizzle-orm";
import {
  LOCAL_UPLOADS_DIR,
  localStorageGuessMimeType,
  resolveLocalStorageFilePath,
} from "../server/storageLocal";
import { getStorageBackend, isS3StorageEnabled, objectStorageUrl } from "../server/storageBackend";
import { s3PutObject } from "../server/storageS3";
import { getDb } from "../server/db";
import { mediaArchiveAssets, videos, voices } from "../drizzle/schema";

type Scope = "all" | "archive" | "videos" | "voices";

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const deleteLocal = process.argv.includes("--delete-local");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = (onlyArg?.split("=")[1] ?? "all") as Scope;
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]!, 10) : undefined;
  return { dryRun, deleteLocal, only, limit };
}

function isLocalStorageUrl(url: string | null | undefined): boolean {
  return !!url?.startsWith("/local-storage/");
}

async function uploadLocalFile(
  localPath: string,
  objectKey: string,
  dryRun: boolean
): Promise<{ key: string; url: string }> {
  const mime = localStorageGuessMimeType(localPath);
  const sizeMb = (fs.statSync(localPath).size / (1024 * 1024)).toFixed(2);
  if (dryRun) {
    console.log(`  [dry-run] would upload ${sizeMb} MB → ${objectKey} (${mime})`);
    return { key: objectKey, url: objectStorageUrl(objectKey) };
  }
  const buf = fs.readFileSync(localPath);
  await s3PutObject(objectKey, buf, mime);
  return { key: objectKey, url: objectStorageUrl(objectKey) };
}

async function migrateArchiveAssets(dryRun: boolean, deleteLocal: boolean, limit?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(mediaArchiveAssets)
    .where(like(mediaArchiveAssets.storageUrl, "/local-storage/%"));

  const slice = limit ? rows.slice(0, limit) : rows;
  console.log(`\n── Archive assets: ${slice.length} local file(s) ──`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const asset of slice) {
    const localPath = resolveLocalStorageFilePath({
      storageUrl: asset.storageUrl,
      storageKey: asset.storageKey,
    });
    if (!localPath) {
      console.warn(`  skip asset #${asset.id} — file not found (${asset.storageUrl})`);
      skip++;
      continue;
    }

    const objectKey =
      asset.storageKey?.trim() ||
      `media-archive/${asset.archiveId}/migrated-${asset.id}${pathExt(localPath)}`;

    try {
      console.log(`  asset #${asset.id}: ${path.basename(localPath)}`);
      const { key, url } = await uploadLocalFile(localPath, objectKey, dryRun);
      if (!dryRun) {
        await db
          .update(mediaArchiveAssets)
          .set({ storageUrl: url, storageKey: key })
          .where(eq(mediaArchiveAssets.id, asset.id));
        if (deleteLocal) fs.unlinkSync(localPath);
      }
      ok++;
    } catch (err) {
      console.error(`  fail asset #${asset.id}:`, err);
      fail++;
    }
  }

  return { ok, skip, fail };
}

async function migrateVideos(dryRun: boolean, deleteLocal: boolean, limit?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(videos)
    .where(
      or(
        like(videos.videoUrl, "/local-storage/%"),
        like(videos.editedVideoUrl, "/local-storage/%")
      )
    );

  const slice = limit ? rows.slice(0, limit) : rows;
  console.log(`\n── Videos: ${slice.length} with local URL(s) ──`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const video of slice) {
    try {
      if (isLocalStorageUrl(video.videoUrl)) {
        const localPath = resolveLocalStorageFilePath({ storageUrl: video.videoUrl });
        if (!localPath) {
          console.warn(`  skip video #${video.id} videoUrl — file missing`);
          skip++;
        } else {
          const objectKey = `videos/${video.id}/final${pathExt(localPath)}`;
          console.log(`  video #${video.id} final: ${path.basename(localPath)}`);
          const { url } = await uploadLocalFile(localPath, objectKey, dryRun);
          if (!dryRun) {
            await db.update(videos).set({ videoUrl: url }).where(eq(videos.id, video.id));
            if (deleteLocal) fs.unlinkSync(localPath);
          }
          ok++;
        }
      }

      if (isLocalStorageUrl(video.editedVideoUrl)) {
        const localPath = resolveLocalStorageFilePath({ storageUrl: video.editedVideoUrl });
        if (!localPath) {
          console.warn(`  skip video #${video.id} editedVideoUrl — file missing`);
          skip++;
        } else {
          const objectKey = `videos/${video.id}/edited_final${pathExt(localPath)}`;
          console.log(`  video #${video.id} edited: ${path.basename(localPath)}`);
          const { url } = await uploadLocalFile(localPath, objectKey, dryRun);
          if (!dryRun) {
            await db.update(videos).set({ editedVideoUrl: url }).where(eq(videos.id, video.id));
            if (deleteLocal) fs.unlinkSync(localPath);
          }
          ok++;
        }
      }
    } catch (err) {
      console.error(`  fail video #${video.id}:`, err);
      fail++;
    }
  }

  return { ok, skip, fail };
}

async function migrateVoices(dryRun: boolean, deleteLocal: boolean, limit?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(voices)
    .where(like(voices.exampleAudioUrl, "/local-storage/%"));

  const slice = limit ? rows.slice(0, limit) : rows;
  console.log(`\n── Voice samples: ${slice.length} local file(s) ──`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const voice of slice) {
    const localPath = resolveLocalStorageFilePath({ storageUrl: voice.exampleAudioUrl });
    if (!localPath) {
      console.warn(`  skip voice #${voice.id} — file missing`);
      skip++;
      continue;
    }

    const objectKey = `voice-examples/${voice.id}${pathExt(localPath)}`;
    try {
      console.log(`  voice #${voice.id} (${voice.name}): ${path.basename(localPath)}`);
      const { url } = await uploadLocalFile(localPath, objectKey, dryRun);
      if (!dryRun) {
        await db.update(voices).set({ exampleAudioUrl: url }).where(eq(voices.id, voice.id));
        if (deleteLocal) fs.unlinkSync(localPath);
      }
      ok++;
    } catch (err) {
      console.error(`  fail voice #${voice.id}:`, err);
      fail++;
    }
  }

  return { ok, skip, fail };
}

function pathExt(filePath: string): string {
  const ext = path.extname(filePath);
  return ext || ".bin";
}

async function main() {
  const { dryRun, deleteLocal, only, limit } = parseArgs();

  if (!isS3StorageEnabled()) {
    console.error("S3 is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (+ S3_ENDPOINT for R2).");
    process.exit(1);
  }

  if (getStorageBackend() !== "s3") {
    console.error("Storage backend is not s3 — check env vars.");
    process.exit(1);
  }

  console.log("Fastvid local → S3 migration");
  console.log("  uploads dir:", LOCAL_UPLOADS_DIR);
  console.log("  bucket:", process.env.S3_BUCKET);
  console.log("  mode:", dryRun ? "DRY RUN" : "LIVE");
  if (deleteLocal && !dryRun) console.log("  will delete local files after successful upload");

  if (!fs.existsSync(LOCAL_UPLOADS_DIR)) {
    console.error("Uploads directory does not exist:", LOCAL_UPLOADS_DIR);
    process.exit(1);
  }

  const totals = { ok: 0, skip: 0, fail: 0 };

  const run = async (scope: Scope) => {
    if (scope === "archive" || scope === "all") {
      const r = await migrateArchiveAssets(dryRun, deleteLocal, limit);
      totals.ok += r.ok;
      totals.skip += r.skip;
      totals.fail += r.fail;
    }
    if (scope === "videos" || scope === "all") {
      const r = await migrateVideos(dryRun, deleteLocal, limit);
      totals.ok += r.ok;
      totals.skip += r.skip;
      totals.fail += r.fail;
    }
    if (scope === "voices" || scope === "all") {
      const r = await migrateVoices(dryRun, deleteLocal, limit);
      totals.ok += r.ok;
      totals.skip += r.skip;
      totals.fail += r.fail;
    }
  };

  await run(only);

  console.log("\n── Summary ──");
  console.log(`  uploaded: ${totals.ok}`);
  console.log(`  skipped:  ${totals.skip}`);
  console.log(`  failed:   ${totals.fail}`);
  if (dryRun) console.log("\nRe-run without --dry-run to apply changes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
