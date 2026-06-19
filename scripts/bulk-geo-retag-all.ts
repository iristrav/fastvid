/**
 * Bulk geo-retag all archive assets (no LLM). Usage:
 *   DATABASE_URL=... npx tsx scripts/bulk-geo-retag-all.ts
 */
import "dotenv/config";
import { runBulkGeoRetagAllArchives } from "../server/archiveHealth";

console.log("[bulk-geo-retag] Starting...");
const result = await runBulkGeoRetagAllArchives();
console.log(
  `[bulk-geo-retag] Done — ${result.archives} archive(s), ${result.updated}/${result.processed} assets updated`
);
