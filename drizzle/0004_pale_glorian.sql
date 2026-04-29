ALTER TABLE `videos` MODIFY COLUMN `status` enum('pending','generating_script','awaiting_approval','generating_voiceover','generating_visuals','generating_effects','completed','failed') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `videos` ADD `videoType` enum('documentary','listicle','tutorial','explainer') DEFAULT 'documentary' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `scriptApproved` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `customVoiceoverUrl` varchar(1024);