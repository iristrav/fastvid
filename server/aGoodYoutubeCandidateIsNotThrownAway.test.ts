/**
 * A GOOD YOUTUBE CANDIDATE IS NOT THROWN AWAY BY AN INTERNAL ROUTE.
 *
 * ── What this file is NOT for ───────────────────────────────────────────────────────────────
 *
 * It is not here to make YouTube win. Every gate below is the production gate, asked the
 * production question, and a candidate that this pipeline legitimately refuses is allowed to be
 * refused — the tests say so where it happens. What is measured is narrower and harder: whether a
 * YouTube candidate that is CONTENT-WISE FINE can be discarded by a route that never looked at it.
 *
 * ── The three ways render 593 lost one ──────────────────────────────────────────────────────
 *
 *     s2b4 / s0b5 / s2b5   candidate delivered, visionJudged=0, topRejects=none
 *     s1b5 / s1b6 / s1b7   "no narration to judge against"
 *     s0b4                 shortlist_full:6
 *
 * Three different machines, and none of them is the vision model saying no. Each one is measured
 * here against the real implementation, and each one's answer is recorded as what it is: a bug, a
 * rule working as intended, or a competition legitimately lost.
 */
import { describe, expect, it } from "vitest";

import {
  admitToShortlist,
  createBeatShortlistState,
  maxShortlistPerBeat,
  maxShortlistPerBeatPerSource,
  noteEligible,
  noteVisionAsked,
  releaseShortlistSlot,
} from "./beatShortlist";
import {
  ensureVerdictBeforeCompose,
  createBeatRelevanceLedger,
  maxComposePhaseJudgements,
  nothingToJudgeAgainst,
  withComposeJudgeScope,
  type ComposeJudgeScope,
} from "./beatVisualRelevance";
import { createBeatImageGateState } from "./beatImageRelevanceGate";
import { sourceMayEnterCuratedArchive } from "./videoPipeline";

/** A compose scope shaped the way production builds one, with the parts a test can supply. */
function scopeWith(over: Partial<ComposeJudgeScope> = {}): ComposeJudgeScope {
  return {
    workDir: "/tmp/yt-fair",
    state: createBeatImageGateState(),
    ledger: createBeatRelevanceLedger(),
    beatForClip: () => undefined,
    contextFor: () => undefined,
    isPlaceholder: () => false,
    budget: maxComposePhaseJudgements(),
    spent: 0,
    ...over,
  };
}

/* ═══════════════════ §5 — shortlist_full, and who spent the places ═══════════════════ */

describe("the shortlist is a competition, and YouTube is allowed to enter it", () => {
  it("MEASURED: the cap is 8 and one source may take at most 4 of it", () => {
    /**
     * `shortlist_full:6` in render 593 is a COUNT OF REFUSALS, not a cap of six — six candidates
     * turned away from a beat whose bound is eight. Recorded here because the earlier forensics
     * read it as the cap, and the two readings suggest opposite work.
     */
    expect(maxShortlistPerBeat()).toBe(8);
    expect(maxShortlistPerBeatPerSource()).toBe(4);
    expect(maxShortlistPerBeatPerSource()).toBeLessThan(maxShortlistPerBeat());
  });

  it("ONE SOURCE CANNOT TAKE THE WHOLE BEAT — the archive stops at its share", () => {
    /**
     * Render 578's defect, asserted against the real admission rule. The curated archive is asked
     * FIRST for every beat, and before the per-source share existed it filled all eight places
     * before YouTube was offered a single one.
     */
    const state = createBeatShortlistState();
    const admitted: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = admitToShortlist(state, 0, 4, `archive-${i}`, undefined, "archive");
      if (a.admitted) admitted.push(`archive-${i}`);
    }
    expect(admitted, "the archive took more than its share").toHaveLength(
      maxShortlistPerBeatPerSource()
    );
    /** And the places it could not take are still there for somebody else. */
    const yt = admitToShortlist(state, 0, 4, "yt-1", undefined, "youtube_cc");
    expect(yt.admitted, "YouTube was refused while the beat still had room").toBe(true);
  });

  it("and YouTube gets no MORE than its share either — no preferential treatment", () => {
    const state = createBeatShortlistState();
    let admittedCount = 0;
    for (let i = 0; i < 8; i++) {
      if (admitToShortlist(state, 0, 4, `yt-${i}`, undefined, "youtube_cc").admitted) {
        admittedCount++;
      }
    }
    expect(admittedCount, "YouTube was given more room than any other source").toBe(
      maxShortlistPerBeatPerSource()
    );
  });

  it("SHORTLIST_FULL and SHORTLIST_SOURCE_SHARE stay different answers", () => {
    /** Opposite findings: the beat is out of room, versus one source is and the beat is not. */
    const state = createBeatShortlistState();
    for (let i = 0; i < 4; i++) admitToShortlist(state, 0, 4, `a-${i}`, undefined, "archive");
    const share = admitToShortlist(state, 0, 4, "a-5", undefined, "archive");
    expect(share.admitted).toBe(false);
    expect(share.reason).toBe("SHORTLIST_SOURCE_SHARE");

    for (const src of ["wikimedia", "openverse"]) {
      for (let i = 0; i < 2; i++) admitToShortlist(state, 0, 4, `${src}-${i}`, undefined, src);
    }
    const full = admitToShortlist(state, 0, 4, "yt-late", undefined, "youtube_cc");
    expect(full.admitted).toBe(false);
    expect(full.reason, "a full beat and a full source read the same").toBe("SHORTLIST_FULL");
  });

  it("A PLACE NOBODY LOOKED AT COMES BACK — so a decline cannot bury a later candidate", () => {
    /**
     * RONDE 230's rule, exercised on a YouTube key. This is the mechanism that stops `shortlist_
     * full` from being permanent after one round of declines, and it is the reason a late YouTube
     * candidate is not automatically lost.
     */
    const state = createBeatShortlistState();
    expect(admitToShortlist(state, 0, 4, "yt-a", undefined, "youtube_cc").admitted).toBe(true);
    const back = releaseShortlistSlot(state, 0, 4, "yt-a");
    expect(back.released, "an unexamined place was kept").toBe(true);
  });

  it("BUT A PLACE THAT WAS ACTUALLY SPENT ON A LOOK STAYS SPENT", () => {
    /** The other half, and the one that keeps this from being a budget increase. */
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 4, "yt-b", undefined, "youtube_cc");
    noteEligible(state, 0, 4);
    noteVisionAsked(state, 0, 4, "yt-b");
    const back = releaseShortlistSlot(state, 0, 4, "yt-b");
    expect(back.released).toBe(false);
    if (!back.released) expect(back.reason).toBe("ALREADY_ASKED");
  });
});

/* ═══════════════════ §4 — no narration, and which kind it was ═══════════════════ */

describe("a slot with no beat behind it says so, instead of blaming the script", () => {
  it("A BEAT THAT EXISTS WITH NO WORDS is no_narration", async () => {
    const outcome = await withComposeJudgeScope(
      scopeWith({
        beatForClip: () => ({ sceneIndex: 1, beatIndex: 2 }),
        /** Three beats in this scene, so index 2 IS a beat — it simply has no text. */
        beatCountFor: () => 3,
      }),
      () =>
        ensureVerdictBeforeCompose({
          clipPath: "/tmp/yt-fair/scene_1_b2.mp4",
          contentKey: "k1",
        })
    );
    expect(outcome.outcome).toBe("no_narration");
  });

  it("A SLOT PAST THE LAST BEAT is slot_without_beat — render 593's s1b5/6/7", async () => {
    /**
     * The finding this test exists for. `minClipsForScene` can need more pictures than the scene
     * has sentences, and the extra ones are montage slots. Asking why they had "no narration"
     * sends a person to the script; the script is fine.
     */
    const outcome = await withComposeJudgeScope(
      scopeWith({
        beatForClip: () => ({ sceneIndex: 1, beatIndex: 5 }),
        /** Scene 1 has five sentences: indices 0–4. There is no beat 5. */
        beatCountFor: () => 5,
      }),
      () =>
        ensureVerdictBeforeCompose({
          clipPath: "/tmp/yt-fair/scene_1_b5.mp4",
          contentKey: "k2",
        })
    );
    expect(outcome.outcome).toBe("slot_without_beat");
  });

  it("A SCOPE THAT CANNOT COUNT reports exactly what it reported before", async () => {
    /** Never claim more than you know: a missing count is not evidence of a missing beat. */
    const outcome = await withComposeJudgeScope(
      scopeWith({ beatForClip: () => ({ sceneIndex: 1, beatIndex: 5 }) }),
      () =>
        ensureVerdictBeforeCompose({
          clipPath: "/tmp/yt-fair/scene_1_b5.mp4",
          contentKey: "k3",
        })
    );
    expect(outcome.outcome).toBe("no_narration");
  });

  it("THE DECISION IS UNCHANGED — both still mean nothing can be asked", () => {
    /**
     * The split is a name, not a gate. If this ever stops holding, a beat with no sentence behind
     * it starts demanding an approval that cannot be earned — which is render 592-B, where scene 2
     * refused four files forty-six times and shipped text overlays the export gate then rejected.
     */
    expect(nothingToJudgeAgainst("no_narration")).toBe(true);
    expect(nothingToJudgeAgainst("slot_without_beat")).toBe(true);
    expect(nothingToJudgeAgainst("judged")).toBe(false);
  });
});

/* ═══════════════════ §16 — and the archive rule has no YouTube exception ═══════════════════ */

describe("YouTube is archiveable, and is not privileged for it", () => {
  it("youtube_cc may enter the curated archive", () => {
    expect(sourceMayEnterCuratedArchive("youtube_cc")).toBe(true);
  });

  it("and so may every other external source that is not exempt", () => {
    for (const src of ["wikimedia", "internet_archive", "openverse", "europeana", "nara", "loc"]) {
      expect(sourceMayEnterCuratedArchive(src), src).toBe(true);
    }
    /** The exemptions are the licence-bound ones and our own archive, unchanged. */
    for (const src of ["pexels", "pixabay", "archive"]) {
      expect(sourceMayEnterCuratedArchive(src), src).toBe(false);
    }
  });
});
