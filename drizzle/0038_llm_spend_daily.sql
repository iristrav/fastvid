-- Application-side LLM daily spend tracker (provider dashboard "hard limits"
-- are not reliably hard-stopping traffic as of 2026 — see server/_core/llmBudget.ts)
CREATE TABLE IF NOT EXISTS `llm_spend_daily` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `day` varchar(10) NOT NULL,
  `spentUsdCents` int NOT NULL DEFAULT 0,
  `callCount` int NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `llm_spend_daily_day_unique` (`day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
