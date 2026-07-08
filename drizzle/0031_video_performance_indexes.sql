-- Performance indexes for the videos table.
-- Eliminates full table scans in queue polling, recovery, and per-user counts.
CREATE INDEX IF NOT EXISTS `videos_status_createdAt_idx` ON `videos` (`status`, `createdAt`);
CREATE INDEX IF NOT EXISTS `videos_userId_createdAt_idx` ON `videos` (`userId`, `createdAt`);
CREATE INDEX IF NOT EXISTS `videos_userId_status_idx`    ON `videos` (`userId`, `status`);
