-- Repair migration for 0042_f326_visual_search_memory.sql: that migration's CREATE TABLE
-- statement for `visual_search_memory` declared the `assetId` column but never emitted the
-- FOREIGN KEY constraint that drizzle/schema.ts's `visualSearchMemory.assetId` field expects
-- (assetId: int("assetId").references(() => mediaArchiveAssets.id)) — a gap in the original
-- migration's SQL itself, not a partially-applied migration. 0042 is already applied/registered
-- and is intentionally left untouched; this adds only the missing constraint.
-- Fully idempotent (safe to run against a database that already has the FK, and safe to re-run)
-- — same INFORMATION_SCHEMA-guarded pattern as 0034_schema_sync.sql's FK repair.
SET @db = DATABASE();
--> statement-breakpoint

-- Step 1: NULL out any assetId that no longer points to an existing media_archive_assets row
-- (e.g. an asset removed after the memory row was written) — required so the FK below can be
-- added without failing on pre-existing orphaned values. No-op if there are none.
UPDATE `visual_search_memory` v
LEFT JOIN `media_archive_assets` a ON a.id = v.assetId
SET v.assetId = NULL
WHERE v.assetId IS NOT NULL AND a.id IS NULL;
--> statement-breakpoint

-- Step 2: add the missing FK exactly as declared in code — drizzle/schema.ts's
-- `assetId: int("assetId").references(() => mediaArchiveAssets.id)` sets no .onDelete()/
-- .onUpdate(), so no ON DELETE/ON UPDATE clause is added here either (MySQL/InnoDB's own
-- default, RESTRICT, applies) — no invented referential behavior beyond what the code
-- declares. Guarded so this is a no-op if the constraint already exists.
SET @addFk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = @db
     AND CONSTRAINT_NAME   = 'visual_search_memory_assetId_media_archive_assets_id_fk') = 0,
  'ALTER TABLE `visual_search_memory` ADD CONSTRAINT `visual_search_memory_assetId_media_archive_assets_id_fk` FOREIGN KEY (`assetId`) REFERENCES `media_archive_assets`(`id`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addFk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
