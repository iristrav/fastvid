-- Add pipelineVersion column to beat_selection_traces for filtering traces across
-- pipeline variants (visual-matching-v1, visual-matching-v2, experimental-v3, etc.)
-- without relying on engineVersion.

ALTER TABLE `beat_selection_traces`
  ADD COLUMN `pipelineVersion` varchar(64) NOT NULL DEFAULT 'visual-matching-v2' AFTER `engineVersion`;
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_pipelineVersion_idx` ON `beat_selection_traces` (`pipelineVersion`);
