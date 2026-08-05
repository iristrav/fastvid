-- Phase 3 hybrid query generation (queryGeneration.ts) — caches the LLM's query-expansion
-- output per beat intent, keyed the same way visual_intent_cache is (intentHash), so an
-- identical beat never re-triggers the LLM query-expansion call twice.
CREATE TABLE IF NOT EXISTS `visual_query_expansion_cache` (
  `id` int AUTO_INCREMENT NOT NULL,
  `intentHash` varchar(128) NOT NULL,
  `queriesJson` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `visual_query_expansion_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'visual_query_expansion_cache' AND INDEX_NAME = 'visual_query_expansion_cache_intentHash_idx') = 0,
  'CREATE INDEX `visual_query_expansion_cache_intentHash_idx` ON `visual_query_expansion_cache` (`intentHash`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
