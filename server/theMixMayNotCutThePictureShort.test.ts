/**
 * THE MIX MAY NOT CUT THE PICTURE SHORT — RONDE 603.
 *
 * Two findings, one round, and they are the same shape as the two before them: an answer that
 * exists on one side of the pipeline and never reaches the side that decides.
 *
 * ── I. `-shortest` binds both ways, and only one was written down ───────────────────────────
 *
 *     [RenderJob] job=16 video=597 status=failed
 *       duration 47.73s differs from the timeline's 62.01s by 14.27s
 *
 * Render 597 skipped no clip — no `could not be recovered`, no `segment was empty`, no
 * `encode failed` — and it planned a VIDEO clip at [47.093s → 53.933s], past where the file ends.
 * The picture existed. The file does not contain it.
 *
 * The audio mux runs `-map 0:v -c:v copy … -shortest`, and its comment accounts for one direction:
 * a music bed may not make the file longer than the edit. `-shortest` binds BOTH. A mix that ends
 * before the picture truncates the picture.
 *
 * THIS ROUND DOES NOT FIX THAT. It measures it. If the mix really is short, the repair is a
 * decision about what should happen — pad the audio, drop the flag, bound the mux explicitly — and
 * each is a different film. Choosing before knowing is how a round goes into the wrong half of the
 * pipeline.
 *
 * ── II. The retrieval funnel never asked YouTube or the archive ─────────────────────────────
 *
 *     [ProviderSkipped] scene=0 archive=not_wired nara=no_api_key
 *                       youtube_cc=no_search_function_supplied
 *
 * `buildSceneCandidatePool` refuses to ask a provider it was not handed a search for — deliberately,
 * so "nobody supplied one" and "it found nothing" stay different facts. It has THREE callers. The
 * two in videoPipeline supply YouTube and the archive. `retrievalFunnel.ts` is the third and
 * supplied neither, and `ENABLE_RETRIEVAL_FUNNEL` defaults on — so on the route production takes,
 * neither source was ever in the pool the ranking runs over.
 *
 * No budget could have fixed that. A source that is not in the pool cannot win, cannot lose and
 * cannot be ranked. RONDE 169 built YouTube as a pool source, 175 put it in the task list, 177
 * wired the search; this route went around all three.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  audioMixExtentSec,
  shortestTruncatesPicture,
  formatMuxSpan,
} from "./timelineRenderer";
import type { MixInput } from "./timelineFilters";

const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const POOL = readFileSync(join(__dirname, "scenePool.ts"), "utf8");
const RENDERER = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");

/** Render 597's own numbers, so the measurement is checked against the render that needed it. */
const R597 = { pictureSec: 62.01, deliveredSec: 47.73 };

const track = (kind: MixInput["kind"], startSec: number, durationSec: number): MixInput =>
  ({ index: 1, kind, startSec, gain: 1, durationSec }) as MixInput;

/* ═══════════ §1 — the span `-shortest` actually compares ═══════════ */

describe("§1 — how far the audio mix reaches", () => {
  it("is the furthest input's end, not the longest input's length", () => {
    /**
     * A voice track that starts at 40s and runs 8s reaches 48s, however short it is. Reading the
     * longest DURATION instead would call this mix 8 seconds long and miss the whole question.
     */
    expect(
      audioMixExtentSec([track("VOICE", 0, 12), track("MUSIC", 40, 8), track("SFX", 5, 2)])
    ).toBe(48);
  });

  it("an empty mix reaches nowhere", () => {
    expect(audioMixExtentSec([])).toBe(0);
  });

  it("a negative length cannot pull the extent backwards", () => {
    expect(audioMixExtentSec([track("VOICE", 10, -5)])).toBe(10);
  });
});

/* ═══════════ §2 — when the flag binds on the picture ═══════════ */

describe("§2 — shortestTruncatesPicture", () => {
  it("RENDER 597: a mix ending at 47.73s under a 62.01s picture — YES", () => {
    expect(shortestTruncatesPicture(R597.pictureSec, R597.deliveredSec, true)).toBe(true);
  });

  it("a mix that reaches the picture does not bind", () => {
    expect(shortestTruncatesPicture(62.01, 62.0, true)).toBe(false);
  });

  it("half a second of slack, because a mix ending a frame early is ordinary", () => {
    expect(shortestTruncatesPicture(60, 59.6, true)).toBe(false);
    expect(shortestTruncatesPicture(60, 59.4, true)).toBe(true);
  });

  it("no mux means no -shortest, so nothing binds", () => {
    /** The `!audioGraph` branch copies the file; the flag is never passed. */
    expect(shortestTruncatesPicture(62.01, 10, false)).toBe(false);
  });

  it("an unmeasurable picture is not evidence of anything", () => {
    expect(shortestTruncatesPicture(null, 10, true)).toBe(false);
  });

  it("a mix with no tracks is not a short mix — there is nothing to compare", () => {
    expect(shortestTruncatesPicture(62.01, 0, true)).toBe(false);
  });
});

/* ═══════════ §3 — the line render 597 needed and did not have ═══════════ */

describe("§3 — the measurement reaches the log", () => {
  it("names both spans, the timeline, and the verdict", () => {
    const line = formatMuxSpan({
      pictureSec: R597.pictureSec,
      audioExtentSec: R597.deliveredSec,
      timelineSec: R597.pictureSec,
      tracks: 3,
      muxed: true,
    });
    expect(line).toContain("[MuxSpan]");
    expect(line).toContain("picture=62.01s");
    expect(line).toContain("audioMix=47.73s");
    expect(line).toContain("shortestWouldTruncatePicture=YES");
    expect(line, "the gap is the number an operator acts on").toContain("14.28s before the picture");
  });

  it("and says no, plainly, when the mix reaches the end", () => {
    const line = formatMuxSpan({
      pictureSec: 62.01,
      audioExtentSec: 62.0,
      timelineSec: 62.01,
      tracks: 2,
      muxed: true,
    });
    expect(line).toContain("shortestWouldTruncatePicture=no");
    expect(line).not.toContain("before the picture");
  });

  it("an unprobeable picture says so rather than printing a number it does not have", () => {
    expect(
      formatMuxSpan({ pictureSec: null, audioExtentSec: 10, timelineSec: 12, tracks: 1, muxed: true })
    ).toContain("picture=unknowns");
  });

  it("THIS ROUND MEASURES — it does not change what is rendered", () => {
    /**
     * The flag stays. Removing it here would trade one silent truncation for another: a music bed
     * outlasting the edit, which is what it was added to stop.
     */
    expect(RENDERER, "the guard was removed before it was understood").toContain('"-shortest",');
    const at = RENDERER.indexOf("export function formatMuxSpan(");
    const body = RENDERER.slice(at, RENDERER.indexOf("\n}", RENDERER.indexOf("return (", at)));
    expect(body, "a measurement that alters the render is not a measurement").not.toContain("args.push");
  });
});

/* ═══════════ §4 — the two providers the funnel never asked ═══════════ */

describe("§4 — the funnel asks YouTube and the archive", () => {
  it("THE DEFECT, NAMED: the funnel's pool call used to carry neither", () => {
    /**
     * Guarded by the shape rather than by absence: the call must now name both, and both must come
     * from the request rather than from a client this module would have to hold.
     */
    const at = FUNNEL.indexOf("buildSceneCandidatePool({");
    expect(at, "the funnel no longer builds a pool").toBeGreaterThan(-1);
    const call = FUNNEL.slice(at, FUNNEL.indexOf("}).then(r => r.candidates)", at));
    expect(call).toContain("youtubeSearch: req.youtubeSearch");
    expect(call).toContain("archiveSearch: req.archiveSearch");
  });

  it("the funnel holds no key and opens no client — they are injected", () => {
    const at = FUNNEL.indexOf("export async function buildRetrievalFunnel(");
    const body = FUNNEL.slice(at, at + 4000);
    expect(body, "the funnel grew its own YouTube client").not.toContain("searchYoutubeVideoCandidates(");
    expect(body, "the funnel grew its own archive selection").not.toContain("listCuratedArchiveCandidates(");
  });

  it("every production caller of the funnel supplies YouTube", () => {
    /**
     * Two call sites: the inline per-scene funnel and the prefetch that runs during TTS. Both must
     * supply it, or the route that happens to run decides whether YouTube exists.
     */
    const sites = [...PIPELINE.matchAll(/buildRetrievalFunnel\(\{/g)].map((m) => m.index ?? 0);
    expect(sites.length, "a call site appeared or vanished").toBe(2);
    for (const at of sites) {
      const call = PIPELINE.slice(at, at + 2500);
      expect(call, `funnel call at ${at} does not supply YouTube`).toContain(
        "youtubeSearch: scenePoolYoutubeSearch("
      );
    }
  });

  it("the inline funnel supplies the archive too; the prefetch cannot, and says why", () => {
    /**
     * `scenePoolArchiveSearch` reads the render's used-asset state, and the prefetch runs before
     * that state exists — the sibling pool prefetch has the same pair for the same reason. The
     * absence is a stated limit, not an oversight, and this pins the stated reason.
     */
    const sites = [...PIPELINE.matchAll(/buildRetrievalFunnel\(\{/g)].map((m) => m.index ?? 0);
    const withArchive = sites.filter((at) =>
      PIPELINE.slice(at, at + 2500).includes("archiveSearch: scenePoolArchiveSearch(")
    );
    expect(withArchive.length, "exactly one funnel call site can reach the archive").toBe(1);
    const prefetch = sites.find((at) => !withArchive.includes(at))!;
    expect(PIPELINE.slice(prefetch, prefetch + 2500)).toContain("createVisualDedupState");
  });

  it("the pool's own distinction is untouched: not supplied is not found-nothing", () => {
    /**
     * RONDE 177's rule, and the reason this defect was visible at all. Collapsing the two would
     * have hidden it completely.
     */
    expect(POOL).toContain("if (req.youtubeSearch) {");
    expect(POOL).toContain('skipped.youtube_cc = "no_search_function_supplied";');
  });
});
