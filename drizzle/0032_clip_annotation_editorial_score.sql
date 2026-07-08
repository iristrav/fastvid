-- Clip annotation & editorial score for media_archive_assets.
-- annotationJson: full ClipAnnotation produced at ingest by the clip annotator.
-- editorialScore: 0-100 derived from annotation, nudged by adopt/reject feedback.
-- annotationVersion: bumped when annotator prompt changes; triggers re-backfill.
ALTER TABLE `media_archive_assets`
  ADD COLUMN IF NOT EXISTS `annotationJson`     JSON,
  ADD COLUMN IF NOT EXISTS `editorialScore`     INT,
  ADD COLUMN IF NOT EXISTS `annotationVersion`  VARCHAR(16);

-- Index for retrieval: filter active + sort by editorial score
CREATE INDEX IF NOT EXISTS `media_archive_assets_editorial_idx`
  ON `media_archive_assets` (`isActive`, `editorialScore`);

-- Index for backfill job: find un-annotated active assets
CREATE INDEX IF NOT EXISTS `media_archive_assets_annotation_backfill_idx`
  ON `media_archive_assets` (`isActive`, `annotationVersion`, `id`);
