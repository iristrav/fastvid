/**
 * RONDE 98 FASE 3 — THE CURATED FETCH THAT ADOPTED AS REAL_FUNNEL WITH NO RECORD.
 *
 * ── Root cause, traced statically and then reproduced ───────────────────────────────────────
 *
 * `adoptArchiveBeatClip` adopts curated clips on three paths. Its ranked queue opens the asset's
 * lineage the moment a candidate is queued:
 *
 *     const candidateLineage = ensureCuratedAssetLineage(dedup, picked, scene.index, beat.index);
 *     funnel.markLineageEligible(candidateLineage.lineageId, "curated_ranked_queue");
 *
 * The other paths fetch through `fetchCuratedArchiveBeatClip`, which returns a prepared file path
 * and cannot reach the ledger — that lives on the render's dedup state, in another module — and
 * then push under `{ source: "archive" }`, which is REAL_FUNNEL. No record was ever opened for
 * those clips, so `markEligible` had nothing to resolve and `isEligible` answered false:
 *
 *     7x  route=archive  eligible=false  vision=APPROVED  blocked=FUNNEL_WITHOUT_EVIDENCE
 *
 * Seven pictures the editor had APPROVED, refused. The beats fell through to `subject_fallback`,
 * and both of render 570's blocking gates follow from that:
 *
 *     BLOCKS no_verified_own_visual   0 of 16 (never_asked=16, own_footage=2)
 *     BLOCKS mostly_unverified_clips  9 of 12 fetched clip(s)
 *
 * ── A correction worth keeping ──────────────────────────────────────────────────────────────
 *
 * The first census named `initialClip` as the culprit — the one adoption attempt that runs before
 * any record exists. Tracing every caller disproved it: all six callers of `adoptArchiveBeatClip`
 * and all seven of its budget wrapper pass `null`, so that path never fires in production. The
 * real gap was two fetch sites further down. Recorded here because a diagnosis that can be
 * corrected by evidence is the only kind worth writing down.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { VisualSourceLedger } from "./visualSourceLineage";
import { ensureCuratedAssetLineageOn } from "./videoPipeline";
import { curatedAssetContentKey } from "./curatedMediaSourcing";
import { adoptionGuardVerdict } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

const ASSET_ID = 57488;
const CLIP = `/w/scene_1_b6_curated_a${ASSET_ID}.mp4`;
const KEY = curatedAssetContentKey(ASSET_ID);

const pick = (): never =>
  ({
    asset: { id: ASSET_ID, mediaType: "video", storageUrl: "https://a/b.mp4", title: "T" },
    score: 9,
    archiveName: "ww2",
  }) as never;

const ENV = "ENFORCE_FUNNEL_ADOPTION";
const guard = (eligible: boolean, vision: "APPROVED" | "REJECTED" | "UNCLEAR" | "NOT_ASKED") => {
  const saved = process.env[ENV];
  try {
    delete process.env[ENV];
    return adoptionGuardVerdict({ source: "archive", eligible, vision });
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
};

/* ═══════════ TEST 1 — a REAL_FUNNEL clip with no lineage is refused, approved or not ═══════════ */

describe("TEST 1 — no lineage, APPROVED: adoption must fail", () => {
  it("the ledger cannot resolve a clip nobody opened a record for", () => {
    const ledger = new VisualSourceLedger("t1");
    expect(ledger.resolve(CLIP, KEY)).toBeNull();
    expect(ledger.isEligible(CLIP, KEY)).toBe(false);
  });

  it("and the guard refuses it even with the editor's approval", () => {
    const ledger = new VisualSourceLedger("t1");
    const v = guard(ledger.isEligible(CLIP, KEY), "APPROVED");
    expect(v.allowed, "this is render 570's seven archive clips").toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
  });
});

/* ═══════════ TEST 2 — with the record opened, the same clip is adopted ═══════════ */

describe("TEST 2 — lineage opened, eligible, APPROVED: adoption must pass", () => {
  const prepared = () => {
    const ledger = new VisualSourceLedger("t2");
    const record = ensureCuratedAssetLineageOn(ledger, pick(), 1, 6);
    return { ledger, record };
  };

  it("the record resolves from the prepared clip's own content key", () => {
    const { ledger, record } = prepared();
    expect(record.contentKey).toBe(KEY);
    expect(ledger.resolve(CLIP, KEY)?.lineageId).toBe(record.lineageId);
  });

  it("the central eligibility writer can now record against it", () => {
    const { ledger } = prepared();
    expect(ledger.markEligible(CLIP, KEY, "vision_gate:archive")).toBe(true);
    expect(ledger.isEligible(CLIP, KEY)).toBe(true);
  });

  it("and the guard adopts it", () => {
    const { ledger } = prepared();
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    expect(guard(ledger.isEligible(CLIP, KEY), "APPROVED").allowed).toBe(true);
  });

  /** The provider is the archive row's own name, so the clip is no longer UNVERIFIED either. */
  it("the clip stops counting toward MOSTLY_UNVERIFIED_CLIPS", () => {
    const { ledger } = prepared();
    expect(ledger.providerFor(CLIP, KEY)).toBe("ww2");
    expect(ledger.providerBucketFor(CLIP, KEY)).not.toBe("UNVERIFIED");
  });
});

/* ═══════════ TESTS 3-5 — the vision bar has not moved ═══════════ */

describe("the vision requirement is unchanged", () => {
  const eligible = () => {
    const ledger = new VisualSourceLedger("t3");
    ensureCuratedAssetLineageOn(ledger, pick(), 1, 6);
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    return ledger.isEligible(CLIP, KEY);
  };

  it("TEST 3 — eligible + NOT_ASKED: adoption must fail", () => {
    expect(guard(eligible(), "NOT_ASKED").allowed).toBe(false);
  });

  it("TEST 4 — eligible + UNCLEAR: adoption must fail", () => {
    expect(guard(eligible(), "UNCLEAR").allowed).toBe(false);
  });

  it("TEST 5 — eligible + REJECTED: adoption must fail", () => {
    expect(guard(eligible(), "REJECTED").allowed).toBe(false);
  });
});

/* ═══════════ TEST 6 — every equivalent fetch goes through the same layer ═══════════ */

describe("TEST 6 — the fetch itself is wrapped, not one call site", () => {
  /**
   * Putting the record in front of one `tryClip` would fix one site and leave the next fetch free
   * to repeat it. The fetch is where the asset's identity is decided, so the wrapper is there.
   */
  /**
   * A CORRECTION, KEPT. This first asserted that the wrapper's own callbacks were the only raw
   * calls left. Running it measured twelve — the fix had covered three of fifteen sites. The
   * census below is what the file looks like once that was traced properly, and the two survivors
   * are survivors on a stated ground, not by omission.
   */
  it("every raw call sits inside the contract layer, except two named ones", () => {
    const raw = PIPE.split("fetchCuratedArchiveBeatClip(").length - 1;
    const wrapped = PIPE.split("fetchCuratedArchiveBeatClipWithLineage(").length - 1;
    /** `wrapped` counts the definition plus its call sites; each call site holds one raw call. */
    const callSites = wrapped - 1;
    expect(raw - callSites, "an unaccounted fetch bypassing the contract layer").toBe(2);
  });

  /**
   * The two exceptions, each with the reason written at the call site:
   *   padShortClipWithNextInner — the fill is concatenated into another clip and never adopted;
   *                               the output's provenance comes from `linkDerivedPath`.
   *   generateGuaranteedBeatClipInner — no dedup state in scope, and its tier adopts as
   *                               `rescue_archive` (RESCUE_REAL), which requires no eligibility.
   */
  it.each([
    ["a fill that is concatenated, not adopted", "NOT wrapped in `fetchCuratedArchiveBeatClipWithLineage`, deliberately."],
    ["a rescue tier that needs no eligibility", "The tier loop's curated fetch is NOT wrapped"],
  ])("%s says so at the call site", (_what, marker) => {
    expect(PIPE).toContain(marker);
  });

  it("every REAL_FUNNEL-reaching fetch site goes through it", () => {
    expect(PIPE.split("fetchCuratedArchiveBeatClipWithLineage(").length - 1).toBe(14);
  });

  it("the wrapper opens the record with the same writer the ranked queue uses", () => {
    const at = PIPE.indexOf("async function fetchCuratedArchiveBeatClipWithLineage(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("ensureCuratedAssetLineage(dedup, pickedOut.pick");
  });

  /**
   * It records IDENTITY and nothing else. Eligibility keeps exactly one writer, at the vision
   * gate, for every route alike — a second one here would be the second registry this codebase
   * has spent three rounds not building.
   */
  it("and marks no eligibility of its own", () => {
    const at = PIPE.indexOf("async function fetchCuratedArchiveBeatClipWithLineage(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).not.toContain("markEligible");
    expect(body).not.toContain("markLineageEligible");
  });

  /** A clip that arrives with no pick behind it is named, not quietly given a provenance. */
  it("a clip with no pick is reported rather than invented", () => {
    const at = PIPE.indexOf("async function fetchCuratedArchiveBeatClipWithLineage(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("[EligibilityGap]");
    expect(body).toContain("route=curated_fetch");
  });

  /** The fetcher hands the pick back through the out-object it already had for this purpose. */
  it("the fetcher returns the winning pick", () => {
    expect(CURATED).toContain("pick?: CuratedCandidatePick;");
    expect(CURATED).toContain("options.pickedOut.pick = picked;");
  });
});
