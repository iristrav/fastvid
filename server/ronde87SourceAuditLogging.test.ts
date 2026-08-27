import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  LINEAGE_STAGES,
  NOT_VERIFIED,
  SUMMARY_COUNTERS,
  UNVERIFIED_PROVIDER,
  VisualSourceLedger,
  emptySummaryCounts,
  formatAuditReport,
  formatFunnelReport,
  formatLineageEvent,
  formatSourceSummary,
  rejectionStageForGate,
} from "./visualSourceLineage";
import {
  bindLineageLedger,
  createClipAdoptAudit,
  recordClipAdopt,
} from "./clipAdoptAudit";
import { createClipRejectAudit, recordClipReject } from "./clipRejectAudit";
import { buildVideoQualityReport } from "./videoQualityReport";
import { buildEditorClipFromPath } from "./editorClips";
import {
  createSourcingCache,
  normalizeFailureReason,
  recordProviderDownloadOutcome,
  tagPathWithProviderAsset,
} from "./videoPipeline";

/**
 * RONDE 87 — the render can prove where every picture came from, or it says it cannot.
 *
 * The rule this whole file exists to hold shut: FastVid may never fill in a source because it is
 * likely. A filename, a URL pattern, a route label and a position in a list are all guesses, and
 * a guess presented in the same field as a fact is worse than an admitted gap. No proof means
 * UNVERIFIED — which is a different answer from zero, and from "unknown provider".
 *
 * Render 536 is the measurement: 66 clips shipped, 27 reported as source=unknown, 20 YouTube
 * downloads none of which could be traced to the finished video, and a report that presented the
 * filename reading as the official source breakdown.
 */

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const REPORT_SRC = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
const EDITOR_SRC = fs.readFileSync(path.join(__dirname, "editorClips.ts"), "utf8");
const LINEAGE_SRC = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");

let seq = 0;
const ledger = (emit?: (line: string) => void) =>
  new VisualSourceLedger({ renderId: `test-${++seq}`, videoId: 536, emit });

/** A candidate whose provider came from the provider's own data — the only VERIFIED path. */
function provenCandidate(l: VisualSourceLedger, over: Record<string, unknown> = {}) {
  return l.createLineage({
    sceneIndex: 7,
    beatIndex: 3,
    candidateId: "youtube_cc:abc123",
    contentKey: "youtube_cc:abc123",
    provider: "youtube_cc",
    providerAssetId: "123",
    sourceUrl: "https://example.invalid/v/123",
    localPath: "/w/scene_7_b3__pid_youtube_cc-0123456789abcdef.mp4",
    mediaType: "video",
    query: "berlin april 1945",
    route: "primary",
    ...over,
  });
}

/* ═════════════ §A — provenance comes from the candidate, never the name ═════════════ */

describe("RONDE 87 §A — a source is recorded only when it is proven", () => {
  it("TEST 1 — the provider is stored from the candidate data and marked VERIFIED", () => {
    const l = ledger();
    const r = provenCandidate(l);
    expect(r.provider).toBe("youtube_cc");
    expect(r.providerStatus).toBe("VERIFIED");
    expect(r.providerAssetId).toBe("123");
    expect(r.sourceUrl).toBe("https://example.invalid/v/123");
    expect(r.lineageId).toContain(l.renderId);
  });

  it("TEST 2 — a filename cannot become a provider, however suggestive it is", () => {
    const l = ledger();
    // The name says youtube in three different ways. No provider was supplied, so there is none.
    const r = l.createLineage({
      sceneIndex: 1, beatIndex: 0,
      candidateId: "x", contentKey: "x",
      localPath: "/w/scene_1_b0_ytcc_youtube__pid_youtube_cc-aaaaaaaaaaaaaaaa.mp4",
    });
    expect(r.provider).toBeNull();
    expect(r.providerStatus).toBe("UNVERIFIED");
    expect(l.providerFor(r.localPath)).toBeNull();
    expect(l.providerBucketFor(r.localPath)).toBe(UNVERIFIED_PROVIDER);
  });

  it("TEST 3 — \"unknown\" is never laundered into a provider name", () => {
    const l = ledger();
    for (const attempt of ["unknown", "UNKNOWN", " ", "", "null", "undefined", "unverified"]) {
      const r = l.createLineage({
        sceneIndex: 0, beatIndex: 0, candidateId: attempt, contentKey: `k-${attempt}`,
        localPath: `/w/${attempt || "blank"}.mp4`, provider: attempt,
      });
      expect(r.provider, `"${attempt}" must not become a provider`).toBeNull();
      expect(r.providerStatus).toBe("UNVERIFIED");
    }
  });

  it("TEST 4 — resolve() has no basename fallback, because a basename match is a guess", () => {
    const l = ledger();
    provenCandidate(l);
    // Same basename, different directory — a different render's work dir looks exactly like this.
    expect(l.resolve("/other/scene_7_b3__pid_youtube_cc-0123456789abcdef.mp4")).toBeNull();
    expect(LINEAGE_SRC).not.toContain("byBasename");
  });
});

/* ═════════════ §B — the full lifecycle, as events ═════════════ */

describe("RONDE 87 §B — every stage of a clip's life is an event", () => {
  it("TEST 5 — all sixteen stages exist and each event carries its full context", () => {
    expect([...LINEAGE_STAGES]).toEqual([
      "FOUND", "ELIGIBLE", "RANKED", "SELECTED",
      "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED", "DOWNLOAD_FAILED",
      "ADOPTED", "TRANSFORMED", "TRIMMED", "PADDED", "OVERLAYED",
      "COMPOSED", "REPLACED", "REMOVED", "FINAL_VIDEO",
    ]);
    const l = ledger();
    const r = provenCandidate(l);
    const e = l.recordEvent(r.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" })!;
    for (const field of ["lineageId", "timestamp", "stage", "status", "sceneIndex", "beatIndex", "provider", "currentPath"]) {
      expect(e, `event is missing ${field}`).toHaveProperty(field);
    }
    expect(e.provider).toBe("youtube_cc");
    expect(e.providerStatus).toBe("VERIFIED");
  });

  it("TEST 6 — a download success and a download failure are both recorded, with a reason", () => {
    const l = ledger();
    const ok = provenCandidate(l);
    l.recordEvent(ok.lineageId, "DOWNLOAD_STARTED", { status: "OK" });
    l.recordEvent(ok.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });

    const bad = provenCandidate(l, { contentKey: "youtube_cc:bad", localPath: "/w/bad.mp4" });
    l.recordEvent(bad.lineageId, "DOWNLOAD_STARTED", { status: "OK" });
    l.recordEvent(bad.lineageId, "DOWNLOAD_FAILED", {
      status: "FAILED", reason: "source_video_too_short",
    });

    const s = l.summary();
    expect(s.total.downloadStarted).toBe(2);
    expect(s.total.downloadSucceeded).toBe(1);
    expect(s.total.downloadFailed).toBe(1);
    expect(s.failureReasons.source_video_too_short).toBe(1);
  });

  it("TEST 7 — the event line names the render, the lineage, the asset and the stage", () => {
    const l = ledger();
    const r = provenCandidate(l);
    const line = formatLineageEvent(
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" })!,
      l.renderId
    );
    expect(line.startsWith("[VisualLineageEvent]")).toBe(true);
    for (const part of [`render=${l.renderId}`, `lineageId=${r.lineageId}`, "scene=7", "beat=3",
      "provider=youtube_cc", "providerAssetId=123", "stage=ADOPTED", "timestamp="]) {
      expect(line).toContain(part);
    }
  });

  it("TEST 8 — an emitted event stream is available live, not only at the end", () => {
    const lines: string[] = [];
    const l = ledger((line) => lines.push(line));
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    // FOUND on creation, then the adoption.
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("stage=FOUND");
    expect(lines[1]).toContain("stage=ADOPTED");
    // The pipeline turns this on behind a flag; the RECORDING is never optional.
    expect(PIPELINE_SRC).toContain('process.env.VISUAL_LINEAGE_EVENT_LOG === "true"');
  });
});

/* ═════════════ §C — derived files stay attached to their origin ═════════════ */

describe("RONDE 87 §C — a rename never creates a new source", () => {
  it("TEST 9 — trim, pad and overlay each carry parentLineageId back to the original", () => {
    const l = ledger();
    const origin = provenCandidate(l);
    const trimmed = l.linkDerivedPath("/w/a_still.mp4", origin.localPath, "TRIMMED")!;
    const padded = l.linkDerivedPath("/w/pad_combined_s7b3_1740000000000.mp4", trimmed.localPath, "PADDED")!;
    const overlaid = l.linkDerivedPath("/w/pad_combined_s7b3_1740000000000_text.mp4", padded.localPath, "OVERLAYED")!;

    expect(trimmed.parentLineageId).toBe(origin.lineageId);
    expect(padded.parentLineageId).toBe(trimmed.lineageId);
    expect(overlaid.parentLineageId).toBe(padded.lineageId);
    // And the whole chain still reports the ORIGINAL provider — inherited along a derivation the
    // pipeline performed, which is proof rather than inference.
    expect(overlaid.provider).toBe("youtube_cc");
    expect(overlaid.providerStatus).toBe("VERIFIED");
    expect(l.rootOf(overlaid.lineageId)!.lineageId).toBe(origin.lineageId);
  });

  it("TEST 10 — the pad_combined name that broke render 536 resolves to its origin", () => {
    const l = ledger();
    const origin = provenCandidate(l);
    l.linkDerivedPath("/w/pad_combined_s7b3_1740000000000.mp4", origin.localPath, "PADDED");
    expect(l.providerFor("/w/pad_combined_s7b3_1740000000000.mp4")).toBe("youtube_cc");
  });

  it("TEST 11 — a derived file whose origin is unknown gets NO provenance rather than a guess", () => {
    const l = ledger();
    expect(l.linkDerivedPath("/w/derived.mp4", "/w/never-seen.mp4", "PADDED")).toBeNull();
    expect(l.providerFor("/w/derived.mp4")).toBeNull();
  });

  it("TEST 12 — both pipeline rename sites pass the stage that describes them", () => {
    expect(PIPELINE_SRC).toContain('linkDerivedPath(effectiveClip, clipPath, "PADDED")');
    expect(PIPELINE_SRC).toContain('linkDerivedPath(withText, effectiveClip, "OVERLAYED")');
  });
});

/* ═════════════ §D — FINAL_VIDEO is proven or it is NOT_VERIFIED ═════════════ */

describe("RONDE 87 §D — downloaded is not adopted is not composed is not in the video", () => {
  it("TEST 13 — the four stages are counted separately and do not imply one another", () => {
    const l = ledger();
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    let s = l.summary();
    expect(s.total.downloadSucceeded).toBe(1);
    expect(s.total.adopted).toBe(0);
    expect(s.total.composed).toBe(0);
    expect(s.total.finalVideo).toBe(0);

    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(r.lineageId, "COMPOSED", { status: "OK" });
    s = l.summary();
    expect(s.total.adopted).toBe(1);
    expect(s.total.composed).toBe(1);
    expect(s.total.finalVideo, "composing a clip does not put it in the video").toBe(0);
  });

  it("TEST 14 — FINAL_VIDEO is written only for clips handed over as proven", () => {
    const l = ledger();
    const inVideo = provenCandidate(l);
    const notInVideo = provenCandidate(l, { contentKey: "youtube_cc:other", localPath: "/w/other.mp4" });
    for (const r of [inVideo, notInVideo]) l.recordEvent(r.lineageId, "COMPOSED", { status: "OK" });

    expect(l.finalVideoWasVerified, "nothing checked yet").toBe(false);
    expect(l.markFinalVideo([inVideo.localPath])).toBe(1);
    expect(l.finalVideoWasVerified).toBe(true);
    expect(l.get(inVideo.lineageId)!.finalVideoAt).toBeGreaterThan(0);
    expect(l.get(notInVideo.lineageId)!.finalVideoAt).toBeUndefined();
  });

  it("TEST 15 — a render that never checked reports NOT_VERIFIED, not zero (§J)", () => {
    const l = ledger();
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    const summary = l.summary();

    // Unchecked: the answer is "nobody looked", which is NOT the same claim as "none made it".
    const unchecked = formatSourceSummary(summary, false).join("\n");
    expect(unchecked).toContain(`finalVideo=${NOT_VERIFIED}`);
    expect(unchecked).not.toContain("finalVideo=0");
    expect(formatFunnelReport(summary, false)[0]).toContain(`finalVideo=${NOT_VERIFIED}`);
    expect(formatAuditReport(l.reconcile())).toContain(`  finalVideoClips=${NOT_VERIFIED}`);

    // Checked and genuinely none: zero is now a real, earned answer.
    l.markFinalVideo([]);
    expect(formatSourceSummary(l.summary(), true).join("\n")).toContain("finalVideo=0");
  });

  it("TEST 16 — the pipeline proves FINAL_VIDEO from the concat that made the delivered file", () => {
    // The proof chain, asserted at the call site: the scene videos actually concatenated, mapped
    // to the clips those scenes were composed from. Nothing derived from a name or a count.
    expect(PIPELINE_SRC).toContain("let finalConcatInputs: string[] = orderedClips;");
    expect(PIPELINE_SRC).toContain("if (out) finalConcatInputs = validClips;");
    expect(PIPELINE_SRC).toContain("const deliveredScenes = new Set(finalConcatInputs.filter(Boolean));");
    expect(PIPELINE_SRC).toContain("if (!sceneVideo || !deliveredScenes.has(sceneVideo)) continue;");
    expect(PIPELINE_SRC).toContain("ledger.markFinalVideo(deliveredClips)");
    // And it runs AFTER the final file has been validated — before that there is nothing to prove.
    const validateIdx = PIPELINE_SRC.indexOf("if (!finalValidation.ok) {");
    expect(PIPELINE_SRC.indexOf("ledger.markFinalVideo(deliveredClips)")).toBeGreaterThan(validateIdx);
  });
});

/* ═════════════ §E — rejections belong to an asset ═════════════ */

describe("RONDE 87 §E — every refusal names the asset and the gate", () => {
  it("TEST 17 — a rejection is attached to the clip's own lineage with its gate", () => {
    const l = ledger();
    const r = provenCandidate(l);
    expect(l.recordRejection(r.localPath, "off_topic_visual")).toBe(true);
    const event = l.allEvents().find((e) => e.status === "REJECTED")!;
    expect(event.lineageId).toBe(r.lineageId);
    expect(event.provider).toBe("youtube_cc");
    expect(event.providerAssetId).toBe("123");
    expect(event.gate).toBe("off_topic_visual");
    expect(event.stage).toBe("ELIGIBLE");
    expect(l.summary().failureReasons.off_topic_visual).toBe(1);
  });

  it("TEST 18 — the gate decides the stage, and an unknown gate is not sorted into a bucket", () => {
    expect(rejectionStageForGate("vision_gate")).toBe("ELIGIBLE");
    expect(rejectionStageForGate("license_rejected")).toBe("ELIGIBLE");
    expect(rejectionStageForGate("compose_gate")).toBe("COMPOSED");
    expect(rejectionStageForGate("near_duplicate")).toBe("COMPOSED");
    expect(rejectionStageForGate("something_new")).toBe("ELIGIBLE");
  });

  it("TEST 19 — every gate in the pipeline reports through the one reject point", () => {
    const audit = createClipRejectAudit();
    const l = ledger();
    audit.lineage = l;
    const r = provenCandidate(l);
    recordClipReject(audit, 7, 3, r.localPath, "vision_gate", "q");
    expect(l.summary().total.rejected).toBe(1);
    expect(l.summary().failureReasons.vision_gate).toBe(1);

    // A clip the ledger has never seen produces NO event — there is nothing to attach it to, and
    // inventing a record with a guessed provider is what this round removes. The per-beat and
    // per-reason counters the audit itself keeps are unaffected.
    expect(l.recordRejection("/w/never-seen.mp4", "vision_gate")).toBe(false);
    expect(audit.recorded).toBe(1);
  });

  it("TEST 20 — a thrown prepare error becomes a groupable reason, and an unknown one is not forced", () => {
    expect(normalizeFailureReason("source video too short (2.14s)")).toBe("source_video_too_short");
    expect(normalizeFailureReason("trimmed clip too short (0.90s < 2.00s)")).toBe("trimmed_clip_too_short");
    expect(normalizeFailureReason("ENOENT: no such file or directory")).toBe("file_missing");
    expect(normalizeFailureReason("fetch failed 404")).toBe("download_error");
    // Not shoehorned into the nearest bucket.
    expect(normalizeFailureReason("something nobody has seen before")).toBe("other");
    expect(normalizeFailureReason(undefined)).toBe("unspecified");
  });
});

/* ═════════════ §F/§G — the summary and the funnel come from events only ═════════════ */

describe("RONDE 87 §F/§G — one source of truth for the counts", () => {
  it("TEST 21 — the summary carries every counter the round asks for", () => {
    expect([...SUMMARY_COUNTERS]).toEqual([
      "searches", "results", "eligible", "ranked", "selected",
      "downloadStarted", "downloadSucceeded", "downloadFailed",
      "adopted", "transformed", "composed", "replaced", "removed",
      "finalVideo", "rejected", "fallback", "rescue", "backfill",
    ]);
    const empty = emptySummaryCounts();
    for (const c of SUMMARY_COUNTERS) expect(empty[c]).toBe(0);
  });

  it("TEST 22 — the same event recorded twice is counted once", () => {
    const l = ledger();
    const r = provenCandidate(l);
    // Independent recovery layers can re-adopt the same beat; the render must not report two.
    for (let i = 0; i < 5; i++) l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    expect(l.summary().total.adopted).toBe(1);
    expect(l.allEvents().filter((e) => e.stage === "ADOPTED").length, "the events are all kept").toBe(5);
  });

  it("TEST 23 — counts are per provider and roll up to the total", () => {
    const l = ledger();
    const yt = provenCandidate(l);
    const ia = l.createLineage({
      sceneIndex: 2, beatIndex: 0, candidateId: "ia:x", contentKey: "internet_archive:x",
      provider: "Internet_Archive", localPath: "/w/ia.mp4",
    });
    l.recordEvent(yt.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(ia.lineageId, "ADOPTED", { status: "OK" });
    l.recordEvent(ia.lineageId, "COMPOSED", { status: "OK" });
    const s = l.summary();
    expect(s.total.adopted).toBe(2);
    // Provider names are one key however a caller spells them.
    expect(s.byProvider.internet_archive!.adopted).toBe(1);
    expect(s.byProvider.internet_archive!.composed).toBe(1);
    expect(s.byProvider.youtube_cc!.adopted).toBe(1);
  });

  it("TEST 24 — clips with no proven source get their own bucket, never redistributed", () => {
    const l = ledger();
    const anon = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "x", contentKey: "x",
      localPath: "/w/scene_0_b0_curated_a55995.mp4",
    });
    l.recordEvent(anon.lineageId, "COMPOSED", { status: "OK" });
    const s = l.summary();
    expect(s.byProvider[UNVERIFIED_PROVIDER]!.composed).toBe(1);
    expect(s.unverifiedRecords).toBe(1);
    expect(s.verifiedRecords).toBe(0);
    // The UNVERIFIED bucket is printed last among providers: it is a finding, not a provider.
    const labels = formatSourceSummary(l.summary(), true)
      .flatMap((block) => block.split("\n"))
      .filter((x) => /^ {2}\S/.test(x))
      .map((x) => x.trim());
    expect(labels).toContain(UNVERIFIED_PROVIDER);
    expect(labels[labels.length - 1], "TOTAL closes the block").toBe("TOTAL");
  });

  it("TEST 25 — searches and results are a provider fact, kept out of the per-asset counts", () => {
    const l = ledger();
    l.countSearch("internet_archive", 1042);
    l.countSearch("internet_archive", 500);
    const s = l.summary();
    expect(s.byProvider.internet_archive!.searches).toBe(2);
    expect(s.byProvider.internet_archive!.results).toBe(1542);
    // Retrieving 1542 rows did not eligible/rank/select/adopt any of them.
    expect(s.total.eligible).toBe(0);
    expect(s.total.adopted).toBe(0);
  });

  it("TEST 26 — the funnel prints TOTAL first, then the same shape per provider", () => {
    const l = ledger();
    l.countSearch("pexels", 900);
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    const lines = formatFunnelReport(l.summary(), true);
    expect(lines[0]).toContain("[VisualFunnel] TOTAL");
    expect(lines[0]).toContain("retrieved=900");
    expect(lines.slice(1).some((x) => x.includes("pexels"))).toBe(true);
    expect(lines.slice(1).some((x) => x.includes("youtube_cc"))).toBe(true);
  });

  it("TEST 27 — a funnel that widens is reported, not quietly clamped", () => {
    const l = ledger();
    const r = provenCandidate(l);
    // COMPOSED without ADOPTED: composed(1) now exceeds adopted(0).
    l.recordEvent(r.lineageId, "COMPOSED", { status: "OK" });
    const result = l.reconcile();
    const funnelWarning = result.warnings.find((w) => w.code === "FUNNEL_NOT_MONOTONIC");
    expect(funnelWarning).toBeDefined();
    expect(funnelWarning!.message).toContain("composed=1");
    // The number itself is untouched — correcting it would hide the bug it is reporting.
    expect(l.summary().total.composed).toBe(1);
  });
});

/* ═════════════ §H — reconciliation ═════════════ */

describe("RONDE 87 §H — the end-of-render consistency check", () => {
  it("TEST 28 — a clean render produces no errors", () => {
    const l = ledger();
    const r = provenCandidate(l);
    for (const stage of ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED",
      "DOWNLOAD_SUCCEEDED", "ADOPTED", "COMPOSED"] as const) {
      l.recordEvent(r.lineageId, stage, { status: "OK" });
    }
    l.markFinalVideo([r.localPath]);
    const result = l.reconcile();
    expect(result.errors).toEqual([]);
    expect(result.finalVideoClips).toBe(1);
    expect(result.verifiedSourceClips).toBe(1);
    expect(result.unverifiedSourceClips).toBe(0);
  });

  it("TEST 29 — a derived clip with no parent is an error", () => {
    const l = ledger();
    const r = provenCandidate(l);
    // A TRIMMED event on a record that was never linked to an origin.
    l.recordEvent(r.lineageId, "TRIMMED", { status: "OK" });
    const errors = l.reconcile().errors.map((e) => e.code);
    expect(errors).toContain("DERIVED_WITHOUT_PARENT");
  });

  it("TEST 30 — an asset may not report two different providers", () => {
    const l = ledger();
    const origin = provenCandidate(l);
    const derived = l.linkDerivedPath("/w/d.mp4", origin.localPath, "TRIMMED")!;
    // Force the conflict the way a careless later edit would.
    derived.provider = "pexels";
    const errors = l.reconcile().errors;
    expect(errors.map((e) => e.code)).toContain("PROVIDER_CONFLICT");
    expect(errors.find((e) => e.code === "PROVIDER_CONFLICT")!.message).toContain("youtube_cc");
  });

  it("TEST 31 — a provider without VERIFIED status, or a status without a provider, is an error", () => {
    const l = ledger();
    const a = provenCandidate(l);
    a.providerStatus = "UNVERIFIED";
    const b = l.createLineage({
      sceneIndex: 0, beatIndex: 1, candidateId: "y", contentKey: "y", localPath: "/w/y.mp4",
    });
    b.providerStatus = "VERIFIED";
    const codes = l.reconcile().errors.map((e) => e.code);
    expect(codes.filter((c) => c === "PROVIDER_STATUS_MISMATCH").length).toBe(2);
  });

  it("TEST 32 — a completed download that was never started is a warning", () => {
    const l = ledger();
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    expect(l.reconcile().warnings.map((w) => w.code)).toContain("DOWNLOAD_WITHOUT_START");
  });

  it("TEST 33 — findings are reported and never silently repaired", () => {
    const l = ledger();
    const r = provenCandidate(l);
    l.recordEvent(r.lineageId, "TRIMMED", { status: "OK" });
    const lines = formatAuditReport(l.reconcile());
    expect(lines.some((x) => x.startsWith("[VisualAuditError]"))).toBe(true);
    expect(lines.some((x) => x.includes("DERIVED_WITHOUT_PARENT"))).toBe(true);
    // The record is left exactly as it was found.
    expect(l.get(r.lineageId)!.parentLineageId).toBeUndefined();
    expect(LINEAGE_SRC).toContain("it never repairs the number");
  });
});

/* ═════════════ §I/§J — the official report ═════════════ */

describe("RONDE 87 §I/§J — the official statistics come from the ledger", () => {
  it("TEST 34 — the quality report's bySource is lineage-only; the filename reading is diagnostic", () => {
    const clip = "/w/pad_combined_s3b2_1740000000000.mp4";
    const report = buildVideoQualityReport([clip], "Hitler's Last Days", {
      resolveSource: () => null, // nothing proven
    });
    expect(report.bySource[UNVERIFIED_PROVIDER]).toBe(1);
    expect(report.bySource.unknown, "an unproven clip is not filed under a guess").toBeUndefined();
    // The old guess is still computed, in its own clearly-named field.
    expect(report.diagnosticBySource).toBeDefined();
    expect(report.warnings.some((w) => w.includes("UNVERIFIED"))).toBe(true);

    const proven = buildVideoQualityReport([clip], "Hitler's Last Days", {
      resolveSource: () => "wikimedia",
    });
    expect(proven.bySource.wikimedia).toBe(1);
  });

  it("TEST 35 — the compose manifest reports the ledger and labels the filename guess as a hint", () => {
    expect(PIPELINE_SRC).toContain("const source = lineageRecord?.provider ?? UNVERIFIED_PROVIDER;");
    expect(PIPELINE_SRC).toContain("diagnosticNameHint=${inferClipSourceFromPath(basename)}");
    // MUTATION GUARD: the RONDE 64 fallback that made a filename an official source is gone.
    expect(PIPELINE_SRC).not.toContain('entry?.source ?? (inferred && inferred !== "unknown" ? inferred : "unknown")');
  });

  it("TEST 36 — no official source statistic is left reading a filename", () => {
    // The inference functions survive as diagnostics and say so at their definition.
    for (const [src, name] of [[PIPELINE_SRC, "videoPipeline"], [REPORT_SRC, "videoQualityReport"]] as const) {
      const idx = src.indexOf("export function inferClipSourceFromPath(");
      expect(idx, `${name} must still define it`).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, idx - 1200), idx), `${name} must mark it diagnostic-only`)
        .toContain("DIAGNOSTIC ONLY");
    }
    // The quality score keeps its historical inputs (§L: no scoring change), from the named field.
    expect(REPORT_SRC).toContain("const stockCount = (diagnosticBySource.pexels ?? 0) + (diagnosticBySource.pixabay ?? 0);");
  });

  it("TEST 37 — the editor manifest prefers the proven source and never guesses \"archive\"", async () => {
    // The old fallback was `clipPath.includes("curated") ? "archive" : "unknown"`.
    expect(EDITOR_SRC).not.toContain('clipPath.includes("curated") ? "archive" : "unknown"');
    const unproven = await buildEditorClipFromPath("/w/scene_0_b0_curated_something.mp4");
    expect(unproven.source).toBe(UNVERIFIED_PROVIDER);
    const proven = await buildEditorClipFromPath("/w/scene_0_b0_thing.mp4", () => "nara");
    expect(proven.source).toBe("nara");
  });

  it("TEST 38 — a route label is never stored as a provider", () => {
    const audit = createClipAdoptAudit();
    const l = ledger();
    bindLineageLedger(audit, l);
    // "rescue_wikimedia" is how the beat was FILLED, not who supplied the picture.
    recordClipAdopt(audit, 1, 2, "beat", "/w/unrecorded.mp4", "rescue_wikimedia");
    const record = l.resolve("/w/unrecorded.mp4")!;
    expect(record.provider).toBeNull();
    expect(record.providerStatus).toBe("UNVERIFIED");
    expect(record.sourceLabel, "the label is kept, in the field that means label").toBe("rescue_wikimedia");
    expect(record.route).toBe("rescue");
  });

  it("TEST 39 — an adoption of a known clip keeps the provider it was proven with", () => {
    const audit = createClipAdoptAudit();
    const l = ledger();
    bindLineageLedger(audit, l);
    const r = provenCandidate(l);
    recordClipAdopt(audit, 7, 3, "beat", r.localPath, "archive", "A title", null, 55995, 8);
    const after = l.resolve(r.localPath)!;
    expect(after.provider, "the adopt label must not overwrite the proven provider").toBe("youtube_cc");
    expect(after.sourceLabel).toBe("archive");
    expect(after.visionScore).toBe(8);
    expect(l.summary().total.adopted).toBe(1);
  });
});

/* ═════════════ §K — renders stay separate ═════════════ */

describe("RONDE 87 §K — concurrent renders never contaminate each other", () => {
  it("TEST 40 — two ledgers share no records, no events and no lineage ids", () => {
    const a = ledger();
    const b = ledger();
    const ra = provenCandidate(a);
    const rb = b.createLineage({
      sceneIndex: 7, beatIndex: 3, candidateId: "youtube_cc:abc123",
      contentKey: "youtube_cc:abc123", provider: "pexels",
      localPath: ra.localPath, // the SAME path, as two renders of the same topic would produce
    });

    expect(ra.lineageId).not.toBe(rb.lineageId);
    expect(ra.lineageId.startsWith(a.renderId)).toBe(true);
    expect(rb.lineageId.startsWith(b.renderId)).toBe(true);
    // Each render answers for its own render only.
    expect(a.providerFor(ra.localPath)).toBe("youtube_cc");
    expect(b.providerFor(ra.localPath)).toBe("pexels");
    expect(a.get(rb.lineageId)).toBeNull();
    expect(b.get(ra.lineageId)).toBeNull();

    a.recordEvent(ra.lineageId, "ADOPTED", { status: "OK" });
    expect(a.summary().total.adopted).toBe(1);
    expect(b.summary().total.adopted, "render B must not see render A's adoption").toBe(0);
  });

  it("TEST 41 — one render proving its final video says nothing about the other", () => {
    const a = ledger();
    const b = ledger();
    const ra = provenCandidate(a);
    const rb = provenCandidate(b);
    a.markFinalVideo([ra.localPath]);
    expect(a.finalVideoWasVerified).toBe(true);
    expect(b.finalVideoWasVerified, "B never checked, and must still say so").toBe(false);
    expect(formatSourceSummary(b.summary(), b.finalVideoWasVerified).join("\n"))
      .toContain(`finalVideo=${NOT_VERIFIED}`);
    expect(b.get(rb.lineageId)!.finalVideoAt).toBeUndefined();
  });

  it("TEST 42 — each render's ledger is created with the render, and bound to its own audits", () => {
    expect(PIPELINE_SRC).toContain("lineage: new VisualSourceLedger({");
    expect(PIPELINE_SRC).toContain("bindLineageLedger(state.clipAdoptAudit, state.sourcingCache.lineage);");
    expect(PIPELINE_SRC).toContain("state.clipRejectAudit.lineage = state.sourcingCache.lineage;");
  });
});

/* ═════════════ §L — nothing about quality logic moved ═════════════ */

describe("RONDE 87 §L — observability only", () => {
  it("TEST 43 — ranking, thresholds, concurrency and fallback order are untouched", () => {
    // RONDE 79/86 ranking.
    expect(PIPELINE_SRC).toContain("export function scoreCandidateAgainstBeat(");
    expect(PIPELINE_SRC).toContain("rankCuratedPicksByBeatContext(ranked, curatedRankCtx)");
    // RONDE 83/86 concurrency.
    expect(PIPELINE_SRC).toContain("const visualLimit = pLimit(perf.sceneParallelism);");
    expect(PIPELINE_SRC).toContain("const beatLimit = pLimit(beatConcurrency);");
    expect(PIPELINE_SRC).toContain("return withGlobalMediaFetch(() => downloadToFileStreamingInner(");
    // RONDE 84 candidate depth and RONDE 85's moving filler.
    expect(PIPELINE_SRC).toContain("export const ARCHIVE_PREPARE_ATTEMPTS_MAX = 6;");
    // SUPERSEDED by RONDE 111: two clone-pads now, both deliberate — the MONTAGE_TAIL_PAD
    // =freeze override, and the remainder after slowing is capped at 2x (the absolute last
    // technical fallback). A THIRD would still mean a freeze had leaked back in.
    expect((PIPELINE_SRC.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(2);
    // RONDE 86 search-performance cap.
    expect(PIPELINE_SRC).toContain("if (queue.length >= prepareCap) break;");
  });

  it("TEST 44 — the audit can never fail a render", () => {
    const idx = PIPELINE_SRC.indexOf("const deliveredScenes = new Set(finalConcatInputs");
    // RONDE 94 added the AssetUsageSummary lines inside this same try, and RONDE 105 added the
    // [FinalVisualReport] block and the per-beat problem lines, so the window has to reach past
    // them to the catch it is asserting about. The rule is unchanged: everything the audit prints
    // sits inside a try whose catch is non-fatal.
    const block = PIPELINE_SRC.slice(Math.max(0, idx - 600), idx + 9000);
    expect(block).toContain("try {");
    expect(block).toContain("[VisualAudit] audit reporting failed (non-fatal)");
  });
});

/* ═════════════ §M — external providers actually get a lineage ═════════════ */

describe("RONDE 88 — the external providers are wired, not just the archive", () => {
  /**
   * The defect this section exists for.
   *
   * RONDE 87 recorded external provenance inside putCachedProviderAsset, gated on the cache entry
   * carrying a `localPath`. Nothing in the codebase ever writes that field — all eighteen callers
   * pass metadata only — so the branch was dead and every external provider produced no lineage
   * record at all. The audit would have reported the whole internet half of the render as
   * UNVERIFIED, and it would have looked like a sourcing problem rather than a wiring bug.
   *
   * It shipped because every RONDE 87 test drove the ledger directly. None of them asked whether
   * the pipeline ever calls it for a provider that is not the curated archive. These do.
   */
  const PROVIDERS = [
    "wikimedia", "flickr", "sepiasearch", "gdelt_tv", "europeana", "vimeo",
    "media_ccc", "nasa", "nara", "internet_archive", "youtube_cc",
  ];

  it("TEST 45 — every download site opens a lineage at the moment it stamps the provider tag", () => {
    // tagPathWithProviderAsset is the one instant provider, asset id and destination path are all
    // in hand, straight from that provider's API response. A call that does not hand over the
    // cache records nothing, which is exactly how the RONDE 87 gap went unnoticed.
    const calls = [...PIPELINE_SRC.matchAll(/tagPathWithProviderAsset\(\s*([\s\S]*?)\n\s*\);/g)]
      .map((m) => m[1]!)
      .filter((body) => !body.includes("export function"));
    expect(calls.length, "expected the twelve download sites").toBeGreaterThanOrEqual(12);
    for (const body of calls) {
      expect(body, `a download site records nothing:\n${body}`).toContain("sourcingCache");
    }
  });

  it("TEST 46 — each named provider is one of those sites", () => {
    // Read out of the tag CALLS themselves, not by searching the whole file for the provider
    // name — that would match any mention anywhere and pass on a provider that is not wired.
    const wired = new Set(
      [...PIPELINE_SRC.matchAll(/tagPathWithProviderAsset\(\s*([\s\S]*?)\n\s*\);/g)]
        .map((m) => m[1]!)
        .filter((body) => body.includes("sourcingCache"))
        .flatMap((body) => [...body.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!))
    );
    for (const provider of PROVIDERS) {
      expect(wired.has(provider), `${provider} does not open a lineage at its download`).toBe(true);
    }
  });

  it("TEST 47 — tagging opens the record before the download, so a failure has somewhere to land", () => {
    const cache = createSourcingCache(536);
    const tagged = tagPathWithProviderAsset(
      "/w/scene_7_b3_wikivid_0.mp4", "wikimedia", "File:Fuhrerbunker.jpg", cache,
      { sceneIndex: 7, beatIndex: 3, title: "Führerbunker", mediaType: "image" }
    );
    const record = cache.lineage.resolve(tagged)!;
    expect(record.provider).toBe("wikimedia");
    expect(record.providerStatus).toBe("VERIFIED");
    expect(record.providerAssetId).toBe("File:Fuhrerbunker.jpg");
    expect(record.sceneIndex).toBe(7);
    // Opened before the bytes arrive, exactly like the curated path.
    expect(cache.lineage.summary().total.downloadStarted).toBe(1);
    expect(cache.lineage.summary().total.downloadSucceeded).toBe(0);

    recordProviderDownloadOutcome(cache, tagged, false, "source video too short (1.20s)");
    expect(cache.lineage.summary().total.downloadFailed).toBe(1);
    expect(cache.lineage.summary().failureReasons.source_video_too_short).toBe(1);
  });

  it("TEST 48 — the same asset tagged twice is one record, not two", () => {
    const cache = createSourcingCache(536);
    const a = tagPathWithProviderAsset("/w/a.mp4", "nara", "rec-1", cache, { sceneIndex: 1 });
    const b = tagPathWithProviderAsset("/w/a.mp4", "nara", "rec-1", cache, { sceneIndex: 1 });
    expect(a).toBe(b);
    expect(cache.lineage.size).toBe(1);
    expect(cache.lineage.summary().total.downloadStarted).toBe(1);
  });

  it("TEST 49 — without a cache the function is still the pure string it always was", () => {
    // Tests and tools call it with three arguments; that behaviour must not change.
    const bare = tagPathWithProviderAsset("/w/x.mp4", "pexels", "123");
    expect(bare).toBe("/w/x__pid_pexels-a665a45920422f9d.mp4".replace(
      "a665a45920422f9d", bare.slice(bare.indexOf("pexels-") + 7, bare.indexOf(".mp4"))
    ));
    expect(bare).toContain("__pid_pexels-");
    expect(tagPathWithProviderAsset("/w/x.mp4", "pexels", undefined)).toBe("/w/x.mp4");
  });

  it("TEST 50 — the dead branch that caused this is gone", () => {
    // MUTATION GUARD: provenance must not depend on a cache field nothing populates.
    const idx = PIPELINE_SRC.indexOf("export function putCachedProviderAsset(");
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
    expect(body, "putCachedProviderAsset must not be the recorder any more")
      .not.toContain("createLineage(");
  });
});

describe("RONDE 88 — the provider-fact columns fill for external providers too", () => {
  it("TEST 51 — searches/results and completed downloads fold in without double-counting", () => {
    const l = new VisualSourceLedger({ renderId: "r88" });
    // A provider that reports through its own counters (every external fetch path).
    l.countSearch("internet_archive", 1042);
    l.countProviderDownloads("internet_archive", 6);
    // A provider that reports through real events (the curated archive).
    const curated = l.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "a:1", contentKey: "curated:1",
      provider: "bundesarchiv", localPath: "/w/c.mp4",
    });
    l.recordEvent(curated.lineageId, "DOWNLOAD_STARTED", { status: "OK" });
    l.recordEvent(curated.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });

    const s = l.summary();
    expect(s.byProvider.internet_archive!.searches).toBe(1);
    expect(s.byProvider.internet_archive!.results).toBe(1042);
    expect(s.byProvider.internet_archive!.downloadSucceeded).toBe(6);
    expect(s.byProvider.bundesarchiv!.downloadSucceeded).toBe(1);
    // Six folded plus one event — not seven plus six.
    expect(s.total.downloadSucceeded).toBe(7);
  });

  it("TEST 52 — the render folds the provider counters in, and skips providers it already counted", () => {
    expect(PIPELINE_SRC).toContain("if (already[provider]?.searches) continue;");
    expect(PIPELINE_SRC).toContain("if (known > 0 || m.downloadCount <= 0) continue;");
    expect(PIPELINE_SRC).toContain("ledger.countProviderDownloads(provider, m.downloadCount)");
  });
});
