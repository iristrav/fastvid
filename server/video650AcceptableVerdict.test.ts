/**
 * VIDEO 650 — the picture editor's fourth answer: ACCEPTABLE.
 *
 * A frame that shows the SUBJECT of the line but not the SITUATION, with nothing in it that
 * contradicts the line, used to be a plain refusal unless the line was abstract (video 644). Now it
 * is `acceptable`: ranked after every fit and every unreviewed candidate, adopted only when the
 * sentence has no fit, carried to the timeline as `contentApproval: "judge_acceptable"`, counted as
 * cover of its own kind and named at the gate. A contradiction, a missing subject, a guessed
 * identity or a logo still refuse it.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  ACCEPTABLE_PREFIX,
  BROLL_PREFIX,
  acceptableRule,
  approvalIsOnlyALogo,
  approvalRestsOnAGuess,
  settleSituationQuestion,
  situationRule,
  type BeatImageJudgement,
} from "./beatImageRelevanceGate";
import { VISION_EVIDENCE_ORDER, evidenceFromVerdict, evidenceTier } from "./visionAwareSelection";
import { visionVerdictFromGate } from "./adoptionPolicy";
import { sentenceCoverage } from "./sentenceCoverage";
import { deliveryGate } from "./deliveryGate";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import type { LineFacts } from "./beatVisualIntent";

const given = (over: Partial<BeatImageJudgement> = {}): BeatImageJudgement => ({
  verdict: "fits", depicts: "A Tesla car driving on a road.", reason: "shows the subject", evaluated: true, ...over,
});
const abstractLine: LineFacts = { evidenceRequirement: "soft", wantsSpecificPicture: false } as LineFacts;
const concreteLine: LineFacts = { evidenceRequirement: "hard", wantsSpecificPicture: true } as LineFacts;

describe("VIDEO 650 — acceptableRule", () => {
  it("subject shown, situation not, no contradiction → acceptable, with its own prefix", () => {
    const refused = situationRule(given(), { subject_matches: true, situation_matches: false });
    expect(refused.verdict).toBe("does_not_fit");
    const r = acceptableRule(refused, { subject_matches: true, situation_matches: false });
    expect(r.verdict).toBe("acceptable");
    expect(r.reason.startsWith(ACCEPTABLE_PREFIX)).toBe(true);
    expect(r.reason).not.toContain("situation not shown:");
  });

  it("the subject NOT shown stays refused; a fit and an unknown are untouched", () => {
    const refused = situationRule(given(), { subject_matches: false, situation_matches: false });
    expect(acceptableRule(refused, { subject_matches: false, situation_matches: false }).verdict).toBe("does_not_fit");
    expect(acceptableRule(given(), { subject_matches: true, situation_matches: true }).verdict).toBe("fits");
    expect(acceptableRule(given({ verdict: "unknown" }), { subject_matches: true, situation_matches: false }).verdict).toBe("unknown");
    /** answers the model did not give keep the refusal */
    expect(acceptableRule(given({ verdict: "does_not_fit" }), {}).verdict).toBe("does_not_fit");
  });

  it("a contradiction in what the model saw or said keeps the refusal", () => {
    for (const depicts of ["A screenshot of a web page about Tesla.", "An animated cartoon of a car.", "A different company's car on a road."]) {
      const refused = given({ verdict: "does_not_fit", depicts, reason: "situation not shown: subject matches" });
      expect(acceptableRule(refused, { subject_matches: true, situation_matches: false }).verdict, depicts).toBe("does_not_fit");
    }
  });

  it("settleSituationQuestion: an abstract line's b-roll is a FIT by rule; a concrete line's subject-only picture stays REFUSED", () => {
    const answer = { subject_matches: true, situation_matches: false };
    const onAbstract = settleSituationQuestion(given(), answer, abstractLine, "Tesla kept building cars.");
    expect(onAbstract.verdict).toBe("fits");
    expect(onAbstract.reason.startsWith(BROLL_PREFIX)).toBe(true);
    const onConcrete = settleSituationQuestion(given(), answer, concreteLine, "In 2018 the SEC sued Tesla over a tweet.");
    expect(onConcrete.verdict).toBe("does_not_fit");
    expect(onConcrete.reason.startsWith(ACCEPTABLE_PREFIX)).toBe(false);
    /** both halves true: a fit, no prefix */
    expect(settleSituationQuestion(given(), { subject_matches: true, situation_matches: true }, concreteLine, "x").verdict).toBe("fits");
  });

  it("a line that needs its situation shown keeps the refusal — hard evidence, a specific picture, a concrete claim; an ordinary line gets ACCEPTABLE", () => {
    const answer = { subject_matches: true, situation_matches: false };
    const refused = () => situationRule(given(), answer);
    const ordinary = "Tesla's approach changed how people think about cars.";
    const hard = { evidenceRequirement: "hard", wantsSpecificPicture: false } as LineFacts;
    const specific = { evidenceRequirement: "soft", wantsSpecificPicture: true } as LineFacts;
    const none = { evidenceRequirement: "none", wantsSpecificPicture: false } as LineFacts;
    expect(acceptableRule(refused(), answer, { beatText: ordinary }, hard).verdict).toBe("does_not_fit");
    expect(acceptableRule(refused(), answer, { beatText: ordinary }, specific).verdict).toBe("does_not_fit");
    /** a concrete claim in the line's own words, whatever the planner said */
    expect(acceptableRule(refused(), answer, { beatText: "The settlement with the SEC was costly for Tesla." }, none).verdict).toBe("does_not_fit");
    expect(acceptableRule(refused(), answer, { beatText: "The settlement with the SEC was costly for Tesla." }).verdict).toBe("does_not_fit");
    /** the ordinary line keeps its fallback: with a soft, a none or no line fact at all */
    expect(acceptableRule(refused(), answer, { beatText: ordinary }, abstractLine).verdict).toBe("acceptable");
    expect(acceptableRule(refused(), answer, { beatText: ordinary }, none).verdict).toBe("acceptable");
    expect(acceptableRule(refused(), answer, { beatText: ordinary }).verdict).toBe("acceptable");
  });

  it("the guards after the rule treat an acceptable like a fit: a guessed identity and a logo still refuse", () => {
    const guessed = given({ verdict: "acceptable", depicts: "A man in a suit.", reason: "likely Elon Musk, given the narration" });
    expect(approvalRestsOnAGuess(guessed, "Elon Musk sold shares.", "Elon Musk")).toBe(true);
    expect(approvalIsOnlyALogo(given({ verdict: "acceptable", depicts: "Tesla logo" }))).toBe(true);
    expect(approvalIsOnlyALogo(given({ verdict: "does_not_fit", depicts: "Tesla logo" }))).toBe(false);
  });
});

describe("VIDEO 650 — acceptable in the selection order and the vocabularies", () => {
  it("ranks after FIT and UNREVIEWED, before UNCLEAR and MISMATCH — adopted only when no fit is found", () => {
    expect(VISION_EVIDENCE_ORDER).toEqual(["FIT", "UNREVIEWED", "ACCEPTABLE", "UNCLEAR", "MISMATCH"]);
    expect(evidenceTier("ACCEPTABLE")).toBeGreaterThan(evidenceTier("FIT"));
    expect(evidenceTier("ACCEPTABLE")).toBeGreaterThan(evidenceTier("UNREVIEWED"));
    expect(evidenceTier("ACCEPTABLE")).toBeLessThan(evidenceTier("UNCLEAR"));
    expect(evidenceFromVerdict({ verdict: "acceptable", evaluated: true })).toBe("ACCEPTABLE");
    expect(evidenceFromVerdict({ verdict: "acceptable", evaluated: false })).toBe("UNREVIEWED");
    expect(visionVerdictFromGate("acceptable", true)).toBe("ACCEPTABLE");
  });
});

function clipFor(id: string, o: { start: number; end: number; approval?: "judge_fit" | "judge_acceptable"; archive?: number | null; beat?: [number, number] }): TimelineVideoClip {
  return {
    id, kind: "video",
    source: { provider: "youtube_cc", providerAssetId: id, ...(o.archive === null ? {} : { archiveAssetId: o.archive ?? 1 }), ...(o.approval ? { contentApproval: o.approval } : {}) },
    sourceIn: 0, sourceOut: o.end - o.start, timelineStart: o.start, timelineEnd: o.end,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
    sceneIndex: o.beat?.[0] ?? 0, beatIndex: o.beat?.[1] ?? 0,
  } as TimelineVideoClip;
}
function timelineWith(clips: TimelineVideoClip[], sentences: ProjectTimeline["sentences"]): ProjectTimeline {
  const t = emptyTimeline(650);
  t.durationSec = 8;
  videoTrack(t).push(...clips);
  t.sentences = sentences;
  return t;
}
const sentence = (b: number, start: number, end: number) => ({ sceneIndex: 0, beatIndex: b, startSec: start, endSec: end, timingBasis: "measured" as const, text: `Sentence ${b}.` });

describe("VIDEO 650 — acceptable footage in the coverage check and the delivery gate", () => {
  it("a sentence under an acceptable picture adopted FOR it is covered, of kind acceptable_footage", () => {
    const r = sentenceCoverage(timelineWith([clipFor("a", { start: 0, end: 4, approval: "judge_acceptable" })], [sentence(0, 0, 4)]));
    expect(r.sentences[0]).toMatchObject({ status: "covered", coveredSec: 4, approvedFootageSec: 0, acceptableFootageSec: 4, kinds: ["acceptable_footage"], reasons: [] });
    expect(r.proven).toBe(true);
  });

  it("an acceptable picture for another sentence is not this sentence's cover", () => {
    const r = sentenceCoverage(timelineWith([clipFor("a", { start: 0, end: 4, approval: "judge_acceptable", beat: [0, 1] })], [sentence(0, 0, 4)]));
    expect(r.sentences[0]).toMatchObject({ status: "uncovered", acceptableFootageSec: 0, otherSentenceSec: 4 });
  });

  it("the delivery gate allows it with an archive handle and names it", () => {
    const t = timelineWith([clipFor("a", { start: 0, end: 4, approval: "judge_acceptable", archive: 7 })], [sentence(0, 0, 4)]);
    const v = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "a", archiveAssetId: 7, provider: "youtube_cc", providerAssetId: "a", resolved: true, fromArchive: true, isPlaceholder: false }],
      sentenceCoverage: sentenceCoverage(t),
    });
    expect(v.allow, v.allow ? "" : JSON.stringify(v.failures)).toBe(true);
    expect(v.lines.some((l) => l.includes("QUALITY_NOTE ACCEPTABLE_FOOTAGE sentences=1 sec=4.00 (s0b0)"))).toBe(true);
  });
});

describe("VIDEO 650 — the pipeline adopts an acceptable picture only without a fit, and names it", () => {
  const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  it("the adoption loop marks an ACCEPTABLE adoption in its own ledger, never in the approval ledger", () => {
    expect(PIPELINE).toContain('if (beatEvidence === "FIT" && !requeuedAfterRefusal.has(p)) noteApprovedPickForBeat(dedup, sceneIndex, beatIndex, contentKey);');
    expect(PIPELINE).toContain('if (beatEvidence === "ACCEPTABLE" && !requeuedAfterRefusal.has(p)) {');
    expect(PIPELINE).toContain("markAcceptableForBeat(dedup, sceneIndex, beatIndex, contentKey);");
    /** the loop holds everything weaker than FIT and keeps looking — the mechanism that makes "only without a fit" true */
    expect(PIPELINE).toContain('if (beatEvidence !== "FIT" && firstLookAtCandidate) {');
  });
  it("the timeline mark: judge_fit, then judge_acceptable, then generic_footage, then unverified", () => {
    const at = PIPELINE.indexOf("contentApproval: pictureApprovedForBeat(visualDedup, scene.index, beatIndex, clipContentKey(clipPath))");
    const body = PIPELINE.slice(at, at + 900);
    const order = ['("judge_fit" as const)', '("judge_acceptable" as const)', '("generic_footage" as const)', '("unverified" as const)'].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
