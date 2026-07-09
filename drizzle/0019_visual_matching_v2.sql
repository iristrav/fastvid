CREATE TABLE IF NOT EXISTS `visual_context_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`topicHash` varchar(128) NOT NULL,
	`contextJson` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_context_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `visual_intent_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`intentHash` varchar(128) NOT NULL,
	`intentJson` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_intent_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'visual_context_cache' AND INDEX_NAME = 'visual_context_cache_topicHash_idx') = 0,
  'CREATE INDEX `visual_context_cache_topicHash_idx` ON `visual_context_cache` (`topicHash`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'visual_intent_cache' AND INDEX_NAME = 'visual_intent_cache_intentHash_idx') = 0,
  'CREATE INDEX `visual_intent_cache_intentHash_idx` ON `visual_intent_cache` (`intentHash`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
