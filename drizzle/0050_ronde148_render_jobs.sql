-- RONDE 148 — render jobs, and the editor's timeline.
--
-- Two things at once because they are one feature: a saved timeline that nothing can render is
-- not worth a column, and a render job with no timeline to point at has nothing to render.
--
-- WHY render_jobs IS ITS OWN TABLE, not a videos.status value:
-- videos.status tracks the GENERATION pipeline. A finished video sitting at 'completed' while a
-- re-render of its timeline runs is exactly right; putting it back into a generating state would
-- break the queue accounting, the stall sweeper, and every list that filters on that column. The
-- generation pipeline stays untouched.
--
-- WHY THE TIMELINE IS NOT IN videoScenes:
-- that column is an EditorScene[] and a dozen readers index into it as an array. Turning it into
-- an object to make room would change the shape under all of them at once, to save one column.
--
-- IDEMPOTENCY: migrationGuard re-runs a partially applied migration rather than aborting, so every
-- statement here must survive being executed twice. Columns and indexes go through
-- INFORMATION_SCHEMA and a prepared statement — the pattern 0019/0020/0023/0024/0047 use, followed
-- rather than reinvented. MySQL does not accept the inline IF NOT EXISTS forms MariaDB allows.
--
-- NOTE FOR ANYONE EDITING THIS FILE: never write the statement-breakpoint marker inside a comment.
-- The splitter matches that string anywhere in the file, comments included, and hands the
-- remainder of the sentence to MySQL as SQL.
CREATE TABLE IF NOT EXISTS `render_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int NOT NULL,
	`requestedByUserId` int,
	`status` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`progress` int NOT NULL DEFAULT 0,
	`progressStep` varchar(64) NOT NULL DEFAULT 'queued',
	`timelineVersion` int NOT NULL,
	`attempt` int NOT NULL,
	`outputUrl` varchar(1024),
	`errorCode` varchar(64),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp NULL,
	`completedAt` timestamp NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `render_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'render_jobs' AND INDEX_NAME = 'render_jobs_status_created_idx') = 0,
  'CREATE INDEX `render_jobs_status_created_idx` ON `render_jobs` (`status`, `createdAt`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'render_jobs' AND INDEX_NAME = 'render_jobs_video_status_idx') = 0,
  'CREATE INDEX `render_jobs_video_status_idx` ON `render_jobs` (`videoId`, `status`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'videoTimeline') = 0,
  'ALTER TABLE `videos` ADD COLUMN `videoTimeline` json',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s4 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'timelineVersion') = 0,
  'ALTER TABLE `videos` ADD COLUMN `timelineVersion` int NOT NULL DEFAULT 0',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s5 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'renderAttempt') = 0,
  'ALTER TABLE `videos` ADD COLUMN `renderAttempt` int NOT NULL DEFAULT 0',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s5;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s6 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'editedVideoTimelineVersion') = 0,
  'ALTER TABLE `videos` ADD COLUMN `editedVideoTimelineVersion` int',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s6;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
