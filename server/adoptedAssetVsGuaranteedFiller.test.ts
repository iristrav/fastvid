/**
 * WHY A BEAT WITH AN ADOPTED ASSET STILL GOT A GUARANTEED FILLER.
 *
 * ── The chain, traced in code for VID-0567 s0b0 ─────────────────────────────────────────────
 *
 * `scene_0_slot100_guaranteed.mp4` is named by `generateGuaranteedBeatClip(sceneIndex, slotIndex…)`
 * as `scene_${sceneIndex}_slot${slotIndex}_guaranteed.mp4`, and its only callers that produce a
 * slot of 100 pass `beat.index + attempt * 100` — beat 0, attempt 1. Both sit inside
 * `rescueBeatVisualWhenEmptyInner`.
 *
 * That rescue is reached from `if (!clipBeatIndices.includes(beat.index))`. `clipBeatIndices` is
 * appended in exactly one kind of place: `pushSceneClip`, right after a clip is accepted. So the
 * beat is "empty" precisely when no clip was ACCEPTED for it — which is a different question from
 * whether one was adopted.
 *
 * And the two are genuinely separable, in this order:
 *
 *   1. the funnel records ADOPTED on the ledger                        (videoPipeline ~33368)
 *   2. `await pushClip(clip)` — the boolean is DISCARDED               (~33942, ~33964, ~34039)
 *   3. `pushSceneClip` refuses: relevance barrier, or duplicate        (4 definitions)
 *   4. no `clipBeatIndices.push`, so the beat reads as empty
 *   5. `rescueBeatVisualWhenEmptyInner` → guaranteed filler
 *
 * An asset can therefore be adopted and still never reach the film, and before this round nothing
 * on either the ledger or the beat tally said so.
 *
 * ── What is fixed, and what is deliberately left alone ──────────────────────────────────────
 *
 * The refusal is now recorded twice over: on the ledger (a terminal outcome, so the asset stops
 * being a silent disappearance) and on the beat's own reject tally — which is what the placeholder
 * decision prints. That line used to read
 *
 *     [VisualCoverage] s0b0: rejected=0 topRejects=none … (all real/contextual/AI sourcing
 *                      strategies exhausted)
 *
 * for a beat where a YouTube clip had been found, downloaded, judged `fits`, selected and adopted.
 * Nothing was exhausted. `rejected=0` is how a beat that was never offered anything looks, so the
 * line described the opposite of what happened.
 *
 * The clip is STILL refused. A barrier that judged this footage wrong for this narration made an
 * editorial decision, and forcing it into the film to avoid a placeholder would be turning a
 * blocking problem into a non-blocking one. The filler stays; it can now be explained.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  createClipRejectAudit,
  recordClipReject,
  beatRejectCount,
  beatRejectReasons,
} from "./clipRejectAudit";
import { VisualSourceLedger } from "./visualSourceLineage";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════ the beat tally now explains the filler ═══════════════ */

describe("a refused adopted asset is visible to the placeholder decision", () => {
  /**
   * Behaviour, not spelling: the counters the `[VisualCoverage]` line reads must change when a
   * push refusal is recorded. Before, they could not — nothing wrote them from that gate.
   */
  it("turns rejected=0 into a real count with a real reason", () => {
    const audit = createClipRejectAudit();
    expect(beatRejectCount(audit, 0, 0)).toBe(0);
    expect(beatRejectReasons(audit, 0, 0)).toEqual([]);

    recordClipReject(audit, 0, 0, "/w/scene_0_ytcc_0__pid_youtube_cc-d5d161a4db2fca58_transformed.mp4", "off_subject");

    expect(beatRejectCount(audit, 0, 0)).toBe(1);
    const [top] = beatRejectReasons(audit, 0, 0);
    expect(top[0]).toBe("off_subject");
    expect(top[1]).toBe(1);
  });

  /** The tally is per beat, so one refused beat cannot explain away a different one. */
  it("does not leak a refusal onto a neighbouring beat", () => {
    const audit = createClipRejectAudit();
    recordClipReject(audit, 0, 0, "/w/a.mp4", "off_subject");
    expect(beatRejectCount(audit, 0, 0)).toBe(1);
    expect(beatRejectCount(audit, 0, 1)).toBe(0);
    expect(beatRejectCount(audit, 1, 0)).toBe(0);
  });
});

/* ═══════════════ and the ledger keeps a terminal outcome ═══════════════ */

describe("an adopted asset refused at the push is not a silent disappearance", () => {
  const adoptedYoutubeClip = () => {
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 567 });
    const rec = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "youtube_cc:d5d161a4db2fca58",
      contentKey: "youtube_cc:d5d161a4db2fca58",
      provider: "youtube_cc",
      providerAssetId: "d5d161a4db2fca58",
      localPath: "/w/yt.mp4",
      mediaType: "video",
      route: "primary",
    });
    ledger.recordEvent(rec.lineageId, "SELECTED", { status: "OK" });
    ledger.recordEvent(rec.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/yt.mp4" });
    return { ledger, rec };
  };

  it("the adopted-but-unpushed state is what the audit called DROPPED_WITHOUT_EVENT", async () => {
    const { formatSelectedButNotRendered } = await import("./visualSourceLineage");
    const { ledger } = adoptedYoutubeClip();
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain("reachedAssigned=true");
    expect(line).toContain("DROPPED_WITHOUT_EVENT");
  });

  it("recording the refusal gives the asset an ending", () => {
    const { ledger } = adoptedYoutubeClip();
    expect(
      ledger.recordRejection("/w/yt.mp4", "off_subject", "youtube_cc:d5d161a4db2fca58")
    ).toBe(true);
    expect(ledger.hasOutcomeFor("/w/yt.mp4", "youtube_cc:d5d161a4db2fca58")).toBe(true);
  });

  /** The provider survives the refusal, so the report can name what was turned away. */
  it("keeps the canonical identity, not a path", () => {
    const { ledger } = adoptedYoutubeClip();
    ledger.recordRejection("/w/yt.mp4", "off_subject", "youtube_cc:d5d161a4db2fca58");
    const r = ledger.resolve("/w/yt.mp4", "youtube_cc:d5d161a4db2fca58");
    expect(r?.provider).toBe("youtube_cc");
    expect(r?.providerAssetId).toBe("d5d161a4db2fca58");
  });
});

/* ═══════════════ the traced chain stays wired ═══════════════ */

describe("the guaranteed filler is still reached the way this audit traced it", () => {
  /** If this naming changes, the trace above stops matching the file it explains. */
  it("names the filler from scene and slot", () => {
    expect(SRC).toContain("`scene_${sceneIndex}_slot${slotIndex}_guaranteed.mp4`");
  });

  /** slot 100 = beat 0, attempt 1 — the arithmetic that identified the call site. */
  it("derives the slot from the beat and the attempt", () => {
    expect(SRC).toContain("beat.index + attempt * 100");
  });

  /** The emptiness test is membership of clipBeatIndices, never a count or an index. */
  it("decides emptiness from clipBeatIndices membership", () => {
    expect(SRC).toContain("if (!clipBeatIndices.includes(beat.index))");
  });

  /** And that array is only ever appended where a clip is accepted. */
  it("fills clipBeatIndices only on acceptance", () => {
    const pushes = SRC.match(/clipBeatIndices\.push\(/g) ?? [];
    expect(pushes.length).toBeGreaterThanOrEqual(4);
    // No route may empty it behind the beat loop's back.
    expect(SRC).not.toContain("clipBeatIndices.splice(");
    expect(SRC).not.toContain("clipBeatIndices.length = 0");
  });

  /** Both push refusals feed the tally the placeholder line reads. */
  it("both refusals record on the beat tally", () => {
    const at = SRC.indexOf("async function beatClipRefusedByRelevanceGate(");
    const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("return true;", at)));
    expect(body).toContain("recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, clipPath, barrier.reason)");
    const dup = SRC.indexOf("function noteDuplicateClipRefused(");
    expect(SRC.slice(dup, dup + 800)).toContain("recordClipReject(");
  });
});
