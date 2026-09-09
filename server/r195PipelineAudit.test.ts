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

describe("the findings this round named have since been closed", () => {
  /**
   * R196 INVERTED ALL THREE, and the correction on the first is worth stating.
   *
   * R195 reported the motion chain as needing a new scoring rule. Reading further found four
   * existing parts of one feature with no joins between them — a target with no reader, a second
   * target written after the read, a context field nobody consulted, and `inferMotionLevel`,
   * declared and never called. Joining them is a carry, not an invention: both sides were already
   * 0–100 on the same scale. The same held for the two expectation lists, whose producers
   * (`shotSearchTerms`, `planSceneAudio`) already existed. Only the feature matrix genuinely
   * needed the decision R195 described, and it got one.
   *
   * The assertions below are the inverted ones. `r196MotionMatrixAndExpectations.test.ts` carries
   * the behaviour; these keep the record of what was closed.
   */
  it("the planned movement band now reaches a scorer", () => {
    expect(DIRECTOR).toContain("targetMotionRange?: readonly [number, number] | null;");
    expect(PIPE).toContain("targetMotionRange: _contract?.motionRange ?? _rhythmBand ?? null,");
    expect(
      (DIRECTOR.match(/ctx\.targetMotionRange/g) ?? []).length,
      "the band lost its reader again"
    ).toBeGreaterThan(0);
  });

  it("the band no longer waits for a write that comes after the read", () => {
    const lazy = PIPE.indexOf("const _rhythmBand = ((): readonly [number, number] | null => {");
    expect(lazy, "the read-time derivation is gone").toBeGreaterThan(-1);
    expect(
      (PIPE.match(/beatRhythmTargets\.set\(/g) ?? []).length,
      "a third writer appeared — the record must stay one derivation plus one refresh"
    ).toBe(2);
  });

  it("a render builds a feature matrix, so its invariant can fire", () => {
    const contract = readFileSync(path.join(__dirname, "renderContract.ts"), "utf8");
    expect(contract).toContain("export function featureMatrixViolations(");
    expect(contract).toContain("export function musicFeatureStatus(");
    expect(contract).toContain("export function buildRenderFeatureMatrix(");
    expect(PIPE).toContain("const matrix = buildRenderFeatureMatrix({");
    expect(PIPE).toContain("formatFeatureMatrix(matrix)");
  });

  it("both expectation lists have a producer", () => {
    expect(DIRECTOR).toContain("expectedAudioTypes?: string[];");
    expect(DIRECTOR).toContain("expectedCinematicTags?: string[];");
    expect(PIPE).toContain("expectedCinematicTags: [...shotSearchTerms(_plannedShot)],");
    expect(PIPE).toContain("expectedAudioTypes: beatExpectedAudioTypes(");
  });
});
