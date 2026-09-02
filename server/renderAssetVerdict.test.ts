/**
 * THE MANIFEST REPORTED ANOTHER CLIP'S VERDICT.
 *
 * ── Two opposite answers about one file, in one render ──────────────────────────────────────
 *
 *     [BeatRelevance] s0b1 gate:archive fits clip=scene_0_b1_curated_a57383.mp4
 *       depicts="Street scene with people in front of a building marked 'Apteka'…"
 *     [RenderAsset] scene=0 beat=1 file=scene_0_b1_curated_a57383.mp4 verdict=does_not_fit
 *
 * Render 563. Same file, same beat, same log. The lookup behind the second line was:
 *
 *     for (const { ctx, decision } of ledger.byClipPath.values())
 *       if (ctx.sceneIndex === r.sceneIndex && ctx.beatIndex === r.beatIndex) return decision;
 *
 * It matched on the BEAT and nothing else, and returned the first entry in insertion order —
 * on a beat that judged several candidates, the first one looked at, which is usually one that
 * was rejected. The clip named on the line took no part in choosing the verdict printed on it.
 *
 * ── Why the harmless direction is not the one to worry about ────────────────────────────────
 *
 * Printing `does_not_fit` for a clip that was approved is noise. The same bug prints `fits` for a
 * clip nobody looked at — whenever a beat approved one candidate and adopted a different one —
 * and that is an audit line asserting that the picture in the delivered file was examined and
 * accepted when nothing of the sort happened.
 *
 * `[RenderAsset]` exists to answer one question: did anybody check what is in the video. An
 * answer assembled out of a different clip's judgement cannot answer it, and a wrong yes is worse
 * than no answer at all.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createBeatRelevanceLedger,
  relevanceVerdictForRenderedAsset,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";

const BEAT = "Martin Bormann sent an unexpected note that reached Berlin.";

/** The approved clip in render 563's log — the one the manifest misreported. */
const APTEKA = "/w/scene_0_b1_curated_a57383.mp4";
/** A candidate the same beat looked at first and refused. */
const REFUSED = "/w/scene_0_b1_curated_a11111.mp4";

function decision(
  verdict: BeatRelevanceDecision["verdict"],
  extra: Partial<BeatRelevanceDecision> = {}
): BeatRelevanceDecision {
  return {
    verdict,
    allowed: verdict !== "does_not_fit",
    reprieved: false,
    cached: false,
    depicts: "",
    reason: "",
    route: "archive",
    evaluated: true,
    ...extra,
  };
}

function judged(
  ledger: BeatRelevanceLedger,
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  d: BeatRelevanceDecision,
  contentKey?: string
): BeatRelevanceLedger {
  const entry = { ctx: { sceneIndex, beatIndex, beatText: BEAT }, decision: d };
  ledger.byClipPath.set(clipPath, entry);
  if (contentKey) ledger.byContentKey.set(contentKey, entry);
  return ledger;
}

/* ═══════════════════════ render 563, exactly ═══════════════════════ */

describe("the verdict belongs to the clip on the line", () => {
  /**
   * The beat refused one candidate and approved the Apteka clip. Insertion order put the refusal
   * first, which is the whole of what the old lookup returned.
   */
  it("reports the approved clip's own verdict, not the beat's first refusal", () => {
    const ledger = createBeatRelevanceLedger();
    judged(ledger, REFUSED, 0, 1, decision("does_not_fit"));
    judged(ledger, APTEKA, 0, 1, decision("fits"));

    const v = relevanceVerdictForRenderedAsset(ledger, {
      localPath: APTEKA,
      sceneIndex: 0,
      beatIndex: 1,
    });
    expect(v?.verdict, "the manifest still prints the refused candidate's verdict").toBe("fits");
    expect(v?.matchedBy).toBe("path");
  });

  /** And still reports a refusal when the refusal is about THIS clip. */
  it("does not hide a refusal that is really about this clip", () => {
    const ledger = judged(createBeatRelevanceLedger(), APTEKA, 0, 1, decision("does_not_fit"));
    const v = relevanceVerdictForRenderedAsset(ledger, {
      localPath: APTEKA,
      sceneIndex: 0,
      beatIndex: 1,
    });
    expect(v?.verdict).toBe("does_not_fit");
  });

  /**
   * THE DANGEROUS DIRECTION, and the reason this is worth fixing rather than tidying.
   *
   * A beat approves a candidate, then adopts a different clip that was never looked at. The old
   * lookup found the approval on that beat and printed `fits` against the unexamined clip.
   */
  it("never lends an approval to a clip nobody looked at", () => {
    const ledger = createBeatRelevanceLedger();
    judged(ledger, "/w/scene_0_b1_curated_other.mp4", 0, 1, decision("fits"));

    const v = relevanceVerdictForRenderedAsset(ledger, {
      localPath: APTEKA,
      sceneIndex: 0,
      beatIndex: 1,
    });
    expect(
      v,
      "an unexamined clip inherited another candidate's approval — the manifest claims it was checked"
    ).toBeNull();
  });

  /**
   * A verdict earned under different narration is about that narration. The gate re-judges a clip
   * reused on another beat for exactly this reason; the manifest must not pre-empt it.
   */
  it("does not carry a verdict across beats", () => {
    const ledger = judged(createBeatRelevanceLedger(), APTEKA, 0, 1, decision("fits"));
    expect(
      relevanceVerdictForRenderedAsset(ledger, { localPath: APTEKA, sceneIndex: 1, beatIndex: 2 })
    ).toBeNull();
  });

  /** Nothing judged at all is null, which the manifest already prints as never_asked. */
  it("says nothing when the ledger holds nothing", () => {
    expect(
      relevanceVerdictForRenderedAsset(createBeatRelevanceLedger(), {
        localPath: APTEKA,
        sceneIndex: 0,
        beatIndex: 1,
      })
    ).toBeNull();
    expect(
      relevanceVerdictForRenderedAsset(undefined, { sceneIndex: 0, beatIndex: 1 })
    ).toBeNull();
  });
});

/* ═══════════════════════ the same clip under a new name ═══════════════════════ */

describe("a clip renamed between the look and the render", () => {
  /**
   * A clip is judged, then trimmed, then has an overlay burned in, and each step writes a new
   * file. Content identity is what survives that — the ledger keeps it for precisely this — so a
   * rename must not turn an examined clip into `never_asked`.
   */
  it("is found by its content identity", () => {
    const ledger = createBeatRelevanceLedger();
    judged(ledger, "/w/pre_trim.mp4", 0, 1, decision("fits"), "archive:57383");

    const v = relevanceVerdictForRenderedAsset(ledger, {
      localPath: "/w/scene_0_b1_curated_a57383_trimmed.mp4",
      contentKey: "archive:57383",
      sceneIndex: 0,
      beatIndex: 1,
    });
    expect(v?.verdict).toBe("fits");
    expect(v?.matchedBy).toBe("content");
  });

  /** And by filename when only the directory changed. */
  it("is found by filename across directories", () => {
    const ledger = judged(
      createBeatRelevanceLedger(),
      "/tmp/a/scene_0_b1_curated_a57383.mp4",
      0,
      1,
      decision("fits")
    );
    const v = relevanceVerdictForRenderedAsset(ledger, {
      currentFilename: "scene_0_b1_curated_a57383.mp4",
      sceneIndex: 0,
      beatIndex: 1,
    });
    expect(v?.verdict).toBe("fits");
    expect(v?.matchedBy).toBe("filename");
  });

  /** A content key from another beat is still another beat's answer. */
  it("does not let content identity cross a beat either", () => {
    const ledger = createBeatRelevanceLedger();
    judged(ledger, "/w/pre_trim.mp4", 0, 1, decision("fits"), "archive:57383");
    expect(
      relevanceVerdictForRenderedAsset(ledger, {
        contentKey: "archive:57383",
        sceneIndex: 2,
        beatIndex: 0,
      })
    ).toBeNull();
  });
});

/* ═══════════════════════ the manifest actually uses it ═══════════════════════ */

describe("the render's manifest asks the right question", () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("looks the verdict up by clip, through the shared function", () => {
    expect(CODE, "the manifest no longer resolves a verdict at all").toContain(
      "relevanceVerdictForRenderedAsset(visualDedup.beatRelevance, r)"
    );
  });

  /** The scan that caused it must not come back — in the manifest or anywhere else. */
  it("does not scan the ledger for the first entry on a beat", () => {
    expect(
      CODE,
      "a beat-only scan of the relevance ledger is back; that is how one clip's verdict " +
        "gets printed against another clip's line"
    ).not.toContain("for (const { ctx, decision } of visualDedup.beatRelevance.byClipPath.values())");
  });
});
