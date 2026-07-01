-- Refinement: add traceId (unique), videoId, winnerSource, schemaVersion, engineVersion,
-- host, workerId, traceHash columns to beat_selection_traces.
-- All new columns are added with defaults where possible to avoid locking on existing rows.

ALTER TABLE `beat_selection_traces`
  ADD COLUMN `traceId` varchar(64) NOT NULL DEFAULT '' AFTER `id`,
  ADD COLUMN `videoId` varchar(256) AFTER `beatId`,
  ADD COLUMN `winnerSource` varchar(64) AFTER `overallScore`,
  ADD COLUMN `schemaVersion` varchar(16) NOT NULL DEFAULT '1.0' AFTER `promptVersion`,
  ADD COLUMN `engineVersion` varchar(32) NOT NULL DEFAULT 'v2' AFTER `schemaVersion`,
  ADD COLUMN `host` varchar(256) NOT NULL DEFAULT '' AFTER `engineVersion`,
  ADD COLUMN `workerId` varchar(128) NOT NULL DEFAULT '' AFTER `host`,
  ADD COLUMN `traceHash` varchar(64) NOT NULL DEFAULT '' AFTER `workerId`;
--> statement-breakpoint
ALTER TABLE `beat_selection_traces` ADD UNIQUE INDEX `beat_selection_traces_traceId_unique` (`traceId`);
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_videoId_idx` ON `beat_selection_traces` (`videoId`);
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_winnerSource_idx` ON `beat_selection_traces` (`winnerSource`);
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_confidenceTier_idx` ON `beat_selection_traces` (`confidenceTier`);
