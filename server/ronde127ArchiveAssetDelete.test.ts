/**
 * RONDE 127 — deleting an archive asset failed, and the fix for it already existed.
 *
 * From the admin:
 *
 *     Failed query: delete from `media_archive_assets` where `id` = ?   params: 57330
 *
 * Two tables carry a foreign key to media_archive_assets:
 *
 *     media_archive_asset_embeddings.assetId   NOT NULL references it
 *     visual_search_memory.assetId             nullable, references it
 *
 * MySQL refuses the DELETE while either still points at the asset. RONDE 12 diagnosed exactly
 * this and fixed it — in the BULK path only. There were three delete routes and two of them kept
 * a bare DELETE, so the admin's per-row button and "delete this archive" both failed on any asset
 * that had ever been embedded. Since archiveIngestion indexes an embedding on write, that is
 * every ingested asset.
 *
 * The fix is delegation rather than a third copy of the cleanup: the drift between copies is what
 * caused this.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const DB_SRC = fs.readFileSync(path.join(process.cwd(), "server", "db.ts"), "utf8");
const SCHEMA_SRC = fs.readFileSync(path.join(process.cwd(), "drizzle", "schema.ts"), "utf8");

function bodyOf(name: string): string {
  const start = DB_SRC.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = DB_SRC.indexOf("\nexport ", start + 10);
  return DB_SRC.slice(start, next === -1 ? start + 3000 : next);
}

describe("RONDE 127 — the foreign keys that block the delete", () => {
  it("both child tables really do reference the asset", () => {
    // If either of these ever stops being a foreign key, this whole round is moot — and the
    // opposite, a NEW child table, is what would reintroduce the bug.
    const refs = SCHEMA_SRC.split("references(() => mediaArchiveAssets.id)").length - 1;
    expect(refs).toBe(2);
    expect(SCHEMA_SRC).toContain('assetId: int("assetId").notNull().references(() => mediaArchiveAssets.id)');
  });

  it("REGRESSION: the single-asset delete no longer issues a bare DELETE", () => {
    const body = bodyOf("deleteMediaArchiveAsset");
    // The exact statement that failed in production.
    expect(body).not.toContain("db.delete(mediaArchiveAssets).where(eq(mediaArchiveAssets.id, id))");
    // It goes through the one path that clears the children first.
    expect(body).toContain("deleteMediaArchiveAssets([id])");
  });

  it("REGRESSION: deleting a whole archive goes the same way", () => {
    const body = bodyOf("deleteMediaArchive");
    expect(body).not.toContain(
      "db.delete(mediaArchiveAssets).where(eq(mediaArchiveAssets.archiveId, id))"
    );
    expect(body).toContain("deleteMediaArchiveAssets(assets.map((a) => a.id))");
    // The archive row itself is still deleted afterwards.
    expect(body).toContain("db.delete(mediaArchives).where(eq(mediaArchives.id, id))");
  });

  it("the one surviving implementation still clears both children, in the right order", () => {
    const body = bodyOf("deleteMediaArchiveAssets");
    const embeddings = body.indexOf("db.delete(mediaArchiveAssetEmbeddings)");
    const memory = body.indexOf("update(visualSearchMemory)");
    const assets = body.indexOf("db.delete(mediaArchiveAssets)");
    expect(embeddings).toBeGreaterThan(-1);
    expect(memory).toBeGreaterThan(-1);
    // Children first, asset last — the other order fails on the same constraint.
    expect(assets).toBeGreaterThan(embeddings);
    expect(assets).toBeGreaterThan(memory);
  });

  it("learned search memory is CLEARED, not deleted with the asset", () => {
    /**
     * visual_search_memory holds "this query on this source found usable footage". That knowledge
     * outlives the file: the asset is gone, the fact that the query worked is not. The column is
     * nullable precisely so it can be detached, and RONDE 12 chose that deliberately.
     */
    const body = bodyOf("deleteMediaArchiveAssets");
    expect(body).toContain("set({ assetId: null })");
    expect(body).not.toContain("delete(visualSearchMemory)");
  });

  it("every delete route in db.ts now goes through the cleanup", () => {
    /**
     * The bug was two copies drifting apart, so this counts the copies. Exactly one function may
     * issue a DELETE against media_archive_assets; everything else delegates to it.
     */
    const bareDeletes = DB_SRC.split("delete(mediaArchiveAssets)").length - 1;
    expect(bareDeletes).toBe(1);
  });
});
