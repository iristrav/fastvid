-- RONDE 648 — one archive per kind of source.
--
-- Measured at boot (ArchiveInventory, 2026-09-24 12:41): archive 36 is named Stockbeelden but held
-- 57 YouTube segments, 3 Wikimedia and 1 Openverse asset, and no stock at all, because every
-- automatic ingest landed in the most recently updated active archive. The operator chose: YouTube
-- to its own archive, other automatic sources to Overig, and Stockbeelden for Pexels and Pixabay
-- only. WW2 (37) is left exactly as it is. Every statement is safe to run twice.
INSERT IGNORE INTO `media_archives` (`name`, `slug`, `description`, `isActive`)
VALUES ('YouTube', 'youtube', 'YouTube segments FastVid fetched and archived automatically.', 1);
--> statement-breakpoint
INSERT IGNORE INTO `media_archives` (`name`, `slug`, `description`, `isActive`)
VALUES ('Overig', 'overig', 'Automatically archived footage from other sources (Wikimedia, Internet Archive, Openverse, ...).', 1);
--> statement-breakpoint
UPDATE `media_archive_assets` x
  JOIN `media_archives` src ON src.`id` = x.`archiveId`
  JOIN `media_archives` dst ON dst.`slug` = 'youtube'
SET x.`archiveId` = dst.`id`
WHERE src.`id` = 36 AND src.`name` = 'Stockbeelden'
  AND (LOWER(COALESCE(x.`sourcePlatform`, '')) IN ('youtube', 'youtube_cc')
       OR x.`storageKey` LIKE 'archive-ingested/%/youtube%');
--> statement-breakpoint
UPDATE `media_archive_assets` x
  JOIN `media_archives` src ON src.`id` = x.`archiveId`
  JOIN `media_archives` dst ON dst.`slug` = 'overig'
SET x.`archiveId` = dst.`id`
WHERE src.`id` = 36 AND src.`name` = 'Stockbeelden'
  AND x.`mixKind` <> 'stock'
  AND LOWER(COALESCE(x.`sourcePlatform`, '')) NOT IN ('pexels', 'pixabay');
--> statement-breakpoint
UPDATE `media_archives` a
  LEFT JOIN `media_archives` s ON s.`slug` = 'stock'
SET a.`slug` = 'stock', a.`isActive` = 0,
    a.`description` = 'Stock shots (Pexels, Pixabay) used in delivered films. Kept so every shot can be read back from our own storage; never offered as archive footage.'
WHERE a.`id` = 36 AND a.`name` = 'Stockbeelden' AND s.`id` IS NULL;
