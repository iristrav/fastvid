/**
 * THE EXPORT MY OWN FIX BLOCKED.
 *
 *     Export blocked — this render cannot say what it is showing:
 *     MOSTLY_UNVERIFIED_CLIPS: 10 of 18 fetched clip(s) have no proven source (56%, limit 50%)
 *     — the lineage cannot say where most of this film came from
 *
 * ── The chain ───────────────────────────────────────────────────────────────────────────────
 *
 * `recordClipAdopt`'s hole-filling branch opens a record with NO provider, deliberately: RONDE 87
 * established that an adopt-route label ("archive", "rescue_wikimedia") is not a provider, and
 * writing one there turns every instrumentation hole into a confident wrong answer.
 *
 * That branch used to pass `contentKey: ""`, and `createLineage` only registers a record in
 * `byContentKey` when the key is non-empty. So the anonymous record was unreachable by key, and the
 * two functions that open an ATTRIBUTED record for the same asset both missed it and created
 * theirs:
 *
 *     ensureCuratedAssetLineageOn   const existing = resolve(...); if (existing) return existing;
 *     tagPathWithProviderAsset      if (!resolve(...)) createLineage(...)
 *
 * Giving that branch its real content key — correct in itself, and what let the cinematic planner
 * find a handle for curated clips — made the anonymous record reachable. Both functions now find it
 * first, return early, and the asset never acquires the provider it can prove. Render 573's sibling
 * sat at 9 of 19 UNVERIFIED (47%); two curated clips flipping is 10 of 18 (56%), and the gate that
 * hangs off no flag refused the export.
 *
 * ── What is NOT done about it ───────────────────────────────────────────────────────────────
 *
 * The gate is right and is untouched. Those clips really did have no provider recorded, and
 * `UNVERIFIED_CLIP_SHARE_LIMIT` is not moved. The repair is that a record with nothing to prove
 * stops blocking one that has a proof.
 */
import { describe, expect, it } from "vitest";
import * as path from "path";

import { VisualSourceLedger, ensureCuratedAssetLineageOn } from "./visualSourceLineage";
import {
  createSourcingCache,
  tagPathWithProviderAsset,
  withRenderSourcingCacheScope,
} from "./videoPipeline";
import { recordClipAdopt, bindLineageLedger, bindContentKeyResolver } from "./clipAdoptAudit";

const curatedPick = (id: number, archiveName?: string) => ({
  asset: { id, mediaType: "video" as const, title: `asset ${id}`, storageUrl: `/s/${id}.mp4` },
  score: 10,
  ...(archiveName ? { archiveName } : {}),
});

describe("a curated asset gets its provider even when an adoption opened the record first", () => {
  const setup = () => {
    const audit: Parameters<typeof recordClipAdopt>[0] = [];
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 573 });
    bindLineageLedger(audit, ledger);
    bindContentKeyResolver(audit, (p) => {
      const m = /_curated_a(\d+)/.exec(path.basename(p));
      return m ? `curated:asset:${m[1]}` : "";
    });
    return { audit, ledger };
  };

  it("the anonymous record is upgraded instead of returned bare", () => {
    const { audit, ledger } = setup();
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "guaranteed");
    expect(ledger.providerFor("/tmp/scene_1_b6_curated_a57392.mp4", "curated:asset:57392")).toBeNull();

    ensureCuratedAssetLineageOn(ledger, curatedPick(57392, "WW2 Archive"), 1, 6);

    expect(ledger.providerFor("/tmp/scene_1_b6_curated_a57392.mp4", "curated:asset:57392")).toBe(
      "ww2 archive"
    );
  });

  it("it stays ONE record — the upgrade must not become a second copy of the asset", () => {
    const { audit, ledger } = setup();
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "guaranteed");
    const before = ledger.allRecords().length;
    ensureCuratedAssetLineageOn(ledger, curatedPick(57392, "WW2 Archive"), 1, 6);
    expect(ledger.allRecords()).toHaveLength(before);
  });

  it("providerStatus moves with the provider — the ledger never holds one without the other", () => {
    const { audit, ledger } = setup();
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "guaranteed");
    const record = ledger.resolve("/tmp/scene_1_b6_curated_a57392.mp4", "curated:asset:57392")!;
    expect(record.providerStatus).toBe("UNVERIFIED");
    ensureCuratedAssetLineageOn(ledger, curatedPick(57392, "WW2 Archive"), 1, 6);
    expect(record.providerStatus).toBe("VERIFIED");
  });

  it("the archive id and the storage url are filled in with it", () => {
    const { audit, ledger } = setup();
    recordClipAdopt(audit, 2, 0, "beat", "/tmp/scene_2_b0_curated_a900.mp4", "guaranteed");
    ensureCuratedAssetLineageOn(ledger, curatedPick(900, "WW2 Archive"), 2, 0);
    const record = ledger.resolve("/tmp/scene_2_b0_curated_a900.mp4", "curated:asset:900")!;
    expect(record.archiveAssetId).toBe(900);
    expect(record.sourceUrl).toBe("/s/900.mp4");
  });

  it("a row with no archive name still proves something — the customer's own archive", () => {
    const { audit, ledger } = setup();
    recordClipAdopt(audit, 0, 0, "beat", "/tmp/scene_0_b0_curated_a12.mp4", "guaranteed");
    ensureCuratedAssetLineageOn(ledger, curatedPick(12), 0, 0);
    expect(ledger.providerFor("/tmp/scene_0_b0_curated_a12.mp4", "curated:asset:12")).toBe(
      "own_archive"
    );
  });
});

describe("a provider already proven is never replaced", () => {
  it("a second, different provider for one content key leaves the first standing", () => {
    /**
     * Two providers claiming one asset is a finding, and resolving it silently by taking the newer
     * is how a provenance ledger starts lying. The upgrade fills a gap; it does not arbitrate.
     */
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 1 });
    ensureCuratedAssetLineageOn(ledger, curatedPick(555, "WW2 Archive"), 0, 0);
    ensureCuratedAssetLineageOn(ledger, curatedPick(555, "Some Other Archive"), 1, 1);
    expect(ledger.providerFor("archive-asset:555", "curated:asset:555")).toBe("ww2 archive");
  });

  it("attributeProvider with no provider changes nothing", () => {
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 1 });
    const record = ledger.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "x", contentKey: "curated:asset:7",
      localPath: "/tmp/x.mp4", mediaType: "video", route: "primary",
    });
    ledger.attributeProvider(record, { provider: "   " });
    expect(record.provider).toBeNull();
    expect(record.providerStatus).toBe("UNVERIFIED");
  });
});

describe("a downloaded asset gets its provider the same way", () => {
  it("tagPathWithProviderAsset attributes a record an adoption opened first", async () => {
    const cache = createSourcingCache(573);
    await withRenderSourcingCacheScope(cache, async () => {
      cache.lineage.createLineage({
        sceneIndex: -1, beatIndex: -1,
        candidateId: "pexels:6611040", contentKey: "pexels:6611040",
        localPath: "/tmp/earlier.mp4", mediaType: "video", route: "primary",
      });
      expect(cache.lineage.providerFor("/tmp/earlier.mp4", "pexels:6611040")).toBeNull();

      const tagged = tagPathWithProviderAsset("/tmp/scene_0_b0_pex.mp4", "pexels", "6611040");
      expect(cache.lineage.providerFor(tagged, "pexels:6611040")).toBe("pexels");
    });
  });

  it("and still opens a fresh record when nothing exists for that key", async () => {
    const cache = createSourcingCache(573);
    await withRenderSourcingCacheScope(cache, async () => {
      const tagged = tagPathWithProviderAsset("/tmp/scene_0_b1_pex.mp4", "pexels", "999");
      const record = cache.lineage.resolve(tagged, "pexels:999");
      expect(record).not.toBeNull();
      expect(record!.provider).toBe("pexels");
      expect(record!.providerAssetId).toBe("999");
    });
  });
});

describe("the export gate itself is untouched", () => {
  const SRC = require("fs").readFileSync(
    path.join(__dirname, "videoQualityReport.ts"),
    "utf8"
  ) as string;

  it("the limit is still one half", () => {
    expect(SRC).toContain("const UNVERIFIED_CLIP_SHARE_LIMIT = 0.5;");
  });

  it("both indefensible conditions still exist and hang off no flag", () => {
    expect(SRC).toContain('code: "NO_VERIFIED_OWN_VISUAL"');
    expect(SRC).toContain('code: "MOSTLY_UNVERIFIED_CLIPS"');
    const at = SRC.indexOf("export function indefensibleExportConditions");
    const body = SRC.slice(at, at + 2_600);
    expect(body).not.toContain("Enabled()");
    expect(body).not.toContain("process.env");
  });
});
