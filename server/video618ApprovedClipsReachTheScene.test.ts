/**
 * Video 618 — two approved YouTube pictures that never reached the film.
 *
 * 1. s0b0 `ofqkKDH_LKM`: approved by the picture editor, archived as #58054, then refused at its
 *    one and only push as "skipping duplicate clip … (once per video)". `adoptClip` marks a picture
 *    used when it approves it; `pushSceneClip` then read that mark as a previous use.
 * 2. s1b0 `NSs7IEpwpqU`: downloads took 119 of the YouTube-first slice's 120 s, the slice's timer
 *    fired while the editor was judging it, the beat moved on to the archive, and the clip was
 *    approved three seconds later — with its last checks refused as "SCOPE_EXPIRED".
 *
 * No network: the scope tests run timers only.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { claimAdoptedForBeat, noteAdoptedForBeat, remainingScopeMs, withSceneFetchTimeout, type YoutubeAdoptionHandle } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const KEY = "youtube_cc:93a96618594e5786";
const CLIP = "/w/scene_1_ytfu_1_t1341d40__pid_youtube_cc-a381cc3256d11924_transformed.mp4";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyOf = (sig: string): string => {
  const at = PIPE.indexOf(sig);
  expect(at, `${sig} is gone`).toBeGreaterThan(-1);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};

describe("Video 618 fix 1 — a picture is not a duplicate of its own approval", () => {
  it("the beat adoptClip approved the picture for may push it", () => {
    const dedup = {};
    noteAdoptedForBeat(dedup, KEY, 0, 0);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(true);
  });

  it("once: a second push of the same picture is a duplicate again", () => {
    const dedup = {};
    noteAdoptedForBeat(dedup, KEY, 0, 0);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(true);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(false);
  });

  it("another beat, another scene, or no beat at all is still refused", () => {
    const dedup = {};
    noteAdoptedForBeat(dedup, KEY, 0, 0);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 1)).toBe(false);
    expect(claimAdoptedForBeat(dedup, KEY, 1, 0)).toBe(false);
    expect(claimAdoptedForBeat(dedup, KEY, 0, undefined)).toBe(false);
    /** …and those refusals do not use up the approved beat's own pass. */
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(true);
  });

  it("a picture nobody approved has no pass", () => {
    expect(claimAdoptedForBeat({}, KEY, 0, 0)).toBe(false);
    const dedup = {};
    noteAdoptedForBeat(dedup, "youtube_cc:other", 0, 0);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(false);
  });

  it("the latest approval wins when the same picture is approved again for another beat", () => {
    const dedup = {};
    noteAdoptedForBeat(dedup, KEY, 0, 0);
    noteAdoptedForBeat(dedup, KEY, 2, 1);
    expect(claimAdoptedForBeat(dedup, KEY, 0, 0)).toBe(false);
    expect(claimAdoptedForBeat(dedup, KEY, 2, 1)).toBe(true);
  });

  it("wiring: adoptClip notes the beat right where it marks the picture used", () => {
    const body = bodyOf("async function adoptClip(");
    expect(body).toMatch(
      /markAssetUsedInVideo\(dedup, \{[\s\S]{0,200}?\}\);\s*\/\*\*[^\n]*\*\/\s*noteAdoptedForBeat\(dedup, contentKey, sceneIndex, beatIndex\);/
    );
  });

  it("wiring: the push asks for the pass only when the picture is already marked, and still refuses otherwise", () => {
    const at = PIPE.indexOf("const pushSceneClip = async (clipPath: string, holdSec: number, beatIndex: number)");
    const body = PIPE.slice(at, PIPE.indexOf("clips.push(clipPath);", at));
    const check = body.indexOf("const used = assetUsedInVideo(dedup, identity);");
    const claim = body.indexOf("!claimAdoptedForBeat(dedup, key, scene.index, beatIndex)");
    const refuse = body.indexOf("noteDuplicateClipRefused(dedup, clipPath, key, scene.index, beatIndex);");
    expect(check).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(check);
    expect(refuse).toBeGreaterThan(claim);
    /** The VisualJudge gate in front of it still comes first. */
    expect(body.indexOf("beatClipRefusedByRelevanceGate(")).toBeLessThan(check);
    /** Still one writer of the mark per path: adoptClip and the push itself. */
    expect(body).toContain("markAssetUsedInVideo(dedup, identity);");
  });
});

describe("Video 618 fix 2 — a picture being judged when the slice ends is judged to the end", () => {

  /**
   * ONE ROUTE — the 618 race cannot happen any more: the YouTube slice only searches and downloads;
   * its candidates are judged afterwards, together with the cascade's, in the beat's own scope.
   */
  it("wiring: the YouTube slice judges nothing; its candidates are judged with the cascade's", () => {
    const slice = bodyOf("async function youtubeFirstBeatSlice(");
    expect(slice).not.toContain("adoptClip(");
    expect(slice).toContain("`youtube-first s${sceneIndex} b${beat.index}`");
    expect(slice).toContain("YouTube-first slice spent");
    const only = bodyOf("async function fetchBeatYoutubeOnly(");
    expect(only).toContain("runCentralYoutubeTurn({");
    expect(only).not.toContain("adoptClip(");
    /** Code audit P9: the slice only ever supplies candidates. */
    expect(only).toContain("return turn.candidatePaths;");
  });
});
