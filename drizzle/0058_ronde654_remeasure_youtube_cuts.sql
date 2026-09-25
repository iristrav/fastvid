-- RONDE 654 — YouTube shot boundaries are measured again, now including dissolves and fades.
--
-- The cuts stored by RONDE 647 hold hard cuts only, so a piece could be taken from inside a
-- cross-fade. Clearing them for YouTube-origin assets makes the next plan that needs an asset
-- measure it again with the gradual-transition pass (`youtubeSoftCuts.ts`). NULL means "never
-- measured", exactly as it did before 0056; nothing else about the row changes.
UPDATE `media_archive_assets` SET `shotCutsSec` = NULL
WHERE LOWER(COALESCE(`sourcePlatform`, '')) IN ('youtube', 'youtube_cc');
