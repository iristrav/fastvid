-- VIDEO 619 — longer archive clips are cut into single-shot pieces of at most 11 seconds.
--
-- `parentAssetId` on a piece names the clip it was cut from; `splitIntoShotsAt` on the parent says
-- when it was cut (null = not yet looked at by the splitter).
ALTER TABLE `media_archive_assets` ADD `parentAssetId` int;
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD `splitIntoShotsAt` timestamp;
--> statement-breakpoint
CREATE INDEX `media_archive_assets_splitIntoShotsAt_idx` ON `media_archive_assets` (`splitIntoShotsAt`);
