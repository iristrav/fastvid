-- MEDIA ARCHIVE ROUND — the archive becomes the authoritative production media store.
--
-- The four facts a stored timeline needs in order to find its own file again, and which the
-- archive was not recording:
--
--   providerAssetId   was only inside the free-text `sourceNote` ("internet_archive:youtube-…"),
--                     so "have we already archived this provider asset" needed a table scan and
--                     a string parse. A note is not a key.
--   checksumSha256    file identity, for deduplicating the same bytes arriving twice under two
--                     different provider ids or two different URLs.
--   fileSizeBytes     measured after the upload, not claimed before it.
--   mediaStatus       the lifecycle. `isActive` says whether an operator WANTS this asset used;
--                     this says how far it actually got. Only READY means the bytes have been
--                     read back out of storage at least once.
--
-- Every column is nullable and nothing is backfilled. A pre-existing row keeps exactly the
-- behaviour it has: `mediaStatus` NULL means "this check never ran", which is the honest value,
-- and declaring those rows READY here would be the database claiming a verification nobody did.
ALTER TABLE `media_archive_assets` ADD COLUMN `providerAssetId` varchar(256);
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD COLUMN `checksumSha256` varchar(64);
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD COLUMN `fileSizeBytes` int;
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD COLUMN `mediaStatus` enum('DOWNLOADED','VALIDATED','ARCHIVED','READY','REJECTED','FAILED','MISSING');
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD COLUMN `readableCheckedAt` timestamp;
--> statement-breakpoint
CREATE INDEX `media_archive_assets_provider_assetId_idx` ON `media_archive_assets` (`sourcePlatform`,`providerAssetId`);
--> statement-breakpoint
CREATE INDEX `media_archive_assets_checksum_idx` ON `media_archive_assets` (`checksumSha256`);
