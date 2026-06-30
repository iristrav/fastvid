CREATE TABLE `backfill_cursors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobName` varchar(128) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`embeddingVersion` varchar(32) NOT NULL,
	`lastProcessedId` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `backfill_cursors_id` PRIMARY KEY(`id`),
	CONSTRAINT `backfill_cursors_job_provider_model_version_idx` UNIQUE(`jobName`,`provider`,`model`,`embeddingVersion`)
);
