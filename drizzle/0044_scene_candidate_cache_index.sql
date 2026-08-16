-- P0 fix 2: getCandidatePool (server/sceneCandidateCache.ts) filters scene_candidate_cache on
-- queryHash+source+expiresAt together on every lookup, called synchronously in the render hot
-- path — this table never got the composite index every other cache table in this file already
-- has (see 0041_phase12_missing_indexes.sql). Idempotent via INFORMATION_SCHEMA guard, matching
-- the 0031/0040/0041 pattern.
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'scene_candidate_cache' AND INDEX_NAME = 'scene_candidate_cache_queryHash_source_expiresAt_idx') = 0,
  'CREATE INDEX `scene_candidate_cache_queryHash_source_expiresAt_idx` ON `scene_candidate_cache` (`queryHash`, `source`, `expiresAt`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
