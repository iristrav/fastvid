/**
 * RONDE 648 — the one-time split of archive 36, as the operator chose it.
 *
 * Measured at boot, 2026-09-24 12:41:
 *
 *   [ArchiveInventory] archive=36 name="Stockbeelden" slug=space-race-nasa active=1 assets=61
 *                      sources=youtube_cc:57,wikimedia:3,openverse:1
 *   [ArchiveInventory] archive=37 name="WW2" slug=ww2 active=1 assets=364
 *                      sources=upload:309,youtube_cc:36,wikimedia:11,internet_archive:6,loc:2
 *
 * Chosen: YouTube out of Stockbeelden into its own archive; other automatic sources into Overig;
 * WW2 untouched; Stockbeelden becomes the stock archive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { AUTO_ARCHIVES, OTHER_ARCHIVE_SLUG, STOCK_ARCHIVE_SLUG, YOUTUBE_ARCHIVE_SLUG } from "./stockArchive";

const SQL = readFileSync(join(__dirname, "..", "drizzle", "0057_ronde648_youtube_overig_stock_archives.sql"), "utf8");
const statements = SQL.split(/--> statement-breakpoint/).map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
const JOURNAL = JSON.parse(readFileSync(join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

describe("the migration", () => {
  it("is registered, so it actually runs", () => {
    expect(JOURNAL.entries.at(-1)).toMatchObject({ idx: 57, tag: "0057_ronde648_youtube_overig_stock_archives" });
  });

  it("creates the two archives under the slugs ingestion routes to", () => {
    expect(statements[0]).toContain(`'${AUTO_ARCHIVES.youtube.name}', '${YOUTUBE_ARCHIVE_SLUG}'`);
    expect(statements[1]).toContain(`'${AUTO_ARCHIVES.other.name}', '${OTHER_ARCHIVE_SLUG}'`);
    for (const s of statements.slice(0, 2)) expect(s).toMatch(/^INSERT IGNORE/);
  });

  it("moves assets only out of archive 36 named Stockbeelden — WW2 (37) is never touched", () => {
    const moves = statements.filter((s) => s.startsWith("UPDATE `media_archive_assets`"));
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect(m).toContain("src.`id` = 36 AND src.`name` = 'Stockbeelden'");
      expect(m).not.toMatch(/\b37\b/);
    }
    expect(moves[0]).toContain("dst.`slug` = 'youtube'");
    expect(moves[1]).toContain("dst.`slug` = 'overig'");
    expect(moves[1]).toContain("x.`mixKind` <> 'stock'");
  });

  it("YouTube moves first, so Overig receives only what is neither YouTube nor stock", () => {
    const i = statements.findIndex((s) => s.includes("dst.`slug` = 'youtube'"));
    const j = statements.findIndex((s) => s.includes("dst.`slug` = 'overig'"));
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("archive 36 becomes the stock archive only if no other archive holds that slug", () => {
    const last = statements.at(-1)!;
    expect(last).toContain(`SET a.\`slug\` = '${STOCK_ARCHIVE_SLUG}', a.\`isActive\` = ${AUTO_ARCHIVES.stock.isActive}`);
    expect(last).toContain("WHERE a.`id` = 36 AND a.`name` = 'Stockbeelden' AND s.`id` IS NULL");
  });

  it("deletes nothing", () => {
    expect(SQL).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
  });
});
