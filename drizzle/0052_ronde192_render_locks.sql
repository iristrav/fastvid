-- RONDE 192 — one production render per video, decided by the database.
--
-- `videoId` is UNIQUE and a row exists only while a render holds the lock, so the acquire is an
-- INSERT that the key either admits or refuses. Two workers cannot both win.
--
-- `expiresAt` is the lease. A crashed worker leaves its row behind; without an expiry that video
-- would be unrenderable for ever, which is worse than the collision this table prevents.
CREATE TABLE IF NOT EXISTS `render_locks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` int NOT NULL,
  `productionRenderId` varchar(64) NOT NULL,
  `holderLabel` varchar(128),
  `acquiredAt` timestamp NOT NULL DEFAULT (now()),
  `expiresAt` timestamp NOT NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `render_locks_id` PRIMARY KEY(`id`),
  CONSTRAINT `render_locks_videoId_unique` UNIQUE(`videoId`)
);
--> statement-breakpoint
CREATE INDEX `render_locks_expires_idx` ON `render_locks` (`expiresAt`);
--> statement-breakpoint
ALTER TABLE `render_locks` ADD CONSTRAINT `render_locks_videoId_videos_id_fk`
  FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;
