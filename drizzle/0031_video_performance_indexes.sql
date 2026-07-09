-- Performance indexes for the videos table.
-- Eliminates full table scans in queue polling, recovery, and per-user counts.
-- Note: standard MySQL CREATE INDEX (no IF NOT EXISTS — not supported in MySQL 8.0).
CREATE INDEX `videos_status_createdAt_idx` ON `videos` (`status`, `createdAt`);
CREATE INDEX `videos_userId_createdAt_idx` ON `videos` (`userId`, `createdAt`);
CREATE INDEX `videos_userId_status_idx`    ON `videos` (`userId`, `status`);
