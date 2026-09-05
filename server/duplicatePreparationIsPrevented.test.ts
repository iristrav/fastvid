/**
 * RONDE 88A P5 — THE SAME ARCHIVE ROW, PREPARED THIRTY-EIGHT TIMES.
 *
 * ── What render 568 measured ─────────────────────────────────────────────────────────────────
 *
 *     09:46:46  #2 score=926 id=57364
 *     09:46:54  Scene 1 beat 6:   curated archive #57364 (score 505)
 *     09:46:54  [PushTrace] scene=1 beat=6 asset=ww2:57364 accepted=false
 *                                          reason=duplicate_clip_once_per_video
 *     09:46:55  #2 score=926 id=57364
 *     09:46:58  Scene 1 beat 106: curated archive #57364 (score 509)
 *     09:47:02  Scene 1 beat 206: …
 *
 * `[PushTrace]` recorded 42 refusals for that scene, 38 of them the single row `ww2:57364`, under
 * 18 distinct filenames. Every one of those was a search, a rank, a download, an ffmpeg transcode
 * and a file write, paid for out of the scene's own wall-clock budget — and then thrown away by a
 * check that already knew the answer before the download started.
 *
 * ── The two halves of one rule ───────────────────────────────────────────────────────────────
 *
 * A curated archive row has two registries in `VisualDedupState`, and they answer different
 * questions:
 *
 *   usedContentKeys ......... the last line of defence. Every `pushSceneClip` variant refuses on
 *                             it, which is why the repeat never reached the film.
 *   usedCuratedAssetIds ..... what the SEARCH reads — `searchCuratedCandidatesForBeat`'s pool
 *   usedCuratedStorageUrls    filter, `listCuratedArchiveCandidates`' excludeIds, the eligibility
 *                             loop in `fetchCuratedArchiveBeatClip`, `archiveAssetPreflight`.
 *
 * Write the first and not the second and the render still cannot use the footage twice — it just
 * cannot stop buying it. Two sites were doing exactly that, and this file pins both.
 *
 * Nothing here changes which footage a render may use. Both fixes hand the SEARCH a decision the
 * PUSH was already making one step later.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  searchCuratedCandidatesForBeat,
  markCuratedAssetUsed,
  type CuratedCandidatePick,
  type CuratedBeatContext,
  type CuratedSceneContext,
} from "./curatedMediaSourcing";
import type { MediaArchiveAsset } from "../drizzle/schema";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════ the read side: a marked asset is never offered again ═══════════════ */

describe("the curated search honours the render's own used-set", () => {
  const origClip = process.env.ENABLE_CLIP_EMBEDDING_INDEX;
  const origSemantic = process.env.ENABLE_SEMANTIC_VISUAL_MATCH;

  beforeEach(() => {
    process.env.ENABLE_CLIP_EMBEDDING_INDEX = "false";
    process.env.ENABLE_SEMANTIC_VISUAL_MATCH = "false";
  });
  afterEach(() => {
    if (origClip === undefined) delete process.env.ENABLE_CLIP_EMBEDDING_INDEX;
    else process.env.ENABLE_CLIP_EMBEDDING_INDEX = origClip;
    if (origSemantic === undefined) delete process.env.ENABLE_SEMANTIC_VISUAL_MATCH;
    else process.env.ENABLE_SEMANTIC_VISUAL_MATCH = origSemantic;
  });

  const beat: CuratedBeatContext = {
    index: 6,
    text: "Soldiers and tanks advanced through the ruined city of berlin",
    keywords: ["soldiers", "tanks", "berlin"],
    searchQuery: "soldiers tanks berlin",
  };
  const scene: CuratedSceneContext = { text: beat.text, pexelsQuery: beat.searchQuery };

  const TAGS = ["soldiers", "tanks", "berlin"];
  const asset = (id: number): MediaArchiveAsset =>
    ({
      id,
      title: `Berlin footage ${id}`,
      tags: TAGS,
      mediaType: "video",
      storageUrl: `https://example.com/asset-${id}.mp4`,
      mixKind: "video",
    }) as unknown as MediaArchiveAsset;

  /** 57364 is render 568's own repeat offender; 57378 the other one the trace named. */
  const pool = (): CuratedCandidatePick[] => [
    { asset: asset(57364), archiveName: "ww2", score: 0, archiveNicheTags: [] },
    { asset: asset(57378), archiveName: "ww2", score: 0, archiveNicheTags: [] },
  ];

  const search = (usedIds: Set<number>, usedUrls = new Set<string>()) =>
    searchCuratedCandidatesForBeat(beat, scene, usedIds, usedUrls, "Test Documentary", {
      candidatePool: pool(),
      skipSemantic: true,
    });

  /**
   * The control. Without it every assertion below would also pass on a search that returns
   * nothing at all, which is the shape of a test that proves the opposite of what it claims.
   */
  it("offers the asset when the render has not used it", async () => {
    const out = await search(new Set());
    expect(out.map((p) => p.asset.id)).toContain(57364);
  });

  it("does not offer an asset id the render already used", async () => {
    const out = await search(new Set([57364]));
    expect(out.map((p) => p.asset.id)).not.toContain(57364);
  });

  it("still offers the rest of the pool — an exclusion is not a starvation", async () => {
    const out = await search(new Set([57364]));
    expect(out.map((p) => p.asset.id)).toContain(57378);
  });

  it("does not offer a second row that points at the same storage file", async () => {
    const out = await search(new Set(), new Set(["https://example.com/asset-57364.mp4"]));
    expect(out.map((p) => p.asset.id)).not.toContain(57364);
  });

  /**
   * The two halves have to fit: `markCuratedAssetUsed` reads the id out of the prepared clip's
   * filename, and the search filters on that same id. This is the whole mechanism, end to end,
   * with no test double in between.
   */
  it("what markCuratedAssetUsed writes is what the search excludes", async () => {
    const usedIds = new Set<number>();
    const usedUrls = new Set<string>();
    markCuratedAssetUsed(
      "/w/s1b6_curated_a57364.mp4",
      usedIds,
      usedUrls,
      "https://example.com/asset-57364.mp4"
    );
    expect(usedIds.has(57364)).toBe(true);
    const out = await search(usedIds, usedUrls);
    expect(out.map((p) => p.asset.id)).not.toContain(57364);
  });

  /**
   * `_curated_a<id>` is the only marker the id survives on. `padShortClipWithNext` and the text
   * overlay both republish the file under a name that carries neither — which is precisely why
   * the marking has to happen on the prepared path, not on whatever compose is holding later.
   */
  it("a derived filename carries no asset id, so it can mark nothing", () => {
    const usedIds = new Set<number>();
    markCuratedAssetUsed("/w/pad_combined_s1b6_1770000000000.mp4", usedIds, new Set());
    expect(usedIds.size).toBe(0);
  });
});

/* ═══════════════ the write side: the funnel's acceptance point ═══════════════ */

describe("adoptClip registers a curated pick in both registries", () => {
  const acceptanceBlock = () => {
    const at = PIPE.indexOf("      dedup.usedPaths.add(p);\n      dedup.usedContentKeys.add(contentKey);");
    expect(at, "adoptClip's single acceptance point is gone").toBeGreaterThan(-1);
    return PIPE.slice(at, at + 2600);
  };

  it("writes the curated asset id beside the content key", () => {
    const b = acceptanceBlock();
    expect(b).toContain("markCuratedAssetUsed(p, dedup.usedCuratedAssetIds, dedup.usedCuratedStorageUrls,");
  });

  /** The storage url comes from the render's own asset rows, never from the filename. */
  it("takes the storage url from the render's archive rows", () => {
    expect(acceptanceBlock()).toContain("curatedStorageUrlForClip(p, dedup)");
  });

  /** Both writes are one decision; a marking that could be skipped is the bug coming back. */
  it("marks unconditionally, in the same block as the content key", () => {
    const b = acceptanceBlock();
    const key = b.indexOf("dedup.usedContentKeys.add(contentKey);");
    const mark = b.indexOf("markCuratedAssetUsed(p,");
    expect(mark).toBeGreaterThan(key);
    expect(b.slice(key, mark)).not.toMatch(/\b(if|return|continue)\b/);
  });

  /**
   * The funnel really can adopt a curated row — otherwise this whole block would be dead code
   * defended by a dead test.
   */
  it("the funnel's own download branch produces curated clips", () => {
    const at = PIPE.indexOf("if (candidate.archivePick) {");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 2600)).toContain("prepareCuratedArchiveClip(");
  });
});

/* ═══════════════ the ladder: never buy what this beat's push will refuse ═══════════════ */

/** Every `generateGuaranteedBeatClip(...)` call in the pipeline, with its argument list. */
function guaranteedCallSites(): Array<{ index: number; call: string; after: string }> {
  const out: Array<{ index: number; call: string; after: string }> = [];
  const NEEDLE = "generateGuaranteedBeatClip(";
  for (let at = PIPE.indexOf(NEEDLE); at !== -1; at = PIPE.indexOf(NEEDLE, at + 1)) {
    if (PIPE.slice(Math.max(0, at - 40), at).includes("function ")) continue; // the declaration
    let depth = 0;
    let end = at + NEEDLE.length - 1;
    for (; end < PIPE.length; end++) {
      if (PIPE[end] === "(") depth++;
      else if (PIPE[end] === ")" && --depth === 0) break;
    }
    out.push({ index: at, call: PIPE.slice(at, end + 1), after: PIPE.slice(end + 1, end + 501) });
  }
  return out;
}

/**
 * The ladder's whole body, bounded by the next top-level declaration rather than a character
 * count — a window measured in characters silently shrinks past the line it is meant to watch the
 * moment a comment is added above it, and then passes for the wrong reason.
 */
function ladderBody(): string {
  const at = PIPE.indexOf("async function generateGuaranteedBeatClipInner(");
  expect(at, "the guaranteed ladder is gone").toBeGreaterThan(-1);
  const end = PIPE.indexOf("\nasync function ", at + 1);
  expect(end).toBeGreaterThan(at);
  return PIPE.slice(at, end);
}

describe("the guaranteed ladder does not prepare a clip the push will refuse", () => {
  it("finds every call site", () => {
    expect(guaranteedCallSites().length).toBeGreaterThanOrEqual(9);
  });

  /**
   * THE INVARIANT, AND WHY IT IS SCOPED THE WAY IT IS.
   *
   * A ladder clip that goes to `pushClip` meets a `pushSceneClip` variant, and every one of those
   * refuses on render-wide `usedContentKeys` before doing anything else. So for those call sites
   * the render-wide rule is applied to the clip either way — the only question is whether it is
   * applied before or after the download. Passing the render-wide curated sets in moves it before.
   *
   * A ladder clip that goes anywhere else (compose's `validClips`, a rescue batch's own array) is
   * governed by RONDE 34 point 8, which keeps rescue batches on batch-scoped sets on purpose: a
   * render-wide exclusion there starves the rescue into a colour card. Those sites are deliberately
   * not covered, and this invariant must never quietly grow to include them.
   */
  it("a call whose result is pushed passes the render-wide curated sets", () => {
    const pushed = guaranteedCallSites().filter((s) => s.after.includes("pushClip("));
    expect(pushed.length, "no ladder call reaches a push any more").toBeGreaterThanOrEqual(3);
    for (const site of pushed) {
      expect(site.call, `a pushed ladder call at offset ${site.index} still excludes nothing`)
        .toContain("dedup.usedCuratedAssetIds");
      expect(site.call, `a pushed ladder call at offset ${site.index} ignores shared storage rows`)
        .toContain("dedup.usedCuratedStorageUrls");
      expect(site.call).not.toMatch(/undefined,\s*undefined,\s*(tierOut|guaranteedTierOut)/);
    }
  });

  /** The compose-side sites keep RONDE 34's batch scope — this is what "not covered" must mean. */
  it("leaves the compose rescues on their own batch-scoped sets", () => {
    const unpushed = guaranteedCallSites().filter((s) => !s.after.includes("pushClip("));
    expect(unpushed.length).toBeGreaterThan(0);
    for (const site of unpushed) {
      expect(site.call, "a compose rescue was quietly given the render-wide set")
        .not.toContain("dedup.usedCuratedAssetIds");
    }
  });

  /**
   * The ladder marks what it picks, which is what makes a shared set accumulate across the four
   * attempts of one rescue loop. Without this line the sets are read-only and the fix above buys
   * nothing after the first attempt.
   */
  it("the ladder marks its pick in the sets it was handed", () => {
    expect(ladderBody()).toContain(
      "markCuratedAssetUsed(topicalClip, excludeAssetIds, excludeStorageUrls, pickedOut.storageUrl)"
    );
  });

  /**
   * And it still defaults to fresh sets for a caller that passes none — which is why the fix had
   * to be at the call sites and could not be a default inside the ladder: the ladder cannot tell
   * which acceptance test its caller is about to apply.
   */
  it("still defaults to fresh sets when a caller supplies none", () => {
    const body = ladderBody();
    expect(body).toContain("const excludeAssetIds = usedAssetIds ?? new Set<number>();");
    expect(body).toContain("const excludeStorageUrls = usedStorageUrls ?? new Set<string>();");
  });
});
