/**
 * WHY "126 DOWNLOADS, 4 ACCEPTED" WAS ANSWERED BY A TRUNCATED TALLY.
 *
 * ── The evidence ────────────────────────────────────────────────────────────────────────────
 *
 * Render 569's export-gate message named the reasons its candidates were refused:
 *
 *     400 rejected. Top reject reasons: shortlist_full=179, FUNNEL_WITHOUT_EVIDENCE=162,
 *     beat_image_gate=31, baked_text=9, subject_gate=6.
 *
 * and the beat audit, three lines earlier, said what that "400" was:
 *
 *     [VisualCoverageFinal] rejectAudit auditEntriesRecorded=515 auditEntriesDropped=115
 *                           auditCapacity=400
 *
 * 515 refusals happened. The breakdown counted 400 of them — the first 400, chronologically,
 * which is how the detail cap fills. So the render's own account of why it found nothing was a
 * sample of its early scenes, presented as the whole.
 *
 * ── Why the fix is one line of plumbing rather than a bigger cap ─────────────────────────────
 *
 * RONDE 70 already built the answer. Its note is explicit that the DETAIL is expensive and stays
 * bounded while the COUNT per beat and per reason "is a handful of integers … and is now never
 * dropped", and `summarizeClipRejectAudit` has two branches for exactly that: given the audit
 * OBJECT it reads the uncapped `perBeat` tally, given a plain ENTRY ARRAY it counts entries.
 *
 * The report was declared as `rejectAudit?: ClipRejectEntry[]` and both call sites passed
 * `.entries`, so it always took the counting branch. The per-beat counts were moved onto the
 * uncapped tally when RONDE 70 fixed this; the render-wide summary was not. One route short of
 * the rule — the same seam this file's neighbours keep finding.
 *
 * No cap is raised here and no reason is redefined. The number that was already being collected
 * is the one now reported.
 */
import { describe, expect, it } from "vitest";

import {
  createClipRejectAudit,
  recordClipReject,
  summarizeClipRejectAudit,
} from "./clipRejectAudit";
import { buildVideoQualityReport } from "./videoQualityReport";

/** Render 569's shape in miniature: a cap of 4, and 10 refusals that do not fit in it. */
function overflowingAudit() {
  const audit = createClipRejectAudit(4);
  /** The first four — the only ones the DETAIL can hold. */
  for (let i = 0; i < 4; i++) {
    recordClipReject(audit, 0, i, `/tmp/early_${i}.mp4`, "shortlist_full");
  }
  /** And six more, on later beats, whose detail is dropped. */
  for (let i = 0; i < 6; i++) {
    recordClipReject(audit, 2, i, `/tmp/late_${i}.mp4`, "beat_image_gate");
  }
  return audit;
}

describe("the render-wide reason breakdown", () => {
  it("counts every refusal, not only the ones the detail cap held", () => {
    const audit = overflowingAudit();
    expect(audit.recorded).toBe(10);
    expect(audit.dropped).toBe(6);
    expect(audit.entries).toHaveLength(4);

    const complete = summarizeClipRejectAudit(audit);
    expect(complete).toEqual({ shortlist_full: 4, beat_image_gate: 6 });
  });

  /**
   * The branch render 569 actually took, kept as a test so the difference is visible rather than
   * asserted about. Six of ten refusals — every one on a late beat — are simply absent.
   */
  it("the entries array alone loses the late beats entirely", () => {
    const truncated = summarizeClipRejectAudit(overflowingAudit().entries);
    expect(truncated).toEqual({ shortlist_full: 4 });
    expect(truncated.beat_image_gate).toBeUndefined();
  });
});

describe("the quality report reads the complete tally", () => {
  const report = (opts: Parameters<typeof buildVideoQualityReport>[2]) =>
    buildVideoQualityReport([], "Why Adolf Hitler Chose Suicide Over Capture", opts);

  it("uses the uncapped tally when it is given one", () => {
    const audit = overflowingAudit();
    const r = report({ rejectAudit: audit.entries, rejectTally: audit });
    expect(r.rejectSummary).toEqual({ shortlist_full: 4, beat_image_gate: 6 });
  });

  /**
   * A caller that has only the entries still gets an answer — this is plumbing, not a new
   * requirement, and a tool or test holding an array must keep working.
   */
  it("falls back to the entries when no tally is passed", () => {
    const audit = overflowingAudit();
    const r = report({ rejectAudit: audit.entries });
    expect(r.rejectSummary).toEqual({ shortlist_full: 4 });
  });

  /** The named examples stay bounded — that is the half of RONDE 70's split that was right. */
  it("keeps the detail bounded", () => {
    const audit = overflowingAudit();
    const r = report({ rejectAudit: audit.entries, rejectTally: audit });
    expect(r.topRejects?.length).toBeLessThanOrEqual(4);
  });

  /**
   * THE POINT OF ALL OF IT, on render 569's real proportions.
   *
   * Its two dominant reasons — the RONDE 95 shortlist bound and the RONDE 94 adoption guard —
   * are pipeline bookkeeping, not judgements about footage. Whether they are 341 of 400 or 341 of
   * 515 changes what an operator does next, and only the complete tally can say.
   */
  it("does not let a cap decide which reason looks dominant", () => {
    const audit = createClipRejectAudit(4);
    for (let i = 0; i < 4; i++) recordClipReject(audit, 0, i, `/tmp/a${i}.mp4`, "baked_text");
    for (let i = 0; i < 20; i++) recordClipReject(audit, 1, i, `/tmp/b${i}.mp4`, "shortlist_full");

    const truncated = summarizeClipRejectAudit(audit.entries);
    const complete = summarizeClipRejectAudit(audit);
    expect(truncated, "the cap made the rarer reason look like the only one").toEqual({ baked_text: 4 });
    expect(complete).toEqual({ baked_text: 4, shortlist_full: 20 });
  });
});
