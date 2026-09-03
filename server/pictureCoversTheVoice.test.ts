/**
 * THE FILM MAY NOT STOP WHILE THE NARRATOR IS STILL SPEAKING.
 *
 * ── The failure ─────────────────────────────────────────────────────────────────────────────
 *
 * A beat whose adopted clip has no rehydratable identity — a colour card, a guaranteed fill, an
 * adoption the lineage ledger could not attribute — is dropped by the cinematic planner. Correct on
 * its own: an edit cannot be built around a file that exists only in this render's temp directory.
 *
 * Then three separate mechanisms turned that into a broken deliverable.
 *
 *   1. `video_gap` is the FIRST entry in NON_BLOCKING_ISSUES, so the render proceeds.
 *   2. The timeline's length was `max(clip.timelineEnd)` — the surviving PICTURE alone. The voice
 *      was never consulted.
 *   3. The final mux carries `-shortest`, bounded by the video. A shorter picture cuts the audio.
 *
 * And the render job's own gate then compared the file against the length the dropped beats had
 * already shrunk. Three checks agreed the file was correct while it ended mid-sentence.
 *
 * ── The fix, and why it is a hold ───────────────────────────────────────────────────────────
 *
 * `holdPictureUnderVoice` does what an editor does: the outgoing shot is held until the next one
 * arrives, and the last one is held until the narration ends. A shot running a few seconds long is
 * ordinary documentary grammar. A cut to black under narration is a mistake, and a film that stops
 * before the narrator does is not a deliverable at all.
 *
 * The renderer makes the hold safe: video inputs are opened with `-stream_loop -1` and bounded by
 * `-t`, so a clip asked to fill more time than its source holds simply fills it.
 */
import { describe, expect, it } from "vitest";

import { holdPictureUnderVoice, translateEdl } from "./edlToTimeline";
import { validateTimeline, NON_BLOCKING_ISSUES } from "./timelineValidator";
import type { TimelineVideoClip } from "./projectTimeline";
import type { EditDecision } from "./cinematicEditingEngine/types";

/* ═══════════════════════ the hold, on its own ═══════════════════════ */

const clip = (id: string, start: number, end: number): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "loc", providerAssetId: id, mediaUrl: `https://x/${id}.mp4` },
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
});

describe("the outgoing shot is held until the next one arrives", () => {
  it("closes a hole left by a dropped beat", () => {
    const clips = [clip("a", 0, 4), clip("b", 9, 13)];
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 13 });

    expect(clips[0]!.timelineEnd).toBe(9);
    expect(clips[1]!.timelineStart).toBe(9);
    expect(covered).toHaveLength(1);
    expect(covered[0]).toContain("held 5.000s to reach b");
  });

  /**
   * The tail is the case that truncated render output. The last shot ends, the narrator keeps
   * talking, and `-shortest` cuts the sentence.
   */
  it("holds the last shot to the end of the narration", () => {
    const clips = [clip("a", 0, 4), clip("b", 4, 8)];
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 21.5 });

    expect(clips[1]!.timelineEnd).toBe(21.5);
    expect(covered.join(" ")).toContain("held 13.500s to the end of the narration");
  });

  it("opens on picture rather than on nothing", () => {
    const clips = [clip("a", 2.5, 8)];
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 8 });

    expect(clips[0]!.timelineStart).toBe(0);
    expect(covered.join(" ")).toContain("the first shot now starts at 0");
  });

  /**
   * The shot keeps the frames the planner chose. Pulling `sourceIn` back with the start would show
   * footage nobody picked — a different shot, silently.
   */
  it("an earlier start does not change which frames are shown", () => {
    const clips = [{ ...clip("a", 3, 9), sourceIn: 12, sourceOut: 18 }];
    holdPictureUnderVoice({ clips, voiceDurationSec: 9 });

    expect(clips[0]!.timelineStart).toBe(0);
    expect(clips[0]!.sourceIn).toBe(12);
    expect(clips[0]!.sourceOut).toBe(18);
  });

  it("a healthy edit is left exactly as it was, and says so", () => {
    const clips = [clip("a", 0, 5), clip("b", 5, 11)];
    const before = JSON.parse(JSON.stringify(clips));
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 11 });

    expect(clips).toEqual(before);
    expect(covered).toEqual([]);
  });

  /** Three floating-point additions produce holes of 1e-15. Those are not edits. */
  it("floating-point noise is not treated as a hole", () => {
    const clips = [clip("a", 0, 5), clip("b", 5.0000001, 10)];
    expect(holdPictureUnderVoice({ clips, voiceDurationSec: 10 })).toEqual([]);
    expect(clips[0]!.timelineEnd).toBe(5);
  });

  it("no voice means nothing to cover at the tail", () => {
    const clips = [clip("a", 0, 5)];
    expect(holdPictureUnderVoice({ clips, voiceDurationSec: null })).toEqual([]);
    expect(clips[0]!.timelineEnd).toBe(5);
  });

  it("an empty edit is not repaired into existence", () => {
    const clips: TimelineVideoClip[] = [];
    expect(holdPictureUnderVoice({ clips, voiceDurationSec: 30 })).toEqual([]);
    expect(clips).toHaveLength(0);
  });

  /** Several dropped beats in a row: every hole gets its own hold and its own line. */
  it("reports one line per hold, so twelve of them read as a sourcing problem", () => {
    const clips = [clip("a", 0, 2), clip("b", 6, 8), clip("c", 14, 16)];
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 20 });

    expect(covered).toHaveLength(3);
    expect(clips[0]!.timelineEnd).toBe(6);
    expect(clips[1]!.timelineEnd).toBe(14);
    expect(clips[2]!.timelineEnd).toBe(20);
  });
});

/* ═══════════════════════ through the real adapter ═══════════════════════ */

describe("a translated EDL is as long as its narration", () => {
  const decision = (beatId: string, startSec: number, endSec: number): EditDecision => ({
    beatId,
    sceneIndex: 0,
    clip: {
      candidateId: `loc:${beatId}`,
      assetType: "video",
      localPath: null,
      remoteUrl: "https://x/a.mp4",
      trimStartSec: 0,
      trimEndSec: endSec - startSec,
      startSec,
      endSec,
      timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "none", intensity: 0, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  });

  const identity = { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://x/a.mp4" };
  const voice = { url: "https://x/voice.mp3", durationSec: 30 };

  /**
   * The production shape: the plan covers the first eighteen seconds because the beats after that
   * fell back to colour cards, and the narration runs to thirty.
   */
  it("the picture reaches the end of the voice even when beats were dropped", () => {
    const { timeline, covered } = translateEdl({
      videoId: 1,
      voice,
      inputs: [
        { decision: decision("s0b0", 0, 9), sceneOffsetSec: 0, identity },
        { decision: decision("s0b1", 9, 18), sceneOffsetSec: 0, identity },
      ],
    });

    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(clips[clips.length - 1]!.timelineEnd).toBe(30);
    expect(timeline.durationSec).toBe(30);
    expect(covered.join(" ")).toContain("to the end of the narration");
  });

  /**
   * The length is the thing every consumer downstream trusts — the mux is bounded by it and the
   * render job's gate compares the finished file against it. Taken from the picture alone, it
   * validated its own truncation.
   */
  it("the timeline's length is never shorter than its voice", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      voice: { url: "https://x/v.mp3", durationSec: 47.25 },
      inputs: [{ decision: decision("s0b0", 0, 6), sceneOffsetSec: 0, identity }],
    });
    expect(timeline.durationSec).toBeGreaterThanOrEqual(47.25);
  });

  /**
   * The one case the hold cannot repair, and the reason the length is a `max` rather than the
   * picture's end.
   *
   * With no clips at all there is no shot to hold — `holdPictureUnderVoice` returns immediately.
   * If the length were still taken from the picture it would be 0, and a zero-length timeline
   * describing thirty seconds of narration is a document that validates its own emptiness.
   *
   * This is not a hypothetical: it is a scene where nothing could be sourced and every beat was
   * dropped for want of a provable identity.
   */
  it("a plan with no usable picture is still as long as its narration", () => {
    const { timeline } = translateEdl({ videoId: 1, voice, inputs: [] });
    expect(timeline.durationSec).toBe(30);
  });

  it("a translation with no voice is unchanged by any of this", () => {
    const { timeline, covered } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision("s0b0", 0, 6), sceneOffsetSec: 0, identity }],
    });
    expect(timeline.durationSec).toBe(6);
    expect(covered).toEqual([]);
  });

  it("the repaired timeline passes its own validator", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      voice,
      inputs: [
        { decision: decision("s0b0", 0, 4), sceneOffsetSec: 0, identity },
        { decision: decision("s0b1", 11, 15), sceneOffsetSec: 0, identity },
      ],
    });
    const blocking = validateTimeline(timeline).issues.filter(
      (i) => !NON_BLOCKING_ISSUES.has(i.code)
    );
    expect(blocking.map((i) => `${i.code}: ${i.reason}`)).toEqual([]);
  });
});

/* ═══════════════════════ the gate that must never be silent ═══════════════════════ */

describe("a picture shorter than its voice stops the render", () => {
  const shortEdit = () => ({
    schemaVersion: 1 as const,
    videoId: 1,
    timelineVersion: 0,
    durationSec: 40,
    format: { widthPx: 1920, heightPx: 1080, fps: 30 },
    tracks: [
      { kind: "VIDEO" as const, clips: [clip("a", 0, 12)] },
      {
        kind: "VOICE" as const,
        clips: [{
          id: "voice_1",
          source: { provider: "narration", canonicalUrl: "https://x/v.mp3" },
          start: 0, end: 40, gain: 1,
        }],
      },
      { kind: "MUSIC" as const, clips: [] },
      { kind: "SFX" as const, clips: [] },
      { kind: "AMBIENT" as const, clips: [] },
      { kind: "CAPTIONS" as const, captions: [] },
      { kind: "TEXT" as const, texts: [] },
      { kind: "GRAPHICS" as const, graphics: [] },
    ],
  });

  it("is reported, and reported as blocking", () => {
    const issues = validateTimeline(shortEdit() as never).issues;
    const found = issues.find((i) => i.code === "picture_short_of_voice");
    expect(found, "the truncation was not detected").toBeDefined();
    expect(found!.reason).toContain("28.000s of speech would be cut off");
    expect(NON_BLOCKING_ISSUES.has("picture_short_of_voice")).toBe(false);
  });

  /**
   * Not a `video_gap`. A gap is a hole an editor can live with — the shots either side still do
   * their job. This is the film physically stopping while somebody is talking, and treating the two
   * the same is how the failure stayed invisible.
   */
  it("is its own verdict, not a variety of video_gap", () => {
    const t = shortEdit();
    const issues = validateTimeline(t as never).issues;
    expect(issues.some((i) => i.code === "picture_short_of_voice")).toBe(true);
    // The picture starts at zero and has no internal holes, so there is no gap to report at all.
    expect(issues.some((i) => i.code === "video_gap")).toBe(false);
  });

  it("a picture that covers its voice raises nothing", () => {
    const t = shortEdit();
    const video = t.tracks.find((x) => x.kind === "VIDEO")!;
    if (video.kind === "VIDEO") video.clips[0]!.timelineEnd = 40;
    const issues = validateTimeline(t as never).issues;
    expect(issues.some((i) => i.code === "picture_short_of_voice")).toBe(false);
  });

  /** A few frames of decay at the tail is a rounding artefact, not a truncated deliverable. */
  it("a fraction of a second is not a truncation", () => {
    const t = shortEdit();
    const video = t.tracks.find((x) => x.kind === "VIDEO")!;
    if (video.kind === "VIDEO") video.clips[0]!.timelineEnd = 39.9;
    const issues = validateTimeline(t as never).issues;
    expect(issues.some((i) => i.code === "picture_short_of_voice")).toBe(false);
  });
});
