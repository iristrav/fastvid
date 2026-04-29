ALTER TABLE `videos` ADD `progressStep` varchar(256);--> statement-breakpoint
ALTER TABLE `videos` ADD `progressPercent` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `videos` ADD `generationStartedAt` timestamp;