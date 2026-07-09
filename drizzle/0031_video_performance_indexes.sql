-- Performance indexes for the videos table — fully idempotent via INFORMATION_SCHEMA.
-- MySQL 8.0 does not support CREATE INDEX IF NOT EXISTS, so we use prepared statements.
-- statement-breakpoint markers are REQUIRED so Drizzle executes each statement separately
-- (mysql2 without multipleStatements:true rejects multi-statement calls).
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_status_createdAt_idx') = 0,
  'CREATE INDEX `videos_status_createdAt_idx` ON `videos` (`status`, `createdAt`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_userId_createdAt_idx') = 0,
  'CREATE INDEX `videos_userId_createdAt_idx` ON `videos` (`userId`, `createdAt`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s3 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_userId_status_idx') = 0,
  'CREATE INDEX `videos_userId_status_idx` ON `videos` (`userId`, `status`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
