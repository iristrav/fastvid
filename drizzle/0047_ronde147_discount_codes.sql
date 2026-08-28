-- RONDE 147 — discount codes.
--
-- Mirrors the Stripe promotion codes created from Admin ▸ Discount Codes. Stripe stays the source
-- of truth for redeemability and redemption counts; this table exists so the overview is one query
-- rather than one API call per row, and so FastVid keeps its own record of who issued a code.
--
-- `stripePromotionCodeId` is unique so a retried create cannot leave two rows pointing at the same
-- Stripe object. `code` is unique because it is what a customer types.

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

CREATE INDEX `discount_codes_isActive_idx` ON `discount_codes` (`isActive`);
CREATE INDEX `discount_codes_created_idx` ON `discount_codes` (`createdAt`);
