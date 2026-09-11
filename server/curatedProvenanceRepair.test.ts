import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  curatedAssetIdOfRecord,
  curatedAssetIdsNeedingProvenance,
  formatCuratedProvenanceRepair,
  repairCuratedProvenance,
  type CuratedArchiveProvenanceRow,
} from "./curatedProvenanceRepair";
import { VisualSourceLedger } from "./visualSourceLineage";

/**
 * THE NINE CLIPS THAT BLOCKED RENDER 577.
 *
 *     Export blocked — MOSTLY_UNVERIFIED_CLIPS: 9 of 15 fetched clip(s) have no proven source
 *
 * All nine came out of FastVid's own curated archive and carried their asset id. What they did
 * not carry was a provider, because the route that adopted them never opened their lineage and
 * `recordClipAdoption` will not name a provider from a route label or a filename (RONDE 87).
 *
 * These tests pin that the repair reads the ARCHIVE TABLE and nothing else, and that a record it
 * cannot prove stays exactly as unproven as it was.
 */

const row = (assetId: number, archiveName: string | null): CuratedArchiveProvenanceRow => ({
  assetId,
  archiveName,
  storageUrl: `https://example.invalid/a${assetId}.mp4`,
});

function ledgerWithUnattributedCurated(assetIds: number[]): VisualSourceLedger {
  const ledger = new VisualSourceLedger({ renderId: "r577", emit: () => {} });
  for (const [i, id] of assetIds.entries()) {
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: i,
      candidateId: `curated:asset:${id}`,
      contentKey: `curated:asset:${id}`,
      localPath: `/w/scene_0_b${i}_curated_a${id}.mp4`,
      route: "backfill",
    });
  }
  return ledger;
}

describe("which records need provenance", () => {
  it("reads the asset id from the canonical key only", () => {
    expect(curatedAssetIdOfRecord({ contentKey: "curated:asset:57547" })).toBe(57547);
    expect(curatedAssetIdOfRecord({ candidateId: "curated:asset:57391" })).toBe(57391);
  });

  it("A FILENAME IS NOT A KEY", () => {
    /**
     * The rule the whole repair rests on. `curated:asset:<id>` is produced by the key resolver and
     * names a row; `scene_0_b1_curated_a57391.mp4` is a name a render chose. Reading the second
     * would be RONDE 87's mistake with extra steps.
     */
    expect(curatedAssetIdOfRecord({ contentKey: "scene_0_b1_curated_a57391.mp4" })).toBeNull();
    expect(curatedAssetIdOfRecord({ candidateId: "archive:57391" })).toBeNull();
    expect(curatedAssetIdOfRecord({ contentKey: "file:abc123" })).toBeNull();
    expect(curatedAssetIdOfRecord({ contentKey: "pexels:8327414" })).toBeNull();
    expect(curatedAssetIdOfRecord({})).toBeNull();
  });

  it("a record that already names a provider is left alone", () => {
    const ids = curatedAssetIdsNeedingProvenance([
      { contentKey: "curated:asset:1", provider: "ww2" },
      { contentKey: "curated:asset:2", provider: null },
    ]);
    expect(ids).toEqual([2]);
  });

  it("one asset offered to several beats is looked up once", () => {
    const ids = curatedAssetIdsNeedingProvenance([
      { contentKey: "curated:asset:57364" },
      { contentKey: "curated:asset:57364" },
      { contentKey: "curated:asset:57364" },
      { contentKey: "curated:asset:57391" },
    ]);
    expect(ids).toEqual([57364, 57391]);
  });
});

describe("the repair", () => {
  it("attributes every unattributed curated record from its archive row", () => {
    const ledger = ledgerWithUnattributedCurated([57391, 57547, 57575]);
    const repair = repairCuratedProvenance(ledger, [
      row(57391, "WW2"),
      row(57547, "WW2"),
      row(57575, "WW2"),
    ]);
    expect(repair).toMatchObject({ candidates: 3, attributed: 3, unresolved: 0 });
    for (const record of ledger.allRecords()) {
      expect(record.provider).toBe("ww2");
      expect(record.providerStatus).toBe("VERIFIED");
      expect(record.archiveAssetId).toBeGreaterThan(0);
    }
  });

  it("AN ASSET THE ARCHIVE CANNOT SUPPLY STAYS UNVERIFIED", () => {
    /**
     * The line between a lookup and an invention. No row, no provider — and the gate then sees
     * exactly what it saw before, which is the correct outcome for footage whose origin this
     * system really cannot prove.
     */
    const ledger = ledgerWithUnattributedCurated([57391, 99999]);
    const repair = repairCuratedProvenance(ledger, [row(57391, "WW2")]);
    expect(repair).toMatchObject({ candidates: 2, attributed: 1, unresolved: 1 });
    const orphan = ledger.allRecords().find((r) => r.contentKey === "curated:asset:99999")!;
    expect(orphan.provider).toBeNull();
    expect(orphan.providerStatus).toBe("UNVERIFIED");
  });

  it("an archive with no name is the operator's OWN archive, and says so", () => {
    const ledger = ledgerWithUnattributedCurated([57391]);
    repairCuratedProvenance(ledger, [row(57391, null)]);
    expect(ledger.allRecords()[0]!.provider).toBe("own_archive");
  });

  it("A PROVIDER ALREADY ON THE RECORD IS NEVER OVERWRITTEN", () => {
    /**
     * `attributeProvider` fills gaps and never replaces — two providers claiming one asset is a
     * finding, not something to resolve by taking the newer. Pinned here because this repair runs
     * over EVERY record in the ledger.
     */
    const ledger = new VisualSourceLedger({ renderId: "r577", emit: () => {} });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "curated:asset:57391",
      contentKey: "curated:asset:57391",
      localPath: "/w/a.mp4",
      provider: "ww2",
      route: "primary",
    });
    const repair = repairCuratedProvenance(ledger, [row(57391, "SOMETHING_ELSE")]);
    expect(repair.candidates, "an attributed record is not even a candidate").toBe(0);
    expect(ledger.allRecords()[0]!.provider).toBe("ww2");
  });

  it("a non-curated unverified record is not touched", () => {
    // The repair knows one kind of evidence. Everything else keeps its honest gap.
    const ledger = new VisualSourceLedger({ renderId: "r577", emit: () => {} });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "scene_0_b0_pex_vid1.mp4",
      contentKey: "",
      localPath: "/w/scene_0_b0_pex_vid1.mp4",
      route: "primary",
    });
    const repair = repairCuratedProvenance(ledger, [row(57391, "WW2")]);
    expect(repair.candidates).toBe(0);
    expect(ledger.allRecords()[0]!.provider).toBeNull();
  });

  it("no rows at all repairs nothing and throws nothing", () => {
    const ledger = ledgerWithUnattributedCurated([57391]);
    const repair = repairCuratedProvenance(ledger, []);
    expect(repair).toMatchObject({ candidates: 1, attributed: 0, unresolved: 1 });
  });
});

describe("what the render says about it", () => {
  it("the routes that needed repairing are NAMED, not absorbed", () => {
    /**
     * A repair that ran silently every render would turn a route defect into routine maintenance.
     * The line names the routes so the real gap stays findable in the log.
     */
    const line = formatCuratedProvenanceRepair({
      candidates: 9,
      attributed: 9,
      unresolved: 0,
      byRoute: { backfill: 6, rescue: 3 },
    });
    expect(line).toContain("attributed 9/9");
    expect(line).toContain("backfill:6");
    expect(line).toContain("rescue:3");
    expect(line).toContain("without opening its lineage first");
  });

  it("nothing to repair is also reported", () => {
    const line = formatCuratedProvenanceRepair({ candidates: 0, attributed: 0, unresolved: 0, byRoute: {} });
    expect(line).toContain("no unattributed curated records");
  });
});

describe("where it runs", () => {
  const pipeline = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("BEFORE the report that counts providers", () => {
    /**
     * The ordering IS the fix. A repair after `buildVideoQualityReport` would mend the ledger and
     * leave `bySource[UNVERIFIED]` — the number the export gate reads — exactly as it was.
     */
    const src = pipeline();
    const repairAt = src.indexOf("const repair = repairCuratedProvenance(ledger, rows);");
    const reportAt = src.indexOf("const qualityReport = buildVideoQualityReport(");
    expect(repairAt).toBeGreaterThan(0);
    expect(reportAt).toBeGreaterThan(repairAt);
  });

  it("the ids come from the ledger and the rows come from the database", () => {
    const src = pipeline();
    const at = src.indexOf("const needing = curatedAssetIdsNeedingProvenance(ledger.allRecords());");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 400);
    expect(block).toContain("await getCuratedArchiveProvenance(needing)");
  });

  it("a failed lookup does not fail the render, and does not attribute anything", () => {
    const src = pipeline();
    const at = src.indexOf("[CuratedProvenance] archive lookup failed");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at - 400, at + 300);
    expect(block).not.toContain("own_archive");
  });

  it("the lookup joins the archive table for the NAME", () => {
    const db = readFileSync(join(__dirname, "db.ts"), "utf8");
    const at = db.indexOf("export async function getCuratedArchiveProvenance");
    expect(at).toBeGreaterThan(0);
    const body = db.slice(at, db.indexOf("\nexport async function", at + 10));
    expect(body).toContain("innerJoin(mediaArchives");
    expect(body).toContain("archiveName: mediaArchives.name");
  });
});
