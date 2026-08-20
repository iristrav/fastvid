/**
 * RONDE 9 — deactivate poisoned curated-archive assets.
 *
 * The old self-learning ingestion archived ANY winning clip (including generic Pexels/Pixabay
 * stock) and tagged it with the beat's NARRATION keywords — so a stock interview clip could sit
 * in the archive labeled "adolf hitler" and outrank real archival footage on every later render
 * (proven in render 519 + the admin screenshots). The ingestion is fixed in code; this script
 * neutralizes the rows the old behavior already created.
 *
 * What it does (deactivates — never deletes; reactivate any asset in the admin):
 *   1. isActive=0 for assets whose source is Pexels/Pixabay (sourcePlatform or sourceNote).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/cleanup-poisoned-archive.ts            # dry run (default)
 *   DATABASE_URL=... npx tsx scripts/cleanup-poisoned-archive.ts --apply   # actually deactivate
 */
import "dotenv/config";
import { getDb } from "../server/db";
import { mediaArchiveAssets } from "../drizzle/schema";
import { and, eq, like, or, sql } from "drizzle-orm";

const apply = process.argv.includes("--apply");

const db = await getDb();
if (!db) {
  console.error("[cleanup-poisoned-archive] No database connection (DATABASE_URL set?)");
  process.exit(1);
}

const stockFilter = and(
  eq(mediaArchiveAssets.isActive, 1),
  or(
    eq(mediaArchiveAssets.sourcePlatform, "pexels"),
    eq(mediaArchiveAssets.sourcePlatform, "pixabay"),
    like(mediaArchiveAssets.sourceNote, "pexels:%"),
    like(mediaArchiveAssets.sourceNote, "pixabay:%")
  )
);

const stockRows = await db
  .select({
    id: mediaArchiveAssets.id,
    title: mediaArchiveAssets.title,
    sourceNote: mediaArchiveAssets.sourceNote,
    tags: mediaArchiveAssets.tags,
  })
  .from(mediaArchiveAssets)
  .where(stockFilter);

console.log(`[cleanup-poisoned-archive] ${stockRows.length} active stock-sourced asset(s) found:`);
for (const r of stockRows.slice(0, 50)) {
  console.log(`  #${r.id}  ${String(r.sourceNote ?? "").slice(0, 40)}  "${String(r.title ?? "").slice(0, 60)}"`);
}
if (stockRows.length > 50) console.log(`  … and ${stockRows.length - 50} more`);

if (!apply) {
  console.log("\n[cleanup-poisoned-archive] DRY RUN — nothing changed. Re-run with --apply to deactivate these assets.");
  process.exit(0);
}

if (stockRows.length > 0) {
  const result = await db
    .update(mediaArchiveAssets)
    .set({ isActive: 0 })
    .where(stockFilter);
  console.log(`[cleanup-poisoned-archive] Deactivated ${stockRows.length} stock-sourced asset(s).`, result ? "" : "");
}

const remaining = await db
  .select({ n: sql<number>`count(*)` })
  .from(mediaArchiveAssets)
  .where(eq(mediaArchiveAssets.isActive, 1));
console.log(`[cleanup-poisoned-archive] Done — ${remaining[0]?.n ?? "?"} active asset(s) remain in the archive.`);
process.exit(0);
