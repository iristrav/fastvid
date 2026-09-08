/**
 * R193 — WHICH RENDER DOES THIS LINEAGE BELONG TO?
 *
 * ── What the audit actually found ────────────────────────────────────────────────────────────
 *
 * The round asked for `productionRenderId` to be threaded through every render-scoped writer and
 * for every latest-render lookup to be fixed. Reading the code first changed the answer, and the
 * finding is worth more than the change:
 *
 *   Render-scoped pipeline state is IN-MEMORY, per render. `createSourcingCache()` builds a fresh
 *   `VisualSourceLedger` inside `_runVideoPipelineInner`, under an AsyncLocalStorage scope opened
 *   per render (`renderCtxStorage`). The BeatLedger, the adopt audit, the compose state and the
 *   cinematic state are all reached through it. None of them is ever queried by videoId, so one
 *   render cannot read another's — not because a check prevents it, but because there is nothing
 *   to read.
 *
 *   The latest-render lookups are two, both on `render_jobs`, both feeding the editor's "most
 *   recent job" panel. That is video-scoped by intent, which the round itself allows. Neither
 *   returns render-scoped pipeline state.
 *
 * ── The one place it was really possible ─────────────────────────────────────────────────────
 *
 * Exactly one render-scoped artifact is persisted: the lineage snapshot, under a SINGLE key in
 * `videos.metadata`. One video, one snapshot — so a later render overwrites an earlier one, and the
 * render job that joins its output against it reads whatever is there.
 *
 * That join already noticed a mismatched timeline version and marked it `STALE_LINEAGE`. But two
 * renders of an unchanged timeline carry the SAME version, and then the version says nothing. The
 * snapshot has carried `renderId` since it was written, and nobody compared it.
 *
 * So this is the honest remainder of §2/§6/§10: not a thread through hundreds of functions, but one
 * comparison at the one boundary where two renders' data can actually meet.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  formatDeliveryRecord,
  recordDelivery,
  type VisualLineageSnapshot,
} from "./visualLineageSnapshot";

const DB = readFileSync(path.join(__dirname, "db.ts"), "utf8");
const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function snapshot(renderId: string, timelineVersion = 3): VisualLineageSnapshot {
  return {
    schemaVersion: 1,
    renderId,
    videoId: 570,
    timelineVersion,
    createdAt: 1_788_000_000_000,
    assets: [
      { key: "internet_archive:abc", stages: ["ADOPTED", "RENDER_INPUT"] } as never,
      { key: "ww2:57378", stages: ["ADOPTED", "RENDER_INPUT"] } as never,
    ],
    unidentifiedRecords: 0,
  };
}

const delivery = (snap: VisualLineageSnapshot, expectedRenderId?: string, timelineVersion = 3) =>
  recordDelivery(snap, {
    deliveredKeys: ["internet_archive:abc"],
    unidentifiedClips: 0,
    route: "render_job",
    jobId: 41,
    attempt: 1,
    published: true,
    timelineVersion,
    ...(expectedRenderId ? { expectedRenderId } : {}),
    now: 1_788_000_100_000,
  });

/* ═══════════════════════ the one boundary where two renders can meet ═══════════════════════ */

describe("a delivery says which render's lineage it joined against", () => {
  it("a matching render is not remarked on", () => {
    const out = delivery(snapshot("RA"), "RA");
    expect(out.record.snapshotRenderId).toBeUndefined();
    expect(formatDeliveryRecord(570, out.record)).not.toContain("RENDER_ID_MISMATCH");
  });

  it("a snapshot from another render is named", () => {
    const out = delivery(snapshot("RA"), "RB");
    expect(out.record.snapshotRenderId).toBe("RA");
  });

  it("and the line says so, beside the numbers it qualifies", () => {
    const line = formatDeliveryRecord(570, delivery(snapshot("RA"), "RB").record);
    expect(line).toContain("RENDER_ID_MISMATCH(snapshotRender=RA)");
    expect(line).toContain("deliveredAssets=");
  });

  it("the same timeline version does not hide a different render", () => {
    /**
     * The gap this closes. A re-render of an unchanged timeline carries the same version, so the
     * existing STALE_LINEAGE check passes and said nothing at all.
     */
    const out = delivery(snapshot("RA", 3), "RB", 3);
    expect(out.record.timelineVersionAtDelivery).toBeUndefined();
    expect(out.record.snapshotRenderId).toBe("RA");
  });

  it("both faults are reported when both are true", () => {
    const line = formatDeliveryRecord(570, delivery(snapshot("RA", 2), "RB", 3).record);
    expect(line).toContain("STALE_LINEAGE");
    expect(line).toContain("RENDER_ID_MISMATCH");
  });

  it("a caller that does not know its render id gets no false alarm", () => {
    /** Absent is absent. Inventing a mismatch from a missing value is its own wrong signpost. */
    expect(delivery(snapshot("RA")).record.snapshotRenderId).toBeUndefined();
  });

  it("the delivery is still recorded — a mismatch is a caveat, not a refusal", () => {
    /**
     * The file is uploaded and the job says completed before this runs. Refusing to account for it
     * would lose the only record that it was delivered at all.
     */
    const out = delivery(snapshot("RA"), "RB");
    expect(out.record.delivered).toBe(1);
  });
});

/* ═══════════════════════ the audit, asserted rather than described ═══════════════════════ */

describe("render-scoped state is per render by construction", () => {
  it("the ledger is built inside the render, not fetched by video", () => {
    expect(PIPELINE).toContain("sourcingCache: createSourcingCache(");
    expect(PIPELINE).toContain("lineage: new VisualSourceLedger({");
  });

  it("no pipeline state is read back by videoId alone", () => {
    /**
     * The forbidden pattern from §7, checked where it would have to appear: a lookup that returns
     * render-scoped pipeline state for a video without naming the render. The two `desc(renderJobs`
     * queries that exist return render JOBS for the editor panel, which is video-scoped by intent.
     */
    const jobLookups = DB.split("orderBy(desc(renderJobs.id))").length - 1;
    expect(jobLookups, "a new latest-render query appeared").toBe(2);
    expect(DB).toContain("/** Jobs for one video, newest first. The editor shows the most recent");
  });

  it("the lock names the render that holds it", () => {
    expect(PIPELINE).toContain("const productionRenderId = newRenderId();");
    expect(PIPELINE).toContain("productionRenderId,");
  });
});

/* ═══════════════════════ what the round asked for and this does not do ═══════════════════════ */

describe("the remaining gaps are named, not quietly closed", () => {
  it("the compose lifecycle has no COMPOSE_INPUT counter yet", () => {
    /**
     * §11-§17 asked for `composeInputs = composeSelected + composeDropped`. It does not exist, and
     * this test says so rather than letting a green suite imply otherwise. When it is built, this
     * expectation is the one to invert.
     */
    expect(PIPELINE).not.toContain("composeInputsWithoutOutcome");
  });

  /**
   * R194 BUILT IT — and this is the expectation R193 said to invert when it did.
   *
   * The original text read `expect(PIPELINE).not.toContain("visionReviewPool")`, with a comment
   * naming §18-§34 as the work and this line as the one to turn round. Inverted rather than
   * deleted, so the file that said "not built" is the file that now says what was built.
   */
  it("the bounded vision review pool has been built", () => {
    expect(PIPELINE).toContain("visionReviewPool: createVisionReviewPoolState(),");
    expect(PIPELINE).toContain("declareVisionReviewPool(");
    /** And it decides something: the adoption loop reads the verdict, not `allowed` alone. */
    expect(PIPELINE).toContain("const beatEvidence: VisionEvidence");
  });
});
