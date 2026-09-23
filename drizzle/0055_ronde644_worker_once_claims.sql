-- RONDE 644 — "exactly one worker does this", for work that costs money.
--
-- The worker runs as three replicas and each boots the same code. A controlled live test of a paid
-- provider (Apify) must run once per deployment, not three times. One row per claim key; the
-- INSERT that lands is the one worker that runs it. Nothing reads this table on a render path.
CREATE TABLE IF NOT EXISTS `worker_once_claims` (
  `id` int AUTO_INCREMENT NOT NULL,
  `claimKey` varchar(128) NOT NULL,
  `holder` varchar(128),
  `claimedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `worker_once_claims_id` PRIMARY KEY(`id`),
  CONSTRAINT `worker_once_claims_claimKey_unique` UNIQUE(`claimKey`)
);