-- RONDE 177: an archive clip's duration has to survive a trim.
--
-- `durationSec` was INT. trimArchiveAsset probes the file it produced and writes that duration
-- back, which is fractional — 8.53s, not 9s. MySQL rounded it on the way in, so:
--
--   · the duration the operator was shown (8.53s) was never the duration in the row (9s), and
--   · a trim that shortened a clip by less than half a second wrote back the same integer it
--     started with, leaving a row that looked like nothing had been saved.
--
-- FLOAT is what media_asset_cache.durationSec has always used for the same values. Widening an
-- INT to a FLOAT preserves every existing value exactly; whole seconds stay whole seconds.
ALTER TABLE `media_archive_assets`
  MODIFY COLUMN `durationSec` float NULL;
