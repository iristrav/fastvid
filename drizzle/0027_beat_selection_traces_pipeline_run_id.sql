-- Add pipelineRunId to beat_selection_traces so VideoQualityReport can join
-- beat traces to their enclosing pipeline run without time-window heuristics.

ALTER TABLE `beat_selection_traces`
  ADD COLUMN `pipelineRunId` varchar(64) AFTER `videoId`;
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_pipelineRunId_idx` ON `beat_selection_traces` (`pipelineRunId`);
