/**
 * VID-0589 — A REFUSED CARD IS NOT BETTER THAN AN APPROVED PICTURE.
 *
 * ── The second the render lost its only YouTube clip ────────────────────────────────────────
 *
 *     09:50:44  [Pipeline] Scene 0 beat 100: no unused curated archive asset
 *     09:50:44  [ArchiveSearch] zin 100 — GEEN kandidaten gevonden in archief
 *     09:50:44  [FFmpegCmd] ffmpeg -f lavfi -i "gradients=…" -vf "drawtext=text='Kris Jenner
 *                 once called a meeting just to discuss a single tweet.'"
 *     09:50:44  [Pipeline] Scene 0 slot 100: text-overlay fallback OK
 *     09:50:47  [BeatRelevance] s0b0 card refused and kept: scene_0_slot100_guaranteed.mp4 —
 *                 NOTHING STANDS BEHIND IT, so the answer is recorded rather than acted on
 *     09:50:47  [BeatRelevance] s0b0 push does_not_fit clip=scene_0_slot100_guaranteed.mp4
 *                 depicts="The frames show plain text on a solid background."
 *                 reason="The frames only show text with no relevant imagery"
 *     09:50:47  [PushTrace] scene=0 beat=0 asset=unknown lineage=none accepted=true
 *     09:50:48  [SceneResourced] scene_0_resourced dropped a fetched asset nothing refused:
 *                 provider=youtube_cc:0fIJzO7EIYI scene=0 beat=0
 *
 * Something did stand behind it. That beat held the render's entire YouTube yield — 1751
 * candidates, 104 download attempts, one success, fair-use transformed — judged FIT by this same
 * editor on this same beat. The reprieve's justification is the sentence it prints, and the
 * sentence was never checked: `cardRefusalKept` read `placeholder && does_not_fit` and nothing
 * about the beat it was covering for.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That the premise is asked; that the reprieve still works in the case it exists for; that the
 * rule is provider-neutral; and that a rebuild trading an approved picture for a generated card
 * is named rather than quiet. Nothing here relaxes a gate — obeying a refusal the editor already
 * issued is the strict direction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  beatAlreadyHasApprovedPicture,
  beatRelevanceBeatKey,
  createBeatRelevanceLedger,
  type BeatRelevanceLedger,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";

const RELEVANCE = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");
const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const ctx = (sceneIndex: number, beatIndex: number): BeatVisualContext =>
  ({ sceneIndex, beatIndex, beatText: "Kris Jenner once called a meeting." }) as BeatVisualContext;

/** Render 589's own two pictures for s0b0. */
const YT_PATH = "/w/scene_0_ytfu_0__pid_youtube_cc-132f0ec33347cc7a_transformed.mp4";
const YT_KEY = "youtube_cc:132f0ec33347cc7a";
const CARD_PATH = "/w/scene_0_slot100_guaranteed.mp4";
const CARD_KEY = "file:419760:scene_0_slot100_guaranteed.mp4";

const seed = (
  ledger: BeatRelevanceLedger,
  clipPath: string,
  contentKey: string,
  scene: number,
  beat: number,
  verdict: "fits" | "does_not_fit" | "unknown",
  over: { evaluated?: boolean } = {}
) =>
  recordExternalRelevanceVerdict(
    ledger,
    clipPath,
    contentKey,
    ctx(scene, beat),
    { verdict, depicts: "", reason: "", ...over },
    "test"
  );

/* ═══════════ §1 — the premise is asked, on the register that already holds it ═══════════ */

describe("VID-0589 §1 — does anything actually stand behind this beat?", () => {
  it("render 589's beat: the YouTube clip is found, and it is what outranks the card", () => {
    const ledger = createBeatRelevanceLedger();
    seed(ledger, YT_PATH, YT_KEY, 0, 0, "fits");
    seed(ledger, CARD_PATH, CARD_KEY, 0, 0, "does_not_fit");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBe(
      `content:${YT_KEY}`
    );
  });

  it("a beat with nothing behind it answers null — the reprieve's real case", () => {
    const ledger = createBeatRelevanceLedger();
    seed(ledger, CARD_PATH, CARD_KEY, 0, 0, "does_not_fit");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBeNull();
  });

  it("a card never outranks itself, under either of its two handles", () => {
    /**
     * `record()` files the same entry under the path AND the content key. Reading them back
     * without excluding both would let a card whose own verdict was `fits` stand behind itself.
     */
    const ledger = createBeatRelevanceLedger();
    seed(ledger, CARD_PATH, CARD_KEY, 0, 0, "fits");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBeNull();
  });

  it("an approval earned on ANOTHER beat is not an approval here", () => {
    /** The whole reason `byBeat` exists: a FIT under one sentence is not a FIT under another. */
    const ledger = createBeatRelevanceLedger();
    seed(ledger, YT_PATH, YT_KEY, 0, 1, "fits");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBeNull();
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 1, CARD_KEY, CARD_PATH)).toBe(
      `content:${YT_KEY}`
    );
  });

  it("neither a refusal nor an unknown stands behind anything", () => {
    const ledger = createBeatRelevanceLedger();
    seed(ledger, "/w/a.mp4", "pexels:1", 0, 0, "does_not_fit");
    seed(ledger, "/w/b.mp4", "pexels:2", 0, 0, "unknown");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBeNull();
  });

  it("a decline is not a verdict — nobody looked, so nobody vouched", () => {
    const ledger = createBeatRelevanceLedger();
    seed(ledger, YT_PATH, YT_KEY, 0, 0, "fits", { evaluated: false });
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBeNull();
  });

  it("beat 1 and beat 10 are different beats, not a prefix of one another", () => {
    /**
     * The key is `s<scene>b<beat>\\0…`; a prefix scan that stopped at the beat number would let
     * s0b10's approval answer for s0b1. The NUL separator is what makes the scan exact, and this
     * is the test that would catch its removal.
     */
    const ledger = createBeatRelevanceLedger();
    seed(ledger, YT_PATH, YT_KEY, 0, 10, "fits");
    expect(beatAlreadyHasApprovedPicture(ledger, 0, 1, CARD_KEY, CARD_PATH)).toBeNull();
  });

  it("the rule is provider-neutral — every provider's approved picture outranks a card", () => {
    /**
     * §2's requirement stated as a test. Not "YouTube may not be replaced" but "an approved
     * picture may not be replaced by a refused card", whoever supplied it.
     */
    for (const key of [
      "youtube_cc:132f0ec33347cc7a",
      "internet_archive:83a770cf64be57ab",
      "wikimedia:aa11bb22cc33dd44",
      "nara:0011223344556677",
      "pexels:1122334455667788",
      "pixabay:99aabbccddeeff00",
      "curated:asset:57378",
    ]) {
      const ledger = createBeatRelevanceLedger();
      seed(ledger, `/w/${key.replace(/[:]/g, "_")}.mp4`, key, 2, 0, "fits");
      expect(
        beatAlreadyHasApprovedPicture(ledger, 2, 0, CARD_KEY, CARD_PATH),
        key
      ).toBe(`content:${key}`);
    }
  });

  it("the answer names the ASSET and is the same every run", () => {
    /**
     * `record()` files one entry under two handles — the path and the content key — so a reader
     * that returned whichever the map yielded first would print a different line on different
     * runs, and half the time would print a path out of this render's temp directory, which this
     * programme has ruled is not an identity.
     */
    for (let i = 0; i < 5; i++) {
      const ledger = createBeatRelevanceLedger();
      seed(ledger, "/w/noise.mp4", "pexels:9", 0, 0, "does_not_fit");
      seed(ledger, YT_PATH, YT_KEY, 0, 0, "fits");
      seed(ledger, CARD_PATH, CARD_KEY, 0, 0, "does_not_fit");
      expect(beatAlreadyHasApprovedPicture(ledger, 0, 0, CARD_KEY, CARD_PATH)).toBe(
        `content:${YT_KEY}`
      );
    }
  });

  it("the key this reads is the one the ledger writes", () => {
    /** Two spellings of one key is how a reader silently answers null forever. */
    const ledger = createBeatRelevanceLedger();
    seed(ledger, YT_PATH, YT_KEY, 3, 4, "fits");
    expect(ledger.byBeat.has(beatRelevanceBeatKey(3, 4, "content", YT_KEY))).toBe(true);
    expect(beatAlreadyHasApprovedPicture(ledger, 3, 4, CARD_KEY, CARD_PATH)).not.toBeNull();
  });
});

/* ═══════════ §2 — the reprieve consults it, and still exists ═══════════ */

describe("VID-0589 §2 — the card's reprieve is conditional now", () => {
  const judgeBody = (): string => {
    const at = RELEVANCE.indexOf("const provenAlternative =");
    expect(at, "the card reprieve moved").toBeGreaterThan(-1);
    return RELEVANCE.slice(at, at + 900);
  };

  it("cardRefusalKept requires that nothing stands behind the beat", () => {
    const body = judgeBody();
    expect(body).toContain("beatAlreadyHasApprovedPicture(");
    expect(body).toMatch(
      /const cardRefusalKept =\s*Boolean\(params\.placeholder\) && judgement\.verdict === "does_not_fit" && !provenAlternative;/
    );
  });

  it("the reprieve is still there for the beat that has nothing", () => {
    /** §16's rule in the other direction: a plain card beats black, and that has not changed. */
    expect(RELEVANCE).toContain("nothing stands behind it, so the answer is recorded rather than");
    expect(RELEVANCE).toContain("reprieved: cardRefusalKept");
  });

  it("a card that is NOT kept says so, with what outranked it", () => {
    expect(RELEVANCE).toContain("card refused AND NOT KEPT");
    expect(RELEVANCE).toContain("this beat already has a picture the editor approved");
  });

  it("the reprieve is only ever asked about a placeholder that was refused", () => {
    /**
     * The lookup is a scan of the beat register, so it must not run on the ordinary path where
     * every real candidate is judged. Guarded by the same two conditions the reprieve itself has.
     */
    expect(judgeBody()).toMatch(
      /params\.placeholder && judgement\.verdict === "does_not_fit"\s*\?\s*beatAlreadyHasApprovedPicture\(/
    );
  });

  it("the compose barrier's rule is untouched — it still refuses an unreprieved refusal", () => {
    expect(RELEVANCE).toContain('if (d.verdict === "does_not_fit" && !d.reprieved)');
    expect(RELEVANCE).toContain('if (d.reprieved) return { allow: true');
  });
});

/* ═══════════ §3 — a rebuild has no quiet permission to make that trade ═══════════ */

describe("VID-0589 §3 — PROVEN_BEAT_VISUAL_MUST_NOT_BE_REPLACED_BY_REJECTED_PLACEHOLDER", () => {
  it("the permission is data, in one place, and no rebuild currently holds it", () => {
    /**
     * §3 asks for explicit permission plus a recorded reason. b6d057f gave the reason its site;
     * this is the permission. The empty set IS the finding: no rebuild exists in order to put a
     * card where an approved picture already was.
     */
    expect(PIPELINE).toContain(
      "const SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE: ReadonlySet<SceneResourceSite> = new Set();"
    );
  });

  it("the invariant fires from the one place every rebuild's result passes through", () => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("PROVEN_BEAT_VISUAL_REPLACED_BY_PLACEHOLDER");
    expect(body).toContain("SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE.has(site)");
    expect(body).toContain("isPipelineFallbackClip(c)");
    expect(body).toContain("beatPictureWasApproved(");
    /** The site is in the line, or the next render cannot act on it. */
    expect(body).toContain("site=${site}");
  });

  it("it reads the editor's verdict rather than inferring one", () => {
    const at = PIPELINE.indexOf("function beatPictureWasApproved(");
    expect(at).toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("dedup?.beatRelevance");
    expect(body).toContain("beatRelevanceBeatKey(sceneIndex, beatIndex,");
    expect(body).toContain('d.verdict === "fits"');
    expect(body).toContain("d.evaluated === false");
  });

  it("it reports and does not rewrite the rebuild's list", () => {
    /**
     * RONDE 574 declined to force a rebuild to carry its old list, because this function can see
     * WHAT left and not WHY. That reasoning still holds; what changed is that the trade is named.
     */
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body, "this function must not mutate the new list").not.toMatch(
      /next\.clips\s*=|next\?\.clips\.push\(|kept\.add\(/
    );
  });

  it("RONDE 574's two behaviours survived", () => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("[SceneResourced]");
    expect(body).toContain('record.providerStatus === "VERIFIED"');
    expect(body).toContain("usedPaths?.delete(clip)");
  });
});
