/**
 * RENDER 573 — 3995 CANDIDATES, 140 DOWNLOADS, 19 CLIPS, AND 3976 ASSETS NOBODY COULD ADOPT.
 *
 * ── What the production log measured ─────────────────────────────────────────────────────────
 *
 *     [AssetUsageSummary] pexels           found=2818 downloaded=1  rendered=0 unused=2818
 *     [AssetUsageSummary] internet_archive found=527  downloaded=49 rendered=0 unused=527
 *     [AssetUsageSummary] pixabay          found=348  downloaded=45 rendered=0 unused=348
 *     [AssetUsageSummary] TOTAL            found=3995 downloaded=140 rendered=19 unused=3976
 *
 *     [EligibilityGap] scene=2 beat=3 route=shaped file=…__pid_pexels-….mp4 contentKey=pexels:…
 *                      — the lineage ledger has no record for this clip, so it can never
 *                      satisfy REAL_FUNNEL                                              ×58
 *
 *     [BeatFunnel] s2b3 … eligible=49 shortlisted=8 visionAsked=13 approved=7
 *     [BeatLedger]  beat=s2b3 … vision_accepted=7 eligible=0 adopted=0 origin=none
 *
 * Seven pictures the editor APPROVED, adopted zero, and the beat ended on `origin=none`.
 *
 * ── The cause: RONDE 173's defect, on its other half ─────────────────────────────────────────
 *
 * `ronde173ProviderQueryCacheReach.test.ts` counted it for the query cache: the render's
 * `SourcingCache` sits at parameter index 9, 10 or 12 of the provider fetchers, and 37 of 72 call
 * sites never reach it. That round fixed `cachedProviderSearch` by falling back to the render
 * context. `tagPathWithProviderAsset` — the function that opens an asset's LINEAGE record — takes
 * the same cache at index 13 and was left on the parameter.
 *
 * So the file got its `__pid_` tag, which is pure string work needing no cache, and no record.
 * `markEligible` then had nothing to mark, and REAL_FUNNEL was unreachable for that asset for the
 * rest of the render — decided at download time, long before any gate looked at the picture.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSourcingCache,
  tagPathWithProviderAsset,
  recordProviderDownloadOutcome,
  withRenderSourcingCacheScope,
  lastFfmpegErrorLine,
} from "./videoPipeline";
import {
  recordClipAdopt,
  bindLineageLedger,
  bindContentKeyResolver,
} from "./clipAdoptAudit";
import { createClipRejectAudit, noteRepeatedRefusal } from "./clipRejectAudit";

describe("a provider download opens a lineage record even when the caller had no cache", () => {
  it("uses the render's own cache when one is published and none is passed", async () => {
    const cache = createSourcingCache(573);
    await withRenderSourcingCacheScope(cache, async () => {
      const tagged = tagPathWithProviderAsset("/tmp/scene_2_b3_pex_vid6611040.mp4", "pexels", "6611040");
      expect(tagged).toContain("__pid_pexels-");
      const record = cache.lineage.resolve(tagged, "pexels:6611040");
      expect(record).not.toBeNull();
      expect(record!.provider).toBe("pexels");
      expect(record!.providerAssetId).toBe("6611040");
    });
  });

  it("markEligible can then mark it — which is the whole of REAL_FUNNEL's first half", async () => {
    const cache = createSourcingCache(573);
    await withRenderSourcingCacheScope(cache, async () => {
      const tagged = tagPathWithProviderAsset("/tmp/scene_2_b3_pix_vid209898.mp4", "pixabay", "209898");
      /** False was the production answer, and it is what [EligibilityGap] reported 58 times. */
      expect(cache.lineage.markEligible(tagged, "pixabay:209898", "vision_gate:test")).toBe(true);
      expect(cache.lineage.isEligible(tagged, "pixabay:209898")).toBe(true);
    });
  });

  it("a cache passed explicitly still wins over the ambient one", async () => {
    const passed = createSourcingCache(1);
    const ambient = createSourcingCache(2);
    await withRenderSourcingCacheScope(ambient, async () => {
      const tagged = tagPathWithProviderAsset("/tmp/a.mp4", "wikimedia", "X", passed);
      expect(passed.lineage.resolve(tagged, "wikimedia:X")).not.toBeNull();
      expect(ambient.lineage.resolve(tagged, "wikimedia:X")).toBeNull();
    });
  });

  it("outside a render nothing is recorded — a tool must not acquire provenance it did not earn", () => {
    const tagged = tagPathWithProviderAsset("/tmp/b.mp4", "pexels", "9");
    expect(tagged).toContain("__pid_pexels-");
    /** No throw, no record, and the pure string behaviour is unchanged. */
    expect(() => recordProviderDownloadOutcome(undefined, tagged, false, "x")).not.toThrow();
  });

  it("the download's OUTCOME reaches the same ledger the record was opened in", async () => {
    const cache = createSourcingCache(573);
    await withRenderSourcingCacheScope(cache, async () => {
      const tagged = tagPathWithProviderAsset("/tmp/c.mp4", "internet_archive", "someitem");
      recordProviderDownloadOutcome(undefined, tagged, false, "archive_segment_fetch_failed");
      const stages = cache.lineage
        .allEvents()
        .filter((e) => e.lineageId === cache.lineage.resolve(tagged)!.lineageId)
        .map((e) => e.stage);
      expect(stages).toContain("DOWNLOAD_FAILED");
    });
  });
});

describe("an adoption carries the content key it computes, instead of opening an anonymous record", () => {
  /**
   * `[CinematicDrop] scene=1 beat=6 asset=unknown:none provider=unknown sourceId=none
   *  reason=NOT_REHYDRATABLE` on `scene_1_b6_curated_a57392.mp4` — a clip out of FastVid's own
   * curated archive, whose asset id the key resolver reads from the path. Seven of fifteen beats
   * were dropped this way and `localOnly=0`, because there was no handle to keep them by either.
   */
  const setup = () => {
    const audit: Parameters<typeof recordClipAdopt>[0] = [];
    const cache = createSourcingCache(573);
    bindLineageLedger(audit, cache.lineage);
    bindContentKeyResolver(audit, (p) => {
      const m = /_curated_a(\d+)/.exec(path.basename(p));
      return m ? `curated:asset:${m[1]}` : "";
    });
    return { audit, cache };
  };

  it("the record it opens is keyed, not blank", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_1_b6_curated_a57392.mp4";
    recordClipAdopt(audit, 1, 6, "Deep within the Führerbunker", clip, "guaranteed");

    const record = cache.lineage.resolve(clip, "curated:asset:57392");
    expect(record).not.toBeNull();
    expect(record!.contentKey).toBe("curated:asset:57392");
  });

  it("a curated key yields the archive asset id the planner needs for a handle", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_1_b6_curated_a57392.mp4";
    recordClipAdopt(audit, 1, 6, "beat", clip, "guaranteed");
    expect(cache.lineage.resolve(clip, "curated:asset:57392")!.archiveAssetId).toBe(57392);
  });

  it("an id the caller supplies still wins over the one read from the key", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_1_b6_curated_a57392.mp4";
    recordClipAdopt(audit, 1, 6, "beat", clip, "guaranteed", undefined, null, 99999);
    expect(cache.lineage.resolve(clip, "curated:asset:57392")!.archiveAssetId).toBe(99999);
  });

  it("the provider stays unset — a route label is not a provider (RONDE 87)", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_1_b6_curated_a57392.mp4";
    recordClipAdopt(audit, 1, 6, "beat", clip, "guaranteed");
    expect(cache.lineage.providerFor(clip, "curated:asset:57392")).toBeNull();
  });

  it("a clip the resolver cannot key is still recorded, still without a handle", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_0_slot0_guaranteed.mp4";
    recordClipAdopt(audit, 0, 0, "beat", clip, "guaranteed");
    const record = cache.lineage.resolve(clip);
    expect(record).not.toBeNull();
    expect(record!.contentKey).toBe("");
    expect(record!.archiveAssetId).toBeUndefined();
  });

  it("an existing record is FOUND by its key instead of being duplicated", () => {
    const { audit, cache } = setup();
    const clip = "/tmp/scene_1_b6_curated_a57392.mp4";
    cache.lineage.createLineage({
      sceneIndex: 1, beatIndex: 6,
      candidateId: "curated:asset:57392", contentKey: "curated:asset:57392",
      provider: "ww2", providerAssetId: "57392", archiveAssetId: 57392,
      localPath: "/tmp/somewhere_else_a57392.mp4", mediaType: "video", route: "primary",
    });
    const before = cache.lineage.allRecords().length;
    recordClipAdopt(audit, 1, 6, "beat", clip, "archive");
    expect(cache.lineage.allRecords().length).toBe(before);
    expect(cache.lineage.resolve(clip, "curated:asset:57392")!.provider).toBe("ww2");
  });
});

describe("the archive segment fetch names a container, and its failure names itself", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("ffmpeg is told the output format, because the scratch path has no extension", () => {
    /**
     * The caller writes to `…_archive_0_tmp`. With `-c copy` and no `-f`, ffmpeg cannot infer a
     * muxer and refuses before reading a byte — which is why render 573 reported
     * `Archive clip too large (90.8MB per metadata) and segment fetch failed` on every large item.
     */
    const at = SRC.indexOf("async function fetchArchiveSegmentViaFfmpeg");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 3_000);
    /**
     * Matroska rather than mp4 — the item filter also admits Ogg Video and WebM, which MP4 cannot
     * carry. Measured on this machine's ffmpeg; see render573FollowUpRisks for the table.
     */
    expect(body).toContain('"-f", "matroska",');
    expect(body).toContain('"-c", "copy",');
    /**
     * RONDE 230-B renamed the scratch file. It used to be `scene_<n>_<tag>archive_<i>_tmp`, named
     * for the scene that asked; it is now `prep_ia_<slug>_tmp`, named for the PREPARATION, so two
     * beats wanting one archive item name one file and the download happens once.
     *
     * What this assertion is for is unchanged and still enforced: the scratch path carries NO
     * EXTENSION, which is precisely why the `-f matroska` above is not optional. Render 573
     * reported `segment fetch failed` on every large item until it was added.
     */
    expect(SRC).toContain("`prep_ia_${prepSlug}_tmp`");
    expect(SRC.slice(SRC.indexOf("`prep_ia_${prepSlug}_tmp`"), SRC.indexOf("`prep_ia_${prepSlug}_tmp`") + 30))
      .not.toContain(".mp4");
  });

  it("every exit past an opened record files an outcome for it", () => {
    /**
     * `[ProviderFunnelInvariant] provider=internet_archive … terminalOutcomes=0 unexplained=33
     *  INVARIANT_BROKEN` — thirty-three of thirty-three, all leaving through a bare `continue`.
     */
    /**
     * RONDE 230-B moved the download and the trim inside `runPreparation`, so these four endings
     * are thrown by their own branch and filed by ONE `recordRejection` at the failure handler
     * instead of four scattered ones. The rule this test exists for is unchanged — no exit past an
     * opened record may leave without an outcome — and it is now enforced in one place rather than
     * four, which is stricter: a new branch inside the callback cannot forget to file, because the
     * handler files whatever reason the throw carried.
     */
    const at = SRC.indexOf("Archive clip too large (${(knownSize");
    expect(at).toBeGreaterThan(-1);
    const region = SRC.slice(at, at + 5_200);
    /** Every branch still names its own ending... */
    expect(region).toContain('archivePrepFailure("archive_segment_fetch_failed")');
    expect(region).toContain('archivePrepFailure("archive_over_size_cap")');
    expect(region).toContain("archivePrepFailure(`archive_http_${dlResp.status || \"no_bytes\"}`)");
    /** ...and the single handler turns whichever one arrived into the rejection it always was. */
    expect(region).toContain("sourcingCache?.lineage?.recordRejection(");
    expect(region).toContain('archiveRejectionReason(prepared.error) ?? "archive_preparation_failed"');
    /** A throw that carried no reason still ends the record — it cannot vanish. */
    expect(SRC).toContain("function archiveRejectionReason(err: unknown): string | null {");
    /**
     * The trim failure is filed as a REJECTION, not a download outcome: `downloadCount++` has
     * already counted this arrival on the counter channel, and `summary()` adds the counter to the
     * events, so a download event here would count one arrival twice.
     */
    expect(region).toContain('archivePrepFailure("archive_trim_produced_no_clip")');
    /**
     * And on the REJECTION channel throughout: this fetcher owns `downloadCount++`, and
     * `[AssetUsageSummary]` adds the counter to the events, so any download event from here would
     * report one archive fetch twice. `downloadsAreCountedOnBothChannels` holds that same line.
     */
    expect(region).not.toContain("recordProviderDownloadOutcome");
  });

  it("the error message is ffmpeg's own last line, not a slice out of the middle of one", () => {
    const stderr = [
      "ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers",
      "  libavutil      58. 29.100 / 58. 29.100",
      "Unable to find a suitable output format for '/var/tmp/fastvid_573_x/scene_2_archive_0_tmp'",
    ].join("\n");
    expect(lastFfmpegErrorLine(stderr)).toBe(
      "Unable to find a suitable output format for '/var/tmp/fastvid_573_x/scene_2_archive_0_tmp'"
    );
  });

  it("an empty stderr says so rather than producing a blank reason", () => {
    expect(lastFfmpegErrorLine("")).toBe("no stderr");
    expect(lastFfmpegErrorLine("\n\n   \n")).toBe("no stderr");
  });

  it("a runaway tail cannot flood one log line", () => {
    expect(lastFfmpegErrorLine("x".repeat(5_000)).length).toBe(200);
  });
});

describe("a repeated refusal is counted, never hidden and never re-printed as news", () => {
  /**
   * `[AdoptionGuard] scene=2 beat=2 route=archive eligible=true vision=UNCLEAR
   *  blocked=FUNNEL_WITHOUT_EVIDENCE file=scene_2_b2_curated_a57465.mp4` — nine identical lines.
   * The guard is a pure function of four inputs, none of which moved between the calls.
   */
  it("says how many times before, starting at zero", () => {
    const audit = createClipRejectAudit();
    expect(noteRepeatedRefusal(audit, 2, 2, "curated:asset:57465", "FUNNEL_WITHOUT_EVIDENCE")).toBe(0);
    expect(noteRepeatedRefusal(audit, 2, 2, "curated:asset:57465", "FUNNEL_WITHOUT_EVIDENCE")).toBe(1);
    expect(noteRepeatedRefusal(audit, 2, 2, "curated:asset:57465", "FUNNEL_WITHOUT_EVIDENCE")).toBe(2);
  });

  it("a different beat, asset or reason is a different question", () => {
    const audit = createClipRejectAudit();
    noteRepeatedRefusal(audit, 2, 2, "a", "R");
    expect(noteRepeatedRefusal(audit, 2, 3, "a", "R")).toBe(0);
    expect(noteRepeatedRefusal(audit, 2, 2, "b", "R")).toBe(0);
    expect(noteRepeatedRefusal(audit, 2, 2, "a", "S")).toBe(0);
  });

  it("it changes no tally — a failure must never be made to look smaller than it was", () => {
    const audit = createClipRejectAudit();
    for (let i = 0; i < 9; i++) noteRepeatedRefusal(audit, 2, 2, "a", "R");
    expect(audit.recorded).toBe(0);
    expect(audit.perBeat.size).toBe(0);
    expect(audit.entries).toHaveLength(0);
  });
});

describe("the compose barrier finds the beat a renamed clip was adopted for", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("beatForClip climbs the content key and the derivation chain, not the basename alone", () => {
    /**
     * `[ComposeBarrier] s2 clip 3: UNJUDGED pad_combined_s2b3_1788851180446.mp4 — beat_unknown;
     *  nothing has looked at this picture and nothing can` ×4, about pads whose origins were judged.
     */
    const at = SRC.indexOf("composeJudgeScope.beatForClip = (clipPath) =>");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 2_400);
    expect(body).toContain("clipContentKey(clipPath)");
    expect(body).toContain("derivationOriginOf");
    /** Bounded and cycle-safe: a malformed chain must not hang the render it is auditing. */
    expect(body).toContain("seen.has(origin)");
  });

  it("it is handed the full path, since two of its three rungs need one", () => {
    const call = SRC.indexOf("scope.beatForClip(");
    const relevance = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(relevance).toContain("scope.beatForClip(params.clipPath)");
    expect(relevance).not.toContain("scope.beatForClip(path.basename(");
    void call;
  });
});

describe("a sentence with no searchable subject yields no query, not the word the gate refuses", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("simplifyStockSearchWord ranks by what can be photographed, not by word length", () => {
    /**
     * `query="shaped"` ×11 and `query="evidence"` ×10 went to stock libraries on beats about the
     * Führerbunker, and both are longer than the words that name a thing. RONDE 97 wrote the rule
     * for `extractPowerWordFromSentence`; this is the other place the same decision is made.
     */
    const at = SRC.indexOf("function simplifyStockSearchWord");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 3_600);
    expect(body).toContain("NON_PICTORIAL_WORD_FORM.test(w)");
    expect(body).not.toContain("unique.sort((a, b) => b.length - a.length)");
  });

  it("its dead end is an empty query, not \"documentary\"", () => {
    /** `[SearchQueryRejected] query="documentary" reason=NO_CONTENT_ANCHOR` ×30, all self-inflicted. */
    const at = SRC.indexOf("function simplifyStockSearchWord");
    const body = SRC.slice(at, at + 3_600);
    const ret = body.lastIndexOf("return ");
    expect(body.slice(ret)).toContain('return "";');
  });

  it("the two stock fetchers drop an empty query instead of searching for nothing", () => {
    const occurrences = SRC.split('.filter((q) => q.trim().length > 0)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("the word form rule itself is unchanged — this reuses it, it does not restate it", () => {
    expect(SRC.split("const NON_PICTORIAL_WORD_FORM").length - 1).toBe(1);
  });
});

describe("a temp file is never left behind by these tests", () => {
  it("nothing here writes to disk", () => {
    /** The lineage ledger is in-memory; the paths above are names, not files. */
    expect(fs.existsSync(path.join(os.tmpdir(), "scene_2_b3_pex_vid6611040__pid_pexels-"))).toBe(false);
  });
});
