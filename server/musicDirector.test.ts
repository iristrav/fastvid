/**
 * THE SCORE — spotted from the film's own emotional shape, filled from a catalogue nobody faked.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * FastVid has never had music. The compose route synthesised a sine bed; the cinematic route
 * refuses to lay that down and reports `musicSourceUnavailable`. Both are honest, neither is a
 * documentary score, and the delivered film after the cutover had nothing under the narration but
 * room tone.
 *
 * ── Why the catalogue ships empty, and why that is the fix rather than a stub ────────────────
 *
 * Music is the one asset class where getting it wrong is a legal problem. A curated list of
 * Freesound or public-domain ids written from memory would render, would sound like music, and
 * would be somebody's copyright with a fabricated licence field attached. So this module ships the
 * architecture — real identity, real licence, a catalogue a deployment plugs in — and no tracks.
 *
 * What that buys, and what these tests guard: the CUE SHEET is planned on every render regardless.
 * A film with no catalogue now reports where music should have been and what it should have been
 * doing, which turns "this build has no music" from a dead end into a specification.
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
  EMPTY_MUSIC_CATALOGUE,
  MIN_CUE_SEC,
  activeMusicCatalogue,
  formatCueSheet,
  planMusicCues,
  registerMusicCatalogue,
  resetMusicCatalogue,
  scoreCues,
  type CurvePoint,
  type MusicCatalogue,
  type MusicTrack,
} from "./musicDirector";

const windows = (count: number, each = 30) =>
  Array.from({ length: count }, (_, i) => ({ startSec: i * each, endSec: (i + 1) * each }));

const curve = (perScene: number[]): CurvePoint[] =>
  perScene.map((intensity, sceneIndex) => ({ sceneIndex, beatIndex: 0, emotion: "n", intensity }));

/* ═══════════════════════ spotting the film ═══════════════════════ */

describe("the cue sheet follows the story, not the clock", () => {
  it("a film always has an opening and a close", () => {
    const cues = planMusicCues({
      curve: curve([50, 50, 50]),
      sceneWindows: windows(3),
      totalDurationSec: 90,
    });
    expect(cues[0]!.role).toBe("intro");
    expect(cues[cues.length - 1]!.role).toBe("outro");
  });

  /**
   * The lowest-intensity stretch of a documentary is where a bed does the most damage: a quiet,
   * factual passage with music under it reads as manipulation. Silence has to be a CUE, not a gap,
   * or the sheet cannot express the decision and an editor cannot argue with it.
   */
  it("the quietest passage is scored as deliberate silence", () => {
    const cues = planMusicCues({
      curve: curve([50, 10, 50]),
      sceneWindows: windows(3),
      totalDurationSec: 90,
    });
    const silent = cues.find((c) => c.role === "silence");
    expect(silent, "a very quiet scene was not marked as silence").toBeDefined();
    expect(silent!.reason).toContain("would read as manipulation");
  });

  it("a rise is a build and a fall is a release", () => {
    const cues = planMusicCues({
      curve: curve([50, 40, 65, 40, 50]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    const roles = cues.map((c) => c.role);
    expect(roles).toContain("build");
    expect(roles).toContain("release");
  });

  /**
   * A flat film has no climax. Labelling its loudest scene one would put a swell under an
   * ordinary paragraph — the single most recognisable sign of a machine-scored video.
   */
  it("a film with no peak is given no climax", () => {
    const cues = planMusicCues({
      curve: curve([45, 48, 46, 47, 45]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    expect(cues.some((c) => c.role === "climax")).toBe(false);
  });

  it("a film with a real peak gets a climax at it", () => {
    const cues = planMusicCues({
      curve: curve([30, 40, 88, 40, 30]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    const climax = cues.find((c) => c.role === "climax");
    expect(climax).toBeDefined();
    expect(climax!.sceneIndices).toContain(2);
  });

  /** Music that changes every scene is stabbing, not scoring. Same job = one cue. */
  it("neighbouring scenes doing the same job become one cue", () => {
    const cues = planMusicCues({
      curve: curve([50, 65, 66, 67, 50]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    const tension = cues.filter((c) => c.role === "tension");
    expect(tension.length).toBeLessThanOrEqual(1);
    if (tension[0]) expect(tension[0].sceneIndices.length).toBeGreaterThan(1);
  });

  it("a cue too short to be a cue is absorbed rather than left as a sting", () => {
    const cues = planMusicCues({
      curve: curve([50, 90, 50]),
      sceneWindows: [
        { startSec: 0, endSec: 40 },
        { startSec: 40, endSec: 42 },
        { startSec: 42, endSec: 80 },
      ],
      totalDurationSec: 80,
    });
    for (const cue of cues) {
      expect(cue.endSec - cue.startSec, `${cue.role} is a sting`).toBeGreaterThanOrEqual(MIN_CUE_SEC);
    }
  });

  /**
   * An unmeasured film still has an opening and a close. A missing curve must produce a neutral
   * sheet, not an empty one — "nobody measured the intensity" is not "there is no film".
   */
  it("a film with no measured curve is still spotted", () => {
    const cues = planMusicCues({ curve: [], sceneWindows: windows(3), totalDurationSec: 90 });
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0]!.role).toBe("intro");
  });

  it("no scenes means no cue sheet, rather than a cue over nothing", () => {
    expect(planMusicCues({ curve: [], sceneWindows: [], totalDurationSec: 90 })).toEqual([]);
    expect(planMusicCues({ curve: [], sceneWindows: windows(2), totalDurationSec: 0 })).toEqual([]);
  });

  it("every cue states why it is there", () => {
    const cues = planMusicCues({
      curve: curve([40, 80, 20, 60, 40]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    for (const cue of cues) expect(cue.reason.length, cue.role).toBeGreaterThan(10);
  });
});

/* ═══════════════════════ the catalogue ═══════════════════════ */

const track = (over: Partial<MusicTrack> = {}): MusicTrack => ({
  identity: { provider: "test_catalogue", providerAssetId: "t1" },
  title: "Slow Strings",
  moods: ["sombre"],
  energy: 30,
  instrumentation: ["strings"],
  durationSec: 180,
  licence: "CC0",
  ...over,
});

describe("what a deployment plugs in", () => {
  beforeEach(() => resetMusicCatalogue());

  /**
   * The shipped default. Not a placeholder — the honest answer for a repository that holds no
   * licensed music and cannot obtain any without inventing identifiers it cannot verify.
   */
  it("ships empty, and says so", () => {
    expect(activeMusicCatalogue()).toBe(EMPTY_MUSIC_CATALOGUE);
    expect(activeMusicCatalogue().name).toBe("none");
    expect(activeMusicCatalogue().find({ role: "intro", intensity: 50, minDurationSec: 10 })).toBeNull();
  });

  it("a registered catalogue is used, and can be revoked", () => {
    const cat: MusicCatalogue = { name: "test", find: () => track() };
    registerMusicCatalogue(cat);
    expect(activeMusicCatalogue().name).toBe("test");
    resetMusicCatalogue();
    expect(activeMusicCatalogue().name).toBe("none");
  });

  it("a scored cue carries a real identity and a real licence", () => {
    registerMusicCatalogue({ name: "test", find: () => track() });
    const scored = scoreCues(
      planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2), totalDurationSec: 60 })
    );
    const withTrack = scored.find((s) => s.track);
    expect(withTrack).toBeDefined();
    expect(withTrack!.track!.identity.provider).toBe("test_catalogue");
    expect(withTrack!.track!.licence).toBe("CC0");
  });

  /**
   * Silence is never "unavailable". Choosing not to score a passage and having nothing to score it
   * with are different facts, and a report that conflates them makes the gap invisible.
   */
  it("a silence cue is never reported as a gap", () => {
    const scored = scoreCues(
      planMusicCues({ curve: curve([50, 8, 50]), sceneWindows: windows(3), totalDurationSec: 90 })
    );
    const silent = scored.find((s) => s.cue.role === "silence");
    expect(silent).toBeDefined();
    expect(silent!.track).toBeNull();
    expect(silent!.unavailableReason).toBe("");
  });

  it("an unfillable cue says which catalogue could not fill it", () => {
    registerMusicCatalogue({ name: "house_library", find: () => null });
    const scored = scoreCues(
      planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2), totalDurationSec: 60 })
    );
    expect(scored[0]!.unavailableReason).toContain("house_library held nothing");
  });

  it("with no catalogue at all the reason names that, not a search failure", () => {
    const scored = scoreCues(
      planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2), totalDurationSec: 60 })
    );
    expect(scored[0]!.unavailableReason).toContain("no music catalogue is registered");
  });

  it("the catalogue is asked for a cue long enough to cover it", () => {
    const asked: number[] = [];
    registerMusicCatalogue({
      name: "spy",
      find: (r) => {
        asked.push(r.minDurationSec);
        return null;
      },
    });
    scoreCues(
      planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2, 45), totalDurationSec: 90 })
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const d of asked) expect(d).toBeGreaterThanOrEqual(MIN_CUE_SEC);
  });
});

/* ═══════════════════════ the report ═══════════════════════ */

describe("the render says what the score is, or is not", () => {
  beforeEach(() => resetMusicCatalogue());

  /**
   * The line that makes the gap a measurement. Without it a film with no music looks exactly like
   * a film that was deliberately played dry.
   */
  it("an unscored film says so unmistakably", () => {
    const lines = formatCueSheet(
      scoreCues(planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2), totalDurationSec: 60 }))
    );
    const total = lines[lines.length - 1]!;
    expect(total).toContain("THIS FILM HAS NO MUSIC");
    expect(total).toContain("registerMusicCatalogue()");
  });

  it("a scored film names the track, its source and its licence", () => {
    registerMusicCatalogue({ name: "test", find: () => track({ title: "Cold Open" }) });
    const lines = formatCueSheet(
      scoreCues(planMusicCues({ curve: curve([50, 50]), sceneWindows: windows(2), totalDurationSec: 60 }))
    ).join("\n");
    expect(lines).toContain('track="Cold Open"');
    expect(lines).toContain("test_catalogue:t1");
    expect(lines).toContain("licence=CC0");
    expect(lines).not.toContain("THIS FILM HAS NO MUSIC");
  });

  /** A film scored entirely in silence is not a failure and must not be reported as one. */
  it("a film scored only with silence is not called unmusical", () => {
    const lines = formatCueSheet([]).join("\n");
    expect(lines).toContain("no cue sheet");
    expect(lines).not.toContain("THIS FILM HAS NO MUSIC");
  });

  it("every cue appears in the report, one line each", () => {
    const cues = planMusicCues({
      curve: curve([40, 80, 20, 60, 40]),
      sceneWindows: windows(5),
      totalDurationSec: 150,
    });
    const lines = formatCueSheet(scoreCues(cues));
    expect(lines).toHaveLength(cues.length + 1);
  });
});
