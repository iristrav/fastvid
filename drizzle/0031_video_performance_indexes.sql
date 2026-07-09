-- Performance indexes for the videos table — idempotent via INFORMATION_SCHEMA check.
-- MySQL 8.0 does not support CREATE INDEX IF NOT EXISTS, so we use a prepared statement.
SET @db = DATABASE();

SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_status_createdAt_idx') = 0,
  'CREATE INDEX `videos_status_createdAt_idx` ON `videos` (`status`, `createdAt`)',
  'SELECT 1'
);
PREPARE stmt FROM @s1; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s2 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_userId_createdAt_idx') = 0,
  'CREATE INDEX `videos_userId_createdAt_idx` ON `videos` (`userId`, `createdAt`)',
  'SELECT 1'
);
PREPARE stmt FROM @s2; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s3 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND INDEX_NAME = 'videos_userId_status_idx') = 0,
  'CREATE INDEX `videos_userId_status_idx` ON `videos` (`userId`, `status`)',
  'SELECT 1'
);
PREPARE stmt FROM @s3; EXECUTE stmt; DEALLOCATE PREPARE stmt;
