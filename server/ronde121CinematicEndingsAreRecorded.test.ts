/**
 * RONDE 121 — THE PLANNER'S TWO ENDINGS, WRITTEN DOWN.
 *
 * ── What RONDE 120's census found ───────────────────────────────────────────────────────────
 *
 * `CINEMATIC_SELECTED` and `CINEMATIC_DROPPED` are declared stages of a clip's life, and nothing
 * in production wrote either — in any render, ever. So `lifecyclesOf` reported both as false for
 * every asset, while render 572 dropped six of twelve beats at exactly that step:
 *
 *     [CinematicPipeline] dropped s1b0: adopted clip has no rehydratable identity
 *     [CinematicDrop] scene=1 beat=0 ... reason=NOT_REHYDRATABLE
 *
 * The console said it. The ledger did not. A clip the planner dropped therefore reached the audit
 * with no ending at all and joined the `unexplained` — and `hasTerminalOutcome` had ALREADY been
 * written to treat CINEMATIC_DROPPED as an ending. The rule was waiting for a caller.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * That the planner announces every beat's ending, that the announcement carries the identity the
 * ledger needs, and that a dropped clip is consequently explained rather than vanished. The
 * planner still knows nothing about lineage: it calls a function it was handed.
 */
import { describe, expect, it } from "vitest";

import {
  buildCinematicSceneInputs,
  type CinematicBeatOutcome,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { VisualSourceLedger } from "./visualSourceLineage";

const CLIP = "/w/scene_0_b0_curated_a57364.mp4";

function scene(over: Partial<SceneFacts> = {}): SceneFacts {
  return {
    scene: { index: 0, text: "berlin, april 1945" } as never,
    beats: [{ index: 0, text: "berlin, april 1945", holdSec: 4, voiceStartSec: 0, voiceEndSec: 4 }],
    clips: [
      {
        facts: { localPath: CLIP, durationSec: 6, kind: "video" },
        adoption: { provider: "ww2", providerAssetId: "57364", archiveAssetId: 57364 },
      },
    ],
    ...over,
  };
}

function outcomesOf(facts: SceneFacts): CinematicBeatOutcome[] {
  const seen: CinematicBeatOutcome[] = [];
  buildCinematicSceneInputs({ scenes: [facts], onBeatOutcome: (o) => seen.push(o) });
  return seen;
}

describe("every beat the planner decides announces its ending", () => {
  it("a planned beat is announced as SELECTED, with the file it was planned around", () => {
    const [outcome, ...rest] = outcomesOf(scene());
    expect(outcome).toMatchObject({
      stage: "CINEMATIC_SELECTED",
      clipPath: CLIP,
      sceneIndex: 0,
      beatIndex: 0,
    });
    expect(rest).toEqual([]);
  });

  it("a clip with no rehydratable identity is announced as DROPPED, and names why", () => {
    /** `provider: null` is what a subject card looks like — no identity to fetch it back with. */
    const facts = scene();
    facts.clips[0]!.adoption = { provider: null };
    const [outcome] = outcomesOf(facts);
    expect(outcome).toMatchObject({
      stage: "CINEMATIC_DROPPED",
      clipPath: CLIP,
      reason: "NOT_REHYDRATABLE",
    });
  });

  it("a beat with no adopted clip is announced too, with no file to name", () => {
    const facts = scene({ clips: [null] });
    const [outcome] = outcomesOf(facts);
    expect(outcome).toMatchObject({
      stage: "CINEMATIC_DROPPED",
      clipPath: null,
      reason: "NO_ADOPTED_CLIP",
    });
  });

  it("the sink is optional — a caller that wants no announcement gets the old behaviour", () => {
    const before = buildCinematicSceneInputs({ scenes: [scene()] });
    const after = buildCinematicSceneInputs({ scenes: [scene()], onBeatOutcome: () => {} });
    expect(after.dropped).toEqual(before.dropped);
    expect(after.stats).toEqual(before.stats);
    expect(after.scenes.length).toBe(before.scenes.length);
  });
});

/* ═══════════════ the ending reaches the ledger, and explains the clip ═══════════════ */

describe("a dropped clip is explained instead of vanished", () => {
  /** The writer `videoPipeline` installs, reproduced exactly: path in, stage filed. */
  const writerFor = (ledger: VisualSourceLedger) => (o: CinematicBeatOutcome) => {
    if (!o.clipPath) return;
    ledger.recordEventForPath(o.clipPath, o.stage, { status: "OK", reason: o.reason });
  };

  function ledgerWithSelectedClip(): VisualSourceLedger {
    const ledger = new VisualSourceLedger({ renderId: "r121", videoId: 574 });
    const record = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "ww2:57364",
      contentKey: "ww2:57364",
      provider: "ww2",
      providerAssetId: "57364",
      localPath: CLIP,
      mediaType: "video",
      route: "primary",
    });
    ledger.recordEvent(record.lineageId, "SELECTED", { status: "OK" });
    return ledger;
  }

  it("without the ending it VANISHED_WITHOUT_OUTCOME — the shape render 572 reported", () => {
    const ledger = ledgerWithSelectedClip();
    ledger.markFinalVideo([]);
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("with it, the same clip is accounted for", () => {
    const ledger = ledgerWithSelectedClip();
    const facts = scene();
    facts.clips[0]!.adoption = { provider: null };
    buildCinematicSceneInputs({ scenes: [facts], onBeatOutcome: writerFor(ledger) });
    ledger.markFinalVideo([]);
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).not.toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("CINEMATIC_DROPPED counts as a terminal outcome, which the rule already said", () => {
    const ledger = ledgerWithSelectedClip();
    const facts = scene();
    facts.clips[0]!.adoption = { provider: null };
    buildCinematicSceneInputs({ scenes: [facts], onBeatOutcome: writerFor(ledger) });
    const invariant = ledger.allEvents().filter((e) => e.stage === "CINEMATIC_DROPPED");
    expect(invariant).toHaveLength(1);
    expect(invariant[0]!.reason).toBe("NOT_REHYDRATABLE");
  });

  it("a SELECTED beat is filed as progress, not as an ending", () => {
    const ledger = ledgerWithSelectedClip();
    buildCinematicSceneInputs({ scenes: [scene()], onBeatOutcome: writerFor(ledger) });
    const stages = ledger.allEvents().map((e) => e.stage);
    expect(stages).toContain("CINEMATIC_SELECTED");
    expect(stages).not.toContain("CINEMATIC_DROPPED");
    /**
     * And it must NOT silence the vanished rule: a clip the planner kept still has to reach the
     * final video, or say why not. Turning selection into an ending would hide exactly that.
     */
    ledger.markFinalVideo([]);
    expect(ledger.reconcile().warnings.map((w) => w.code)).toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("a path the ledger never saw writes nothing rather than inventing a record", () => {
    const ledger = new VisualSourceLedger({ renderId: "r121b", videoId: 574 });
    buildCinematicSceneInputs({ scenes: [scene()], onBeatOutcome: writerFor(ledger) });
    expect(ledger.allEvents()).toEqual([]);
  });
});
