import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 12 — the admin "Delete failed" error.
//
// Deleting archive assets in the admin threw a MySQL foreign-key error:
//   "Failed query: delete from media_archive_assets where id in (?, ...)"
// Two tables carry a foreign key to media_archive_assets:
//   - media_archive_asset_embeddings.assetId  (NOT NULL reference)
//   - visual_search_memory.assetId            (nullable reference)
// MySQL rejects the asset DELETE while any child row still points at it. The fix removes the
// dependent rows first, per chunk, BEFORE deleting the asset: embedding rows are asset-specific
// and are deleted outright; visual_search_memory.assetId is nullable so it is cleared (set null)
// to preserve the learned query/source memory.

const dbSrc = readFileSync(path.join(__dirname, "db.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function bodyOfDelete(): string {
  const start = dbSrc.indexOf("export async function deleteMediaArchiveAssets(");
  expect(start).toBeGreaterThan(-1);
  const end = dbSrc.indexOf("\nexport ", start + 1);
  return codeOnly(dbSrc.slice(start, end === -1 ? undefined : end));
}

describe("RONDE 12 — deleteMediaArchiveAssets clears dependent rows before the asset delete", () => {
  const body = bodyOfDelete();

  it("deletes the embedding rows for the chunk", () => {
    expect(body).toContain(
      "db.delete(mediaArchiveAssetEmbeddings).where(inArray(mediaArchiveAssetEmbeddings.assetId, chunk))"
    );
  });

  it("nulls out visual_search_memory.assetId (not deleting the learned memory)", () => {
    expect(body).toContain("update(visualSearchMemory)");
    expect(body).toContain("assetId: null");
    expect(body).toContain("inArray(visualSearchMemory.assetId, chunk)");
    // it must NOT delete the visual_search_memory rows
    expect(body).not.toContain("db.delete(visualSearchMemory)");
  });

  it("deletes the dependent rows BEFORE the asset row", () => {
    const embIdx = body.indexOf("db.delete(mediaArchiveAssetEmbeddings)");
    const memIdx = body.indexOf("update(visualSearchMemory)");
    const assetIdx = body.indexOf("db.delete(mediaArchiveAssets)");
    expect(embIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(-1);
    expect(assetIdx).toBeGreaterThan(-1);
    expect(embIdx).toBeLessThan(assetIdx);
    expect(memIdx).toBeLessThan(assetIdx);
  });

  it("still chunks and dedupes the ids exactly as before", () => {
    expect(body).toContain("const uniqueIds = [...new Set(ids)];");
    expect(body).toContain("const chunkSize = 500;");
    expect(body).toContain("const chunk = uniqueIds.slice(i, i + chunkSize);");
    expect(body).toContain("return uniqueIds.length;");
  });
});
