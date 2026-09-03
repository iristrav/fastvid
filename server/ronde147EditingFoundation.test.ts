/**
 * RONDE 147 — the three pieces that connect what already existed.
 *
 * ── What this round did NOT build, on purpose ────────────────────────────────────────────────
 *
 * No EditDirector, no retrieval engine, no downloader, no caption planner, no second cache. The
 * RONDE 145 audit found all of those already in the tree — `cinematicEditingEngine/` alone is 1736
 * lines with a test per planner, and its own header says its output is "ready for a future
 * renderer (Phase 5) to consume". This round is the three sentences between those parts:
 *
 *     timelineValidator   nothing renders from a timeline nobody checked
 *     assetRehydrator     an identity becomes a file again
 *     edlToTimeline       the engine's decisions become renderable data
 *
 * ── The end-to-end proof ─────────────────────────────────────────────────────────────────────
 *
 * The last block runs the whole chain with real ffmpeg and real files: an identity with no local
 * file → rehydrated from a "provider" → validated → rendered → checked with ffprobe. If that
 * passes, the path the brief's end criterion names exists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import {
  DEFAULT_FORMAT,
  DEFAULT_TEXT_STYLE,
  TIMELINE_SCHEMA_VERSION,
  emptyTimeline,
  timelineDigest,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";
import {
  NON_BLOCKING_ISSUES,
  TimelineValidationError,
  assertRenderableTimeline,
  formatTimelineIssue,
  validateTimeline,
} from "./timelineValidator";
import {
  cacheIdentityKey,
  formatRehydrationSummary,
  providerIsRehydratable,
  rehydrateTimelineAssets,
  rehydratedFileName,
  rehydrationUrlFor,
} from "./assetRehydrator";
import { CAMERA_MAP, TRANSITION_MAP, translateEdl, trackForCaption } from "./edlToTimeline";
import type { EditDecision } from "./cinematicEditingEngine/types";
import { checkRenderedFile, renderTimeline } from "./timelineRenderer";

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";

let ROOT = "";
let SOURCE_A = "";
let SOURCE_B = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r147-"));
  const make = async (name: string, pattern: string) => {
    const out = path.join(ROOT, `${name}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `${pattern}=size=320x180:rate=25:duration=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
    ]);
    return out;
  };
  SOURCE_A = await make("src_a", "smptebars");
  SOURCE_B = await make("src_b", "testsrc");
}, 300_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

/** A minimal, valid two-clip timeline. */
function goodTimeline(): ProjectTimeline {
  const t = emptyTimeline(1, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  const clip = (i: number, url: string): TimelineVideoClip => ({
    id: `vc_${i}`,
    kind: "video",
    source: { provider: "pexels", providerAssetId: `${100 + i}`, mediaUrl: url },
    sourceIn: 0,
    sourceOut: 3,
    timelineStart: i * 3,
    timelineEnd: (i + 1) * 3,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
  });
  t.tracks = [
    { kind: "VIDEO", clips: [clip(0, SOURCE_A), clip(1, SOURCE_B)] },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", texts: [] },
  ];
  t.durationSec = 6;
  return t;
}

/* ═══════════════════════ PHASE 9 — the validator ═══════════════════════ */

describe("PHASE 9 — the timeline validator reports and never repairs", () => {
  it("a well-formed timeline has no issues", () => {
    const result = validateTimeline(goodTimeline());
    expect(result.issues.map(formatTimelineIssue)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("negative duration is caught", () => {
    // clips[0] runs 0 → 3; ending it at -1 is a negative span. (An earlier version of this test
    // set it to 1, which is a perfectly valid one-second clip — the validator was right and the
    // test was wrong.)
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    const codes = validateTimeline(t).issues.map((i) => i.code);
    expect(codes).toContain("negative_duration");
  });

  it("a zero-length clip is caught — it would render as nothing", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = track.clips[0]!.timelineStart;
    expect(validateTimeline(t).issues.map((i) => i.code)).toContain("zero_duration");
  });

  it("end before start is caught, and the issue names the element and its times", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[1]!.timelineStart = 9;
      track.clips[1]!.timelineEnd = 7;
    }
    const issue = validateTimeline(t).issues.find((i) => i.code === "negative_duration")!;
    expect(issue.elementId).toBe("vc_1");
    expect(issue.start).toBe(9);
    expect(issue.end).toBe(7);
    expect(formatTimelineIssue(issue)).toContain("VIDEO/vc_1");
  });

  it("an invalid source range is caught", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[0]!.sourceIn = 5;
      track.clips[0]!.sourceOut = 2;
    }
    expect(validateTimeline(t).issues.map((i) => i.code)).toContain("source_out_before_in");

    const t2 = goodTimeline();
    const tr2 = t2.tracks.find((x) => x.kind === "VIDEO");
    if (tr2?.kind === "VIDEO") tr2.clips[0]!.sourceIn = -1;
    expect(validateTimeline(t2).issues.map((i) => i.code)).toContain("negative_source_in");
  });

  it("overlapping video clips are caught", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[1]!.timelineStart = 1.5;
    const issue = validateTimeline(t).issues.find((i) => i.code === "video_overlap");
    expect(issue).toBeDefined();
    expect(issue!.reason).toContain("overlaps vc_0");
  });

  it("a gap is caught — and is reported WITHOUT blocking the render", () => {
    /**
     * A gap produces black, which is visible and recoverable. Refusing to render because of one
     * would make a small imperfection cost the whole render, so it is reported without blocking —
     * as is `caption_overlap`, for the same reason. Everything else stops the render.
     */
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[1]!.timelineStart = 4;
      track.clips[1]!.timelineEnd = 7;
    }
    t.durationSec = 7;
    const result = validateTimeline(t);
    expect(result.issues.map((i) => i.code)).toContain("video_gap");
    expect(NON_BLOCKING_ISSUES.has("video_gap")).toBe(true);
    expect(() => assertRenderableTimeline(t)).not.toThrow();
  });

  it("a duration mismatch is caught — a render may never silently get another length", () => {
    const t = goodTimeline();
    t.durationSec = 30;
    const issue = validateTimeline(t).issues.find((i) => i.code === "duration_mismatch")!;
    expect(issue).toBeDefined();
    expect(issue.reason).toContain("never silently");
  });

  it("a missing asset is caught, and the issue names provider and id", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.source = { provider: "wikimedia" };
    const issue = validateTimeline(t).issues.find((i) => i.code === "missing_asset")!;
    expect(issue).toBeDefined();
    expect(issue.reason).toContain("provider=wikimedia");
    expect(issue.reason).toContain("providerAssetId=null");
  });

  it("an unknown transition is caught rather than rendered as something else", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      (track.clips[0] as unknown as { transitionIn: string }).transitionIn = "film_burn";
    }
    expect(validateTimeline(t).issues.map((i) => i.code)).toContain("invalid_transition");
  });

  it("a duplicate element id is caught — an edit could not address either", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[1]!.id = "vc_0";
    expect(validateTimeline(t).issues.map((i) => i.code)).toContain("duplicate_element_id");
  });

  it("audio gain and fades are checked", () => {
    const t = goodTimeline();
    t.tracks = t.tracks.map((x) =>
      x.kind === "MUSIC"
        ? {
            kind: "MUSIC",
            clips: [
              { id: "m1", source: { provider: "x", mediaUrl: "u" }, start: 0, end: 6, gain: 99 },
              { id: "m2", source: { provider: "x", mediaUrl: "u" }, start: 0, end: 2, gain: 1, fadeInSec: 10 },
            ],
          }
        : x
    );
    const codes = validateTimeline(t).issues.map((i) => i.code);
    expect(codes).toContain("invalid_gain");
    expect(codes).toContain("invalid_fade");
  });

  it("BLOCKING ISSUES THROW, with every element named", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -5;
    let caught: TimelineValidationError | null = null;
    try {
      assertRenderableTimeline(t);
    } catch (err) {
      caught = err as TimelineValidationError;
    }
    expect(caught).toBeInstanceOf(TimelineValidationError);
    expect(caught!.issues.length).toBeGreaterThan(0);
    expect(caught!.message).toContain("VIDEO/vc_0");
  });

  it("IT NEVER REPAIRS: the timeline is unchanged after validation", () => {
    /**
     * The rule the module exists for. A validator that clamps an end to a start turns a visible
     * error into an invisible one, and the render then differs from the plan with nothing saying so.
     */
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    const before = JSON.stringify(t);
    validateTimeline(t);
    try {
      assertRenderableTimeline(t);
    } catch {
      /* expected */
    }
    expect(JSON.stringify(t)).toBe(before);
  });

  it("a disabled clip does not create a phantom gap", () => {
    // It is not going to be on screen, and the space it leaves is deliberate.
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[1]!.disabled = true;
    t.durationSec = 3;
    expect(validateTimeline(t).issues.map((i) => i.code)).not.toContain("video_gap");
  });
});

/* ═══════════════════════ PHASE 6/7 — the rehydrator ═══════════════════════ */

/**
 * The rehydrator's BEHAVIOUR — cache order, provider auth, YouTube authorisation, corrupt files,
 * "asset B is never used for asset A" — is proven in `ronde147AssetRehydration.test.ts`, TEST 1–12.
 * What stays here is the part this file is about: the pure functions the rest of the chain reads,
 * with no I/O and no dependencies.
 */
describe("PHASE 6 — the identity → URL rules, as pure functions", () => {
  it("every provider the audit called rehydratable is supported", () => {
    for (const p of [
      "curated", "archive", "wikimedia", "loc", "internet_archive",
      "pexels", "pixabay", "youtube_cc", "nasa", "nara", "europeana", "openverse",
    ]) {
      expect(providerIsRehydratable(p), p).toBe(true);
    }
    expect(providerIsRehydratable("some_new_api")).toBe(false);
  });

  it("the archive's own URL wins over everything — it never expires", () => {
    const url = rehydrationUrlFor({
      provider: "archive", archiveAssetId: 7,
      canonicalUrl: "/api/archive-media/7", mediaUrl: "https://cdn/expiring.mp4",
    })!;
    expect(url.kind).toBe("canonical");
    expect(url.url).toBe("/api/archive-media/7");
  });

  it("Wikimedia is fetched by TITLE, not by the stored upload URL", () => {
    /**
     * Special:FilePath resolves a File: title to the current media and keeps resolving after a
     * re-upload; a stored upload.wikimedia.org URL does not. The id outlives the URL, which is the
     * whole reason identity is stored separately from mediaUrl.
     */
    const url = rehydrationUrlFor({
      provider: "wikimedia", providerAssetId: "File:Reichstag.jpg",
      mediaUrl: "https://upload.wikimedia.org/old/path.jpg",
    })!;
    expect(url.kind).toBe("derived");
    expect(url.url).toContain("Special:FilePath/Reichstag.jpg");
  });

  it("providers with a stable media URL use it", () => {
    for (const provider of ["loc", "nasa", "nara", "europeana", "openverse", "internet_archive"]) {
      const url = rehydrationUrlFor({
        provider, providerAssetId: "x", mediaUrl: "https://example.org/media.mp4",
      })!;
      expect(url.url, provider).toBe("https://example.org/media.mp4");
    }
  });

  it("an identity with nothing fetchable yields no URL at all", () => {
    expect(rehydrationUrlFor({ provider: "pexels", providerAssetId: "1" })).toBeNull();
    expect(rehydrationUrlFor({ provider: "wikimedia" })).toBeNull();
  });

  it("§5: THE CACHE KEY IS THE IDENTITY, so an expiring URL cannot fragment it", () => {
    /**
     * The same Pexels clip handed out under two CDN links is ONE asset. Keying the cache on the URL
     * would store it twice and hit neither; keying it on provider:id is why the cache works at all
     * across renders.
     */
    const monday = { provider: "pexels", providerAssetId: "3195394", mediaUrl: "https://cdn/a.mp4?exp=1" };
    const friday = { provider: "pexels", providerAssetId: "3195394", mediaUrl: "https://cdn/b.mp4?exp=2" };
    expect(cacheIdentityKey(friday)).toBe(cacheIdentityKey(monday));
    expect(cacheIdentityKey(monday)).not.toBe(
      cacheIdentityKey({ provider: "pexels", providerAssetId: "999" })
    );
    // §16 — an identity is all that is ever keyed on; no credential can reach the key.
    expect(cacheIdentityKey(monday)).not.toContain("exp=");
  });

  it("the filename is stable across renders and distinct per asset", () => {
    const a = { provider: "pexels", providerAssetId: "1" };
    expect(rehydratedFileName(a)).toBe(rehydratedFileName(a));
    expect(rehydratedFileName(a)).not.toBe(rehydratedFileName({ provider: "pexels", providerAssetId: "2" }));
  });
});

/* ═══════════════════════ PHASE 10 — EDL → timeline ═══════════════════════ */

describe("PHASE 10 — the adapter translates and decides nothing", () => {
  const decision = (over: Partial<EditDecision> = {}): EditDecision => ({
    beatId: "b1",
    sceneIndex: 0,
    clip: {
      candidateId: "wikimedia:File:X.jpg",
      assetType: "video",
      localPath: null,
      remoteUrl: "https://upload.wikimedia.org/x.mp4",
      trimStartSec: 2.5,
      trimEndSec: 6.5,
      startSec: 0,
      endSec: 4,
      timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "slow_push", intensity: 0.4, reason: "r" },
    transitionIn: { type: "cross_dissolve", durationSec: 0.5, reason: "r" },
    captions: [],
    motionGraphics: [],
    effects: [],
    sounds: [],
    pacing: { tone: "dramatic", cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "r" },
    ...over,
  });

  const identity = { provider: "wikimedia", providerAssetId: "File:X.jpg", mediaUrl: "https://u/x.mp4" };

  it("the planner's trim points become sourceIn/sourceOut UNCHANGED", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision(), sceneOffsetSec: 10, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.sourceIn).toBe(2.5);
    expect(clip!.sourceOut).toBe(6.5);
  });

  /**
   * RENDER 564 — the clip remembers WHICH BEAT it illustrates.
   *
   * `beatIndex` has been on `TimelineVideoClip` since RONDE 148 and nothing ever set it, so every
   * consumer that needed a clip's beat had to parse it back out of the element id or give up. The
   * cutover needs it: it is how the render job is told which already-downloaded file belongs to
   * which clip, and `sceneIndex` alone cannot distinguish a scene's beats from one another.
   */
  it("the clip records the beat it illustrates, from the decision's own beat id", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [
        { decision: decision({ beatId: "s2b7", sceneIndex: 2 }), sceneOffsetSec: 0, identity },
      ],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.sceneIndex).toBe(2);
    expect(clip!.beatIndex).toBe(7);
  });

  /**
   * An id in another shape leaves the field ABSENT. Defaulting it to 0 would file this clip under
   * beat 0 of its scene and hand that beat's file to a clip that never belonged to it — the same
   * class of mistake as a verdict recorded under the wrong beat.
   */
  it("a beat id in another shape leaves beatIndex absent rather than defaulting to zero", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision({ beatId: "b1" }), sceneOffsetSec: 0, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.beatIndex).toBeUndefined();
  });

  it("beat-relative times become absolute using the caller's offset", () => {
    // The one thing the adapter computes, and it is arithmetic on the planner's own numbers.
    //
    // Read on the SECOND clip. The property under test — a beat's own seconds plus its scene's
    // offset — is unchanged, but the first clip in a translation is now pulled back to zero by
    // `holdPictureUnderVoice`, because a film that opens on ten seconds of nothing is a hole, not
    // an edit. Asserting the arithmetic on the leading clip would be asserting the absence of that
    // repair rather than the offset maths it was written for.
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [
        { decision: decision({ beatId: "s0b0" }), sceneOffsetSec: 0, identity },
        { decision: decision({ beatId: "s1b0" }), sceneOffsetSec: 10, identity },
      ],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(clips[1]!.timelineStart).toBe(10);
    expect(clips[1]!.timelineEnd).toBe(14);
    expect(timeline.durationSec).toBe(14);
  });

  /**
   * The repair itself, asserted here so the change to the test above is not the only record of it.
   *
   * A translation whose first surviving clip starts late has lost its opening beat to a colour card
   * or an unattributable adoption. Holding the first shot back to zero is what keeps the film from
   * opening on nothing — and it does NOT touch `sourceIn`, so the shot still shows the frames the
   * planner chose; it simply begins sooner.
   */
  it("a film that would open on nothing opens on its first shot instead", () => {
    const { timeline, covered } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision(), sceneOffsetSec: 10, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.timelineStart).toBe(0);
    expect(clip!.timelineEnd).toBe(14);
    expect(clip!.sourceIn).toBe(2.5);
    expect(covered.join(" ")).toContain("the first shot now starts at 0");
  });

  it("the engine's transition and camera vocabularies map to the renderer's", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision(), sceneOffsetSec: 0, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.transitionIn).toBe("crossfade");
    expect(clip!.motion).toBe("slow_push");
    expect(TRANSITION_MAP.cut).toBe("hard_cut");
    expect(CAMERA_MAP.camera_hold).toBe("none");
  });

  it("A TRANSITION THE RENDERER CANNOT DO IS REPORTED, not silently swapped", () => {
    /**
     * The planner recorded a reason for choosing a film burn. Turning it into a dissolve without
     * saying so would make the render differ from the plan with nothing anywhere admitting it.
     */
    const { timeline, unsupported } = translateEdl({
      videoId: 1,
      inputs: [{
        decision: decision({ transitionIn: { type: "film_burn", durationSec: 0.5, reason: "era shift" } }),
        sceneOffsetSec: 0,
        identity,
      }],
    });
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.transitionIn).toBe("hard_cut");
    expect(unsupported.some((u) => u.includes("film_burn"))).toBe(true);
    expect(unsupported.some((u) => u.includes("era shift"))).toBe(true);
  });

  it("subtitles go to CAPTIONS and editorial cards go to TEXT", () => {
    /**
     * Different tracks because a user switching captions off must not lose the date cards with
     * them — they are different kinds of thing that happen to both be text.
     */
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{
        decision: decision({
          captions: [
            { captionType: "subtitle", text: "spoken words", startSec: 0, endSec: 2, animation: "fade", position: "bottom", reason: "r" },
            { captionType: "date", text: "APRIL 1945", startSec: 0.5, endSec: 3, animation: "fade", position: "center", reason: "r" },
          ],
        }),
        sceneOffsetSec: 0,
        identity,
      }],
    });
    const caps = timeline.tracks.find((t) => t.kind === "CAPTIONS");
    const texts = timeline.tracks.find((t) => t.kind === "TEXT");
    expect(caps && caps.kind === "CAPTIONS" ? caps.captions.length : 0).toBe(1);
    expect(texts && texts.kind === "TEXT" ? texts.texts.length : 0).toBe(1);
    expect(trackForCaption({ captionType: "subtitle" } as never)).toBe("CAPTIONS");
    expect(trackForCaption({ captionType: "location" } as never)).toBe("TEXT");
  });

  it("motion graphics and effects are reported as not executed, never dropped in silence", () => {
    /**
     * RONDE 149 note: this used to use `glow` as the unexecutable effect, and glow now RENDERS
     * (split/gblur/screen). The test failed while the code had improved — so the example moved to
     * `lens_flare`, which genuinely cannot be done with a filter because it needs an overlay
     * sprite. What is being tested is unchanged: an effect the renderer cannot run is REPORTED.
     */
    const { unsupported } = translateEdl({
      videoId: 1,
      inputs: [{
        decision: decision({
          motionGraphics: [{ graphicType: "map", data: {}, startSec: 0, durationSec: 2, reason: "r" }],
          effects: [{ effectType: "lens_flare", startSec: 0, durationSec: 1, intensity: 0.5, reason: "r" } as never],
        }),
        sceneOffsetSec: 0,
        identity,
      }],
    });
    expect(unsupported.some((u) => u.includes("map"))).toBe(true);
    expect(unsupported.some((u) => u.includes("lens_flare"))).toBe(true);
  });

  it("RONDE 149: an effect the renderer CAN run is not reported as missing", () => {
    // The other half of the same rule — reporting a supported effect would be crying wolf.
    const { timeline, unsupported } = translateEdl({
      videoId: 1,
      inputs: [{
        decision: decision({
          effects: [{ effectType: "glow", startSec: 0, durationSec: 1, intensity: 0.5, reason: "r" } as never],
        }),
        sceneOffsetSec: 0,
        identity,
      }],
    });
    expect(unsupported.some((u) => u.includes("glow"))).toBe(false);
    // And it is still carried on the clip, so the renderer can execute it.
    const track = timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.effects?.[0]?.effectType).toBe("glow");
  });

  it("the translation is DETERMINISTIC — same EDL, same timeline", () => {
    const input = { decision: decision(), sceneOffsetSec: 3, identity };
    const a = translateEdl({ videoId: 1, inputs: [input] });
    const b = translateEdl({ videoId: 1, inputs: [input] });
    expect(timelineDigest(b.timeline)).toBe(timelineDigest(a.timeline));
    expect(JSON.stringify(b.timeline.tracks)).toBe(JSON.stringify(a.timeline.tracks));
  });

  it("a persisted voiceover becomes the VOICE track", () => {
    const { timeline } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision(), sceneOffsetSec: 0, identity }],
      voice: { url: "/local-storage/videos/1/voiceover.mp3", durationSec: 12 },
    });
    const voice = timeline.tracks.find((t) => t.kind === "VOICE");
    const clips = voice && voice.kind === "VOICE" ? voice.clips : [];
    expect(clips).toHaveLength(1);
    expect(clips[0]!.source.canonicalUrl).toBe("/local-storage/videos/1/voiceover.mp3");
    expect(clips[0]!.end).toBe(12);
  });

  it("the timeline carries a schema version", () => {
    const { timeline } = translateEdl({ videoId: 1, inputs: [], voice: null });
    expect(timeline.schemaVersion).toBe(TIMELINE_SCHEMA_VERSION);
  });
});

/* ═══════════════════════ THE CHAIN, END TO END ═══════════════════════ */

describe("END TO END — identity → rehydrate → validate → render → MP4", () => {
  it("REAL FFMPEG: a timeline whose clips have no local file still renders", async () => {
    /**
     * The path the brief's end criterion names, exercised with nothing mocked but the provider's
     * network call — and that stands in for a real download by copying a real file, so the bytes
     * that reach the renderer are real bytes it has never seen before.
     */
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      // No canonicalUrl, no localPath: exactly what an old render leaves behind.
      track.clips[0]!.source = { provider: "wikimedia", providerAssetId: "File:A.mp4" };
      track.clips[1]!.source = { provider: "loc", providerAssetId: "item/2", mediaUrl: "https://loc/b.mp4" };
    }
    t.tracks = t.tracks.map((x) =>
      x.kind === "TEXT"
        ? {
            kind: "TEXT",
            texts: [{
              id: "t1", text: "REHYDRATED", start: 0.5, end: 5,
              style: { ...DEFAULT_TEXT_STYLE, fontSizePx: 28 }, animation: "fade",
            }],
          }
        : x
    );

    // 1. validate BEFORE rendering — the whole point of the validator's placement
    const validation = validateTimeline(t);
    expect(validation.issues.filter((i) => i.code === "missing_asset")).toEqual([]);
    expect(() => assertRenderableTimeline(t)).not.toThrow();

    // 2. rehydrate every clip from its identity alone
    const workDir = path.join(ROOT, "e2e_work");
    /**
     * Keyed on the URL the rehydrator DERIVES, not on the id — because that derivation is the
     * thing under test. Wikimedia becomes Special:FilePath/A.mp4 from the title alone; `loc` keeps
     * its stored media URL, which shares nothing with its id "item/2".
     */
    const bySource = new Map<string, string>([
      ["Special:FilePath/A.mp4", SOURCE_A],
      ["https://loc/b.mp4", SOURCE_B],
    ]);
    const rehydration = await rehydrateTimelineAssets({
      timeline: t,
      workDir,
      deps: {
        download: async (url, dest) => {
          // Stands in for the network: the URL the rehydrator derived decides which file arrives.
          const src = [...bySource.entries()].find(([key]) => url.includes(key))?.[1];
          if (!src) return false;
          fs.copyFileSync(src, dest);
          return true;
        },
      },
    });
    expect(rehydration.failures).toEqual([]);
    expect(rehydration.ok).toBe(true);
    expect(formatRehydrationSummary(rehydration)[0]).toContain("recovered=2");
    const recovered = rehydration.byClipId;

    // 3. render from the rehydrated files
    const out = path.join(ROOT, "e2e.mp4");
    const rendered = await renderTimeline({
      timeline: t,
      workDir: path.join(ROOT, "e2e_render"),
      outputPath: out,
      resolveMedia: async (clip) => recovered.get(clip.id) ?? null,
    });
    expect(rendered.clipsRendered).toBe(2);
    expect(rendered.skipped).toEqual([]);
    expect(rendered.textsDrawn).toBe(1);

    // 4. the quality gate, measured with ffprobe
    const check = await checkRenderedFile({ filePath: out, timeline: t, expectAudio: false });
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.widthPx).toBe(320);
    expect(check.durationSec).toBeGreaterThan(5.5);
  }, 420_000);

  it("a clip that cannot be rehydrated stops the render with its name, not silently", async () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.source = { provider: "pexels" };
    const issues = validateTimeline(t).issues.filter((i) => i.code === "missing_asset");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.elementId).toBe("vc_0");
    expect(() => assertRenderableTimeline(t)).toThrow(TimelineValidationError);
  });
});
