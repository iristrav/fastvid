/**
 * Video 617/618 — a scene's first beat spent its two YouTube minutes and the later beats never
 * started: 8 of 14 beats in render 617, 3 of 6 in render 618's scene 1 (about 165 s per scene).
 * A beat's YouTube turn is still two minutes at most, but never so long that the scene's later
 * beats keep less than 15 s each.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { YOUTUBE_FIRST_TURN_MS } from "./sourcingPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const turn = (remainingSec: number, beatsAfter: number) =>
  youtubeTurnLeavingRoomForLaterBeats(YOUTUBE_FIRST_TURN_MS, remainingSec * 1000, beatsAfter) / 1000;

describe("Video 617/618 — a beat's YouTube turn leaves room for the scene's later beats", () => {

  it("the two minutes are what the operator set", () => {
    expect(YOUTUBE_FIRST_TURN_MS).toBe(120_000);
    /** VIDEO 622 replaced the 15 s later-beat reserve with each sentence's own share; it is gone. */
  });

  it("wiring: the scene records its beat count where its lookahead starts; the slice uses the capped turn", () => {
    expect(PIPE).toMatch(
      /startSceneYoutubeLookahead\(scene, beats, workDir, clipFetchDur, videoTitle, personName, dedup\);\s*\/\*\*[^\n]*\*\/\s*\(dedup\.sceneBeatCount \?\?= new Map\(\)\)\.set\(scene\.index, beats\.length\);/
    );
    const slice = PIPE.slice(PIPE.indexOf("async function youtubeFirstBeatSlice("), PIPE.indexOf("export async function fetchBeatArchivalThenPexels("));
    /**
     * VIDEO 622 — the later beats' room is each sentence's own share of the scene now, so the turn
     * leaves room in its own beat instead: see `youtubeTurnLeavingRoomForArchive`.
     */
    expect(slice).toContain("const turnMs = youtubeTurnLeavingRoomForArchive(ytBudget, remainingScopeMs());");
    expect(slice).toContain("const sliceMs = Math.min(turnMs, remainingScopeMs());");
    /** The request is still printed next to the grant, as before. */
    expect(slice).toContain("asked for ${Math.round(ytBudget / 1000)}s");
  });
});
