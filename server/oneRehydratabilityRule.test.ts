/**
 * ONE RULE FOR "CAN THIS CLIP BE FETCHED BACK".
 *
 * ── The two answers render 567 gave about the same clips ────────────────────────────────────
 *
 * The cinematic planner threw away twelve of thirteen beats:
 *
 *     [CinematicPipeline] inputs scenes=2 beats=13 planned=2 dropped=12
 *     [CinematicPipeline] dropped s1b1: adopted clip has no rehydratable identity (provider=unknown)
 *
 * and the render's own identity report, built minutes later from the same ledger records, said the
 * opposite about the very same clips:
 *
 *     [AssetIdentity] s0c2 provider=UNVERIFIED assetId=null archiveAssetId=57378 … rehydratable=true
 *     [AssetIdentity] s1c0 provider=UNVERIFIED assetId=null archiveAssetId=57368 … rehydratable=true
 *     [AssetIdentity] s1c1 provider=UNVERIFIED assetId=null archiveAssetId=57449 … rehydratable=true
 *     [AssetIdentity] s1c5 provider=UNVERIFIED assetId=null archiveAssetId=57420 … rehydratable=true
 *     [AssetIdentity] s1c6 provider=UNVERIFIED assetId=null archiveAssetId=57479 … rehydratable=true
 *
 * Five of the ten delivered clips, each holding a real archive asset id and no provider NAME.
 * `identityIsRehydratable` opens with `if (identity.archiveAssetId != null) return true` — this
 * system stores the file and serves it itself — and the render job agrees in practice: its
 * rehydrator fetches by that id alone, which is why a failure there reads
 * `REHYDRATION_DOWNLOAD_FAILED — archiveAssetId=57353 could not be read from storage`. A storage
 * failure on a handle it accepted, not a refusal to use one.
 *
 * `identityFrom` was a second implementation of the same question, with an extra requirement
 * nobody else made: a provider name on top of the handle. So a clip FastVid holds in its own
 * archive was called unplannable for want of a label, and the film that reached the plan was two
 * clips long.
 *
 * ── What this file pins ─────────────────────────────────────────────────────────────────────
 *
 * That there is one rule and the planner uses it. The numbers below are the render's own.
 */
import { describe, expect, it } from "vitest";

import { identityFrom, type AdoptionFacts } from "./cinematicPipelineInputs";
import { identityFromAdoption, identityIsRehydratable } from "./assetIdentity";

/** The five clips above, as the ledger held them: an archive id and no provider name. */
const archiveBacked = (archiveAssetId: number): AdoptionFacts => ({
  provider: null,
  archiveAssetId,
});

describe("a clip FastVid stores itself can be planned", () => {
  it.each([57378, 57368, 57449, 57420, 57479])(
    "archive asset %i is plannable without a provider name",
    (id) => {
      const identity = identityFrom(archiveBacked(id));
      expect(identity, `archive asset ${id} was dropped`).not.toBeNull();
      expect(identity!.archiveAssetId).toBe(id);
    }
  );

  /**
   * The exact disagreement, asserted as an equivalence rather than as two separate expectations —
   * so a future change to either side has to keep them in step.
   */
  it("answers the same question the same way as the identity report", () => {
    const cases: AdoptionFacts[] = [
      { provider: null, archiveAssetId: 57449 },
      { provider: "ww2", archiveAssetId: 57353, providerAssetId: "57353" },
      { provider: "internet_archive", providerAssetId: "white-lives-matter-washington-1" },
      { provider: null },
      { provider: null, sourceUrl: "https://cdn.example.com/expiring.mp4" },
      { provider: "pexels", providerAssetId: "12345" },
    ];
    for (const facts of cases) {
      const viaReport = identityFromAdoption(facts);
      const plannable = identityFrom(facts) !== null;
      expect(plannable, JSON.stringify(facts)).toBe(
        Boolean(viaReport && identityIsRehydratable(viaReport))
      );
    }
  });
});

describe("the guard the drop exists for is untouched", () => {
  /** No durable handle at all — planning a shot around this is the failure the ledger prevents. */
  it("a clip with no handle is still refused", () => {
    expect(identityFrom({ provider: null })).toBeNull();
    expect(identityFrom({ provider: "ww2" })).toBeNull();
    expect(identityFrom(null)).toBeNull();
  });

  /**
   * STRICTER than before, and deliberately. The old rule accepted any non-empty provider plus a
   * `sourceUrl`, so a clip whose only handle was an expiring CDN link was planned around. A
   * provider FastVid could not prove is not a provider it can go back to.
   */
  it("an unproven provider holding only an expiring URL is refused", () => {
    expect(
      identityFrom({ provider: null, sourceUrl: "https://cdn.example.com/expiring.mp4" }),
      "an expiring URL from an unproven provider was accepted as a durable handle"
    ).toBeNull();
  });

  /** A proven provider with a real id stays plannable, as it always was. */
  it("a proven provider with its own id is still accepted", () => {
    const identity = identityFrom({ provider: "pexels", providerAssetId: "12345" });
    expect(identity).not.toBeNull();
    expect(identity!.provider).toBe("pexels");
    expect(identity!.providerAssetId).toBe("12345");
  });

  /** And the archive id wins over a missing label, without inventing one. */
  it("does not invent a provider name it was never given", () => {
    const identity = identityFrom(archiveBacked(57449));
    expect(identity!.provider).toBe("UNVERIFIED");
    expect(identity!.providerAssetId).toBeUndefined();
  });
});

describe("there is only one implementation left", () => {
  it("identityFrom delegates instead of re-deriving the rule", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "cinematicPipelineInputs.ts"),
      "utf8"
    );
    const at = src.indexOf("export function identityFrom(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toContain("identityFromAdoption(adoption)");
    expect(body).toContain("identityIsRehydratable(identity)");
    // The hand-rolled rule must not come back.
    expect(body).not.toContain("hasHandle");
    expect(body).not.toContain("adoption.providerAssetId ?");
  });
});
