-- RONDE 118: record whether an archive asset's preview was ever proven readable.
--
-- Both columns are nullable and default to NULL on purpose. Every row that predates this check
-- keeps its current behaviour until a sweep actually looks at it — declaring 57 000 existing
-- assets broken because nobody had checked them yet would be a worse lie than the one this
-- round exists to remove.
--
--   previewCheckedAt  NULL = never checked; a timestamp = the preview was readable at that moment
--   previewIssue      NULL = no known problem; a short reason code when there is one
--
-- isActive stays the column that decides whether an asset reaches candidate selection; these two
-- say WHY it was switched off, so a broken asset is distinguishable from one an operator
-- deactivated deliberately.
ALTER TABLE `media_archive_assets`
  ADD COLUMN `previewCheckedAt` timestamp NULL,
  ADD COLUMN `previewIssue` varchar(64) NULL;
