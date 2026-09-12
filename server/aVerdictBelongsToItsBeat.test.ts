import { describe, it, expect } from "vitest";
import {
  composeBarrierAllows,
  createBeatRelevanceLedger,
  inheritBeatRelevance,
  relevanceVerdictForRenderedAsset,
  reprieveBeatClip,
  beatRelevanceBeatKey,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";

/**
 * A VERDICT BELONGS TO THE SENTENCE IT WAS EARNED UNDER.
 *
 * ── What the ledger could not hold ──────────────────────────────────────────────────────────
 *
 * The picture editor judges per BEAT. Its cache key is `${contentKey}|${beatIdentity}`, so the
 * same clip is asked about again for every sentence it might run under — which is right, because
 * a shot that does not belong under one line is regularly the right shot for another.
 *
 * `byClipPath` and `byContentKey` kept ONE entry per clip, overwritten by each new judgement. So
 * of the several verdicts a clip earned, only the last survived, and two things followed:
 *
 *   1. An approval was destroyed by an unrelated question. Clip approved for beat 2, judged again
 *      for beat 5, and beat 2's reader — which correctly refuses a verdict earned at another beat
 *      — then answered `never_asked`. Under REAL_FUNNEL (youtube_cc, wikimedia, archive, stock,
 *      pexels) an unjudged clip may not be adopted at all, so the approval's destruction cost the
 *      film the shot.
 *
 *   2. One beat's refusal blocked every beat. `composeBarrierAllows` read whatever verdict was
 *      left and never asked which sentence it was about — its own log line says `refused on s1b0`
 *      while turning the clip away at s1b3, which never saw that judgement. That is the YouTube
 *      pre-pool screening's failure, surviving in a second place: one sentence ending a clip's
 *      life for a whole scene.
 *
 * Render 578 delivered `FIT=0` across seventeen beats and not one of its 2479 YouTube candidates.
 * These tests do not prove that this is why — the render's own verdict counts would say that, and
 * they are in a log this repository does not have. They prove the mechanism is gone.
 *
 * ── What deliberately did not change ────────────────────────────────────────────────────────
 *
 * A beat with no verdict of its own still inherits a refusal recorded elsewhere. Nothing here
 * loosens the barrier; the only behaviour that moves is the case where the beat HAS its own
 * answer, which is the one about the narration the clip will actually run under.
 */

const ctx = (sceneIndex: number, beatIndex: number, beatText: string): BeatVisualContext => ({
  sceneIndex,
  beatIndex,
  beatText,
  sceneText: "The fall of Berlin.",
  videoTitle: "The Last Days",
});

const CLIP = "/tmp/r/scene_1_b2_youtube_abc.mp4";
const KEY = "youtube:abc123";

const approve = (ledger: ReturnType<typeof createBeatRelevanceLedger>, c: BeatVisualContext) =>
  recordExternalRelevanceVerdict(ledger, CLIP, KEY, c, {
    verdict: "fits",
    depicts: "a bombed street",
    reason: "the street under the narration",
  }, "beat_judge");

const refuse = (ledger: ReturnType<typeof createBeatRelevanceLedger>, c: BeatVisualContext) =>
  recordExternalRelevanceVerdict(ledger, CLIP, KEY, c, {
    verdict: "does_not_fit",
    depicts: "a modern office",
    reason: "a modern office under wartime narration",
  }, "beat_judge");

describe("an approval survives the next beat's question", () => {
  it("THE APPROVAL EARNED AT BEAT 2 IS STILL THERE AFTER BEAT 5 IS ASKED", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 5, "Inside the bunker, the air was still."));

    const atBeat2 = relevanceVerdictForRenderedAsset(ledger, {
      localPath: CLIP,
      contentKey: KEY,
      sceneIndex: 1,
      beatIndex: 2,
    });
    expect(atBeat2, "beat 2's verdict was overwritten by beat 5's question").not.toBeNull();
    expect(atBeat2!.verdict).toBe("fits");
  });

  it("and beat 5 still has its own refusal — neither answer replaces the other", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 5, "Inside the bunker, the air was still."));

    const atBeat5 = relevanceVerdictForRenderedAsset(ledger, {
      localPath: CLIP,
      contentKey: KEY,
      sceneIndex: 1,
      beatIndex: 5,
    });
    expect(atBeat5!.verdict).toBe("does_not_fit");
  });

  it("A BEAT NOBODY ASKED ABOUT STILL ANSWERS NOTHING", () => {
    /**
     * The half that must not move. `never_asked` is what makes REAL_FUNNEL refuse an unjudged
     * picture, and inventing a verdict for a beat from a neighbour's answer is precisely the
     * silent substitution this pipeline forbids.
     */
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    expect(
      relevanceVerdictForRenderedAsset(ledger, {
        localPath: CLIP,
        contentKey: KEY,
        sceneIndex: 1,
        beatIndex: 9,
      })
    ).toBeNull();
  });

  it("the verdict says it was matched at the beat, not merely found", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 5, "Inside the bunker."));
    const at2 = relevanceVerdictForRenderedAsset(ledger, {
      localPath: CLIP,
      contentKey: KEY,
      sceneIndex: 1,
      beatIndex: 2,
    });
    expect(at2!.matchedBy).toBe("beat_path");
  });

  it("content identity finds it too, for a file renamed past recognition", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 5, "Inside the bunker."));
    const at2 = relevanceVerdictForRenderedAsset(ledger, {
      localPath: "/tmp/r/scene_1_b2_youtube_abc_trimmed_overlay.mp4",
      contentKey: KEY,
      sceneIndex: 1,
      beatIndex: 2,
    });
    expect(at2!.verdict).toBe("fits");
    expect(at2!.matchedBy).toBe("beat_content");
  });
});

describe("the compose barrier asks about the sentence the clip will run under", () => {
  it("A REFUSAL AT ONE BEAT NO LONGER BLOCKS THE BEAT THAT APPROVED IT", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 0, "Standing on the brink of utter defeat."));

    const atApproved = composeBarrierAllows(ledger, CLIP, KEY, { sceneIndex: 1, beatIndex: 2 });
    expect(atApproved.allow, atApproved.reason).toBe(true);
    expect(atApproved.reason).toBe("fits");
  });

  it("and still blocks at the beat that refused it", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 0, "Standing on the brink of utter defeat."));

    const atRefused = composeBarrierAllows(ledger, CLIP, KEY, { sceneIndex: 1, beatIndex: 0 });
    expect(atRefused.allow).toBe(false);
    expect(atRefused.reason).toContain("refused on s1b0");
  });

  it("A BEAT WITH NO VERDICT OF ITS OWN STILL INHERITS THE REFUSAL", () => {
    /** Nothing is loosened here. The reason simply stops implying a judgement that never happened. */
    const ledger = createBeatRelevanceLedger();
    refuse(ledger, ctx(1, 0, "Standing on the brink of utter defeat."));

    const elsewhere = composeBarrierAllows(ledger, CLIP, KEY, { sceneIndex: 1, beatIndex: 3 });
    expect(elsewhere.allow).toBe(false);
    expect(elsewhere.reason).toContain("refused on s1b0");
    expect(elsewhere.reason).toContain("s1b3 has no verdict of its own");
  });

  it("a caller with no beat keeps exactly the behaviour it had", () => {
    /** Four compose call sites are handed bare paths. They pass no beat and must not change. */
    const ledger = createBeatRelevanceLedger();
    refuse(ledger, ctx(1, 0, "Standing on the brink of utter defeat."));
    const blind = composeBarrierAllows(ledger, CLIP, KEY);
    expect(blind.allow).toBe(false);
    expect(blind.reason).toBe(
      "refused on s1b0: a modern office under wartime narration"
    );
  });

  it("an unknown clip still passes, and still says so", () => {
    const ledger = createBeatRelevanceLedger();
    const unknown = composeBarrierAllows(ledger, "/tmp/r/pad.mp4", "file:12:pad.mp4", {
      sceneIndex: 0,
      beatIndex: 0,
    });
    expect(unknown.allow).toBe(true);
    expect(unknown.reason).toContain("never judged");
  });
});

describe("a reprieve and a rename reach the per-beat record too", () => {
  it("ALL THREE INDEXES HOLD THE SAME ENTRY, so a mutation reaches every one of them", () => {
    /**
     * `reprieveBeatClip` does not replace an entry, it mutates the one it finds. Object identity
     * is therefore the mechanism, not an implementation detail: a per-beat index holding COPIES
     * would drift from the other two the first time anything changed a decision in place.
     *
     * Asserted on identity rather than through a reprieve, because a reprieve can no longer be
     * granted — see the next test.
     */
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    const fromPath = ledger.byClipPath.get(CLIP);
    const fromContent = ledger.byContentKey.get(KEY);
    const fromBeat = ledger.byBeat.get(beatRelevanceBeatKey(1, 2, "path", CLIP));
    const fromBeatContent = ledger.byBeat.get(beatRelevanceBeatKey(1, 2, "content", KEY));
    expect(fromBeat).toBe(fromPath);
    expect(fromBeatContent).toBe(fromPath);
    expect(fromContent).toBe(fromPath);
  });

  it("A REFUSAL STILL CANNOT BE OVERRULED — RONDE 200 is untouched", () => {
    /**
     * "Er mag nooit een beeld in de video die er niet bij past." `reprieveAllowedFor` returns
     * false for every kind, so no refusal is liftable at any price. Asserted here because making
     * the barrier beat-aware is exactly the kind of change that could open that door by accident.
     */
    const ledger = createBeatRelevanceLedger();
    refuse(ledger, ctx(1, 0, "Standing on the brink of utter defeat."));

    expect(reprieveBeatClip(ledger, CLIP, "the only picture this beat has")).toBe(false);
    const barrier = composeBarrierAllows(ledger, CLIP, KEY, { sceneIndex: 1, beatIndex: 0 });
    expect(barrier.allow).toBe(false);
  });

  it("A TRIM DOES NOT COST THE CLIP ITS APPROVAL", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    const trimmed = "/tmp/r/scene_1_b2_youtube_abc_trim.mp4";
    inheritBeatRelevance(ledger, CLIP, trimmed);

    const at2 = relevanceVerdictForRenderedAsset(ledger, {
      localPath: trimmed,
      sceneIndex: 1,
      beatIndex: 2,
    });
    expect(at2, "the trimmed file lost the verdict its source earned").not.toBeNull();
    expect(at2!.verdict).toBe("fits");
  });

  it("and it carries EVERY beat's verdict across, not just the last one", () => {
    /**
     * The whole point of the index is that a clip holds several verdicts at once. A rename that
     * picked one of them would put the overwrite back under a different name.
     */
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    refuse(ledger, ctx(1, 5, "Inside the bunker."));
    const trimmed = "/tmp/r/scene_1_b2_youtube_abc_trim.mp4";
    inheritBeatRelevance(ledger, CLIP, trimmed);

    expect(
      relevanceVerdictForRenderedAsset(ledger, { localPath: trimmed, sceneIndex: 1, beatIndex: 2 })!
        .verdict
    ).toBe("fits");
    expect(
      relevanceVerdictForRenderedAsset(ledger, { localPath: trimmed, sceneIndex: 1, beatIndex: 5 })!
        .verdict
    ).toBe("does_not_fit");
  });

  it("renaming to the same path is not a second record", () => {
    const ledger = createBeatRelevanceLedger();
    approve(ledger, ctx(1, 2, "Rubble filled every street."));
    const before = ledger.byBeat.size;
    inheritBeatRelevance(ledger, CLIP, CLIP);
    expect(ledger.byBeat.size).toBe(before);
  });
});

describe("the key keeps a filename from being read as an asset identity", () => {
  it("a path handle and a content handle are different keys", () => {
    expect(beatRelevanceBeatKey(1, 2, "path", "x")).not.toBe(
      beatRelevanceBeatKey(1, 2, "content", "x")
    );
  });

  it("and the beat is part of the key, not assumed by the caller", () => {
    expect(beatRelevanceBeatKey(1, 2, "path", "x")).not.toBe(
      beatRelevanceBeatKey(1, 3, "path", "x")
    );
    expect(beatRelevanceBeatKey(1, 2, "path", "x")).not.toBe(
      beatRelevanceBeatKey(2, 2, "path", "x")
    );
  });

  it("A NON-CANONICAL KEY IS NOT INDEXED AS AN IDENTITY", () => {
    /**
     * `file:<size>:<basename>` is a fingerprint of one file, not an asset. Indexing it would put a
     * promise in the identity index that a copy or a re-trim breaks — the same rule `record()`
     * obeys, asked through the same function rather than re-derived here.
     */
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(ledger, CLIP, "file:993:clip.mp4", ctx(0, 0, "Berlin."), {
      verdict: "fits",
      depicts: "x",
      reason: "y",
    }, "beat_judge");
    expect(ledger.byBeat.has(beatRelevanceBeatKey(0, 0, "content", "file:993:clip.mp4"))).toBe(false);
    expect(ledger.byBeat.has(beatRelevanceBeatKey(0, 0, "path", CLIP))).toBe(true);
  });
});
