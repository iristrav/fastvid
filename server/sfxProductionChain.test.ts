/**
 * ENABLE CINEMATIC PRODUCTION + SFX — a planned sound effect actually makes a sound.
 *
 * ── The defect this closes ──────────────────────────────────────────────────────────────────
 *
 * The Phase 4 sound planner is genuinely semantic: it reads the beat's content and asks for an
 * explosion where something explodes, a crowd where a crowd is named, and nothing at all for "The
 * committee met on Tuesday." All of that worked.
 *
 * Then `edlToTimeline` wrote the planner's own word onto the timeline as the ASSET ID:
 *
 *     source: { provider: "cinematic_audio", providerAssetId: "explosion" }
 *
 * Nothing in the repository resolves `cinematic_audio`. Not the render worker, not the rehydrator,
 * not `providerResolver`. So every sound effect reasoned out of a beat reached the document,
 * failed to resolve, and was dropped by the renderer as "could not be recovered".
 *
 * The render worker had the mirror defect: its audio loop began `if (!url) continue`, and an SFX or
 * AMBIENT clip is addressed by identity and carries no URL — so both tracks were skipped there in
 * silence, without even the warning that fires when a real download fails.
 *
 * Two halves of one seam, and the bridge to cross it (`audioAssetSource` → the Freesound catalogue)
 * had existed since R154. This is the missing row and the missing call.
 *
 * ── The rule these tests protect ────────────────────────────────────────────────────────────
 *
 * Never a fake sound. A whoosh, a heartbeat and a cash register are not field recordings and this
 * catalogue is a field-recording library, so they resolve to nothing and are reported as
 * SFX_NOT_AVAILABLE — rather than played as "something close", which is the failure the brief names
 * explicitly.
 */
import { describe, expect, it } from "vitest";

import { planSoundEffects } from "./cinematicEditingEngine/soundPlanner";
import type { EditDecision, PacingProfile } from "./cinematicEditingEngine/types";
import { translateEdl } from "./edlToTimeline";
import { formatSfxPlan } from "./cinematicProduction";
import { SOUND_EFFECT_TO_CATEGORY, resolveSoundEffect } from "./audioAssetSource";
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import type { VisualIntent } from "./visualMatchingV2/types";

function intent(over: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "s0b0", spokenText: "", visualSubject: "", visualAction: "", visualLocation: "",
    visualTime: "", historicalContext: "", emotion: "neutral", visualDescription: "",
    primaryKeyword: "", secondaryKeyword: "", negativeKeywords: [], secondaryVisualSubjects: [],
    objects: [], brands: [], companies: [], people: [], countries: [], events: [],
    intentHash: "h", cacheHit: false, ...over,
  } as VisualIntent;
}

const PACING: PacingProfile = {
  tone: "dramatic", cutSpeedMultiplier: 1, movementIntensity: 0.5, reason: "r",
};

const plan = (spokenText: string) => planSoundEffects(intent({ spokenText }), PACING, 4, 6);

/* ═══════════════════════ §5 — semantic, not automatic ═══════════════════════ */

describe("SFX — planned from what the beat says", () => {
  /** Each of these is a sound the beat's own words call for. */
  it.each([
    ["A huge explosion tore through the building.", "explosion"],
    ["The crowd filled the square.", "crowd"],
    ["The audience applauded for a full minute.", "applause"],
    ["Rain fell on the empty street.", "rain"],
    ["Press photographers pushed forward for a photograph.", "camera_click"],
  ])("%s → plans %s", (text, soundType) => {
    expect(plan(text).map((s) => s.soundType)).toContain(soundType);
  });

  /**
   * The load-bearing negative, and the brief's own example. A planner that fires on everything
   * makes a worse film and would pass any "SFX exist" test.
   */
  it("an ordinary sentence gets no sound at all", () => {
    expect(plan("The committee met on Tuesday.")).toEqual([]);
    expect(plan("He was appointed to the role that year.")).toEqual([]);
  });

  /** Every cue must say why it was planned — a sound with no reason cannot be reviewed. */
  it("every planned sound carries its reason and a sane volume", () => {
    for (const s of plan("A huge explosion tore through the crowd.")) {
      expect(s.reason.length, `${s.soundType} has no reason`).toBeGreaterThan(20);
      expect(s.volume).toBeGreaterThan(0);
      /** Narration is primary: no effect may be planned at full scale. */
      expect(s.volume, `${s.soundType} is loud enough to fight the narration`).toBeLessThanOrEqual(0.7);
      expect(s.fadeInSec).toBeGreaterThanOrEqual(0);
      expect(s.fadeOutSec).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ═══════════════════════ §6 — the sound is a REAL recording ═══════════════════════ */

describe("SFX — every mapped sound names a real catalogue recording", () => {
  /**
   * The mapping must be complete over the planner's vocabulary: a sound type missing from the table
   * would be `undefined` rather than a decision, and would silently resolve to nothing.
   */
  it("covers every sound type the planner can emit", () => {
    const planned = new Set(
      [
        ...plan("A huge explosion tore through the crowd."),
        ...plan("Rain fell as the fire burned and the wind rose."),
        ...plan("He turned the page, typing at the keyboard."),
      ].map((s) => s.soundType)
    );
    for (const type of planned) {
      expect(
        Object.prototype.hasOwnProperty.call(SOUND_EFFECT_TO_CATEGORY, type),
        `${type} has no row in SOUND_EFFECT_TO_CATEGORY`
      ).toBe(true);
    }
  });

  /** Every non-null mapping must point at a category the catalogue really holds. */
  it("no mapping points at an empty catalogue category", () => {
    for (const [type, category] of Object.entries(SOUND_EFFECT_TO_CATEGORY)) {
      if (!category) continue;
      expect(SOUND_CATALOG[category]?.length, `${type} → "${category}" has no recording`)
        .toBeGreaterThan(0);
    }
  });

  it("resolves to a Freesound identity, not to the planner's own word", () => {
    const found = resolveSoundEffect("explosion", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.identity.provider).toBe("freesound");
    expect(found.identity.providerAssetId).toMatch(/^\d+$/);
    expect(found.identity.sourcePageUrl).toContain("freesound.org");
  });

  /** Determinism: the same timeline must not render a different mix on every attempt. */
  it("the same request resolves to the same recording every time", () => {
    const a = resolveSoundEffect("crowd", 3);
    const b = resolveSoundEffect("crowd", 3);
    expect(a).toEqual(b);
  });

  /**
   * §6's rule. A whoosh is not a field recording, so there is nothing to play — and the answer is
   * an explicit refusal, never a metal clang standing in for it.
   */
  it.each(["whoosh", "heartbeat", "notification", "cash_register", "ui_click"] as const)(
    "%s has no recording and says so rather than approximating one",
    (type) => {
      const found = resolveSoundEffect(type, 0);
      expect(found.ok).toBe(false);
      if (found.ok) return;
      expect(found.reason).toContain("SFX_NOT_AVAILABLE");
    }
  );
});

/* ═══════════════════════ §8 — it reaches the timeline, correctly timed ═══════════════════════ */

describe("SFX — the plan crosses into the timeline", () => {
  const identity = { provider: "wikimedia", providerAssetId: "File:X.jpg", mediaUrl: "https://u/x.mp4" };

  const decision = (over: Partial<EditDecision> = {}): EditDecision => ({
    beatId: "b1",
    sceneIndex: 0,
    clip: {
      candidateId: "wikimedia:File:X.jpg", assetType: "video", localPath: null,
      remoteUrl: "https://upload.wikimedia.org/x.mp4",
      trimStartSec: 0, trimEndSec: 8, startSec: 0, endSec: 8,
      timingSource: "tts_word_alignment",
    },
    shot: { shotType: "wide", reason: "r" } as EditDecision["shot"],
    camera: { movement: "slow_push", intensity: 0.4, reason: "r" },
    transitionIn: { type: "cross_dissolve", durationSec: 0.5, reason: "r" },
    captions: [], motionGraphics: [], effects: [], sounds: [],
    pacing: PACING,
    ...over,
  });

  const sfxTrackFor = (sounds: EditDecision["sounds"], sceneOffsetSec = 10) => {
    const { timeline, unsupported } = translateEdl({
      videoId: 1,
      inputs: [{ decision: decision({ sounds }), sceneOffsetSec, identity }],
    });
    const track = timeline.tracks.find((t) => t.kind === "SFX");
    return { clips: track?.kind === "SFX" ? track.clips : [], unsupported, timeline };
  };

  /**
   * The regression itself. Before this round the clip's provider was the literal string
   * "cinematic_audio", which nothing resolves — so this assertion is the difference between a
   * sound that plays and a sound that is dropped.
   */
  it("a planned explosion becomes a clip with a real Freesound identity", () => {
    const { clips } = sfxTrackFor(plan("A huge explosion tore through the building."));
    expect(clips.length).toBeGreaterThan(0);
    const clip = clips[0]!;
    expect(clip.source.provider, "the planner's own word is still being used as an asset id")
      .toBe("freesound");
    expect(clip.source.providerAssetId).toMatch(/^\d+$/);
    expect(clip.source.provider).not.toBe("cinematic_audio");
  });

  /** Timing is the scene offset plus the planner's own moment — not the start of the video. */
  it("lands at the planned moment, with a real duration and gain", () => {
    const sounds = plan("A huge explosion tore through the building.");
    const { clips } = sfxTrackFor(sounds, 10);
    const clip = clips[0]!;
    expect(clip.start).toBeCloseTo(10 + sounds[0]!.timeSec, 3);
    expect(clip.end).toBeGreaterThan(clip.start);
    expect(clip.end - clip.start).toBeLessThanOrEqual(3);
    expect(clip.gain).toBeGreaterThan(0);
    /** Narration stays primary: an effect never arrives at full scale. */
    expect(clip.gain).toBeLessThanOrEqual(0.7);
    expect(clip.fadeInSec).toBeGreaterThanOrEqual(0);
    expect(clip.fadeOutSec).toBeGreaterThanOrEqual(0);
  });

  /** An effect punctuates a moment; it must never run under the whole film. */
  it("does not stretch across the video", () => {
    const { clips, timeline } = sfxTrackFor(plan("The crowd filled the square as the rain fell."));
    for (const c of clips) {
      expect(c.end - c.start, `${c.id} runs for the whole video`).toBeLessThan(timeline.durationSec);
    }
  });

  /**
   * §6 again, at the seam: a sound with no recording is NOT written to the timeline, and the reason
   * is reported. A silent clip nobody can fetch would be the fake effect in another costume.
   */
  it("a sound with no recording is left out and reported, not faked", () => {
    const sounds = plan("A huge explosion tore through the building.").concat([
      { soundType: "heartbeat", timeSec: 1, volume: 0.3, fadeInSec: 0.4, fadeOutSec: 0.4, reason: "tension" },
    ]);
    const { clips, unsupported } = sfxTrackFor(sounds);
    expect(clips.map((c) => c.id).join(" "), "a heartbeat clip was written with nothing behind it")
      .not.toContain("heartbeat");
    expect(unsupported.join(" ")).toContain("SFX_NOT_AVAILABLE");
    expect(unsupported.join(" ")).toContain("heartbeat");
  });

  it("an ordinary beat produces an empty SFX track", () => {
    expect(sfxTrackFor(plan("The committee met on Tuesday.")).clips).toEqual([]);
  });
});

/* ═══════════════════════ §9 — the audit line ═══════════════════════ */

describe("SFX — the render says which sounds it has", () => {
  const identity = { provider: "wikimedia", providerAssetId: "File:X.jpg", mediaUrl: "https://u/x.mp4" };
  const built = translateEdl({
    videoId: 1,
    inputs: [{
      decision: {
        beatId: "b7", sceneIndex: 0,
        clip: {
          candidateId: "wikimedia:File:X.jpg", assetType: "video", localPath: null,
          remoteUrl: "https://u/x.mp4", trimStartSec: 0, trimEndSec: 8,
          startSec: 0, endSec: 8, timingSource: "tts_word_alignment",
        },
        shot: { shotType: "wide", reason: "r" },
        camera: { movement: "slow_push", intensity: 0.4, reason: "r" },
        transitionIn: { type: "cross_dissolve", durationSec: 0.5, reason: "r" },
        captions: [], motionGraphics: [], effects: [],
        sounds: plan("A huge explosion tore through the building.").concat([
          { soundType: "whoosh", timeSec: 1, volume: 0.4, fadeInSec: 0.05, fadeOutSec: 0.15, reason: "t" },
        ]),
        pacing: PACING,
      } as EditDecision,
      sceneOffsetSec: 0,
      identity,
    }],
  });

  const lines = formatSfxPlan(built.timeline, built.unsupported);

  it("names each sound that will play, with the recording behind it", () => {
    const found = lines.filter((l) => l.includes("status=FOUND"));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatch(/\[SFX\] beat=\S+ type=\S+ status=FOUND source=freesound:\d+/);
    expect(found[0]).toMatch(/start=[\d.]+ dur=[\d.]+ gain=[\d.]+/);
  });

  it("names each sound it could not play", () => {
    expect(lines.some((l) => l.includes("status=NOT_AVAILABLE") && l.includes("whoosh"))).toBe(true);
  });

  /** A video with no effects says so, rather than printing nothing and looking like a bug. */
  it("says so when a video has no sounds at all", () => {
    const empty = translateEdl({ videoId: 1, inputs: [] });
    expect(formatSfxPlan(empty.timeline, [])).toEqual(["[SFX] none planned for this video"]);
  });

  /** The Freesound id is a public asset identity; no key or token may appear in the line. */
  it("prints no credential", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/api[_-]?key|token|secret/i);
    }
  });
});

/* ═══════════════════════ the render worker fetches it ═══════════════════════ */

describe("SFX — the render worker can actually fetch an identity-addressed sound", () => {
  /**
   * The mirror half of the defect. The worker's audio loop opened with `if (!url) continue`, and an
   * SFX or AMBIENT clip carries no URL at all — only `freesound:398913`. Both tracks were therefore
   * skipped there without even the warning that fires when a real download fails.
   */
  it("the audio loop no longer requires a URL", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    const start = src.indexOf("const audioByClip = new Map<string, string>();");
    expect(start, "the worker's audio loop has moved").toBeGreaterThan(-1);
    const loop = src.slice(start, src.indexOf("/* 5.", start));
    expect(loop, "an audio clip without a URL is still skipped outright")
      .not.toMatch(/if \(!url\) continue;/);
    expect(loop, "the worker does not resolve provider identities for audio")
      .toContain("providerResolver");
  });

  /**
   * And the route it resolves through is real and reachable. Without a Freesound key this
   * environment cannot fetch the recording — the point is that the answer is a specific, honest
   * refusal about THIS asset rather than "no lookup is implemented for provider freesound", which
   * is what an unwired provider returns.
   */
  it("the shared resolver knows freesound and says exactly why it cannot fetch here", async () => {
    const { productionRehydrateDeps } = await import("./rehydrationDeps");
    const deps = productionRehydrateDeps({ download: async () => false });
    const resolved = await deps.providerResolver!({
      provider: "freesound",
      providerAssetId: "398913",
    });
    expect(resolved.ok === false && resolved.code, JSON.stringify(resolved))
      .not.toBe("REHYDRATION_UNSUPPORTED_PROVIDER");
    if (!resolved.ok) {
      expect(resolved.message).toContain("Freesound");
      /** The reason names the missing configuration, not a made-up fault. */
      expect(resolved.message).toContain("FREESOUND_API_KEY");
    }
  }, 60_000);

  /** Every SFX identity the timeline writes must be one that resolver recognises. */
  it("the provider written onto SFX clips is one the resolver handles", () => {
    const found = resolveSoundEffect("crowd", 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.identity.provider).toBe("freesound");
  });
});
