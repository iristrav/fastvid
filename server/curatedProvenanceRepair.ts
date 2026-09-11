import type { VisualLineageRecord, VisualSourceLedger } from "./visualSourceLineage";

/**
 * THE ARCHIVE ROW IS THE PROOF, AND IT IS STILL AVAILABLE AFTER THE FACT.
 *
 * Render 577 blocked on `MOSTLY_UNVERIFIED_CLIPS: 9 of 15 fetched clip(s) have no proven source`.
 * All nine were clips out of FastVid's OWN curated archive. Their ledger records read
 *
 *     provider=UNVERIFIED providerStatus=UNVERIFIED route=backfill archiveAsset=57391
 *     candidateId=curated:asset:57547 clip=scene_0_b101_curated_a57391.mp4
 *
 * — the asset id present, the provider absent. They were opened by `recordClipAdoption`'s
 * untraced branch, which is reached when a route adopts a clip the ledger has never seen. That
 * branch is right to leave the provider unset: it holds a route label and a filename, and
 * RONDE 87's rule is that neither is evidence of where a picture came from.
 *
 * But `curated:asset:<id>` is not a filename and not a route label. It is a canonical key into
 * this system's own `media_archive_assets` table, produced by the key resolver, and the row it
 * names carries the archive's name — the same `picked.archiveName` that
 * `ensureCuratedAssetLineageOn` writes as the provider on the routes that DO open a record in
 * time. So the evidence for these nine clips was never lost; it was simply never looked up.
 *
 * ── What this is, and what it is not ────────────────────────────────────────────────────────
 *
 * It is a LOOKUP, not an inference. The caller loads real rows from the archive table and this
 * attributes from them, through `attributeProvider` — the ledger's single provider writer, which
 * fills a gap and never overwrites. A record whose key is not canonical curated, or whose asset
 * is no longer in the table, keeps no provider and stays in the UNVERIFIED bucket where it
 * belongs. Nothing is relaxed: the share limit, the gate and every threshold are untouched.
 *
 * It is also not a substitute for fixing the route that lost the attribution. `repairSummary`
 * prints which routes needed repairing and how often, so the underlying gap stays visible in the
 * log rather than being quietly absorbed here every render.
 */

/** The canonical curated key, and the only shape an asset id may be read from. */
const CURATED_KEY = /^curated:asset:(\d+)$/;

/** What the archive table must supply for one asset before its clips can be attributed. */
export type CuratedArchiveProvenanceRow = {
  assetId: number;
  /** The archive's own name — e.g. "WW2". The provider. */
  archiveName: string | null;
  storageUrl?: string | null;
};

/** The asset id a record's content key names, or null when the key is not a curated one. */
export function curatedAssetIdOfRecord(record: {
  contentKey?: string;
  candidateId?: string;
}): number | null {
  for (const key of [record.contentKey, record.candidateId]) {
    const id = CURATED_KEY.exec((key ?? "").trim())?.[1];
    if (id) return Number(id);
  }
  return null;
}

/**
 * The curated assets whose records have no provider yet.
 *
 * Deduplicated, because one archive asset is routinely offered to several beats and each copy may
 * hold its own record — one row per asset answers all of them.
 */
export function curatedAssetIdsNeedingProvenance(
  records: readonly { contentKey?: string; candidateId?: string; provider?: string | null }[]
): number[] {
  const ids = new Set<number>();
  for (const record of records) {
    if (record.provider) continue;
    const id = curatedAssetIdOfRecord(record);
    if (id != null) ids.add(id);
  }
  return [...ids];
}

export type CuratedProvenanceRepair = {
  /** Records that had no provider and named a curated asset. */
  candidates: number;
  /** Records this attributed from a real archive row. */
  attributed: number;
  /** Records whose asset the archive could not supply — still UNVERIFIED, deliberately. */
  unresolved: number;
  /** How many repairs each adopt route needed, so the route that lost the attribution is named. */
  byRoute: Record<string, number>;
};

/**
 * Attribute every unattributed curated record from the archive rows it names.
 *
 * `rows` comes from the database. Nothing here reads a path, a basename or a route label.
 */
export function repairCuratedProvenance(
  ledger: Pick<VisualSourceLedger, "allRecords" | "attributeProvider">,
  rows: readonly CuratedArchiveProvenanceRow[]
): CuratedProvenanceRepair {
  const byId = new Map<number, CuratedArchiveProvenanceRow>();
  for (const row of rows) byId.set(row.assetId, row);

  const repair: CuratedProvenanceRepair = {
    candidates: 0,
    attributed: 0,
    unresolved: 0,
    byRoute: {},
  };

  for (const record of ledger.allRecords() as VisualLineageRecord[]) {
    if (record.provider) continue;
    const assetId = curatedAssetIdOfRecord(record);
    if (assetId == null) continue;
    repair.candidates += 1;
    const row = byId.get(assetId);
    /**
     * An archive name is the provider. `own_archive` when the row carries none — the same answer
     * `ensureCuratedAssetLineageOn` gives, and a real one: the asset came from the operator's own
     * uploaded archive. A row that is not there at all is NOT that case, and gets nothing.
     */
    if (!row) {
      repair.unresolved += 1;
      continue;
    }
    const before = record.provider;
    ledger.attributeProvider(record, {
      provider: row.archiveName?.trim() || "own_archive",
      providerAssetId: String(assetId),
      archiveAssetId: assetId,
      sourceUrl: row.storageUrl ?? undefined,
    });
    if (!before && record.provider) {
      repair.attributed += 1;
      const route = record.route ?? "unknown";
      repair.byRoute[route] = (repair.byRoute[route] ?? 0) + 1;
    } else {
      repair.unresolved += 1;
    }
  }
  return repair;
}

/**
 * The line the render prints about its own repair.
 *
 * Written even when nothing needed repairing, because "none" is the answer that says the routes
 * are attributing their own clips again — and a silent success is indistinguishable from a step
 * that never ran.
 */
export function formatCuratedProvenanceRepair(repair: CuratedProvenanceRepair): string {
  if (repair.candidates === 0) {
    return "[CuratedProvenance] no unattributed curated records — every route opened its own";
  }
  const routes = Object.entries(repair.byRoute)
    .sort((a, b) => b[1] - a[1])
    .map(([route, n]) => `${route}:${n}`)
    .join(",");
  return (
    `[CuratedProvenance] attributed ${repair.attributed}/${repair.candidates} curated record(s) ` +
    `from the archive table (unresolved=${repair.unresolved}` +
    (routes ? `, routes=${routes}` : "") +
    ") — these routes adopted a curated clip without opening its lineage first"
  );
}
