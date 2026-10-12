/**
 * VIDEO 646 — THE YOUTUBE LIFECYCLE REPORT SAID FOUR THINGS THE RECORD DID NOT SUPPORT.
 *
 * The render was refused by the DeliveryGate (voice timing estimated, chapter cards as placeholder),
 * and the lifecycle trace printed beside that refusal:
 *
 *   A  24 of 24 rows CONTENT_KEY_NOT_ASSET_IDENTITY, FIT=UNKNOWN, VERDICT INCONCLUSIVE — while the
 *      verdicts sat in the relevance ledger under the very keys the rows carried: the production
 *      fragment key `youtube_cc:<16 hex>@t<ms>d<sec>` (VIDEO 620), which the identity regex refused.
 *   B  two render inputs RENDER_INPUT_NOT_IN_FINAL — "not in the film" about a film nobody checked,
 *      because FINAL_VIDEO is proven only inside `if (jobOutcome.ok)`.
 *   C  s2b2's first FIT ADOPTED_NO_TERMINAL_OUTCOME missingStage=TRIMMED — the sentence had gone on
 *      with its second FIT, and nothing filed the hand-off on the loser.
 *   D  s1b2's clip REJECTED_AFTER_ADOPTION reason=file_missing — the refusal of another sentence's
 *      copy of the same moment, folded into the adopted clip's history and read as its ending,
 *      although the clip went on to CINEMATIC_SELECTED and RENDER_INPUT.
 *
 * Each test here reproduces one of those shapes from the ledgers alone and asks for the answer the
 * record supports. No gate, budget or coverage rule is touched by the code under test.
 */
import { describe, expect, it, vi } from "vitest";

import { VisualSourceLedger, recordAssetOutcome, type LineageStage } from "./visualSourceLineage";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";
import { beatRelevanceBeatKey } from "./beatVisualRelevance";
import {
  YOUTUBE_PROVIDER,
  YOUTUBE_ASSET_IDENTITY_RE,
  isYoutubeAssetIdentityKey,
  traceYoutubeLifecycle,
  youtubeLifecycleTotals,
  youtubeLifecycleVerdict,
  youtubeLifecycleViolations,
  formatYoutubeLifecycle,
} from "./youtubeLifecycleTrace";
import { formatFitChainLine, noteApprovedPickForBeat, recordReplacedApprovals } from "./videoPipeline";

/* ═══════════════════════ the harness, as the existing trace tests build it ═══════════════════════ */

const HEX = "acc0dfc922f30224";
/** The production key `clipContentKey` returns for a fetched YouTube moment since VIDEO 620. */
const fragment = (ms: number, sec = 40) => `${YOUTUBE_PROVIDER}:${HEX}@t${ms}d${sec}`;
/** The pre-620 whole-video key, still written by `providerAssetKey`. */
const whole = `${YOUTUBE_PROVIDER}:${HEX}`;

const decision = (over: Partial<BeatRelevanceDecision> = {}): BeatRelevanceDecision =>
  ({ verdict: "fits", allowed: true, reprieved: false, cached: false, depicts: "", reason: "", route: "adopt", evaluated: true, ...over }) as BeatRelevanceDecision;

const emptyRelevance = (): BeatRelevanceLedger =>
  ({ byClipPath: new Map(), byContentKey: new Map(), byBeat: new Map(), spendByBeat: new Map(), finalSayRetried: new Set() }) as unknown as BeatRelevanceLedger;

const fitFor = (ledger: BeatRelevanceLedger, scene: number, beat: number, contentKey: string, d: Partial<BeatRelevanceDecision> = {}) => {
  ledger.byBeat.set(beatRelevanceBeatKey(scene, beat, "content", contentKey), { ctx: {} as never, decision: decision(d) });
  return ledger;
};

type Filed = LineageStage | [LineageStage, { status?: string; reason?: string; gate?: string; sceneIndex?: number; beatIndex?: number }];

const file = (ledger: VisualSourceLedger, lineageId: string, filed: Filed[]) => {
  for (const entry of filed) {
    const [stage, opts] = Array.isArray(entry) ? entry : [entry, {}];
    ledger.recordEvent(lineageId, stage, opts as never);
  }
};

const FOUND_TO_ADOPTED: Filed[] = ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED", "ADOPTED"];

/** One root record for a moment, as `fetchYouTubeCCClips` names its file. */
const root = (ledger: VisualSourceLedger, contentKey: string, scene: number, beat: number, n = 0) =>
  ledger.createLineage({
    sceneIndex: scene,
    beatIndex: beat,
    candidateId: contentKey,
    contentKey,
    localPath: `/w/scene_${scene}_ytfu_0m${n}_${contentKey.split("@")[1] ?? "t0d0"}__pid_youtube_cc-${HEX}.mp4`,
    provider: YOUTUBE_PROVIDER,
    providerAssetId: "YRvf00NooN8",
  });

/** The copy of that moment transformed for one sentence — the record ADOPTED is filed on in production. */
const copyFor = (ledger: VisualSourceLedger, parentLineageId: string, contentKey: string, scene: number, beat: number, tag: string) =>
  ledger.createLineage({
    sceneIndex: scene,
    beatIndex: beat,
    candidateId: `${contentKey}#${tag}`,
    contentKey,
    localPath: `/w/scene_${scene}_${tag}_${contentKey.split("@")[1] ?? "t0d0"}__pid_youtube_cc-${HEX}_transformed.mp4`,
    parentLineageId,
  });

/* ═══════════════════════ A — the fragment key is this asset's identity ═══════════════════════ */

describe("VIDEO 646 A — both key shapes a YouTube record legitimately carries are accepted, nothing else", () => {
  it.each([whole, fragment(5769), fragment(5830, 40), fragment(0, 1), `${YOUTUBE_PROVIDER}:0123456789abcdef@t1000d40`])(
    "%s names the asset",
    (key) => {
      expect(isYoutubeAssetIdentityKey(key)).toBe(true);
      expect(YOUTUBE_ASSET_IDENTITY_RE.test(key)).toBe(true);
    }
  );

  it.each([
    `${YOUTUBE_PROVIDER}:acc0dfc922f3022`, // 15 hex
    `${YOUTUBE_PROVIDER}:acc0dfc922f302244`, // 17 hex
    `${YOUTUBE_PROVIDER}:ACC0DFC922F30224`, // uppercase
    `${YOUTUBE_PROVIDER}:acc0dfc922f3022g`, // not hex
    `${YOUTUBE_PROVIDER}:${HEX}@t`, // bare fragment marker
    `${YOUTUBE_PROVIDER}:${HEX}@t5769`, // no duration
    `${YOUTUBE_PROVIDER}:${HEX}@t5769d`, // empty duration
    `${YOUTUBE_PROVIDER}:${HEX}@t5769d4.5`, // decimal
    `${YOUTUBE_PROVIDER}:${HEX}@t5769d40x`, // stray suffix
    `${YOUTUBE_PROVIDER}:${HEX}#trim`, // another suffix
    `${YOUTUBE_PROVIDER}:${HEX}@t-5d40`, // sign
    `pexels:${HEX}@t5769d40`, // another provider
    `file:4210233:scene_2_b1.mp4`,
    `stock:vid:7`,
    `scene_2_b1.mp4`,
    "",
  ])("%s does not", (key) => {
    expect(isYoutubeAssetIdentityKey(key)).toBe(false);
  });

  it("two moments of one video stay two identities — a fragment is never folded to its video", () => {
    expect(fragment(5769)).not.toBe(fragment(5830));
    expect(isYoutubeAssetIdentityKey(fragment(5769)) && isYoutubeAssetIdentityKey(fragment(5830))).toBe(true);
  });

  it("a ledger keyed with the production fragment key links the FIT the picture editor filed under it", () => {
    const k = fragment(5769);
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, k, 2, 2);
    file(ledger, r.lineageId, [...FOUND_TO_ADOPTED, "CINEMATIC_SELECTED", "RENDER_INPUT", "FINAL_VIDEO"]);
    const rows = traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 2, 2, k));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vision).toBe("FIT");
    expect(rows[0]!.visionFromOwnBeat).toBe(true);
    expect(rows[0]!.approvedForThisBeat).toBe(true);
    expect(rows[0]!.status).toBe("FINAL");
    const t = youtubeLifecycleTotals(rows);
    expect(t.youtubeContentKeyNotAssetIdentity).toBe(0);
    expect(t.youtubeVisionFitForThisBeat).toBe(1);
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
  });

  it("the verdict for one moment is not read as the verdict for another moment of the same video", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    file(ledger, root(ledger, fragment(5769), 2, 2, 1).lineageId, FOUND_TO_ADOPTED);
    file(ledger, root(ledger, fragment(5830), 2, 2, 2).lineageId, FOUND_TO_ADOPTED);
    const rel = fitFor(emptyRelevance(), 2, 2, fragment(5830));
    fitFor(rel, 2, 2, fragment(5769), { verdict: "does_not_fit", allowed: false });
    const rows = traceYoutubeLifecycle(ledger, rel);
    const byKey = new Map(rows.map((r) => [r.contentKey, r.vision]));
    expect(byKey.get(fragment(5830))).toBe("FIT");
    expect(byKey.get(fragment(5769))).toBe("MISMATCH");
  });

  it("a MISMATCH under a fragment key is MISMATCH, and a missing record is VISION_RECORD_MISSING — never NOT_ASSET_IDENTITY", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    file(ledger, root(ledger, fragment(5605), 1, 2).lineageId, ["ELIGIBLE", "RANKED"]);
    expect(traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 1, 2, fragment(5605), { verdict: "does_not_fit", allowed: false }))[0]!.vision).toBe("MISMATCH");
    expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.vision).toBe("VISION_RECORD_MISSING");
  });

  it("[FitChain] prints the linked FIT count for a render whose rows all carry fragment keys", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    file(ledger, root(ledger, fragment(5769), 2, 2).lineageId, [...FOUND_TO_ADOPTED, "CINEMATIC_SELECTED", "RENDER_INPUT"]);
    ledger.markFinalVideo([]);
    const totals = youtubeLifecycleTotals(traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 2, 2, fragment(5769))));
    const line = formatFitChainLine({ approved: 1, placed: 1 }, totals, 6);
    expect(line).toContain("FIT=1 ");
    expect(line).not.toContain("UNKNOWN(");
  });

  it("the lower rungs of the key ladder are still refused as identity", () => {
    for (const k of ["file:4210233:scene_2_b1.mp4", "stock:vid:7", "still:abc123"]) {
      const ledger = new VisualSourceLedger({ renderId: "r646" });
      const r = ledger.createLineage({ sceneIndex: 0, beatIndex: 0, candidateId: k, contentKey: k, localPath: "/w/x.mp4", provider: YOUTUBE_PROVIDER, providerAssetId: "v" });
      file(ledger, r.lineageId, ["ADOPTED"]);
      expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.vision).toBe("CONTENT_KEY_NOT_ASSET_IDENTITY");
    }
  });
});

/* ═══════════════════════ B — a refused delivery is not a lost picture ═══════════════════════ */

describe("VIDEO 646 B — render input, checked film and delivered film are three different facts", () => {
  const renderInput = (scene: number, beat: number, key: string) => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, key, scene, beat);
    file(ledger, r.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const c = copyFor(ledger, r.lineageId, key, scene, beat, "copy");
    file(ledger, c.lineageId, ["TRANSFORMED", "ADOPTED", "CINEMATIC_SELECTED", "RENDER_INPUT"]);
    return { ledger, copyPath: c.localPath };
  };

  it("the gate refused the film: RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN, the refusal quoted, no violation", () => {
    const { ledger } = renderInput(2, 2, fragment(5830));
    const rows = traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 2, 2, fragment(5830)), {
      refusal: "RENDER_FAILED — DeliveryGate: SENTENCE_COVERAGE_UNPROVEN ×12, PLACEHOLDER_IN_FILE",
    });
    const r = rows[0]!;
    expect(r.render).toBe("INPUT");
    expect(r.finalVideo).toBe(false);
    expect(r.finalVideoProven).toBe(false);
    expect(r.status).toBe("RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN");
    expect(r.reason).toBe("delivery not proven: RENDER_FAILED — DeliveryGate: SENTENCE_COVERAGE_UNPROVEN ×12, PLACEHOLDER_IN_FILE");
    expect(r.violation).toBeNull();
    /** The gap stays visible: the row stops at RENDER_INPUT and names what was expected next. */
    expect(r.lastKnownStage).toBe("RENDER_INPUT");
    expect(r.missingStage).toBe("FINAL_VIDEO");
    expect(youtubeLifecycleViolations(rows)).toEqual([]);
    /** An APPROVED render input with an unproven delivery is not a vanished picture. */
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
    expect(formatYoutubeLifecycle(rows)[0]).toContain("status=RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN reason=delivery not proven:");
  });

  it("without a refusal text the row still says that no delivered file was checked", () => {
    const { ledger } = renderInput(2, 3, fragment(5697));
    const r = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(r.status).toBe("RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN");
    expect(r.reason).toBe("delivery not proven: no delivered file was checked");
  });

  it("a delivered film that holds the clip: FINAL, as before", () => {
    const { ledger, copyPath } = renderInput(2, 2, fragment(5830));
    expect(ledger.replaceFinalVideo([copyPath])).toBe(1);
    const r = traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 2, 2, fragment(5830)))[0]!;
    expect(r.status).toBe("FINAL");
    expect(r.finalVideo).toBe(true);
    expect(r.finalVideoProven).toBe(true);
  });

  it("a delivered film that was checked and does NOT hold the clip is still RENDER_INPUT_NOT_IN_FINAL", () => {
    const { ledger } = renderInput(2, 2, fragment(5830));
    ledger.replaceFinalVideo(["/w/some_other_clip.mp4"]);
    const r = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(r.finalVideoProven).toBe(true);
    expect(r.status).toBe("RENDER_INPUT_NOT_IN_FINAL");
    expect(r.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
  });

  it("an APPROVED clip missing from a CHECKED film is still the finding this module exists for", () => {
    const { ledger } = renderInput(2, 2, fragment(5830));
    ledger.markFinalVideo([]);
    const rows = traceYoutubeLifecycle(ledger, fitFor(emptyRelevance(), 2, 2, fragment(5830)));
    expect(rows[0]!.status).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    expect(youtubeLifecycleVerdict(rows)).toBe("YES");
  });

  it("the totals keep the unproven render inputs apart from the proven film, and [FitChain] says NOT_PROVEN instead of 0", () => {
    const { ledger } = renderInput(2, 2, fragment(5830));
    const b = root(ledger, fragment(5697), 2, 3, 2);
    file(ledger, b.lineageId, [...FOUND_TO_ADOPTED, "CINEMATIC_SELECTED", "RENDER_INPUT"]);
    const refused = youtubeLifecycleTotals(traceYoutubeLifecycle(ledger, emptyRelevance(), { refusal: "gate" }));
    expect(refused.youtubeRenderInput).toBe(2);
    expect(refused.youtubeFinalVideo).toBe(0);
    expect(refused.youtubeFinalVideoProven).toBe(0);
    expect(refused.youtubeRenderInputFinalVideoNotProven).toBe(2);
    const line = formatFitChainLine({ approved: 2, placed: 2 }, refused, 6);
    expect(line).toContain("RENDER=2 FINAL_VIDEO=NOT_PROVEN(2 render input(s); no delivered file was checked)");
    expect(line).not.toContain("FINAL_VIDEO=0");

    ledger.markFinalVideo([b.localPath]);
    const delivered = youtubeLifecycleTotals(traceYoutubeLifecycle(ledger, emptyRelevance()));
    expect(delivered.youtubeFinalVideoProven).toBe(1);
    expect(delivered.youtubeRenderInputFinalVideoNotProven).toBe(0);
    expect(delivered.youtubeFinalVideo).toBe(1);
    expect(formatFitChainLine({ approved: 2, placed: 2 }, delivered, 6)).toContain("RENDER=2 FINAL_VIDEO=1 ");
  });

  it("a render with no YouTube render input has nothing unproven: FINAL_VIDEO prints its count, not NOT_PROVEN", () => {
    /** No YouTube rows at all (a delivered film from other sources). */
    const none = youtubeLifecycleTotals(traceYoutubeLifecycle(new VisualSourceLedger({ renderId: "r646" }), emptyRelevance(), { refusal: "gate" }));
    expect(none.youtubeFinalVideoProven).toBe(1);
    expect(none.youtubeRenderInputFinalVideoNotProven).toBe(0);
    expect(formatFitChainLine({ approved: 0, placed: 0 }, none, 0)).toContain("RENDER=0 FINAL_VIDEO=0 ");
    /** Rows, delivery unproven, but none reached the renderer: still a plain count. */
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    file(ledger, root(ledger, fragment(5769), 2, 2).lineageId, [...FOUND_TO_ADOPTED, "TRANSFORMED"]);
    const unproven = youtubeLifecycleTotals(traceYoutubeLifecycle(ledger, emptyRelevance(), { refusal: "gate" }));
    expect(unproven.youtubeFinalVideoProven).toBe(0);
    expect(unproven.youtubeRenderInputFinalVideoNotProven).toBe(0);
    expect(formatFitChainLine({ approved: 1, placed: 0 }, unproven, 1)).toContain("RENDER=0 FINAL_VIDEO=0 ");
  });

  it("totals that predate the proof field (older callers, older tests) print the count as before", () => {
    const yt = { youtubeTracked: 3, youtubeContentKeyNotAssetIdentity: 0, youtubeVisionFitForThisBeat: 3, youtubeAdopted: 3, youtubeCinematicSelected: 2, youtubeRenderInput: 2, youtubeFinalVideo: 2, youtubeVanishedAfterAdoption: 0, youtubeDownstreamGap: 1 };
    expect(formatFitChainLine({ approved: 3, placed: 2 }, yt, 9)).toContain("FINAL_VIDEO=2 ");
  });

  it("a clip that never reached the renderer is not re-labelled by the missing proof", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    file(ledger, root(ledger, fragment(5769), 2, 2).lineageId, [...FOUND_TO_ADOPTED, "TRANSFORMED"]);
    const r = traceYoutubeLifecycle(ledger, emptyRelevance(), { refusal: "gate" })[0]!;
    expect(r.status).toBe("ADOPTED_NO_TERMINAL_OUTCOME");
    expect(r.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
  });
});

/* ═══════════════════════ C — the loser of two approvals is filed as replaced ═══════════════════════ */

describe("VIDEO 646 C — an approved clip whose sentence took another picture gets its ending", () => {
  const LOSER = fragment(5769);
  const WINNER = fragment(5830);
  const S = 2;
  const B = 2;

  /** s2b2 of render 646: two FITs adopted for one sentence, the film holds the second. */
  const scenario = () => {
    const dedup = {};
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const loserRoot = root(ledger, LOSER, S, B, 1);
    file(ledger, loserRoot.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const loser = copyFor(ledger, loserRoot.lineageId, LOSER, S, B, "ytfu_0m1");
    file(ledger, loser.lineageId, ["TRANSFORMED", "ADOPTED"]);
    const winnerRoot = root(ledger, WINNER, S, B, 2);
    file(ledger, winnerRoot.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const winner = copyFor(ledger, winnerRoot.lineageId, WINNER, S, B, "ytfu_0m2");
    file(ledger, winner.lineageId, ["TRANSFORMED", "ADOPTED", "CINEMATIC_SELECTED", "RENDER_INPUT"]);
    noteApprovedPickForBeat(dedup, S, B, LOSER);
    noteApprovedPickForBeat(dedup, S, B, WINNER);
    const placed = () => new Set([WINNER]);
    return { dedup, ledger, loser, winner, placed };
  };
  const sentences = [{ sceneIndex: S, beatIndex: B }];
  const replacedEvents = (ledger: VisualSourceLedger) => ledger.allEvents().filter((e) => e.stage === "REPLACED");

  it("the loser is filed replaced_by_candidate with the winner named; the winner is untouched", () => {
    const { dedup, ledger, loser, winner, placed } = scenario();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const filed = recordReplacedApprovals(dedup, sentences, placed, ledger);
      expect(filed).toEqual([{ sceneIndex: S, beatIndex: B, loser: LOSER, winner: WINNER }]);
      const replaced = replacedEvents(ledger);
      expect(replaced).toHaveLength(1);
      expect(replaced[0]!.lineageId).toBe(loser.lineageId);
      expect(replaced[0]!.status).toBe("REPLACED");
      expect(replaced[0]!.reason).toBe(`replaced_by_candidate:s${S}b${B} winner=${WINNER}`);
      expect(ledger.allEvents().filter((e) => e.lineageId === winner.lineageId && e.stage === "REPLACED")).toEqual([]);
      expect(log.mock.calls.some((c) => String(c[0]).includes(`[ApprovedReplaced] s2b2 loser=${LOSER} winner=${WINNER}`))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("the lifecycle then reads REPLACED for the loser, not ADOPTED_NO_TERMINAL_OUTCOME; the winner keeps its render link", () => {
    const { dedup, ledger, placed } = scenario();
    vi.spyOn(console, "log").mockImplementation(() => {});
    recordReplacedApprovals(dedup, sentences, placed, ledger);
    vi.restoreAllMocks();
    const rel = fitFor(fitFor(emptyRelevance(), S, B, LOSER), S, B, WINNER);
    const rows = traceYoutubeLifecycle(ledger, rel, { refusal: "gate" });
    const byKey = new Map(rows.map((r) => [r.contentKey, r]));
    expect(byKey.get(LOSER)!.status).toBe("REPLACED");
    expect(byKey.get(LOSER)!.reason).toContain(`winner=${WINNER}`);
    expect(byKey.get(LOSER)!.violation).toBeNull();
    expect(byKey.get(WINNER)!.render).toBe("INPUT");
    expect(byKey.get(WINNER)!.cinematic).toBe("SELECTED");
    expect(byKey.get(WINNER)!.status).toBe("RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN");
    expect(youtubeLifecycleTotals(rows).youtubeDownstreamGap).toBe(0);
  });

  it("filed once: a second pass finds the ending and writes nothing more", () => {
    const { dedup, ledger, placed } = scenario();
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(recordReplacedApprovals(dedup, sentences, placed, ledger)).toHaveLength(1);
      expect(recordReplacedApprovals(dedup, sentences, placed, ledger)).toHaveLength(0);
      expect(recordReplacedApprovals(dedup, sentences, placed, ledger)).toHaveLength(0);
      expect(replacedEvents(ledger)).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a clip that truly failed keeps its own ending and is not re-described as replaced", () => {
    const { dedup, ledger, loser, placed } = scenario();
    recordAssetOutcome(ledger, loser.localPath, "transform_failed", `s${S}b${B}`, LOSER);
    expect(recordReplacedApprovals(dedup, sentences, placed, ledger)).toEqual([]);
    expect(replacedEvents(ledger)).toEqual([]);
    /** The ending it has is the one its failure filed (a REJECTED outcome on the REMOVED stage), never REPLACED. */
    const row = traceYoutubeLifecycle(ledger, emptyRelevance()).find((r) => r.contentKey === LOSER)!;
    expect(row.status).not.toBe("REPLACED");
    expect(row.status).toBe("REMOVED");
    expect(row.reason).toContain("transform_failed");
  });

  it("a sentence that holds no picture files nothing — that is a loss, not a hand-off", () => {
    const { dedup, ledger } = scenario();
    expect(recordReplacedApprovals(dedup, sentences, () => new Set(), ledger)).toEqual([]);
    expect(replacedEvents(ledger)).toEqual([]);
  });

  it("an approved key that was never ADOPTED files nothing, and a key the ledger does not know files nothing", () => {
    const dedup = {};
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const neverAdopted = root(ledger, LOSER, S, B);
    file(ledger, neverAdopted.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    noteApprovedPickForBeat(dedup, S, B, LOSER);
    noteApprovedPickForBeat(dedup, S, B, fragment(9999));
    expect(recordReplacedApprovals(dedup, sentences, () => new Set([WINNER]), ledger)).toEqual([]);
    expect(replacedEvents(ledger)).toEqual([]);
  });

  it("an approved key the film holds under ANOTHER sentence was placed, not replaced — nothing is filed", () => {
    const { dedup, ledger, placed } = scenario();
    /** s2b2's loser is in the film under s2b3 (the inventory route judged it for that sentence). */
    const twoSentences = [{ sceneIndex: S, beatIndex: B }, { sceneIndex: S, beatIndex: 3 }];
    const keysOf = (sceneIndex: number, beatIndex: number) => (beatIndex === B ? placed() : new Set([LOSER]));
    expect(recordReplacedApprovals(dedup, twoSentences, keysOf, ledger)).toEqual([]);
    expect(replacedEvents(ledger)).toEqual([]);
  });

  it("no ledger, no approvals, or a sentence not asked about: nothing happens", () => {
    const { dedup, ledger, placed } = scenario();
    expect(recordReplacedApprovals(dedup, sentences, placed, undefined)).toEqual([]);
    expect(recordReplacedApprovals({}, sentences, placed, ledger)).toEqual([]);
    expect(recordReplacedApprovals(dedup, [{ sceneIndex: 0, beatIndex: 0 }], placed, ledger)).toEqual([]);
    expect(replacedEvents(ledger)).toEqual([]);
  });
});

/* ═══════════════════════ D — another offering's refusal does not end the adopted clip ═══════════════════════ */

describe("VIDEO 646 D — a REJECTED event ends the adopted clip only when it is about that clip", () => {
  const K = fragment(5605);

  /** s1b2 of render 646: adopted and rendered for s1b2, while s2b2's copy of the same moment was refused. */
  const rendered = (otherOfferingRejection: { scene: number; beat: number; sameLine?: boolean } | null) => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, K, 1, 2);
    file(ledger, r.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const used = copyFor(ledger, r.lineageId, K, 1, 2, "ytfu_0m0");
    file(ledger, used.lineageId, ["TRANSFORMED", "ADOPTED"]);
    if (otherOfferingRejection) {
      const o = otherOfferingRejection;
      const target = o.sameLine ? used : copyFor(ledger, r.lineageId, K, o.scene, o.beat, `ytfu_0m${o.scene}${o.beat}`);
      ledger.recordEvent(target.lineageId, "ELIGIBLE", { status: "REJECTED", gate: "file_missing", reason: "file_missing", sceneIndex: o.scene, beatIndex: o.beat });
    }
    file(ledger, used.lineageId, ["CINEMATIC_SELECTED", "RENDER_INPUT"]);
    return { ledger, used };
  };

  it("a file_missing on another sentence's copy of the moment is not the adopted clip's ending", () => {
    const { ledger } = rendered({ scene: 2, beat: 2 });
    ledger.markFinalVideo([]);
    const r = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(r.status).not.toBe("REJECTED_AFTER_ADOPTION");
    expect(r.status).toBe("RENDER_INPUT_NOT_IN_FINAL");
    expect(r.cinematic).toBe("SELECTED");
    expect(r.render).toBe("INPUT");
  });

  it("… and with the delivery unproven it is NOT_PROVEN, so the rejection cannot hide a gap either way", () => {
    const { ledger } = rendered({ scene: 2, beat: 2 });
    const r = traceYoutubeLifecycle(ledger, emptyRelevance(), { refusal: "gate" })[0]!;
    expect(r.status).toBe("RENDER_INPUT_FINAL_VIDEO_NOT_PROVEN");
  });

  it("a delivered clip stays FINAL whatever another sentence said about a copy of it", () => {
    const { ledger, used } = rendered({ scene: 2, beat: 2 });
    ledger.markFinalVideo([used.localPath]);
    expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.status).toBe("FINAL");
  });

  it("a real refusal of the SAME adopted clip, with nothing after it, is still REJECTED_AFTER_ADOPTION", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, K, 1, 2);
    file(ledger, r.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const used = copyFor(ledger, r.lineageId, K, 1, 2, "ytfu_0m0");
    file(ledger, used.lineageId, ["TRANSFORMED", "ADOPTED", ["TRANSFORMED", { status: "REJECTED", gate: "transform", reason: "no video stream" }]]);
    const row = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(row.status).toBe("REJECTED_AFTER_ADOPTION");
    expect(row.reason).toBe("transform: no video stream");
    expect(row.violation).toBeNull();
  });

  it("a refusal on a copy DERIVED from the adopted clip belongs to it (the existing rule is kept)", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, K, 1, 2);
    file(ledger, r.lineageId, [...FOUND_TO_ADOPTED]);
    const pad = copyFor(ledger, r.lineageId, K, 1, 2, "pad");
    ledger.recordEvent(pad.lineageId, "PADDED", { status: "REJECTED", gate: "technical", reason: "half-written" });
    expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.status).toBe("REJECTED_AFTER_ADOPTION");
  });

  it("a refusal filed under the adopted clip's OWN sentence on another line is kept — no separation is invented", () => {
    /**
     * Same scene, same beat, a sibling line: the recorded fields do not say which of two offerings to
     * the same sentence this refusal was about, so the reader keeps the ending rather than guessing.
     */
    const { ledger } = rendered(null);
    const r = ledger.allRecords().find((x) => !x.parentLineageId)!;
    const sibling = copyFor(ledger, r.lineageId, K, 1, 2, "ytfu_0m1");
    ledger.recordEvent(sibling.lineageId, "ELIGIBLE", { status: "REJECTED", gate: "file_missing", reason: "file_missing", sceneIndex: 1, beatIndex: 2 });
    expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.status).toBe("REJECTED_AFTER_ADOPTION");
  });

  it("a refusal the same line later outlived (CINEMATIC_SELECTED / RENDER_INPUT after it) did not end it", () => {
    const { ledger } = rendered({ scene: 1, beat: 2, sameLine: true });
    ledger.markFinalVideo([]);
    const r = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(r.status).toBe("RENDER_INPUT_NOT_IN_FINAL");
  });

  it("an adopted clip refused by another sentence and then NOT used anywhere is still a gap, not explained away", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, K, 1, 2);
    file(ledger, r.lineageId, ["ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED"]);
    const used = copyFor(ledger, r.lineageId, K, 1, 2, "ytfu_0m0");
    file(ledger, used.lineageId, ["TRANSFORMED", "ADOPTED"]);
    const other = copyFor(ledger, r.lineageId, K, 2, 3, "ytfu_0m23");
    ledger.recordEvent(other.lineageId, "ELIGIBLE", { status: "REJECTED", gate: "file_missing", reason: "file_missing", sceneIndex: 2, beatIndex: 3 });
    const row = traceYoutubeLifecycle(ledger, emptyRelevance())[0]!;
    expect(row.status).toBe("ADOPTED_NO_TERMINAL_OUTCOME");
    expect(row.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
  });

  it("before adoption nothing changes: a refusal is REJECTED_BEFORE_ADOPTION as before", () => {
    const ledger = new VisualSourceLedger({ renderId: "r646" });
    const r = root(ledger, K, 1, 2);
    ledger.recordEvent(r.lineageId, "ELIGIBLE", { status: "REJECTED", gate: "license_rejected", reason: "LICENSE_UNKNOWN" });
    expect(traceYoutubeLifecycle(ledger, emptyRelevance())[0]!.status).toBe("REJECTED_BEFORE_ADOPTION");
  });
});
