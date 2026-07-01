-- SelectionFeedback refinements:
-- 1. Add updatedAt to selection_feedback (tracks latest edit; auto-set on UPDATE)
-- 2. Add version metadata columns to selection_feedback
-- 3. Rename changedBy → actor in selection_feedback_events
-- 4. Add 'restored' to selection_feedback_events.eventType enum

ALTER TABLE `selection_feedback`
  ADD COLUMN `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP AFTER `createdAt`,
  ADD COLUMN `pipelineVersion` varchar(64) AFTER `updatedAt`,
  ADD COLUMN `engineVersion` varchar(32) AFTER `pipelineVersion`,
  ADD COLUMN `visionModel` varchar(128) AFTER `engineVersion`,
  ADD COLUMN `embeddingModel` varchar(128) AFTER `visionModel`,
  ADD COLUMN `rankingConfigVersion` varchar(32) AFTER `embeddingModel`;
--> statement-breakpoint
ALTER TABLE `selection_feedback_events`
  CHANGE COLUMN `changedBy` `actor` varchar(320) NOT NULL,
  MODIFY COLUMN `eventType` enum('created','updated','deleted','restored') NOT NULL;
