CREATE TABLE `visual_context_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`topicHash` varchar(128) NOT NULL,
	`contextJson` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_context_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `visual_intent_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`intentHash` varchar(128) NOT NULL,
	`intentJson` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_intent_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `visual_context_cache_topicHash_idx` ON `visual_context_cache` (`topicHash`);
--> statement-breakpoint
CREATE INDEX `visual_intent_cache_intentHash_idx` ON `visual_intent_cache` (`intentHash`);
