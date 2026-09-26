/**
 * RONDE 660 — VIDEO 608: FOUR APPROVED PICTURES REFUSED, AND 130 CARDS REFUSED FOR THEM.
 *
 *     08:12:31  [BeatRelevance] s0b0 push fits clip=scene_0_b0_curated_a57805.mp4
 *     08:12:31  [AdoptionGuard] scene=0 beat=0 route=beat_fetch eligible=false vision=APPROVED
 *                 blocked=FUNNEL_WITHOUT_EVIDENCE
 *     …the same for 57866 (s1b1), 57924 (s2b1) and 57810 (s1b3)…
 *     08:46:50 → 08:51:54  [BeatRelevance] s2b2 card refused AND NOT KEPT … this beat already has
 *                 a picture the editor approved (content:curated:asset:57924)   × ~45
 *
 * Three defects, one chain:
 *
 *   1. The push route judged those clips in `ensureVerdictBeforeCompose`, which called the judge
 *      directly — past the one desk that stamps eligibility. APPROVED without the stamp is refused.
 *   2. The refusal is filed as `ELIGIBLE status=REJECTED`, and `hasStage` ignored the status, so a
 *      refusal read as eligibility and `markLineageEligible` never wrote the real stamp.
 *   3. The approved-but-refused picture still counted as "standing behind the beat", so every card
 *      for the beat was refused too; the beat stayed empty and the ladder ran again and again.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  beatAlreadyHasApprovedPicture,
  createBeatRelevanceLedger,
  notePushOutcomeForBeat,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";
import { VisualSourceLedger } from "./visualSourceLineage";
import { ensureCuratedAssetLineageOn } from "./videoPipeline";
import { curatedAssetContentKey } from "./curatedMediaSourcing";

const RELEVANCE = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");
const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const ASSET_ID = 57924;
const CLIP = `/w/scene_2_b2_curated_a${ASSET_ID}.mp4`;
const KEY = curatedAssetContentKey(ASSET_ID);
const CARD = "/w/scene_2_slot2_guaranteed.mp4";
const CARD_KEY = "file:1:scene_2_slot2_guaranteed.mp4";

const pick = (): never =>
  ({
    asset: { id: ASSET_ID, mediaType: "video", storageUrl: "https://a/b.mp4", title: "T" },
    score: 9,
    archiveName: "youtube",
  }) as never;

const ctx = (sceneIndex: number, beatIndex: number): BeatVisualContext =>
  ({ sceneIndex, beatIndex, beatText: "Hitler took his own life in the bunker." }) as BeatVisualContext;

describe("RONDE 660 §2 — a refusal is not eligibility", () => {
  it("an ELIGIBLE event with status REJECTED does not make the asset eligible", () => {
    const ledger = new VisualSourceLedger("r660a");
    ensureCuratedAssetLineageOn(ledger, pick(), 2, 2);
    ledger.recordRejection(CLIP, "FUNNEL_WITHOUT_EVIDENCE", KEY);
    expect(ledger.isEligible(CLIP, KEY)).toBe(false);
  });

  it("and the real stamp can still be written after it", () => {
    const ledger = new VisualSourceLedger("r660b");
    ensureCuratedAssetLineageOn(ledger, pick(), 2, 2);
    ledger.recordRejection(CLIP, "vision_gate", KEY);
    expect(ledger.markEligible(CLIP, KEY, "judged_at_push")).toBe(true);
    expect(ledger.isEligible(CLIP, KEY)).toBe(true);
  });
});

describe("RONDE 660 §3 — an approval refused at the push does not stand behind the beat", () => {
  const seeded = () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(ledger, CLIP, KEY, ctx(2, 2), { verdict: "fits", depicts: "", reason: "" }, "test");
    return ledger;
  };

  it("before the push, the approved picture is found (VID-0589's rule is unchanged)", () => {
    expect(beatAlreadyHasApprovedPicture(seeded(), 2, 2, CARD_KEY, CARD)).not.toBeNull();
  });

  it("refused at the push: the beat has no picture, so its card is not refused for it", () => {
    const ledger = seeded();
    notePushOutcomeForBeat(ledger, 2, 2, { clipPath: CLIP, contentKey: KEY }, false);
    expect(beatAlreadyHasApprovedPicture(ledger, 2, 2, CARD_KEY, CARD)).toBeNull();
  });

  it("refused under a derived file name: the content key still carries it", () => {
    const ledger = seeded();
    notePushOutcomeForBeat(ledger, 2, 2, { clipPath: "/w/scene_2_b2_curated_a57924_text.mp4", contentKey: KEY }, false);
    expect(beatAlreadyHasApprovedPicture(ledger, 2, 2, CARD_KEY, CARD)).toBeNull();
  });

  it("refused once and accepted later: it stands behind the beat again", () => {
    const ledger = seeded();
    notePushOutcomeForBeat(ledger, 2, 2, { clipPath: CLIP, contentKey: KEY }, false);
    notePushOutcomeForBeat(ledger, 2, 2, { clipPath: CLIP, contentKey: KEY }, true);
    expect(beatAlreadyHasApprovedPicture(ledger, 2, 2, CARD_KEY, CARD)).not.toBeNull();
  });

  it("a refusal at ANOTHER beat changes nothing here", () => {
    const ledger = seeded();
    notePushOutcomeForBeat(ledger, 2, 1, { clipPath: CLIP, contentKey: KEY }, false);
    expect(beatAlreadyHasApprovedPicture(ledger, 2, 2, CARD_KEY, CARD)).not.toBeNull();
  });
});

describe("RONDE 660 §1 — the wiring", () => {
  it("the push-route judge stamps a real picture before judging it, and never a card", () => {
    const fn = RELEVANCE.slice(RELEVANCE.indexOf("export async function ensureVerdictBeforeCompose"));
    const stamp = fn.indexOf("if (!placeholder) scope.noteJudged?.(params.clipPath, params.contentKey, at);");
    const judge = fn.indexOf("await checkBeatRelevance(");
    expect(stamp).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(stamp);
  });

  it("the render installs the stamp through the same helper every other judge uses", () => {
    expect(PIPELINE).toContain("composeJudgeScope.noteJudged = (clipPath, _contentKey, at) => {");
    expect(PIPELINE).toContain('noteEligibleForJudgement(visualDedup, clipPath, "judged_at_push", at.sceneIndex, at.beatIndex);');
  });

  it("every push outcome is filed under the beat, at the one place all outcomes pass", () => {
    const fn = PIPELINE.slice(PIPELINE.indexOf("function tracePushOutcome("));
    expect(fn.slice(0, 900)).toContain("notePushOutcomeForBeat(");
  });
});
