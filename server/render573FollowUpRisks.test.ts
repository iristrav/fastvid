/**
 * THE FIVE THINGS THE PREVIOUS ROUND'S OWN FIXES COULD BREAK.
 *
 * Found by reading the three commits back against the code they touched, rather than by waiting
 * for a render to show them. Each one is a consequence of a repair, not of the original defect.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { createSourcingCache, withRenderSourcingCacheScope } from "./videoPipeline";
import { recordClipAdopt, bindLineageLedger, bindContentKeyResolver } from "./clipAdoptAudit";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("one asset adopted for several beats keeps naming the beat that opened it", () => {
  /**
   * The regression this closes, created by giving the untraced record a content key.
   *
   * With `contentKey: ""` the record was never registered in `byContentKey`, so every adoption of
   * the same curated asset opened its own unfindable record. With a real key the second adoption
   * FINDS the first — and `record.sceneIndex = sceneIndex` then moved it to the later beat.
   * Render 573 selected archive asset 57364 for four beats (s0b0, s1b0, s1b4, s2b0), so
   * `[SourceLineage] scene= beat=` would have described whichever came last.
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

  it("the first beat wins and the later ones do not move it", () => {
    const { audit, cache } = setup();
    recordClipAdopt(audit, 0, 0, "first beat", "/tmp/scene_0_b0_curated_a57364.mp4", "archive");
    recordClipAdopt(audit, 2, 0, "later beat", "/tmp/scene_2_b0_curated_a57364.mp4", "archive");

    const record = cache.lineage.resolve("/tmp/scene_0_b0_curated_a57364.mp4", "curated:asset:57364")!;
    expect(record.sceneIndex).toBe(0);
    expect(record.beatIndex).toBe(0);
  });

  it("the sharing is counted rather than hidden", () => {
    const { audit, cache } = setup();
    for (const [s, b] of [[0, 0], [1, 0], [1, 4], [2, 0]] as const) {
      recordClipAdopt(audit, s, b, "beat", `/tmp/scene_${s}_b${b}_curated_a57364.mp4`, "archive");
    }
    const record = cache.lineage.resolve("/tmp/scene_0_b0_curated_a57364.mp4", "curated:asset:57364")!;
    /** Three further beats after the one that opened it. */
    expect(record.reusedOnBeats).toBe(3);
  });

  it("a single adoption writes no counter — a number nobody wrote is not a measurement", () => {
    const { audit, cache } = setup();
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "archive");
    expect(
      cache.lineage.resolve("/tmp/scene_1_b6_curated_a57392.mp4", "curated:asset:57392")!.reusedOnBeats
    ).toBeUndefined();
  });

  it("re-adopting the SAME beat is not counted as reuse", () => {
    const { audit, cache } = setup();
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "archive");
    recordClipAdopt(audit, 1, 6, "beat", "/tmp/scene_1_b6_curated_a57392.mp4", "rescue_archive");
    expect(
      cache.lineage.resolve("/tmp/scene_1_b6_curated_a57392.mp4", "curated:asset:57392")!.reusedOnBeats
    ).toBeUndefined();
  });

  it("a record opened at -1/-1 by a downloader is still placed by the first adoption", () => {
    /** `tagPathWithProviderAsset` uses `meta?.sceneIndex ?? -1` when the fetcher knew no beat. */
    const { audit, cache } = setup();
    cache.lineage.createLineage({
      sceneIndex: -1, beatIndex: -1,
      candidateId: "curated:asset:57500", contentKey: "curated:asset:57500",
      localPath: "/tmp/elsewhere_a57500.mp4", mediaType: "video", route: "primary",
    });
    recordClipAdopt(audit, 2, 3, "beat", "/tmp/scene_2_b3_curated_a57500.mp4", "archive");
    const record = cache.lineage.resolve("/tmp/scene_2_b3_curated_a57500.mp4", "curated:asset:57500")!;
    expect(record.sceneIndex).toBe(2);
    expect(record.beatIndex).toBe(3);
    expect(record.reusedOnBeats).toBeUndefined();
  });
});

describe("the archive segment fetch uses a container that holds what the filter accepts", () => {
  it("matroska, not mp4 — the item filter admits Ogg Video and WebM", () => {
    /**
     * Measured with the ffmpeg on this machine, not assumed:
     *
     *     t.ogv  -> mp4 FAIL   t.ogv  -> matroska OK
     *     t.webm -> mp4 FAIL   t.webm -> matroska OK
     *     t.mp4  -> mp4 OK     t.mp4  -> matroska OK
     *
     * `-f mp4` would have fixed h.264 and left the other two failing for the same reason as
     * before, with only a better message.
     */
    const at = PIPE.indexOf("async function fetchArchiveSegmentViaFfmpeg");
    const body = PIPE.slice(at, at + 3_500);
    expect(body).toContain('"-f", "matroska",');
    expect(body).not.toContain('"-f", "mp4",');
    /** An MP4-only flag has no business on a matroska mux. */
    expect(body).not.toContain('"-movflags"');
  });

  it("the accepted format list is the one this container has to cover", () => {
    expect(PIPE).toContain("['h.264', 'MPEG4', 'MP4', 'Ogg Video', 'WebM'].includes(f.format)");
  });
});

describe("an empty query falls through instead of being sent", () => {
  it("the SerpAPI still route uses || so \"\" steps aside", () => {
    /**
     * `simplifyStockSearchWord` now returns "" where it returned the literal "documentary".
     * `??` only steps aside for null and undefined, so an empty entry would have gone out as an
     * empty search.
     */
    const at = PIPE.indexOf("buildPersonSerpQuery(personName, sceneIndex, beat.index, beat.text)");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 300);
    expect(region).toContain("unique[qi] || beat.searchQuery || beat.text.slice(0, 60)");
    expect(region).not.toContain("unique[qi] ?? beat.searchQuery");
  });

  it("the Openverse route uses it too", () => {
    expect(PIPE).toContain('unique[0] || beat.searchQuery || ""');
    expect(PIPE).not.toContain("(unique[0] ?? beat.searchQuery)");
  });
});

describe("a beat with no searchable subject says so before the ladder moves on", () => {
  it("the empty-query exit is named, not silent", () => {
    /**
     * This state was effectively unreachable while the builder always produced something. It is
     * reachable now, and `return false` on its own would skip the stock ladder for that beat with
     * nothing in the log to explain it.
     */
    const at = PIPE.indexOf("if (queries.length === 0) {");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 1_400);
    expect(region).toContain("no stock query — the beat names");
    expect(region).toContain("stock ladder skipped for this beat");
    expect(region).toContain("return false;");
  });

  it("the ladder's contract is unchanged — false still means this route found nothing", () => {
    const at = PIPE.indexOf("if (queries.length === 0) {");
    const region = PIPE.slice(at, at + 1_400);
    /** No throw, no early return of a fabricated clip. */
    expect(region).not.toContain("throw ");
  });
});

describe("the note about resolving by content key says what is actually true", () => {
  const ADOPT = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");

  it("it no longer claims production was missing records", () => {
    /**
     * `setContentKeyResolver(clipContentKey)` is bound at cache creation and
     * `bindContentKeyResolver(audit, clipContentKey)` at dedup creation — the same function — so
     * `resolve()` already derived the identical key. Passing it explicitly is right for callers
     * that bind nothing, and it fixed nothing in a render.
     */
    const at = ADOPT.indexOf("const record = ledger.resolve(clipPath, adoptedContentKey");
    expect(at).toBeGreaterThan(-1);
    const note = ADOPT.slice(at - 1_400, at);
    expect(note).toContain("It had not; the resolver was already bound.");
    expect(note).not.toContain("A record that exists under a canonical key was therefore missed");
  });

  it("both resolvers really are the same function", () => {
    expect(PIPE).toContain("cache.lineage.setContentKeyResolver(clipContentKey);");
    expect(PIPE).toContain("bindContentKeyResolver(state.clipAdoptAudit, clipContentKey);");
  });
});
