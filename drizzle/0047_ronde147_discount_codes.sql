-- RONDE 147 — discount codes.
--
-- Mirrors the Stripe promotion codes created from Admin ▸ Discount Codes. Stripe stays the source
-- of truth for redeemability and redemption counts; this table exists so the overview is one query
-- rather than one API call per row, and so FastVid keeps its own record of who issued a code.
--
-- `stripePromotionCodeId` is unique so a retried create cannot leave two rows pointing at the same
-- Stripe object. `code` is unique because it is what a customer types.
--
-- ── RONDE 150: two things this file got wrong the first time ────────────────────────────────
--
-- 1. `--> statement-breakpoint` is required, not decoration. drizzle-orm's migrator splits a
--    migration on those markers and sends each piece as its own query; without them all three
--    statements arrive as one string and MySQL rejects it.
--
-- 2. `CREATE INDEX IF NOT EXISTS` is MariaDB syntax. MySQL does not accept it, so the idempotent
--    form has to go through INFORMATION_SCHEMA and a prepared statement — the pattern already
--    established by 0019/0020/0023/0024 in this folder, followed here verbatim rather than
--    invented again. Idempotency matters because migrationGuard re-runs a partially applied
--    migration rather than aborting, and only if it can detect the migration is safe to re-run.
CREATE TABLE IF NOT EXISTS `discount_codes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`stripeCouponId` varchar(128) NOT NULL,
	`stripePromotionCodeId` varchar(128) NOT NULL,
	`percentOff` int,
	`amountOffCents` int,
	`currency` varchar(8),
	`isActive` int NOT NULL DEFAULT 1,
	`startsAt` timestamp NULL,
	`expiresAt` timestamp NULL,
	`maxRedemptions` int,
	`timesRedeemed` int NOT NULL DEFAULT 0,
	`note` varchar(256),
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `discount_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `discount_codes_code_unique` UNIQUE(`code`),
	CONSTRAINT `discount_codes_stripePromotionCodeId_unique` UNIQUE(`stripePromotionCodeId`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'discount_codes' AND INDEX_NAME = 'discount_codes_isActive_idx') = 0,
  'CREATE INDEX `discount_codes_isActive_idx` ON `discount_codes` (`isActive`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'discount_codes' AND INDEX_NAME = 'discount_codes_created_idx') = 0,
  'CREATE INDEX `discount_codes_created_idx` ON `discount_codes` (`createdAt`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
