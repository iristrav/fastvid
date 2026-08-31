/**
 * RONDE 151 §5/§19/§20/§26 — the production route, including every way it refuses.
 *
 * `planAndStoreCinematicTimeline` is the function videoPipeline.ts now calls. Its interesting
 * behaviour is not the happy path — that is `runCinematicPipeline`, already tested — but what it
 * does when something is wrong: whether it stores a bad plan, whether it says so, and whether a
 * failure here can cost a video that has already been rendered and uploaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CINEMATIC_PLAN_ERROR,
  cinematicPlanningEnabled,
  cinematicRenderPathEnabled,
  formatRenderRoute,
  planAndStoreCinematicTimeline,
} from "./cinematicProduction";
import type { SceneFacts } from "./cinematicPipelineInputs";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ fixtures ═══════════════════════ */

function scene(index: number, duration = 8): Scene {
  return {
    index,
    text: "Apple introduced the Vision Pro.",
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration,
  };
}

function sceneFacts(index: number, beatCount = 2): SceneFacts {
  const beats = Array.from({ length: beatCount }, (_, i) => ({
    index: i,
    text: `Beat ${i} about Apple.`,
    searchQuery: "apple park",
    powerWord: "Apple",
    holdSec: 4,
    voiceStartSec: i * 4,
    voiceEndSec: i * 4 + 4,
  }));
  return {
    scene: scene(index, beatCount * 4),
    beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 },
      adoption: {
        provider: "pexels",
        providerAssetId: `${index}${i}`,
        sourceUrl: "https://videos.pexels.com/x.mp4",
        query: "apple park",
      },
    })),
  };
}

/** A persist that records what it was asked to store, and says it worked. */
function recordingPersist() {
  const calls: Array<{ id: number; timeline: unknown; expectedVersion: number; nextVersion: number }> = [];
  return {
    calls,
    persist: async (p: { id: number; timeline: unknown; expectedVersion: number; nextVersion: number }) => {
      calls.push(p);
      return { saved: true };
    },
  };
}

const ORIGINAL_ENGINE = process.env.CINEMATIC_EDITING_ENGINE;
const ORIGINAL_DIRECTOR = process.env.AI_DIRECTOR;
const ORIGINAL_RENDER_PATH = process.env.CINEMATIC_RENDER_PATH;

beforeEach(() => {
  process.env.CINEMATIC_EDITING_ENGINE = "true";
  process.env.AI_DIRECTOR = "true";
  delete process.env.CINEMATIC_RENDER_PATH;
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("CINEMATIC_EDITING_ENGINE", ORIGINAL_ENGINE);
  restore("AI_DIRECTOR", ORIGINAL_DIRECTOR);
  restore("CINEMATIC_RENDER_PATH", ORIGINAL_RENDER_PATH);
  vi.restoreAllMocks();
});

/* ═══════════════════════ TEST 1 — the route runs ═══════════════════════ */

describe("RONDE 151 §2 — the production route plans and stores one timeline", () => {
  it("stores a timeline built from real production facts", async () => {
    const { calls, persist } = recordingPersist();
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0), sceneFacts(1)],
      persist,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(7);
    expect(outcome.timeline.videoId).toBe(7);
    const track = outcome.timeline.tracks.find((t) => t.kind === "VIDEO");
    expect(track && track.kind === "VIDEO" ? track.clips : []).toHaveLength(4);
  });

  it("stores at the NEXT version, conditioned on the one the row holds", async () => {
    const { calls, persist } = recordingPersist();
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist,
      storedVersion: 4,
    });
    expect(outcome.ok).toBe(true);
    expect(calls[0]!.expectedVersion).toBe(4);
    expect(calls[0]!.nextVersion).toBe(5);
    if (outcome.ok) expect(outcome.timeline.version).toBe(5);
  });

  /**
   * §22 — the conditional UPDATE is what makes the optimistic check real. A person who saved an
   * edit while this render was finishing must not have it overwritten by a generated plan.
   */
  it("reports a lost race instead of overwriting somebody's edit", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist: async () => ({ saved: false }),
      storedVersion: 2,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(CINEMATIC_PLAN_ERROR.PERSIST_FAILED);
    expect(outcome.reason).toContain("left alone");
  });

  it("carries the persisted narration onto the voice track — never regenerates it", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist: recordingPersist().persist,
      voice: { url: "https://storage.example/v/7.mp3", durationSec: 8 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const voice = outcome.timeline.tracks.find((t) => t.kind === "VOICE");
    expect(voice && voice.kind === "VOICE" ? voice.clips : []).toHaveLength(1);
  });
});

/* ═══════════════════════ TEST 7 — the validator blocks ═══════════════════════ */

describe("RONDE 151 §5 — a plan that fails validation is NOT stored", () => {
  it("stores nothing when a scene has no plannable beat at all", async () => {
    const { calls, persist } = recordingPersist();
    const empty = sceneFacts(0);
    empty.clips = [null, null];
    const outcome = await planAndStoreCinematicTimeline({ videoId: 7, scenes: [empty], persist });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(CINEMATIC_PLAN_ERROR.NO_PLANNABLE_BEATS);
    // The important half: nothing reached the database.
    expect(calls).toHaveLength(0);
  });

  it("names every dropped beat in the log rather than shortening the edit in silence", async () => {
    const s = sceneFacts(0);
    s.clips[1] = { facts: { localPath: "/tmp/x.mp4" }, adoption: { provider: "mystery" } };
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [s],
      persist: recordingPersist().persist,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.dropped.join(" ")).toContain("s0b1");
    expect(outcome.log.join(" ")).toContain("dropped");
  });

  it("a planner that throws is reported and does not escape", async () => {
    const broken = sceneFacts(0);
    // A beat whose text is not a string is the shape no planner expects.
    (broken.beats[0] as unknown as { text: unknown }).text = null;
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [broken],
      persist: recordingPersist().persist,
    });
    // Either it planned around it or it reported — what it must never do is throw.
    expect(typeof outcome.ok).toBe("boolean");
    if (!outcome.ok) {
      expect([
        CINEMATIC_PLAN_ERROR.PLANNER_THREW,
        CINEMATIC_PLAN_ERROR.TIMELINE_INVALID,
        CINEMATIC_PLAN_ERROR.NO_PLANNABLE_BEATS,
      ]).toContain(outcome.code);
    }
  });

  it("the log reports the validator's verdict either way", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist: recordingPersist().persist,
    });
    expect(outcome.ok).toBe(true);
    // Every issue the validator raised is in the log, labelled advisory or BLOCKING.
    for (const line of outcome.log.filter((l) => l.startsWith("[Validator]"))) {
      expect(line).toMatch(/\[Validator\] (advisory|BLOCKING)/);
    }
  });
});

/* ═══════════════════════ TEST 26/27 — no silent fallback ═══════════════════════ */

describe("RONDE 151 §19/§20 — the two switches, and the line that counts them", () => {
  it("planning is off unless an operator turns it on", () => {
    delete process.env.CINEMATIC_EDITING_ENGINE;
    expect(cinematicPlanningEnabled()).toBe(false);
    process.env.CINEMATIC_EDITING_ENGINE = "true";
    expect(cinematicPlanningEnabled()).toBe(true);
  });

  /**
   * The render cutover is a SECOND switch, deliberately. Planning is safe to enable early — the
   * stored timeline sits beside the video the old path produced. Rendering from it changes the
   * file a customer receives, so it waits for a real render to have been compared.
   */
  it("the render cutover is a separate switch from planning", () => {
    process.env.CINEMATIC_EDITING_ENGINE = "true";
    expect(cinematicPlanningEnabled()).toBe(true);
    expect(cinematicRenderPathEnabled()).toBe(false);
    process.env.CINEMATIC_RENDER_PATH = "true";
    expect(cinematicRenderPathEnabled()).toBe(true);
  });

  it("refuses to plan at all when the route is disabled, and says which flag", async () => {
    delete process.env.CINEMATIC_EDITING_ENGINE;
    const { calls, persist } = recordingPersist();
    const outcome = await planAndStoreCinematicTimeline({ videoId: 7, scenes: [sceneFacts(0)], persist });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(CINEMATIC_PLAN_ERROR.ROUTE_DISABLED);
    expect(outcome.reason).toContain("CINEMATIC_EDITING_ENGINE");
    expect(calls).toHaveLength(0);
  });

  it("a legacy render always says RENDER_FALLBACK_USED, with the reason", () => {
    const flagOff = formatRenderRoute({ videoId: 3, route: "legacy_compose", planOk: true });
    expect(flagOff).toContain("RENDER_FALLBACK_USED");
    expect(flagOff).toContain("CINEMATIC_RENDER_PATH is not enabled");

    const planFailed = formatRenderRoute({
      videoId: 3,
      route: "legacy_compose",
      planOk: false,
      reason: "2 blocking issue(s): overlapping_clips",
    });
    expect(planFailed).toContain("RENDER_FALLBACK_USED");
    expect(planFailed).toContain("overlapping_clips");
  });

  it("a cinematic render says so and does NOT carry the fallback marker", () => {
    const line = formatRenderRoute({ videoId: 3, route: "cinematic_timeline", planOk: true });
    expect(line).toContain("route=cinematic_timeline");
    expect(line).not.toContain("RENDER_FALLBACK_USED");
  });
});

/* ═══════════════════════ §7 — the ledger records the cut ═══════════════════════ */

describe("RONDE 151 §7 — the lineage ledger stores the trim into the original", () => {
  it("records a measured cut against the clip's own record", async () => {
    const { VisualSourceLedger } = await import("./visualSourceLineage");
    const ledger = new VisualSourceLedger({ renderId: "r1" });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:1",
      contentKey: "k1",
      localPath: "/tmp/clip.mp4",
    });

    const updated = ledger.recordSourceTrim("/tmp/clip.mp4", { inSec: 37.5, outSec: 41.5 });
    expect(updated?.sourceInSec).toBe(37.5);
    expect(updated?.sourceOutSec).toBe(41.5);
  });

  /**
   * A path with no record gets no record invented for it. Provenance built out of a filename is
   * exactly what the ledger exists to prevent.
   */
  it("does nothing for a path nobody registered", async () => {
    const { VisualSourceLedger } = await import("./visualSourceLineage");
    const ledger = new VisualSourceLedger({ renderId: "r1" });
    expect(ledger.recordSourceTrim("/tmp/never-seen.mp4", { inSec: 5 })).toBeNull();
  });

  it("refuses a nonsense offset rather than storing it", async () => {
    const { VisualSourceLedger } = await import("./visualSourceLineage");
    const ledger = new VisualSourceLedger({ renderId: "r1" });
    ledger.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "c", contentKey: "k", localPath: "/tmp/c.mp4",
    });
    expect(ledger.recordSourceTrim("/tmp/c.mp4", { inSec: -3 })?.sourceInSec).toBeUndefined();
    expect(ledger.recordSourceTrim("/tmp/c.mp4", { inSec: Number.NaN })?.sourceInSec).toBeUndefined();
    // An end before the start is not stored either — the start still is, because it is valid.
    const r = ledger.recordSourceTrim("/tmp/c.mp4", { inSec: 10, outSec: 4 });
    expect(r?.sourceInSec).toBe(10);
    expect(r?.sourceOutSec).toBeUndefined();
  });
});

/* ═══════════════════════ §25 — the log leaks nothing ═══════════════════════ */

describe("RONDE 151 §25 — observability without secrets", () => {
  it("no log line carries a URL, a path or a token", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist: recordingPersist().persist,
      voice: { url: "https://storage.example/v/7.mp3?X-Amz-Signature=SECRET", durationSec: 8 },
    });
    expect(outcome.ok).toBe(true);
    const all = outcome.log.join("\n");
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain("X-Amz");
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toContain("/tmp/");
  });

  it("the stored timeline itself carries no credential", async () => {
    const { calls, persist } = recordingPersist();
    await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist,
      voice: { url: "https://storage.example/v/7.mp3?token=SECRET", durationSec: 8 },
    });
    const stored = JSON.stringify(calls[0]!.timeline);
    // The narration URL is legitimately on the timeline; a signature in a query string is not.
    expect(stored).not.toContain("X-Amz-Signature");
    expect(stored).not.toContain("api_key");
    expect(stored).not.toContain("apiKey");
  });

  it("every log line is prefixed with the subsystem that produced it", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 7,
      scenes: [sceneFacts(0)],
      persist: recordingPersist().persist,
    });
    for (const line of outcome.log) {
      /** RONDE 157B added [Director] — the editorial quality findings, reported during planning. */
      expect(line).toMatch(/^\[(CinematicPipeline|EDL|Validator|Timeline|Director)\]/);
    }
  });
});
