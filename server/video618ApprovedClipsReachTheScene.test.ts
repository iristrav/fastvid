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
import {
  claimAdoptedForBeat,
  finishStartedYoutubeAdoption,
  noteAdoptedForBeat,
  openYoutubeAdoptionHandle,
  remainingScopeMs,
  runYoutubeAdoptionWindow,
  withSceneFetchTimeout,
  YOUTUBE_ADOPTION_WINDOW_MS,
  type YoutubeAdoptionHandle,
} from "./videoPipeline";

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
      /dedup\.usedContentKeys\.add\(contentKey\);\s*\/\*\*[^\n]*\*\/\s*noteAdoptedForBeat\(dedup, contentKey, sceneIndex, beatIndex\);/
    );
  });

  it("wiring: the push asks for the pass only when the picture is already marked, and still refuses otherwise", () => {
    const at = PIPE.indexOf("const pushSceneClip = async (clipPath: string, holdSec: number, beatIndex: number)");
    const body = PIPE.slice(at, PIPE.indexOf("clips.push(clipPath);", at));
    const check = body.indexOf("if (dedup.usedContentKeys.has(key)) {");
    const claim = body.indexOf("if (!claimAdoptedForBeat(dedup, key, scene.index, beatIndex)) {");
    const refuse = body.indexOf("noteDuplicateClipRefused(dedup, clipPath, key, scene.index, beatIndex);");
    expect(check).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(check);
    expect(refuse).toBeGreaterThan(claim);
    /** The gates in front of it are unchanged and still come first. */
    expect(body.indexOf("beatClipRefusedByRelevanceGate(")).toBeLessThan(check);
    expect(body.indexOf("adoptionGuardRefusesPush(")).toBeLessThan(check);
    /** Still one writer of the mark per path: adoptClip and the push itself. */
    expect(body).toContain("dedup.usedContentKeys.add(key);");
  });
});

describe("Video 618 fix 2 — a picture being judged when the slice ends is judged to the end", () => {
  it("the 618 case: the slice times out mid-judgement, the approval still arrives and is kept", async () => {
    let late: string | null = "unset";
    await withSceneFetchTimeout(async () => {
      const adoption = openYoutubeAdoptionHandle();
      try {
        await withSceneFetchTimeout(
          async () => {
            await sleep(20); // the downloads — most of the slice
            adoption.running = runYoutubeAdoptionWindow(
              adoption,
              async () => {
                await sleep(120); // the editor, finishing after the slice's timer
                return CLIP;
              },
              1,
              0
            );
            return adoption.running;
          },
          60,
          "youtube-first s1 b0"
        );
        throw new Error("the slice should have timed out");
      } catch (err) {
        expect((err as Error).message).toContain("youtube-first s1 b0");
        late = await finishStartedYoutubeAdoption(adoption);
      }
    }, 5_000, "scene 1 beat 0 visuals");
    expect(late).toBe(CLIP);
  });

  it("the judgement's own checks can still open their scopes after the slice has ended", async () => {
    const opened: string[] = [];
    await withSceneFetchTimeout(async () => {
      const adoption = openYoutubeAdoptionHandle();
      await withSceneFetchTimeout(
        async () => {
          adoption.running = runYoutubeAdoptionWindow(
            adoption,
            async () => {
              await sleep(100); // past the slice's 40 ms
              /** On 618 this was "luma …_transformed.mp4" — SCOPE_EXPIRED. */
              opened.push(await withSceneFetchTimeout(async () => "luma ok", 1_000, "luma check"));
              expect(remainingScopeMs()).toBeGreaterThan(0);
              return CLIP;
            },
            1,
            0
          );
          return adoption.running;
        },
        40,
        "youtube-first s1 b0"
      ).catch(() => null);
      await finishStartedYoutubeAdoption(adoption);
    }, 5_000, "scene 1 beat 0 visuals");
    expect(opened).toEqual(["luma ok"]);
  });

  it("the window is bounded and clamped to the beat: a beat with little time left gives little", async () => {
    let seen = Number.POSITIVE_INFINITY;
    await withSceneFetchTimeout(async () => {
      const adoption = openYoutubeAdoptionHandle();
      await runYoutubeAdoptionWindow(adoption, async () => {
        seen = remainingScopeMs();
        return null;
      }, 0, 0);
    }, 300, "a beat nearly out of time");
    expect(seen).toBeLessThanOrEqual(300);
    expect(YOUTUBE_ADOPTION_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });

  it("a judgement that refuses, fails, or never started keeps nothing", async () => {
    const none: YoutubeAdoptionHandle = { outerScope: undefined };
    expect(await finishStartedYoutubeAdoption(none)).toBeNull();
    expect(await finishStartedYoutubeAdoption({ outerScope: undefined, running: Promise.resolve(null) })).toBeNull();
    expect(
      await finishStartedYoutubeAdoption({ outerScope: undefined, running: Promise.reject(new Error("editor refused")) })
    ).toBeNull();
    /** A pipeline fallback card is not a picture, exactly as `fetchBeatYoutubeOnly` already says. */
    expect(
      await finishStartedYoutubeAdoption({ outerScope: undefined, running: Promise.resolve("/w/scene_1_b0_fallback.mp4") })
    ).toBeNull();
    /** A real picture does come back. */
    expect(await finishStartedYoutubeAdoption({ outerScope: undefined, running: Promise.resolve(CLIP) })).toBe(CLIP);
  });

  it("wiring: only the YouTube-first slice opens the handle; the slice still has its own bound and log lines", () => {
    const slice = bodyOf("async function youtubeFirstBeatSlice(");
    expect(slice).toContain("const adoption = openYoutubeAdoptionHandle();");
    expect(slice).toContain("`${tag}yt-first`,\n        adoption\n");
    expect(slice).toContain("const late = await finishStartedYoutubeAdoption(adoption);");
    expect(slice).toContain("`youtube-first s${sceneIndex} b${beat.index}`");
    expect(slice).toContain("YouTube-first slice spent");
    const only = bodyOf("async function fetchBeatYoutubeOnly(");
    /** The same adoption flow, now inside its own window when a handle is given; unchanged without one. */
    expect(only).toContain("const adopt = () => adoptClip(");
    expect(only).toContain("runYoutubeAdoptionWindow(adoption, adopt, sceneIndex, beat.index)");
    expect(only).toContain(": await adopt();");
    expect(only).toContain("runCentralYoutubeTurn({");
  });
});
