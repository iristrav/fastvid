-- RONDE 657 — YouTube shot boundaries are measured once more, now with a dissolve detector that sees.
--
-- The gradual-transition pass of RONDE 654 read ffmpeg's `scene` score, which stays near zero during
-- a steady cross-fade; cuts stored with it can miss dissolves. Clearing them for YouTube-origin assets
-- makes the next plan that needs an asset measure it again with the frame-difference pass. NULL means
-- "never measured"; nothing else about the row changes.
UPDATE `media_archive_assets` SET `shotCutsSec` = NULL
WHERE LOWER(COALESCE(`sourcePlatform`, '')) IN ('youtube', 'youtube_cc');
