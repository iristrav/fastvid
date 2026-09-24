-- RONDE 647 — the shot boundaries of an archive asset, so a YouTube piece never crosses a cut.
--
-- Nullable and not backfilled: NULL means "never measured", and the first plan that needs an
-- asset's cuts measures them and writes them here. [] means measured, one continuous shot.
ALTER TABLE `media_archive_assets` ADD COLUMN `shotCutsSec` json;
