ALTER TABLE `niche_requests` MODIFY `userId` int NULL;
--> statement-breakpoint
ALTER TABLE `niche_requests` MODIFY `videoFormat` varchar(32) NULL;
--> statement-breakpoint
ALTER TABLE `niche_requests` ADD `contactEmail` varchar(320);
