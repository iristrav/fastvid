/**
 * RONDE 247 — A PLACE HANDED BACK TO THE BEAT BUT NOT TO THE SOURCE.
 *
 * Render 584 blocked its own export on `Scene 2: 4 zinnen maar 0 voice/script-matchende clips`,
 * having already downloaded thirty-five candidates for that scene — a successful YouTube download
 * among them. The picture editor was shown three of them. Two of the four sentences were shown
 * nothing at all, and their funnel lines said why in a shape that reads as a contradiction:
 *
 *   s2b2 retrieved=4 shortlisted=0/8 visionAsked=0 slotsReturned=8 SHORTLIST_EMPTY
 *   s2b3 retrieved=3 shortlisted=0/8 visionAsked=0 slotsReturned=6 sourceShareOut=4
 *
 * Every place on the beat free, and candidates refused because "one source is out of room while
 * the beat is not". Both statements were true. `releaseShortlistSlot` (RONDE 230-A) decremented
 * `shortlisted` and left `bySource` standing, because the per-source cap was added afterwards and
 * the two were never introduced. So a source could take its four places, have all four returned
 * unjudged, and be locked out of that sentence for the rest of the render.
 *
 * Render-wide that render: 59 places returned, 21 refusals for source share, 84 candidates never
 * put to the editor at all.
 */
import { describe, expect, it } from "vitest";
import {
  admitToShortlist,
  createBeatShortlistState,
  maxShortlistPerBeat,
  maxShortlistPerBeatPerSource,
  noteVisionAsked,
  releaseShortlistSlot,
} from "./beatShortlist";

const PER_SOURCE = maxShortlistPerBeatPerSource();
const CAP = maxShortlistPerBeat();

/** Fill one source's share on a beat, then hand every one of those places back unjudged. */
const takeAndReturn = (state: ReturnType<typeof createBeatShortlistState>, source: string) => {
  const keys = Array.from({ length: PER_SOURCE }, (_, i) => `${source}-${i}`);
  for (const k of keys) expect(admitToShortlist(state, 2, 3, k, CAP, source).admitted).toBe(true);
  for (const k of keys) expect(releaseShortlistSlot(state, 2, 3, k).released).toBe(true);
  return keys;
};

describe("1. a returned place is returned to both accounts", () => {
  it("the source may use the share it handed back", () => {
    const state = createBeatShortlistState();
    takeAndReturn(state, "youtube");

    const after = admitToShortlist(state, 2, 3, "youtube-next", CAP, "youtube");
    expect(
      after.admitted,
      "every place on the beat is free — refusing here is render 584's shortlisted=0/8 sourceShareOut=4"
    ).toBe(true);
  });

  /**
   * More than one source, because render 584's beats had several and every one of them was locked
   * out at once. Two fills the beat's cap exactly and spends its release budget exactly — a third
   * would be refused by RONDE 97's bound, which is a different and correct refusal.
   */
  it("and the beat does not report itself empty while refusing everyone", () => {
    const state = createBeatShortlistState();
    const sources = ["youtube", "archive"];
    expect(sources.length * PER_SOURCE, "fills the beat's cap exactly").toBe(CAP);
    for (const src of sources) takeAndReturn(state, src);

    for (const src of sources) {
      expect(
        admitToShortlist(state, 2, 3, `${src}-after`, CAP, src).admitted,
        `${src} handed back every place it held and is still refused`
      ).toBe(true);
    }
  });

  /**
   * THE DIRECTION THAT MUST NOT MOVE. A release gives back what was taken and nothing more, so a
   * source still cannot exceed its share — the cap is the number it was.
   */
  it("but a source still cannot hold more than its share at once", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < PER_SOURCE; i++) {
      expect(admitToShortlist(state, 2, 3, `loc-${i}`, CAP, "loc").admitted).toBe(true);
    }
    const over = admitToShortlist(state, 2, 3, "loc-extra", CAP, "loc");
    expect(over.admitted).toBe(false);
    expect(over.reason).toBe("SHORTLIST_SOURCE_SHARE");
  });

  /** And a release cannot manufacture headroom for a source that never held a place. */
  it("a release does not credit a source that was not holding the place", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < PER_SOURCE; i++) {
      expect(admitToShortlist(state, 2, 3, `wikimedia-${i}`, CAP, "wikimedia").admitted).toBe(true);
    }
    /** Somebody else's key comes back. Wikimedia's share is untouched by it. */
    expect(releaseShortlistSlot(state, 2, 3, "a-key-nobody-admitted").released).toBe(false);
    expect(admitToShortlist(state, 2, 3, "wikimedia-x", CAP, "wikimedia").admitted).toBe(false);
  });
});

describe("2. the guarantees RONDE 230-A already made are unchanged", () => {
  it("a place the editor actually spent is not handed back", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 0, "seen", CAP, "youtube");
    /** Mark it asked the way the funnel does, then try to reclaim it. */
    noteVisionAsked(state, 0, 0, "seen");
    const kept = releaseShortlistSlot(state, 0, 0, "seen");
    expect(kept.released).toBe(false);
    expect(kept.reason).toBe("ALREADY_ASKED");
  });

  it("and the release budget still bounds how far a beat may walk its list", () => {
    const state = createBeatShortlistState();
    let released = 0;
    for (let i = 0; i < CAP * 3; i++) {
      const k = `churn-${i}`;
      if (!admitToShortlist(state, 1, 1, k, CAP, `src${i % 4}`).admitted) continue;
      if (releaseShortlistSlot(state, 1, 1, k).released) released++;
    }
    expect(released, "RONDE 97's bound — a beat hands back at most `cap` places").toBe(CAP);
  });
});
