/**
 * R195 — TWO MEASUREMENTS THAT EXISTED AND NEVER REACHED THE DECISION THEY WERE FOR.
 *
 * The audit walked the whole chain and both repairs it produced are the same shape, which is this
 * codebase's signature defect: a value is computed, has a complete and tested reader, and nothing
 * carries it from one to the other.
 *
 * ── 1. How long is this beat on screen? ─────────────────────────────────────────────────────
 *
 * `AssetDirectorContext.beatDurationSec` is documented as "used for temporal best-window
 * selection". Two things read it — the temporal bonus in `computeArchiveMetadataScores`, and
 * `computeTrimHint`, whose hint `adoptClip` applies through `applySegmentTrimIfNeeded` to cut a
 * long archive clip down to the window that matches this beat. Both are gated on the value being
 * present, both feature flags default ON, and the one production call site never set the field.
 * The scorer's `else if (… no beat duration …)` branch, written as the exceptional case, was the
 * only branch that ever ran.
 *
 * ── 2. Does the picture cover the narration? ────────────────────────────────────────────────
 *
 * `checkFileAvSync` names `audio_past_picture`. Video 574's delivered file measured 68.04s of
 * video against 69.88s of audio and shipped without a word, because on the render-job route the
 * check ran, was returned in the outcome with a doc comment saying "Returned rather than only
 * logged so the caller can put it in the quality report", and the caller read everything in that
 * outcome except `avSync`; and on the compose route it was never computed at all.
 *
 * ── And what the audit found and did NOT fix ────────────────────────────────────────────────
 *
 * Named at the bottom of this file rather than left for a green suite to imply otherwise. Each of
 * those expectations is the one to invert when the gap is closed.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { checkAvSync, avSyncFindingCodes, LENGTH_TOLERANCE_SEC } from "./avSyncCheck";
import { computeTrimHint } from "./archiveMetadataScorer";
import type { TemporalSceneProfile } from "./temporalSceneIntelligence";
import { selectBestWindowForBeat } from "./temporalSceneIntelligence";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const DIRECTOR = readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");

/* ═══════════════════ 1. the beat's own length reaches the ranking ═══════════════════ */

function profile(durationSec = 30): TemporalSceneProfile {
  return {
    events: [],
    subjectTracks: [],
    cameraTimeline: [],
    motionTimeline: [],
    emotionTimeline: [],
    ocrTimeline: [],
    audioTimeline: [],
    bestEntryPoints: [
      { startSec: 2, endSec: 6, durationSec: 4, score: 60, reason: "steady wide of the street" },
      { startSec: 11, endSec: 15, durationSec: 4, score: 88, reason: "subject enters frame" },
      { startSec: 20, endSec: 32, durationSec: 12, score: 95, reason: "long take, no cuts" },
    ],
    internalHighlights: [],
    computedAt: "2026-01-01T00:00:00.000Z",
    durationSec,
  };
}

const annotationWith = (p: TemporalSceneProfile) =>
  ({ temporalProfile: p } as unknown as Parameters<typeof computeTrimHint>[2]);

describe("the beat's length decides which window of a long clip is used", () => {
  /** The behaviour the missing value was switching off. */
  it("a beat with a length gets the best window that fits it", () => {
    const hint = computeTrimHint(null, null, annotationWith(profile()), 4);
    expect(hint).not.toBeNull();
    expect(hint!.startSec).toBe(11);
    expect(hint!.endSec).toBe(15);
    expect(hint!.reason).toContain("temporal best window");
  });

  /** And without it, the same clip yields nothing at all — which is what production did. */
  it("the same clip with no beat length yields no hint", () => {
    expect(computeTrimHint(null, null, annotationWith(profile()), undefined)).toBeNull();
  });

  it("a longer beat reaches a different, better-scoring window", () => {
    const hint = computeTrimHint(null, null, annotationWith(profile()), 12);
    expect(hint!.startSec).toBe(20);
    expect(hint!.endSec).toBe(32);
  });

  /** A beat as long as the clip needs no window — the whole clip already fits. */
  it("a beat that fills the clip is not trimmed", () => {
    expect(selectBestWindowForBeat(profile(30), 30)).toBeNull();
  });

  it("zero is not a length, and does not enable the path", () => {
    expect(computeTrimHint(null, null, annotationWith(profile()), 0)).toBeNull();
  });

  /**
   * The guard that makes wiring the value safe. `selectBestWindowForBeat` bounds a window from
   * above and not from below, so a clip whose only entry points are brief can offer a 4s window
   * for a 10s beat — a fragment the montage would then have to hold or loop under the narration.
   */
  it("a window shorter than the beat is refused rather than trimmed to", () => {
    const short: TemporalSceneProfile = {
      ...profile(60),
      bestEntryPoints: [
        { startSec: 3, endSec: 7, durationSec: 4, score: 99, reason: "brief but perfect" },
      ],
    };
    expect(computeTrimHint(null, null, annotationWith(short), 10)).toBeNull();
  });

  it("a window that exactly covers the beat is still used", () => {
    const exact: TemporalSceneProfile = {
      ...profile(60),
      bestEntryPoints: [
        { startSec: 3, endSec: 7, durationSec: 4, score: 99, reason: "covers the beat exactly" },
      ],
    };
    expect(computeTrimHint(null, null, annotationWith(exact), 4)?.startSec).toBe(3);
  });

  /** And the refusal does not swallow the older segment-similarity route. */
  it("refusing the temporal window leaves the segment trim its turn", () => {
    const short: TemporalSceneProfile = {
      ...profile(60),
      bestEntryPoints: [
        { startSec: 3, endSec: 7, durationSec: 4, score: 99, reason: "brief but perfect" },
      ],
    };
    const annotation = {
      temporalProfile: short,
      timeline: [{ description: "the crowd fills the square", startSec: 20, endSec: 32 }],
    } as unknown as Parameters<typeof computeTrimHint>[2];
    const hint = computeTrimHint(
      { segmentIndex: 0, startSec: 20, endSec: 32, similarity: 0.9 },
      0.4,
      annotation,
      10
    );
    expect(hint?.startSec).toBe(20);
    expect(hint?.reason).toContain("segment 0");
  });

  /** THE WIRING. One reader, one writer, no new store and no threading through the call sites. */
  it("the ranking context is given the beat's own hold", () => {
    const at = PIPE.indexOf("const adCtx: AssetDirectorContext = {");
    expect(at, "the ranking context is gone").toBeGreaterThan(-1);
    const block = PIPE.slice(at, PIPE.indexOf("};", at));
    expect(block).toContain(
      "beatDurationSec: dedup.sceneBeatsBySceneIndex.get(sceneIndex)?.[beatIndex]?.holdSec"
    );
  });

  /**
   * Read from the by-reference record rather than a copy, so a hold the TTS alignment measures
   * later is the one the ranking sees. `sceneBeatsBySceneIndex` is documented in the source as the
   * array every beat-resolving route stores by reference.
   */
  it("it reads the record every beat-resolving route writes", () => {
    expect(PIPE).toContain("dedup.sceneBeatsBySceneIndex.set(sceneIndex, beats);");
    const set = PIPE.indexOf("dedup.sceneBeatsBySceneIndex.set(sceneIndex, beats);");
    const read = PIPE.indexOf("beatDurationSec: dedup.sceneBeatsBySceneIndex.get(sceneIndex)");
    expect(set, "the writer is gone").toBeGreaterThan(-1);
    expect(read, "the reader is gone").toBeGreaterThan(-1);
  });

  /** Both readers still take it from the context — a second source would be the drift. */
  it("both readers are still fed from the one context field", () => {
    expect(DIRECTOR).toContain("ctx.beatDurationSec");
    expect((DIRECTOR.match(/ctx\.beatDurationSec/g) ?? []).length).toBe(2);
  });
});

/* ═══════════════════ 2. the delivered file's AV envelope ═══════════════════ */

describe("narration running past the picture is reported", () => {
  /** Video 574's exact delivered shape. */
  it("68.04s of picture under 69.88s of audio is not ok", () => {
    const result = checkAvSync({
      videoSec: 68.04,
      audioSec: 69.88,
      firstSoundSec: 0,
      lastSoundSec: 69.88,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("audio_past_picture");
  });

  it("a healthy film says nothing", () => {
    const result = checkAvSync({
      videoSec: 70.0,
      audioSec: 69.95,
      firstSoundSec: 0.1,
      lastSoundSec: 69.9,
    });
    expect(result.ok).toBe(true);
    expect(avSyncFindingCodes(result)).toEqual([]);
  });

  it("container rounding is not a finding", () => {
    const result = checkAvSync({
      videoSec: 70,
      audioSec: 70 - LENGTH_TOLERANCE_SEC / 2,
      firstSoundSec: 0,
      lastSoundSec: 69.8,
    });
    expect(result.findings.map((f) => f.code)).not.toContain("stream_length_mismatch");
  });

  /** The codes carry how far out they were, so a report says by how much and not only that. */
  it("the codes name the size of the gap", () => {
    const codes = avSyncFindingCodes(
      checkAvSync({ videoSec: 68.04, audioSec: 69.88, firstSoundSec: 0, lastSoundSec: 69.88 })
    );
    expect(codes.join(" ")).toMatch(/audio_past_picture\(\+1\.8\ds\)/);
  });

  /** THE WIRING, compose side: the route that delivers when the cinematic render is not used. */
  it("the compose delivery path measures the file it is about to upload", () => {
    const at = PIPE.indexOf("const avSync = await checkFileAvSync(finalVideoPath)");
    expect(at, "the compose-side AV check is gone").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 1200);
    expect(block).toContain('measuredOn: "compose_montage"');
    expect(block).toContain("avSyncFindingCodes(avSync)");
    /** It reports; it does not gate. Same policy as the spot check beside it. */
    expect(block).not.toContain("throw ");
  });

  /** THE WIRING, cinematic side: the verdict the render job already took on the delivered file. */
  it("the cinematic cutover reads the verdict the render job returned", () => {
    const at = PIPE.indexOf("if (jobOutcome.avSync) {");
    expect(at, "the delivered-file AV verdict is dropped again").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 900);
    expect(block).toContain('measuredOn: "delivered_render"');
    expect(block).toContain("avSyncFindingCodes(av)");
  });

  /** And the source of that verdict is still produced and still returned. */
  it("the render job still measures and still returns it", () => {
    const worker = readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(worker).toContain("const avSync = await checkFileAvSync(outputPath)");
    expect(worker).toContain("avSync,");
  });

  /**
   * The rule R190/R191 established and this follows: a number about a file the viewer did not
   * receive is worse than no number. The compose montage's verdict is REPLACED, never left
   * standing beside a delivery it does not describe.
   */
  it("the delivered verdict overwrites the montage's, rather than sitting beside it", () => {
    const compose = PIPE.indexOf('measuredOn: "compose_montage"');
    const delivered = PIPE.indexOf('measuredOn: "delivered_render"');
    expect(compose).toBeGreaterThan(-1);
    expect(delivered).toBeGreaterThan(compose);
    expect((PIPE.match(/qualityReport\.avSync = \{/g) ?? []).length).toBe(2);
  });

  it("a probe that cannot run is absent, never a pass", () => {
    const at = PIPE.indexOf("const avSync = await checkFileAvSync(finalVideoPath)");
    expect(PIPE.slice(at, at + 200)).toContain(".catch(() => null)");
    expect(PIPE.slice(at, at + 300)).toContain("if (avSync) {");
  });
});

/* ═══════════════════ what the audit proved and did not repair ═══════════════════ */

describe("the remaining findings are named, not quietly closed", () => {
  /**
   * P2 — THE VISUAL RHYTHM ENGINE'S MOTION TARGET REACHES NOBODY.
   *
   * Two breaks in one chain. `beatRhythmTargets` is written once, in the compose stage, with the
   * comment "so AssetDirector can use them during retrieval" — and retrieval for that scene has
   * already finished by then, so `_rhythmTarget` reads a key nothing has written yet. And even
   * with a value, `targetMotionLevel` is declared on the context and read by no scorer at all.
   *
   * Not repaired here: making it count means deciding how motion should weigh against the other
   * signals, which is a new scoring rule, and this round may not invent one. Invert these two when
   * that rule exists.
   */
  it("targetMotionLevel is set on the context and read by no scorer", () => {
    expect(DIRECTOR).toContain("targetMotionLevel?: number | null;");
    expect(PIPE).toContain("targetMotionLevel: _rhythmTarget ?? null,");
    expect(
      (DIRECTOR.match(/ctx\.targetMotionLevel/g) ?? []).length,
      "a scorer now reads it — invert this test"
    ).toBe(0);
  });

  it("the rhythm targets are written after the retrieval that reads them", () => {
    const write = PIPE.indexOf("visualDedup.beatRhythmTargets.set(");
    const read = PIPE.indexOf("dedup.beatRhythmTargets?.get(");
    expect(write, "the only writer is gone").toBeGreaterThan(-1);
    expect(read, "the only reader is gone").toBeGreaterThan(-1);
    expect(
      (PIPE.match(/beatRhythmTargets\.set\(/g) ?? []).length,
      "an earlier writer appeared — invert this test"
    ).toBe(1);
  });

  /**
   * P3 — THE FEATURE MATRIX IS AN INVARIANT NO RENDER CAN BREAK.
   *
   * `renderContract.ts` carries a full enabled → planned → executed → delivered → verified
   * monotonicity check, an UNEXPLAINED_GAP rule, and `musicFeatureStatus`, which is the honest
   * statement that this build has no music catalogue. Nothing in production builds a matrix, so
   * none of it can fire. Not repaired here: filling it in means deciding, per feature, what each
   * of the five states means, which is not a small change.
   */
  it("no production module builds a feature matrix", () => {
    const contract = readFileSync(path.join(__dirname, "renderContract.ts"), "utf8");
    expect(contract).toContain("export function featureMatrixViolations(");
    expect(contract).toContain("export function musicFeatureStatus(");
    expect(
      PIPE.includes("formatFeatureMatrix(") || PIPE.includes("featureMatrixViolations("),
      "the pipeline now builds one — invert this test"
    ).toBe(false);
  });

  /**
   * P3 — TWO RANKING INPUTS WITH READERS AND NO WRITER, LEFT ALONE ON PURPOSE.
   *
   * `expectedAudioTypes` and `expectedCinematicTags` are read by `computeArchiveMetadataScores`
   * and set by nothing. Unlike `beatDurationSec`, the value does not already exist anywhere: the
   * blueprint directive carries a `visualType`, not a list of cinematic tags, so supplying them
   * means inventing a mapping — a new scoring rule, which this round may not add.
   */
  it("the two expectation lists still have no producer", () => {
    expect(DIRECTOR).toContain("expectedAudioTypes?: string[];");
    expect(DIRECTOR).toContain("expectedCinematicTags?: string[];");
    for (const field of ["expectedAudioTypes", "expectedCinematicTags"]) {
      expect(PIPE.includes(`${field}:`), `${field} now has a producer — invert this test`).toBe(
        false
      );
    }
  });
});
