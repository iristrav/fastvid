-- Phase 12 D2/D3 follow-up: embedding_cache and media_archive_assets got their indexes
-- added to drizzle/schema.ts but no migration was ever generated for them (drizzle-kit
-- generate could not produce a clean diff due to the incomplete drizzle/meta snapshot
-- history), so live databases never received these two indexes. Idempotent via
-- INFORMATION_SCHEMA guards, matching the 0031/0040 pattern.
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'embedding_cache' AND INDEX_NAME = 'embedding_cache_subjectId_model_embeddingVersion_idx') = 0,
  'CREATE INDEX `embedding_cache_subjectId_model_embeddingVersion_idx` ON `embedding_cache` (`subjectId`, `model`, `embeddingVersion`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s2 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND INDEX_NAME = 'media_archive_assets_archiveId_isActive_idx') = 0,
  'CREATE INDEX `media_archive_assets_archiveId_isActive_idx` ON `media_archive_assets` (`archiveId`, `isActive`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
