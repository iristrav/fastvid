import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  admitToShortlist,
  createBeatShortlistState,
  maxShortlistPerBeat,
  maxShortlistPerBeatPerSource,
} from "./beatShortlist";
import { MAX_JUDGEMENTS_PER_BEAT } from "./beatImageRelevanceGate";

/**
 * WHY NOT ONE YOUTUBE CLIP REACHED THE FILM.
 *
 * Render 578: 2479 YouTube candidates found, 88 downloaded, and the delivered film came out as
 * `clips=13 [ww2=13]` — thirteen clips, every one from the operator's own curated archive.
 *
 *     s1b3 shortlisted=8/8 visionAsked=7 approved=0 notAsked=48 cappedOut=37
 *     s1b0 shortlisted=8/8 visionAsked=4 approved=0 notAsked=48 cappedOut=31
 *
 * `admitToShortlist` was first-come, first-served. The curated archive is asked first for every
 * beat on every topic, so it filled all eight slots before YouTube's candidates were offered.
 * This file's own note had already asked the question — "whether the eight the editor saw were
 * the best eight or the first eight" — and the answer was the first eight.
 */

const state = () => createBeatShortlistState();

describe("one source cannot fill a beat's shortlist", () => {
  it("THE FIRST SOURCE NO LONGER TAKES EVERY SLOT", () => {
    const s = state();
    const cap = maxShortlistPerBeat();
    const admitted: boolean[] = [];
    for (let i = 0; i < cap; i++) {
      admitted.push(admitToShortlist(s, 0, 0, `archive:${i}`, cap, "archive").admitted);
    }
    const taken = admitted.filter(Boolean).length;
    expect(taken, "the archive gets its full judgement budget").toBe(maxShortlistPerBeatPerSource());
    expect(taken, "but not the whole list").toBeLessThan(cap);
  });

  it("and the source that arrives late still gets in", () => {
    const s = state();
    const cap = maxShortlistPerBeat();
    for (let i = 0; i < cap; i++) admitToShortlist(s, 0, 0, `archive:${i}`, cap, "archive");
    const late = admitToShortlist(s, 0, 0, "youtube_cc:abc", cap, "youtube_cc");
    expect(late.admitted, "YouTube arrives to a list that still has room").toBe(true);
  });

  it("the refusal says WHICH kind of full it was", () => {
    /**
     * `SHORTLIST_FULL` and `SHORTLIST_SOURCE_SHARE` are opposite findings — the beat is out of
     * room, or one source is out of room and the beat is not. Render 578 could not tell them
     * apart, and the difference is the whole diagnosis.
     */
    const s = state();
    const cap = maxShortlistPerBeat();
    for (let i = 0; i < cap; i++) admitToShortlist(s, 0, 0, `archive:${i}`, cap, "archive");
    const refused = admitToShortlist(s, 0, 0, "archive:more", cap, "archive");
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe("SHORTLIST_SOURCE_SHARE");
  });

  it("A BEAT IS STILL ALLOWED TO FILL UP", () => {
    // The bound itself is untouched: enough sources still exhaust the list, and say so.
    const s = state();
    const cap = maxShortlistPerBeat();
    for (let i = 0; i < cap; i++) {
      admitToShortlist(s, 0, 0, `src${i}:a`, cap, `source${i}`);
    }
    const refused = admitToShortlist(s, 0, 0, "srcN:a", cap, "sourceN");
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe("SHORTLIST_FULL");
  });

  it("NO SLOT IS WASTED when only one source has anything", () => {
    /**
     * The RONDE 170 lesson this is careful not to repeat. The editor judges at most
     * MAX_JUDGEMENTS_PER_BEAT candidates; the per-source cap is exactly that number, so a beat
     * served by one source alone still reaches the full judgement budget.
     */
    expect(maxShortlistPerBeatPerSource()).toBe(MAX_JUDGEMENTS_PER_BEAT);
    expect(maxShortlistPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT * 2);
  });

  it("a caller that names no source is unaffected", () => {
    // Optional by design: an unnamed source is left outside the rule, never guessed at.
    const s = state();
    const cap = maxShortlistPerBeat();
    let taken = 0;
    for (let i = 0; i < cap; i++) {
      if (admitToShortlist(s, 0, 0, `x:${i}`, cap).admitted) taken++;
    }
    expect(taken).toBe(cap);
  });

  it("a refusal never consumes a source's share", () => {
    const s = state();
    const cap = maxShortlistPerBeat();
    const per = maxShortlistPerBeatPerSource();
    for (let i = 0; i < per; i++) admitToShortlist(s, 0, 0, `a:${i}`, cap, "archive");
    for (let i = 0; i < 5; i++) admitToShortlist(s, 0, 0, `a:extra${i}`, cap, "archive");
    /** The archive is still at its share, not beyond it, and the rest is still open. */
    expect(admitToShortlist(s, 0, 0, "yt:1", cap, "youtube_cc").admitted).toBe(true);
  });

  it("re-offering the same asset is still not a second slot", () => {
    const s = state();
    const again = () => admitToShortlist(s, 0, 0, "curated:asset:1", maxShortlistPerBeat(), "archive");
    expect(again().admitted).toBe(true);
    const second = again();
    expect(second.admitted).toBe(true);
    expect(second.alreadyOnList).toBe(true);
  });

  it("beats are counted separately", () => {
    const s = state();
    const cap = maxShortlistPerBeat();
    const per = maxShortlistPerBeatPerSource();
    for (let i = 0; i < per; i++) admitToShortlist(s, 0, 0, `a:${i}`, cap, "archive");
    expect(
      admitToShortlist(s, 0, 1, "a:next-beat", cap, "archive").admitted,
      "a share is per beat, not per render"
    ).toBe(true);
  });
});

describe("the render says it happened", () => {
  const SRC = readFileSync(join(__dirname, "beatShortlist.ts"), "utf8");

  it("the funnel line reports source-share refusals apart from cap refusals", () => {
    expect(SRC).toContain("sourceShareOut=${f.refusedForSourceShare}");
    expect(SRC).toContain("cappedOut=${f.refusedForCap}");
  });

  it("both admission sites pass the source, read from the ledger", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const calls = PIPE.match(/admitToShortlist\(/g) ?? [];
    expect(calls.length, "two production call sites").toBe(2);
    expect(PIPE).toContain("dedup.sourcingCache?.lineage?.providerFor(p, contentKey)");
    expect(PIPE).toContain("dedup.sourcingCache?.lineage?.providerFor(clipPath, shortlistKey)");
    expect(PIPE, "never from a filename").not.toContain("admitToShortlist(dedup.beatShortlist, sceneIndex, beatIndex, contentKey, undefined, path.basename");
  });
});
