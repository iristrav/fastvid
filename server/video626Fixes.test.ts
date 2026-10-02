/**
 * VIDEO 626 — "Ik zie veel stilstaande beelden. En ook afbeeldingen die worden herhaald en beelden
 * wat er niet bij hoort."
 *
 * The render's own log: every scene's clips reached the planner shifted by one or more sentences
 * (scene 2's second sentence under its first, and the reverse), scene 1's third sentence's approved
 * picture was lost, and one Unsplash photo stood on screen for 22 s in five pieces.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildCinematicSceneInputs,
  MIN_SHARED_SHOT_SEC,
  pickLocalFileForClip,
  shareBeatTime,
} from "./cinematicPipelineInputs";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const PIPE = read("videoPipeline.ts");

/* ═══════════ 1. every picture under the sentence it was approved for ═══════════ */

describe("1. the scene records the sentence of every clip it pushes", () => {
  it("the push writes the sentence next to the clip, and the scene returns all three lists together", () => {
    const at = PIPE.indexOf("const pushSceneClip = async (clipPath: string, holdSec: number, beatIndex: number)");
    const body = PIPE.slice(at, PIPE.indexOf("notePushedIntoFilm(dedup, clipPath, key);", at));
    expect(body).toMatch(/clips\.push\(clipPath\);\s*beatDurations\.push\(actualHold\);\s*clipBeatIndices\.push\(beatIndex\);/);
    expect(PIPE).toContain("return { clips: usable, beatDurations: usableDurations, clipBeatIndices: usableBeatIndices };");
    /** The old pairing of a clip with another clip's length is gone. */
    expect(PIPE).not.toMatch(/^\s*return \{ clips: usable, beatDurations: beatDurations\.slice\(0, usable\.length\) \};/m);
  });

  it("the planner pairs by that record; the empty adoption audit is no longer read for it", () => {
    const at = PIPE.indexOf("const clipsForBeat = pairClipsToBeats({");
    const block = PIPE.slice(at, at + 300);
    expect(block).toContain("clipBeatIndices: sceneVisualResults[i]?.clipBeatIndices ?? []");
    expect(block).not.toContain("adoptions:");
  });
});

const SCENE = { index: 1, text: "s", duration: 20, visualQuery: "", narration: "" } as never;
const adoption = (id: string, sourceInSec: number | null = null) => ({
  provider: "internet_archive",
  providerAssetId: id,
  archiveAssetId: null,
  sourceUrl: `https://archive.org/${id}`,
  originalUrl: null,
  assetTitle: "t",
  query: "q",
  candidateId: `c-${id}`,
  sourceInSec,
  sourceOutSec: null,
});
const beat = (index: number, start: number, end: number) => ({
  index, text: `beat ${index}`, searchQuery: "q", powerWord: "w", keywords: [], holdSec: end - start,
  voiceStartSec: start, voiceEndSec: end,
});

describe("1. a sentence with two approved clips shows both, one after the other", () => {
  it("the sentence's time is shared: each clip its own length, the last the rest", () => {
    expect(shareBeatTime(8, [3, 4])).toEqual([3, 5]);
    expect(shareBeatTime(8, [10, 4]), "a first clip that covers the sentence keeps it all").toEqual([8]);
    expect(shareBeatTime(8, [7.5, 4]), "a second clip is never a flash").toEqual([8]);
    expect(shareBeatTime(9, [3, 3, 3])).toEqual([3, 3, 3]);
    expect(shareBeatTime(6, [null, null])).toEqual([3, 3]);
    expect(shareBeatTime(0, [3])).toEqual([]);
    for (const shares of [shareBeatTime(8, [3, 4]), shareBeatTime(12.3, [2, 2, 2, 9])]) {
      expect(shares.slice(1).every((s) => s >= MIN_SHARED_SHOT_SEC)).toBe(true);
    }
  });

  it("the adapter plans both clips inside the sentence's window, back to back", () => {
    const built = buildCinematicSceneInputs({
      scenes: [
        {
          scene: SCENE,
          beats: [beat(0, 0, 6), beat(1, 6, 14)],
          clips: [
            { facts: { localPath: "/w/a.mp4", durationSec: 3 }, adoption: adoption("a") },
            { facts: { localPath: "/w/c.mp4", durationSec: 9 }, adoption: adoption("c") },
          ],
          moreClips: [[{ facts: { localPath: "/w/b.mp4", durationSec: 5 }, adoption: adoption("b") }], []],
        } as never,
      ],
    });
    const planned = built.scenes[0]!.beats.map((b) => ({
      id: b.identity?.providerAssetId,
      start: b.input.beatVoiceStartSec,
      dur: b.input.beatVoiceDurationSec,
      beat: b.input.intent.beatId,
    }));
    expect(planned).toEqual([
      { id: "a", start: 0, dur: 3, beat: "s1b0" },
      { id: "b", start: 3, dur: 3, beat: "s1b0" },
      { id: "c", start: 6, dur: 8, beat: "s1b1" },
    ]);
    expect(built.adapterIssues).toEqual([]);
  });
});

describe("1. a timeline clip finds its own file when its sentence holds two", () => {
  const two = [
    { path: "/w/a.mp4", adoption: adoption("a") as never },
    { path: "/w/b.mp4", adoption: adoption("b") as never },
  ];
  it("by asset id; a clip no file matches gets none rather than another clip's file", () => {
    expect(pickLocalFileForClip(two, { source: { providerAssetId: "b" } })).toBe("/w/b.mp4");
    expect(pickLocalFileForClip(two, { source: { providerAssetId: "a" } })).toBe("/w/a.mp4");
    expect(pickLocalFileForClip(two, { source: { providerAssetId: "zz" } })).toBeNull();
    expect(pickLocalFileForClip([], { source: { providerAssetId: "a" } })).toBeNull();
    expect(pickLocalFileForClip([two[0]!], { source: { providerAssetId: "zz" } })).toBe("/w/a.mp4");
  });

  it("two cuts of one source are told apart by where each was cut from", () => {
    const cuts = [
      { path: "/w/y1.mp4", adoption: adoption("yt", 10) as never },
      { path: "/w/y2.mp4", adoption: adoption("yt", 40) as never },
    ];
    expect(pickLocalFileForClip(cuts, { source: { providerAssetId: "yt" }, sourceIn: 41.2 })).toBe("/w/y2.mp4");
    expect(pickLocalFileForClip(cuts, { source: { providerAssetId: "yt" }, sourceIn: 10 })).toBe("/w/y1.mp4");
  });

  it("the render job and the checks read the file through it", () => {
    expect((PIPE.match(/localPathFor: localFileForClip,/g) ?? []).length).toBe(2);
    expect(PIPE).not.toContain("localFileByBeat");
  });
});

describe("1. a sentence's text, sound and graphics are placed once", () => {
  it("a second decision for the same sentence adds its picture only", () => {
    const edl = read("edlToTimeline.ts");
    expect(edl).toContain("const sentenceAlreadyDressed = dressedBeats.has(decision.beatId);");
    for (const list of ["decision.captions", "decision.sounds", "decision.motionGraphics"]) {
      expect(edl).toContain(`of sentenceAlreadyDressed ? [] : ${list})`);
    }
  });
});

/* ═══════════ 2. no photo stretched over sentences without a picture ═══════════ */

import { holdPictureUnderVoice, MAX_HOLD_SEC } from "./edlToTimeline";
import type { TimelineVideoClip } from "./projectTimeline";

const shot = (id: string, start: number, end: number, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "loc", providerAssetId: id, mediaUrl: `https://x/${id}.mp4` },
  sourceIn: 0,
  sourceOut: end - start,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  sceneIndex: 1,
  ...over,
});

describe("2. a hole is filled with the film's other shots, not one shot stretched", () => {
  /** Render 626, scene 1: the photo (4.84 s of source) was held 17.4 s to the next shot. */
  it("render 626's hole: the photo is held at most its own length, other shots fill the rest", () => {
    const clips = [
      shot("musk_a", 0, 5.9),
      shot("musk_b", 5.9, 11.4),
      shot("tesla_photo", 11.4, 16.24),
      shot("next_scene", 33.67, 39.1, { sceneIndex: 2 }),
    ];
    const covered = holdPictureUnderVoice({ clips, voiceDurationSec: 39.1 });
    const photo = clips.filter((c) => c.source.providerAssetId === "tesla_photo");
    expect(photo, "the photo came back as a filler").toHaveLength(1);
    expect(photo[0]!.timelineEnd - photo[0]!.timelineStart).toBeLessThanOrEqual(4.84 + 1e-6);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]!.timelineStart).toBeCloseTo(clips[i - 1]!.timelineEnd, 3);
      expect(clips[i]!.source.providerAssetId, "the same shot twice in a row").not.toBe(
        clips[i - 1]!.source.providerAssetId
      );
      /** At most six seconds, plus a remainder under a second that is not worth its own cut. */
      expect(clips[i]!.timelineEnd - clips[i]!.timelineStart).toBeLessThan(7);
    }
    expect(covered.join(" ")).toContain("from elsewhere in the film");
  });

  it("a filler moves, cuts in hard, and prefers moving footage to a still", () => {
    const clips = [
      shot("a", 0, 4),
      shot("still", 4, 8, { kind: "image" }),
      shot("moving", 8, 12),
      shot("b", 30, 34),
    ];
    holdPictureUnderVoice({ clips, voiceDurationSec: 34 });
    const fillers = clips.filter((c) => c.id.includes("_fill"));
    expect(fillers.length).toBeGreaterThan(0);
    expect(fillers[0]!.source.providerAssetId).not.toBe("still");
    for (const f of fillers) {
      expect(f.camera).toBeDefined();
      expect(f.transitionIn).toBe("hard_cut");
    }
  });

  it("a shot planned longer than its source ends with it when the film has another shot", () => {
    const clips = [shot("a", 0, 12, { sourceIn: 2, sourceOut: 5 }), shot("b", 12, 16), shot("c", 16, 20)];
    holdPictureUnderVoice({ clips, voiceDurationSec: 20 });
    expect(clips[0]!.timelineEnd - clips[0]!.timelineStart).toBeLessThanOrEqual(3 + 1e-6);
    expect(clips[1]!.id).toBe("c_fill1");
    expect(clips[clips.length - 1]!.timelineEnd).toBe(20);
    expect(MAX_HOLD_SEC).toBe(1.5);
  });

  it("a shot the user edited is left as they set it", () => {
    const clips = [shot("a", 0, 12, { sourceIn: 2, sourceOut: 5, editedByUser: true }), shot("b", 12, 16)];
    holdPictureUnderVoice({ clips, voiceDurationSec: 16 });
    expect(clips[0]!.timelineEnd).toBe(12);
  });
});

/* ═══════════ 3. a sentence's turn is its whole turn ═══════════ */

import { BEAT_FALLBACK_MIN_MS, BEAT_RESOLVE_SHARE } from "./videoPipeline";

describe("3. everything a sentence does happens inside its own turn", () => {
  const loop = PIPE.slice(PIPE.indexOf("const beatDeadlineMs = Date.now() + beatWallMs;"));
  const body = loop.slice(0, loop.indexOf("    await fillBeatWithMoreClips();\n  } finally {"));

  it("its own search gets a share of the turn, the fallbacks the rest", () => {
    expect(BEAT_RESOLVE_SHARE).toBeGreaterThan(0.5);
    expect(BEAT_RESOLVE_SHARE).toBeLessThan(1);
    expect(BEAT_FALLBACK_MIN_MS).toBeGreaterThan(0);
    expect(body).toContain("Math.max(1, Math.round(beatWallMs * BEAT_RESOLVE_SHARE)),");
  });

  it("the fill for more clips stays inside the same turn", () => {
    expect(PIPE).toContain("fillFor = { beat, clipsBefore: beatDurations.length, deadlineMs: beatDeadlineMs };");
    expect(PIPE).toContain("const turnLeftMs = f.deadlineMs - Date.now();");
    expect(PIPE).toContain("Math.min(BEAT_FILL_FETCH_MS, turnLeftMs),");
  });
});

/* ═══════════ 4. a photograph always moves ═══════════ */

import { cameraMoves, translateEdl } from "./edlToTimeline";

describe("4. a photograph with no planned move is given one", () => {
  const decision = (beatId: string, startSec: number, endSec: number, movement = "camera_hold") => ({
    beatId,
    sceneIndex: 0,
    clip: {
      candidateId: `c:${beatId}`, assetType: "video", localPath: null, remoteUrl: "https://x/a.mp4",
      trimStartSec: 0, trimEndSec: endSec - startSec, startSec, endSec, timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" },
    camera: { movement, intensity: 0.5, reason: "r" },
    transitionIn: { type: "cut", durationSec: 0, reason: "r" },
    captions: [], motionGraphics: [], effects: [], sounds: [],
    pacing: { tone: "measured", cutSpeedMultiplier: 1, movementIntensity: 0.3, reason: "r" },
  }) as never;
  const identity = { provider: "unsplash", providerAssetId: "p1", mediaUrl: "https://x/p.jpg" };

  it("a still gets a slow push or pull; footage keeps the planner's choice", () => {
    const { timeline } = translateEdl({
      videoId: 626,
      inputs: [
        { decision: decision("s0b0", 0, 4), sceneOffsetSec: 0, identity, still: true },
        { decision: decision("s0b1", 4, 8), sceneOffsetSec: 0, identity: { ...identity, providerAssetId: "v" } },
      ],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(cameraMoves(clips[0]!.camera!)).toBe(true);
    expect(["slow_push", "slow_pull"]).toContain(clips[0]!.motion);
    expect(cameraMoves(clips[1]!.camera!)).toBe(false);
    expect(clips[1]!.motion).toBe("none");
  });

  it("a still the planner already moves keeps that move", () => {
    const { timeline } = translateEdl({
      videoId: 626,
      inputs: [{ decision: decision("s0b0", 0, 4, "pan_left"), sceneOffsetSec: 0, identity, still: true }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.camera!.type).toBe("pan_left");
  });

  it("the pipeline marks a photograph, and the mark reaches the timeline", () => {
    expect(PIPE).toContain("...(stillClips.has(clipPath) ? { still: true } : {}),");
    expect(read("cinematicPipelineInputs.ts")).toContain("...(partAdopted.facts.still ? { still: true } : {}),");
    expect(read("cinematicPipeline.ts")).toContain("...(stills[i] ? { still: true } : {}),");
  });
});

/* ═══════════ 5. the person alone is not always enough ═══════════ */

import { approvalRestsOnAGuess, buildBeatImagePrompt } from "./beatImageRelevanceGate";

describe("5. render 626's approvals that rested on a likeness or on the line", () => {
  const fits = (depicts: string, reason: string) => ({ verdict: "fits" as const, depicts, reason });
  const line = "Elon Musk once confessed to fabricating rumors about himself.";

  it("a likeness is not an identification", () => {
    expect(approvalRestsOnAGuess(
      fits("A man resembling Elon Musk sitting in a car.", "The footage shows a man resembling Elon Musk inside a vehicle, which aligns with the narration about him."),
      line
    )).toBe(true);
    expect(approvalRestsOnAGuess(
      fits("A close-up view of a man who could be a public figure, possibly Elon Musk, talking.", "The frames show a close-up of a person who appears to be the subject of the narration."),
      line
    )).toBe(true);
    expect(approvalRestsOnAGuess(
      fits("Two people sitting together, one of whom resembles Elon Musk, in an indoor setting.", "The individual in the shot resembles Elon Musk, who is named in the narration."),
      line
    )).toBe(true);
  });

  it("an identity taken from the line, with no one named in the frame, is refused", () => {
    expect(approvalRestsOnAGuess(
      fits("A man speaking, likely an interview. Background includes vehicles.", "The subject is a person mentioned in the narration, making it relevant."),
      "Every strange statement from Elon Musk is more than a joke."
    )).toBe(true);
  });

  it("the person the judge names plainly is still an approval", () => {
    expect(approvalRestsOnAGuess(
      fits("Elon Musk speaking with a car in the background.", "The clip shows Elon Musk, who is directly named in the line of narration."),
      line
    )).toBe(false);
    expect(approvalRestsOnAGuess(
      fits("Elon Musk in a Tesla showroom setting, speaking to camera.", "The footage shows Elon Musk, who is directly named in the line of narration."),
      line
    )).toBe(false);
  });

  it("the same for any name: nothing here knows who the film is about", () => {
    expect(approvalRestsOnAGuess(
      fits("A woman resembling Marie Curie in a laboratory.", "A woman resembling Marie Curie at work."),
      "Marie Curie isolated radium in 1902."
    )).toBe(true);
    expect(approvalRestsOnAGuess(
      fits("Marie Curie in her laboratory, early 1900s.", "Marie Curie is on screen."),
      "Marie Curie isolated radium in 1902."
    )).toBe(false);
  });

  it("the picture editor is told that a line about a filmable thing wants that thing", () => {
    const prompt = buildBeatImagePrompt("A tweet from Elon Musk confirmed the rumor.", 3);
    expect(prompt).toContain("as long as you can SEE it is them");
    expect(prompt).toContain("unless the line is about a specific thing a camera could show");
    expect(prompt).toContain("then the person alone is not");
    /**
     * The rule that ended render 564's 91% refusals stays — another moment of the person still
     * belongs — but since October 2026 only when it shows the same kind of situation.
     */
    expect(prompt).toContain("filmed at a different moment than the one described still");
    expect(prompt).toContain("belongs when it shows the same kind of situation");
  });
});

/* ═══════════ 6. a camera move never freezes the picture, and it is slow ═══════════ */

import { execFileSync } from "child_process";
import os from "os";
import { cameraChain } from "./timelineFilters";
import { pieceCamera, PIECE_ZOOM } from "./longShotLimit";

describe("6. a camera move keeps the footage playing", () => {
  const FMT = { widthPx: 320, heightPx: 180, fps: 25 } as never;

  it("no zoompan: it made every frame of a shot out of the shot's first frame", () => {
    const s = cameraChain(pieceCamera(1), FMT, 4)!;
    expect(s).not.toContain("zoompan");
    expect(s).toContain("eval=frame");
  });

  /**
   * A source whose colour changes with time and not with place: a zoom cannot change a frame's
   * colour, so a first and a last frame that differ prove the footage kept playing under the move.
   */
  it("measured: the last frame of a moving source is not its first frame", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam626-"));
    const out = path.join(dir, "o.mp4");
    const chain = cameraChain(pieceCamera(1), FMT, 2)!;
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "nullsrc=s=320x180:r=25,geq=r='min(255,T*120)':g='0':b='0'",
      "-t", "2", "-vf", chain, "-an", out,
    ]);
    const red = (at: string) =>
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", at, "-i", out, "-frames:v", "1",
        "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])[0]!;
    expect(red("0.1")).toBeLessThan(40);
    expect(red("1.9")).toBeGreaterThan(180);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a piece's move is slow: 6% over the piece, a drift of 2% of the frame", () => {
    expect(PIECE_ZOOM).toBeLessThanOrEqual(1.06);
    for (const k of [1, 2, 3, 4]) {
      const c = pieceCamera(k);
      expect(Math.abs((c.endScale ?? 1) - (c.startScale ?? 1))).toBeLessThanOrEqual(0.06 + 1e-9);
      expect(Math.abs((c.endX ?? 0.5) - 0.5)).toBeLessThanOrEqual(0.02 + 1e-9);
    }
  });

  it("an archive picture of kind image is moved like a photograph", () => {
    expect(read("edlToTimeline.ts")).toContain('const isStill = still === true || clip.assetType === "image";');
  });
});

/* ═══════════ 7. a still is recognised by its frames, and zoomed once ═══════════ */

import { clipLooksStill, ffmpegFrameGrabber, frameDifference, STILL_FRAME_DIFF } from "./stillClipProbe";
import { buildKenBurnsTail, STILL_MAX_ZOOM, standardArchiveKenBurnsZoomEnd } from "./documentaryStyle";

describe("7. whether a clip is a still is asked of its frames", () => {
  const make = (dir: string, name: string, lavfi: string) => {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", lavfi, "-t", "2", "-pix_fmt", "yuv420p", out]);
    return out;
  };

  it("a photograph encoded without a move is a still; footage and a zooming photo are not", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "still626-"));
    const grab = ffmpegFrameGrabber("ffmpeg");
    const photo = make(dir, "photo.mp4", "testsrc2=size=320x180:rate=25,trim=end_frame=1,loop=loop=-1:size=1,setpts=N/25/TB");
    const footage = make(dir, "footage.mp4", "testsrc2=size=320x180:rate=25");
    expect(await clipLooksStill(photo, 2, grab)).toBe(true);
    expect(await clipLooksStill(footage, 2, grab)).toBe(false);
    expect(await clipLooksStill(path.join(dir, "missing.mp4"), 2, grab), "unreadable is not a verdict").toBeNull();
    expect(await clipLooksStill(photo, 0, grab)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the comparison is per pixel and refuses frames it cannot line up", () => {
    expect(frameDifference(Buffer.from([10, 10]), Buffer.from([10, 12]))).toBe(1);
    expect(frameDifference(Buffer.from([1]), Buffer.from([1, 2]))).toBe(Infinity);
    expect(STILL_FRAME_DIFF).toBeGreaterThan(0);
  });

  it("the pipeline marks a still from its frames, falling back to its name only when unreadable", () => {
    expect(PIPE).toContain("if (looked === true || (looked === null && isStillPhotoClip(clipPath))) stillClips.add(clipPath);");
    expect(PIPE).toContain("...(stillClips.has(clipPath) ? { still: true } : {}),");
  });
});

describe("7. a photograph's own zoom is slow and even", () => {
  it("at most 6% over the shot, whatever its length, without a fast start", () => {
    expect(STILL_MAX_ZOOM).toBe(1.06);
    for (const sec of [2, 5, 8, 20]) expect(standardArchiveKenBurnsZoomEnd(sec)).toBeLessThanOrEqual(STILL_MAX_ZOOM);
    expect(buildKenBurnsTail(4, STILL_MAX_ZOOM, "center", "zoom-in")).not.toContain("sin(");
  });
});

/* ═══════════ 8. what else the log of 626 showed about pictures that do not belong ═══════════ */

import { approvalIsOnlyALogo } from "./beatImageRelevanceGate";
import { providerFieldIsEmpty, searchGateDecision, withoutRepeatedWords, FUNCTION_WORDS } from "./searchQueryContract";

describe("8. a frame that is only a logo is refused", () => {
  const fits = (depicts: string) => ({ verdict: "fits" as const, depicts });
  it("render 626's Twitter logo, and logos on a plain ground", () => {
    expect(approvalIsOnlyALogo(fits("Twitter logo"))).toBe(true);
    expect(approvalIsOnlyALogo(fits("The Tesla logo on a white background."))).toBe(true);
    expect(approvalIsOnlyALogo(fits("A close-up of a company logo."))).toBe(true);
  });
  it("a picture of something with a logo in it is not", () => {
    expect(approvalIsOnlyALogo(fits("A Tesla car parked in front of a Tesla logo on a wall."))).toBe(false);
    expect(approvalIsOnlyALogo(fits("A bust of a person with company logos: Tesla, Neuralink, and SpaceX."))).toBe(false);
    expect(approvalIsOnlyALogo(fits("Elon Musk speaking on stage."))).toBe(false);
    expect(approvalIsOnlyALogo({ verdict: "does_not_fit", depicts: "Twitter logo" })).toBe(false);
  });
  it("it is applied where a guessed identity is, to fresh and stored verdicts alike", () => {
    const gate = read("beatImageRelevanceGate.ts");
    const fn = gate.slice(gate.indexOf("function refuseGuessedIdentity<"));
    expect(fn.slice(0, 400)).toContain("if (approvalIsOnlyALogo(judgement)) {");
  });
});

describe("8. a search query names something a picture can show", () => {
  it("filler words alone are not a search", () => {
    for (const w of ["perhaps", "minutes", "later", "part"]) expect(FUNCTION_WORDS.has(w)).toBe(true);
    expect(searchGateDecision("unsplash", "perhaps", "v626").admitted).toBe(false);
    expect(searchGateDecision("unsplash", "minutes later", "v626").admitted).toBe(false);
  });
  it("a word asked twice is asked once; nothing is added", () => {
    expect(withoutRepeatedWords("Elon Musk Elon Musk")).toBe("Elon Musk");
    expect(withoutRepeatedWords("Elon Musk musk tweet")).toBe("Elon Musk tweet");
    expect(withoutRepeatedWords("Marie Curie radium")).toBe("Marie Curie radium");
  });
  it("an archive field with no value is not sent", () => {
    expect(providerFieldIsEmpty("subject:")).toBe(true);
    expect(providerFieldIsEmpty("title:() AND mediatype:movies")).toBe(true);
    expect(providerFieldIsEmpty("title:(Elon Musk) AND mediatype:movies")).toBe(false);
    expect(providerFieldIsEmpty("collection:tvnews AND Elon Musk")).toBe(false);
  });
});

describe("8. an archive clip nobody could check for text is not recorded as clean", () => {
  it("the curated route writes a verdict only when the detector answered", () => {
    const curated = read("curatedMediaSourcing.ts");
    const at = curated.indexOf("const text = await judgeOnScreenText({ path: rawPath, mimeType: asset.mimeType });");
    const block = curated.slice(at, at + 1600);
    const notAsked = block.indexOf("if (text.evaluated === false) {");
    const write = block.indexOf("await updateMediaArchiveAsset(asset.id, { hasBakedEditText:");
    expect(notAsked).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(notAsked);
    expect(block.slice(notAsked, write)).toContain("} else {");
  });
});
