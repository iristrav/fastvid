-- Clip annotation & editorial score for media_archive_assets.
-- annotationJson: full ClipAnnotation produced at ingest by the clip annotator.
-- editorialScore: 0-100 derived from annotation, nudged by adopt/reject feedback.
-- annotationVersion: bumped when annotator prompt changes; triggers re-backfill.
-- Note: uses standard MySQL ADD COLUMN (no IF NOT EXISTS — not supported in MySQL 8.0).
ALTER TABLE `media_archive_assets`
  ADD COLUMN `annotationJson`     JSON,
  ADD COLUMN `editorialScore`     INT,
  ADD COLUMN `annotationVersion`  VARCHAR(16);

-- Indexes use standard CREATE INDEX (no IF NOT EXISTS in MySQL 8.0).
CREATE INDEX `media_archive_assets_editorial_idx`
  ON `media_archive_assets` (`isActive`, `editorialScore`);

CREATE INDEX `media_archive_assets_annotation_backfill_idx`
  ON `media_archive_assets` (`isActive`, `annotationVersion`, `id`);
