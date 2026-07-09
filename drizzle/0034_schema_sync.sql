-- Schema sync: fix three mismatches found by schemaAuditor at startup.
--
-- 1. editorial_reviews.overallScore was created as TINYINT UNSIGNED in migration 0033
--    but drizzle/schema.ts declares it as int().  Widen to INT to match the schema.
--
-- 2. media_archives.createdByUserId was declared with .references(() => users.id)
--    in the schema but migration 0012 never created the FK constraint.
--    Add it now (idempotent via INFORMATION_SCHEMA check).

-- 1. Widen overallScore from TINYINT UNSIGNED → INT
ALTER TABLE `editorial_reviews`
  MODIFY COLUMN `overallScore` INT NOT NULL;
--> statement-breakpoint

-- 2. Add missing FK on media_archives.createdByUserId → users.id (idempotent)
SET @db = DATABASE();
--> statement-breakpoint
SET @addFk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = @db
     AND CONSTRAINT_NAME = 'media_archives_createdByUserId_users_id_fk') = 0,
  'ALTER TABLE `media_archives` ADD CONSTRAINT `media_archives_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addFk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
