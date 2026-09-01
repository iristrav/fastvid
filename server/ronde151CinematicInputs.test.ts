/**
 * RONDE 151 §26 — the bridge between the production pipeline and the cinematic engine.
 *
 * These tests exist because of what the §1 audit found. RONDE 150 ended with "the cinematic
 * pipeline exists but the main pipeline does not call it", which sounds like a missing function
 * call. It was not: the production pipeline speaks `SceneBeat` + clip paths + lineage records, and
 * the engine's input contract is written in `VisualIntent` + `CandidateAsset` — types belonging to
 * visualMatchingV2, a parallel retrieval system that is feature-flagged off and not imported by
 * videoPipeline.ts at all.
 *
 * So the thing to test is the translation, and specifically the two ways a translation can lie:
 * by inventing a value the pipeline never established, and by losing one it did.
 */
import { describe, expect, it } from "vitest";

import {
  beatIdFor,
  buildCinematicSceneInputs,
  candidateFrom,
  engineSourceFor,
  formatCinematicInputs,
  identityFrom,
  intentFrom,
  type AdoptedClipFacts,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ fixtures, in the production pipeline's own shapes ═══════════════════════ */

function scene(index: number, duration = 16): Scene {
  return {
    index,
    text: "Apple introduced the Vision Pro at its own campus in Cupertino.",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration,
    ...({} as Record<string, never>),
  };
}

/** A SceneBeat as `buildTtsSceneBeatMap` produces it: voice times SCENE-LOCAL. */
function beat(index: number, startSec: number, durationSec = 4): ProductionBeat {
  return {
    index,
    text: `Beat ${index} narration about Apple.`,
    searchQuery: "apple park",
    powerWord: "Apple",
    keywords: ["apple", "vision pro"],
    holdSec: durationSec,
    visualDescription: "",
    voiceStartSec: startSec,
    voiceEndSec: startSec + durationSec,
  };
}

function adoption(overrides: Partial<AdoptionFacts> = {}): AdoptionFacts {
  return {
    provider: "pexels",
    providerAssetId: "12345",
    sourceUrl: "https://videos.pexels.com/x.mp4",
    assetTitle: "Apple Park",
    query: "apple park",
    ...overrides,
  };
}

function facts(overrides: Partial<AdoptedClipFacts> = {}): AdoptedClipFacts {
  return { localPath: "/tmp/clip.mp4", ...overrides };
}

function sceneFacts(index: number, beatCount: number, opts: { duration?: number } = {}): SceneFacts {
  const beats = Array.from({ length: beatCount }, (_, i) => beat(i, i * 4));
  return {
    scene: scene(index, opts.duration ?? beatCount * 4),
    beats,
    clips: beats.map((_, i) => ({
      facts: facts({ localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 }),
      adoption: adoption({ providerAssetId: `${index}${i}` }),
    })),
  };
}

/* ═══════════════════════ §4 / TEST 4 — the times, exactly ═══════════════════════ */

describe("RONDE 151 §4 — 4 beats × 4 seconds land on 0, 4, 8, 12", () => {
  /**
   * The brief asks for this test by name, and it is the one that would have caught the RONDE 150
   * double-count. Note that it goes all the way through: production beats → adapter → AI Director →
   * EDL → ProjectTimeline. Testing the adapter alone would prove nothing about the offset, because
   * the offset is applied two modules later.
   */
  it("through the WHOLE chain, from production beats to the finished timeline", () => {
    const scenes = [sceneFacts(0, 2, { duration: 8 }), sceneFacts(1, 2, { duration: 8 })];
    const built = buildCinematicSceneInputs({ scenes });
    expect(built.dropped).toEqual([]);
    expect(built.scenes).toHaveLength(2);

    // The scene offsets are derived from the pipeline's own durations, one per scene.
    expect(built.scenes.map((s) => s.sceneOffsetSec)).toEqual([0, 8]);

    const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes });
    const track = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];

    expect(clips.map((c) => c.timelineStart)).toEqual([0, 4, 8, 12]);
    expect(clips.map((c) => c.timelineEnd)).toEqual([4, 8, 12, 16]);
    expect(result.timeline.durationSec).toBeCloseTo(16, 3);
  });

  it("a per-beat offset cannot be expressed — the shape forbids the old mistake", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 2, { duration: 8 })] });
    const beatKeys = Object.keys(built.scenes[0]!.beats[0]!);
    expect(beatKeys).not.toContain("beatOffsetSec");
    expect(Object.keys(built.scenes[0]!)).toContain("sceneOffsetSec");
  });

  it("honours a MEASURED scene offset over the derived one, when the render has it", () => {
    const scenes = [sceneFacts(0, 1, { duration: 8 }), sceneFacts(1, 1, { duration: 8 })];
    // The TTS knows scene 1 really starts at 7.4s, not at the script's rounded 8.
    const built = buildCinematicSceneInputs({ scenes, sceneOffsetsSec: [0, 7.4] });
    expect(built.scenes.map((s) => s.sceneOffsetSec)).toEqual([0, 7.4]);
  });
});

/* ═══════════════════════ §2 — the translation invents nothing ═══════════════════════ */

describe("RONDE 151 §2 — an unknown field is empty, never plausible", () => {
  /**
   * ── RONDE 177 changed what this test asserts, and why ────────────────────────────────────
   *
   * It used to pin `visualTime`, `historicalContext`, `objects` and `events` as permanently "".
   * That was correct for R151 — nothing filled them — but it also pinned the bug: real planner
   * rules (the shot planner's object rules, the caption planner's date card and timeline label)
   * could never fire in production, because their inputs were hard-coded empty.
   *
   * R177 fills them from the RETRIEVAL path's own extractors. The rule this test still enforces is
   * unchanged and is the one that matters: a field is empty when the beat proves nothing, never
   * filled with something plausible. This beat names no year, no event and no object, so all four
   * are still "" — for a reason about the beat rather than about the pipeline.
   */
  it("leaves an intent field empty when the beat proves nothing for it", () => {
    const intent = intentFrom(beat(0, 0), 0, 0, adoption(), {});
    expect(intent.visualTime).toBe("");
    expect(intent.historicalContext).toBe("");
    expect(intent.objects).toEqual([]);
    expect(intent.events).toEqual([]);
  });

  /**
   * `emotion` and `countries` are the two that stay empty by design, and each for its own reason —
   * see intentFrom's comment. Pinned so that "fill them too" is a deliberate change rather than a
   * tidy-up.
   */
  it("still leaves emotion and countries empty, deliberately", () => {
    const intent = intentFrom(beat(0, 0), 0, 0, adoption(), {});
    expect(intent.emotion).toBe("");
    expect(intent.countries).toEqual([]);
    expect(intent.negativeKeywords).toEqual([]);
  });

  it("carries what production DOES know", () => {
    const intent = intentFrom(beat(3, 12), 1, 3, adoption(), {});
    expect(intent.beatId).toBe("s1b3");
    expect(intent.spokenText).toContain("Beat 3");
    expect(intent.visualSubject).toBe("Apple");
    expect(intent.primaryKeyword).toBe("apple park");
    expect(intent.secondaryKeyword).toBe("apple");
  });

  it("uses the pipeline's OWN extractors when they are injected — never a second copy", () => {
    const intent = intentFrom(beat(0, 0), 0, 0, adoption(), {
      people: () => ["Tim Cook"],
      place: () => "Cupertino",
      action: () => "walking on stage",
    });
    expect(intent.people).toEqual(["Tim Cook"]);
    expect(intent.visualLocation).toBe("Cupertino");
    expect(intent.visualAction).toBe("walking on stage");
  });

  it("takes intentHash from the query that ACTUALLY ran, not a recomputed hash", () => {
    const intent = intentFrom(beat(0, 0), 0, 0, adoption({ query: "apple park drone shot" }), {});
    expect(intent.intentHash).toBe("apple park drone shot");
    expect(intent.cacheHit).toBe(false);
  });

  /** §7 in one assertion: an unmeasured dimension is null, not a convenient number. */
  it("leaves width, height and duration NULL when this render never probed them", () => {
    const candidate = candidateFrom(facts(), adoption(), beat(0, 0), 0, 0);
    expect(candidate.width).toBeNull();
    expect(candidate.height).toBeNull();
    expect(candidate.duration).toBeNull();
  });

  it("carries a probe when the render DID take one", () => {
    const candidate = candidateFrom(
      facts({ widthPx: 1920, heightPx: 1080, durationSec: 12.5 }),
      adoption(),
      beat(0, 0),
      0,
      0
    );
    expect(candidate.width).toBe(1920);
    expect(candidate.height).toBe(1080);
    expect(candidate.duration).toBe(12.5);
  });

  it("is deterministic — the same render facts produce the same inputs", () => {
    const a = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 3)] });
    const b = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 3)] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

/* ═══════════════════════ §6 / TEST 5 — identity, and never a substitution ═══════════════════════ */

describe("RONDE 151 §6 — the adoption record is the only source of identity", () => {
  it("builds the identity from the record, never from the filename", () => {
    const identity = identityFrom(adoption({ provider: "wikimedia", providerAssetId: "File:X.jpg" }));
    expect(identity).toEqual({
      provider: "wikimedia",
      providerAssetId: "File:X.jpg",
      mediaUrl: "https://videos.pexels.com/x.mp4",
      title: "Apple Park",
    });
  });

  it("refuses an identity with no handle — a name alone cannot be fetched again", () => {
    expect(identityFrom({ provider: "pexels" })).toBeNull();
    expect(identityFrom(null)).toBeNull();
    expect(identityFrom({ provider: null, providerAssetId: "1" })).toBeNull();
  });

  it("accepts an archive row as a handle in its own right", () => {
    const identity = identityFrom({ provider: "curated", archiveAssetId: 91 });
    expect(identity?.archiveAssetId).toBe(91);
  });

  /**
   * The rule §28 states as "geen willekeurige asset substitution". A beat whose clip cannot be
   * proven leaves the edit and SAYS SO; it never inherits its neighbour's shot.
   */
  it("DROPS a beat whose clip has no rehydratable identity, and names it", () => {
    const s = sceneFacts(0, 2);
    s.clips[1] = { facts: facts(), adoption: { provider: "mystery" } };
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.scenes[0]!.beats).toHaveLength(1);
    expect(built.dropped.join(" ")).toContain("s0b1");
    expect(built.dropped.join(" ")).toContain("mystery");
    // The surviving beat keeps its OWN clip — it did not absorb the dropped one's.
    expect(built.scenes[0]!.beats[0]!.identity.providerAssetId).toBe("00");
  });

  it("drops a beat with no adopted clip at all, rather than leaving a hole in silence", () => {
    const s = sceneFacts(0, 2);
    s.clips[0] = null;
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.dropped.join(" ")).toContain("no clip was adopted");
    expect(built.scenes[0]!.beats).toHaveLength(1);
  });

  it("drops a whole scene that has nothing plannable, and says the scene is out", () => {
    const s = sceneFacts(0, 1);
    s.clips = [null];
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.scenes).toHaveLength(0);
    expect(built.dropped.join(" ")).toContain("scene 0");
  });

  it("drops a beat with no voice window and no hold, rather than planning a zero-length shot", () => {
    const s = sceneFacts(0, 1);
    s.beats[0] = { index: 0, text: "x", voiceStartSec: 2, voiceEndSec: 2, holdSec: 0 };
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.dropped.join(" ")).toContain("no voice window");
  });
});

/* ═══════════════════════ §7 — the trim into the provider's original ═══════════════════════ */

describe("RONDE 151 §7 — sourceIn is relative to what the rehydrator returns", () => {
  /**
   * The defect this closes, stated as a scenario.
   *
   * `trimRemoteVideoToClip` cuts a new file with `-ss clipStart`, so the adopted clip on disk
   * begins at second `clipStart` of the provider's asset. The planner then works in that file's
   * own time and says "use from 0". A re-render rehydrates the FULL asset from the provider and,
   * with no recorded offset, starts at second 0 of THAT — a different shot, in a video that
   * reports no error at all.
   */
  it("adds the render's own cut to the planner's trim", () => {
    const s = sceneFacts(0, 1);
    s.clips[0] = {
      facts: facts({ localPath: "/tmp/a.mp4", durationSec: 4 }),
      // The render cut this clip out of the original starting at 37.5 seconds.
      adoption: adoption({ sourceInSec: 37.5, sourceOutSec: 41.5 }),
    };
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.scenes[0]!.beats[0]!.sourceTrim).toEqual({ inSec: 37.5, outSec: 41.5 });

    const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes });
    const track = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;

    const planned = result.edl.decisions[0]!.clip;
    expect(clip!.sourceIn).toBeCloseTo(37.5 + planned.trimStartSec, 3);
    expect(clip!.sourceOut).toBeCloseTo(37.5 + planned.trimEndSec, 3);
    // The proof that the bug is gone: sourceIn is NOT the planner's 0.
    expect(clip!.sourceIn).toBeGreaterThan(30);
  });

  /** §7's other half: an unmeasured trim must not become a confident zero. */
  it("leaves the planner's own numbers alone when no cut was recorded", () => {
    const s = sceneFacts(0, 1);
    s.clips[0] = { facts: facts({ durationSec: 4 }), adoption: adoption() };
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.scenes[0]!.beats[0]!.sourceTrim).toBeUndefined();

    const result = runCinematicPipeline({ videoId: 1, scenes: built.scenes });
    const track = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    const clip = track && track.kind === "VIDEO" ? track.clips[0]! : null;
    expect(clip!.sourceIn).toBe(result.edl.decisions[0]!.clip.trimStartSec);
  });

  it("counts how many clips carried a measured trim, for the render log", () => {
    const s = sceneFacts(0, 2);
    s.clips[0] = { facts: facts({ durationSec: 4 }), adoption: adoption({ sourceInSec: 12 }) };
    const built = buildCinematicSceneInputs({ scenes: [s] });
    expect(built.stats.withTrim).toBe(1);
    expect(formatCinematicInputs(built)).toContain("trimmed=1");
  });
});

/* ═══════════════════════ the provider classification ═══════════════════════ */

describe("RONDE 151 — the engine's source token is a classification, not the provider", () => {
  it("passes an exact union member through unchanged", () => {
    expect(engineSourceFor("wikimedia")).toBe("wikimedia");
    expect(engineSourceFor("pexels")).toBe("pexels");
    expect(engineSourceFor("europeana")).toBe("europeana");
  });

  it("classifies a production provider the union has no name for", () => {
    // NARA and NASA are archival; the engine has no token for either.
    expect(engineSourceFor("nara")).toBe("internet_archive");
    expect(engineSourceFor("nasa")).toBe("internet_archive");
    expect(engineSourceFor("curated", 42)).toBe("own_archive");
    expect(engineSourceFor("runway")).toBe("ai_generated");
  });

  /**
   * The important negative. `own_archive` and `internet_archive` both put the shot planner into
   * its archival branch, so an unknown provider must NOT get one: that would apply an editorial
   * rule on no evidence at all.
   */
  it("does not call an unclassified provider archival", () => {
    const token = engineSourceFor("some-new-provider");
    expect(["own_archive", "internet_archive"]).not.toContain(token);
  });

  it("the TRUE provider always survives in the identity, whatever token the engine sees", () => {
    const a = adoption({ provider: "nara", providerAssetId: "12345" });
    expect(engineSourceFor(a.provider)).toBe("internet_archive");
    // Provenance, the colour grade and the rehydrator all read THIS, and it still says nara.
    expect(identityFrom(a)!.provider).toBe("nara");
  });
});

/* ═══════════════════════ the whole chain ═══════════════════════ */

describe("RONDE 151 §2 — production facts reach the finished timeline", () => {
  it("every clip on the timeline carries its own beat's proven identity", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 2), sceneFacts(1, 2)] });
    const result = runCinematicPipeline({ videoId: 4, scenes: built.scenes });
    const track = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(clips.map((c) => c.source.providerAssetId)).toEqual(["00", "01", "10", "11"]);
    expect(clips.every((c) => c.source.provider === "pexels")).toBe(true);
  });

  it("the AI Director sees every scene the adapter planned", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 2), sceneFacts(1, 2)] });
    expect(built.scenes[0]!.director.beatIntents).toHaveLength(2);
    expect(built.scenes[0]!.director.durationSec).toBeGreaterThan(0);
    expect(built.scenes.map((s) => s.director.scene.index)).toEqual([0, 1]);
  });

  it("the log line reports counts and never a path or a URL", () => {
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts(0, 2)] });
    const line = formatCinematicInputs(built);
    expect(line).toContain("[CinematicPipeline]");
    expect(line).toContain("planned=2");
    expect(line).not.toContain("/tmp/");
    expect(line).not.toMatch(/https?:/);
  });

  it("beat ids are positional and stable", () => {
    expect(beatIdFor(2, 3)).toBe("s2b3");
    expect(beatIdFor(0, 0)).toBe("s0b0");
  });
});
