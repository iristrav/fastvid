-- Fencing token for video generation runs.
-- A stall-requeue (server/db.ts requeueStalledPipeline) sets status back to "queued" so a
-- fresh worker can retry, but the old ("zombie") run may still be executing in a different
-- process (e.g. a separate Railway worker service) and never learns it was cancelled — it
-- keeps overwriting progressStep/status with stale data. generationAttempt is bumped once
-- per fresh claim; each run captures its own attempt number at start and stops writing once
-- the DB's current attempt no longer matches its own, regardless of which process it runs in.
SET @db = DATABASE();
--> statement-breakpoint
SET @addGenerationAttempt = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'generationAttempt') = 0,
  'ALTER TABLE `videos` ADD COLUMN `generationAttempt` INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addGenerationAttempt;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
