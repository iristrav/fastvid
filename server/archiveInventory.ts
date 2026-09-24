/**
 * RONDE 648 — WHAT IS IN EACH ARCHIVE, READ ONCE AT BOOT.
 *
 * Render 605 used four YouTube segments from an archive named "Stockbeelden" (id 36): every
 * automatic ingest — YouTube, Wikimedia, Internet Archive — lands in the most recently updated
 * active archive, and that archive is this one. RONDE 647 had meanwhile created a second, hidden
 * archive under the same name for Pexels and Pixabay. Before any asset is moved, the actual
 * contents are logged: per archive, its name, slug, state and how many assets came from where.
 * Read-only. Nothing here writes.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export type ArchiveInventoryRow = {
  archiveId: number;
  name: string;
  slug: string;
  isActive: number;
  source: string;
  mixKind: string;
  n: number;
};

/**
 * One line per archive. `source` is `sourcePlatform` when the row has one, else the provider an
 * automatic ingest writes into the object key (`archive-ingested/<id>/<provider>:…`), else
 * `upload` — an asset somebody put there by hand.
 */
export function formatArchiveInventory(rows: readonly ArchiveInventoryRow[]): string[] {
  const byArchive = new Map<number, ArchiveInventoryRow[]>();
  for (const r of rows) {
    const list = byArchive.get(r.archiveId) ?? [];
    list.push(r);
    byArchive.set(r.archiveId, list);
  }
  const tally = (list: ArchiveInventoryRow[], key: "source" | "mixKind") => {
    const m = new Map<string, number>();
    for (const r of list) if (r.n > 0) m.set(r[key], (m.get(r[key]) ?? 0) + r.n);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(",");
  };
  return [...byArchive.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, list]) => {
      const head = list[0]!;
      const total = list.reduce((s, r) => s + r.n, 0);
      return (
        `[ArchiveInventory] archive=${id} name=${JSON.stringify(head.name)} slug=${head.slug} ` +
        `active=${head.isActive} assets=${total} sources=${tally(list, "source") || "none"} ` +
        `mix=${tally(list, "mixKind") || "none"}`
      );
    });
}

export async function logArchiveInventory(log: (line: string) => void = console.log): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const result = await db.execute(sql`
    SELECT a.id AS archiveId, a.name AS name, a.slug AS slug, a.isActive AS isActive,
      COALESCE(NULLIF(x.sourcePlatform, ''),
        CASE WHEN x.storageKey LIKE 'archive-ingested/%'
          THEN SUBSTRING_INDEX(SUBSTRING_INDEX(x.storageKey, '/', -1), ':', 1)
          ELSE 'upload' END) AS source,
      COALESCE(x.mixKind, 'none') AS mixKind,
      COUNT(x.id) AS n
    FROM media_archives a
    LEFT JOIN media_archive_assets x ON x.archiveId = a.id
    GROUP BY a.id, a.name, a.slug, a.isActive, source, mixKind
  `);
  /** drizzle mysql2 returns `[rows, fields]` for a SELECT — the shape archiveClipEmbeddingStore reads. */
  const first = Array.isArray(result) ? (result as unknown[])[0] : null;
  const raw = (Array.isArray(first) ? first : Array.isArray(result) ? result : []) as Record<string, unknown>[];
  const rows: ArchiveInventoryRow[] = raw.map((r) => ({
    archiveId: Number(r.archiveId),
    name: String(r.name ?? ""),
    slug: String(r.slug ?? ""),
    isActive: Number(r.isActive),
    source: Number(r.n) === 0 ? "none" : String(r.source ?? "upload"),
    mixKind: Number(r.n) === 0 ? "none" : String(r.mixKind ?? "none"),
    n: Number(r.n),
  }));
  for (const line of formatArchiveInventory(rows)) log(line);
}
