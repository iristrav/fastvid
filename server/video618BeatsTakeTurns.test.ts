/**
 * Video 617/618 — a scene's first beat spent its two YouTube minutes and the later beats never
 * started: 8 of 14 beats in render 617, 3 of 6 in render 618's scene 1 (about 165 s per scene).
 * A beat's YouTube turn is still two minutes at most, but never so long that the scene's later
 * beats keep less than 15 s each.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  YOUTUBE_LATER_BEAT_RESERVE_MS,
  YOUTUBE_TURN_FLOOR_MS,
  youtubeBeatsAfter,
  youtubeTurnLeavingRoomForLaterBeats,
} from "./videoPipeline";
import { YOUTUBE_FIRST_TURN_MS } from "./sourcingPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const turn = (remainingSec: number, beatsAfter: number) =>
  youtubeTurnLeavingRoomForLaterBeats(YOUTUBE_FIRST_TURN_MS, remainingSec * 1000, beatsAfter) / 1000;

describe("Video 617/618 — a beat's YouTube turn leaves room for the scene's later beats", () => {
  it("render 618 scene 1 (6 beats, 165 s): the first beat gets 90 s, not 120", () => {
    expect(turn(165, 5)).toBe(90);
  });

  it("a scene with few beats keeps the full two minutes", () => {
    expect(turn(165, 2)).toBe(120);
    expect(turn(165, 0)).toBe(120);
    expect(turn(400, 5)).toBe(120);
  });

  it("later beats of the same scene are capped by what is left for the ones after them", () => {
    /** Beat 1 of six, after beat 0 used 90 s: 75 s left, four beats after it. */
    expect(turn(75, 4)).toBe(15);
    /** The last beat has nobody after it: it may use what is left. */
    expect(turn(30, 0)).toBe(120);
  });

  it("never below the floor: a beat always gets a look, and a ready lookahead result is taken at once", () => {
    expect(turn(20, 5)).toBe(YOUTUBE_TURN_FLOOR_MS / 1000);
    expect(youtubeTurnLeavingRoomForLaterBeats(10_000, 20_000, 5)).toBe(10_000);
  });

  it("outside a scope, or with nothing known about the scene, nothing changes", () => {
    expect(youtubeTurnLeavingRoomForLaterBeats(YOUTUBE_FIRST_TURN_MS, Number.POSITIVE_INFINITY, 5)).toBe(YOUTUBE_FIRST_TURN_MS);
    expect(youtubeBeatsAfter({}, 1, 0)).toBe(0);
  });

  it("beats after this one are counted from the scene's own beat list", () => {
    const dedup = { sceneBeatCount: new Map([[1, 6]]) };
    expect(youtubeBeatsAfter(dedup, 1, 0)).toBe(5);
    expect(youtubeBeatsAfter(dedup, 1, 5)).toBe(0);
    expect(youtubeBeatsAfter(dedup, 2, 0)).toBe(0);
  });

  it("the two minutes and the 15 s reserve are what the operator and this fix set", () => {
    expect(YOUTUBE_FIRST_TURN_MS).toBe(120_000);
    expect(YOUTUBE_LATER_BEAT_RESERVE_MS).toBe(15_000);
  });

  it("wiring: the scene records its beat count where its lookahead starts; the slice uses the capped turn", () => {
    expect(PIPE).toMatch(
      /startSceneYoutubeLookahead\(scene, beats, workDir, clipFetchDur, videoTitle, personName, dedup\);\s*\/\*\*[^\n]*\*\/\s*\(dedup\.sceneBeatCount \?\?= new Map\(\)\)\.set\(scene\.index, beats\.length\);/
    );
    const slice = PIPE.slice(PIPE.indexOf("async function youtubeFirstBeatSlice("), PIPE.indexOf("export async function fetchBeatArchivalThenPexels("));
    expect(slice).toContain("youtubeBeatsAfter(dedup, sceneIndex, beat.index)");
    expect(slice).toContain("const sliceMs = Math.min(turnMs, remainingScopeMs());");
    /** The request is still printed next to the grant, as before. */
    expect(slice).toContain("asked for ${Math.round(ytBudget / 1000)}s");
  });
});
