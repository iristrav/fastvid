-- Per-user companion to llm_spend_daily (Phase 1 "AI Gateway" — tracking only,
-- no enforcement yet). See server/_core/llmBudget.ts recordLlmUsage().
CREATE TABLE IF NOT EXISTS `llm_spend_by_user` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `userId` int NOT NULL,
  `day` varchar(10) NOT NULL,
  `model` varchar(128) NOT NULL,
  `promptTokens` int NOT NULL DEFAULT 0,
  `completionTokens` int NOT NULL DEFAULT 0,
  `spentUsdCents` int NOT NULL DEFAULT 0,
  `callCount` int NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `llm_spend_by_user_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`),
  INDEX `llm_spend_by_user_userId_day_idx` (`userId`, `day`),
  UNIQUE INDEX `llm_spend_by_user_userId_day_model_unique` (`userId`, `day`, `model`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
