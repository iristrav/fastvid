/**
 * RONDE 156 — smart replacement: finding alternatives, and changing nothing else.
 *
 * §3 lists nine things a replacement must leave alone, and the failure mode is silent — a video
 * whose captions drifted a quarter second still plays perfectly. So the centre of this file is
 * `replacementSideEffects`, run against a REAL replacement performed by the production function.
 */
import { describe, expect, it } from "vitest";

import {
  CANDIDATE_WEIGHTS,
  candidateFromAsset,
  formatCandidateSearch,
  rankReplacementCandidates,
  replacementContextFor,
  replacementSideEffects,
  scoreCandidate,
  technicalRejection,
  type ArchiveAssetLike,
  type ReplacementContext,
} from "./replacementCandidates";
import { replaceTimelineClipSource } from "./timelineStore";
import {
  DEFAULT_CAPTION_STYLE,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";

/* ═══════════════════════ fixtures ═══════════════════════ */

function clip(i: number, overrides: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: `vc${i}`,
    kind: "video",
    source: { provider: "pexels", providerAssetId: String(100 + i), archiveAssetId: 100 + i },
    sourceIn: 0,
    sourceOut: 4,
    timelineStart: i * 4,
    timelineEnd: i * 4 + 4,
    motion: "slow_push",
    camera: { type: "slow_push", startScale: 1, endScale: 1.08 },
    effects: [{ effectType: "film_grain", intensity: 0.3 }],
    transitionIn: i === 0 ? "hard_cut" : "crossfade",
    transitionOut: "hard_cut",
    ...overrides,
  } as TimelineVideoClip;
}

function timelineWith(clips: TimelineVideoClip[]): ProjectTimeline {
  const t = emptyTimeline(7, { widthPx: 1920, heightPx: 1080, fps: 25 });
  t.durationSec = clips.length * 4;
  for (const track of t.tracks) {
    if (track.kind === "VIDEO") track.clips.push(...clips);
    if (track.kind === "CAPTIONS") {
      track.captions.push({
        id: "c1",
        text: "Apple introduced the Vision Pro headset in Cupertino",
        start: 0,
        end: 4,
        style: DEFAULT_CAPTION_STYLE,
      } as never);
    }
    if (track.kind === "GRAPHICS") {
      track.graphics.push({
        id: "g1", graphicType: "lower_third", label: "Tim Cook", data: {}, start: 1, end: 3,
      } as never);
    }
    if (track.kind === "VOICE") {
      track.clips.push({
        id: "voice", source: { provider: "storage", providerAssetId: "v" },
        start: 0, end: clips.length * 4, gain: 1,
      } as never);
    }
  }
  return t;
}

function asset(id: number, overrides: Partial<ArchiveAssetLike> = {}): ArchiveAssetLike {
  return {
    id,
    title: "Apple Park drone shot",
    mediaType: "video",
    tags: ["apple", "cupertino"],
    entities: [],
    topics: [],
    width: 1920,
    height: 1080,
    durationSec: 12,
    editorialScore: 70,
    isActive: 1,
    ...overrides,
  };
}

function contextFor(t: ProjectTimeline, clipId = "vc0"): ReplacementContext {
  const ctx = replacementContextFor(t, clipId);
  expect(ctx).not.toBeNull();
  return ctx!;
}

/* ═══════════════════════ the slot's context ═══════════════════════ */

describe("RONDE 156 — the slot describes itself, the client does not describe it", () => {
  it("reads the slot's real duration and format off the timeline", () => {
    const ctx = contextFor(timelineWith([clip(0), clip(1)]));
    expect(ctx.slotDurationSec).toBe(4);
    expect(ctx.format.widthPx).toBe(1920);
    expect(ctx.clipId).toBe("vc0");
  });

  it("takes its keywords from the captions that OVERLAP this clip, not the whole script", () => {
    const ctx = contextFor(timelineWith([clip(0), clip(1)]));
    expect(ctx.words).toContain("apple");
    expect(ctx.words).toContain("cupertino");
    // Clip 1 runs from 4s and the caption ends at 4s, so it sees no words.
    expect(contextFor(timelineWith([clip(0), clip(1)]), "vc1").words).toEqual([]);
  });

  it("knows every archive id already in the video, so a replacement can add variety", () => {
    const ctx = contextFor(timelineWith([clip(0), clip(1), clip(2)]));
    expect(ctx.usedArchiveAssetIds).toEqual([100, 101, 102]);
    expect(ctx.currentArchiveAssetId).toBe(100);
  });

  it("returns null for a clip that is not on the timeline", () => {
    expect(replacementContextFor(timelineWith([clip(0)]), "nope")).toBeNull();
  });
});

/* ═══════════════════════ the technical filter ═══════════════════════ */

describe("RONDE 156 — technical refusals remove a candidate; taste only lowers its score", () => {
  const ctx = contextFor(timelineWith([clip(0), clip(1)]));

  it("accepts a usable asset", () => {
    expect(technicalRejection(asset(200), ctx)).toBeNull();
  });

  it("refuses a deactivated asset", () => {
    expect(technicalRejection(asset(200, { isActive: 0 }), ctx)).toContain("deactivated");
  });

  it("refuses an asset whose preview is broken", () => {
    expect(technicalRejection(asset(200, { previewIssue: "no_preview_frame" }), ctx)).toContain(
      "no_preview_frame"
    );
  });

  /** Somebody else's burned-in caption would appear in this video. An existing FastVid gate. */
  it("refuses an asset with baked-in edit text", () => {
    expect(technicalRejection(asset(200, { hasBakedEditText: 1 }), ctx)).toContain("burned-in text");
  });

  it("refuses the clip that is already in the slot", () => {
    expect(technicalRejection(asset(100), ctx)).toContain("already in this slot");
  });

  it("refuses a VIDEO shorter than the slot — it would have to loop or freeze", () => {
    expect(technicalRejection(asset(200, { durationSec: 1.5 }), ctx)).toContain("1.5s");
  });

  /** A still is held for as long as the slot needs. That is what Ken Burns is for. */
  it("accepts an IMAGE regardless of duration", () => {
    expect(
      technicalRejection(asset(200, { mediaType: "image", durationSec: null }), ctx)
    ).toBeNull();
  });

  it("accepts a video with an unknown duration rather than guessing it is too short", () => {
    expect(technicalRejection(asset(200, { durationSec: null }), ctx)).toBeNull();
  });
});

/* ═══════════════════════ the ranking ═══════════════════════ */

describe("RONDE 156 — ranking, and why each signal moves the score", () => {
  const ctx = contextFor(timelineWith([clip(0), clip(1)]));

  it("the weights sum to 1, so a score is genuinely 0..1", () => {
    const total = Object.values(CANDIDATE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("a relevant asset outranks an irrelevant one", () => {
    const relevant = scoreCandidate(asset(200, { tags: ["apple", "cupertino"] }), ctx);
    const irrelevant = scoreCandidate(asset(201, { tags: ["kittens"], title: "A cat" }), ctx);
    expect(relevant.score).toBeGreaterThan(irrelevant.score);
    expect(relevant.reason).toContain("narration");
  });

  it("real footage outranks a still, all else equal", () => {
    const video = scoreCandidate(asset(200), ctx);
    const still = scoreCandidate(asset(200, { mediaType: "image", mixKind: "photo" }), ctx);
    expect(video.score).toBeGreaterThan(still.score);
  });

  it("a clip that fits the frame outranks a portrait one", () => {
    const wide = scoreCandidate(asset(200, { width: 1920, height: 1080 }), ctx);
    const tall = scoreCandidate(asset(201, { width: 1080, height: 1920 }), ctx);
    expect(wide.score).toBeGreaterThan(tall.score);
    expect(tall.reason.length).toBeGreaterThan(0);
  });

  it("an asset already used in this video scores lower than an unused one", () => {
    const fresh = scoreCandidate(asset(200), ctx);
    const reused = scoreCandidate(asset(101), ctx);
    expect(fresh.score).toBeGreaterThan(reused.score);
    expect(reused.reason + fresh.reason).toContain("already used");
  });

  /**
   * Saturating relevance. A heavily-tagged asset must not out-rank a precisely relevant one just
   * by carrying more words.
   */
  it("relevance saturates rather than rewarding tag spam", () => {
    const precise = scoreCandidate(asset(200, { tags: ["apple", "cupertino"] }), ctx);
    const spammed = scoreCandidate(
      asset(201, { tags: ["apple", "cupertino", ...Array.from({ length: 50 }, (_, i) => `t${i}`)] }),
      ctx
    );
    expect(spammed.score).toBeCloseTo(precise.score, 4);
  });

  it("is deterministic", () => {
    expect(scoreCandidate(asset(200), ctx)).toEqual(scoreCandidate(asset(200), ctx));
  });

  it("an asset with no metadata at all still scores, and scores low", () => {
    const bare = scoreCandidate(
      { id: 999, title: null, mediaType: "image" },
      ctx
    );
    expect(bare.score).toBeGreaterThanOrEqual(0);
    expect(bare.score).toBeLessThan(0.6);
  });
});

describe("RONDE 156 — the ranked list", () => {
  const ctx = contextFor(timelineWith([clip(0), clip(1)]));
  const urls = (a: ArchiveAssetLike) => ({
    previewUrl: `/api/editor/archive/media/${a.id}`,
    thumbnailUrl: `/api/editor/archive/media/${a.id}`,
    provider: "ww2_archive",
  });

  it("orders by score and reports what it excluded", () => {
    const ranked = rankReplacementCandidates(
      [
        asset(200, { tags: ["kittens"], title: "A cat" }),
        asset(201, { tags: ["apple", "cupertino"] }),
        asset(202, { isActive: 0 }),
      ],
      ctx,
      urls
    );
    expect(ranked.candidates.map((c) => c.archiveAssetId)).toEqual([201, 200]);
    expect(ranked.rejected).toHaveLength(1);
    expect(ranked.rejected[0]!.archiveAssetId).toBe(202);
  });

  /** A list that reshuffles between two requests moves under the cursor of the person choosing. */
  it("breaks ties by id, so the list never reshuffles", () => {
    const pool = [asset(203), asset(201), asset(202)];
    const a = rankReplacementCandidates(pool, ctx, urls);
    const b = rankReplacementCandidates([...pool].reverse(), ctx, urls);
    expect(b.candidates.map((c) => c.archiveAssetId)).toEqual(a.candidates.map((c) => c.archiveAssetId));
  });

  it("honours the limit", () => {
    const pool = Array.from({ length: 40 }, (_, i) => asset(300 + i));
    expect(rankReplacementCandidates(pool, ctx, urls, 5).candidates).toHaveLength(5);
  });

  it("an empty pool gives an empty list, not an error", () => {
    expect(rankReplacementCandidates([], ctx, urls).candidates).toEqual([]);
  });

  /** §5/§32 — the browser must never receive a private or signed URL. */
  it("carries NO storage URL to the client", () => {
    const ranked = rankReplacementCandidates(
      [asset(201, { sourceUrl: "https://commons.example/File:X.jpg" })],
      ctx,
      (a) => ({
        previewUrl: `/api/editor/archive/media/${a.id}`,
        thumbnailUrl: `/api/editor/archive/media/${a.id}`,
        provider: "ww2_archive",
      })
    );
    const wire = JSON.stringify(ranked.candidates);
    expect(wire).not.toContain("X-Amz");
    expect(wire).not.toContain("storageUrl");
    expect(wire).not.toContain("s3.amazonaws");
    // The preview URL is this application's own endpoint.
    expect(ranked.candidates[0]!.previewUrl).toBe("/api/editor/archive/media/201");
    // The provider's PAGE is fine — it is public and it is attribution.
    expect(ranked.candidates[0]!.sourcePageUrl).toContain("commons.example");
  });

  it("the candidate carries everything the editor needs to show it", () => {
    const c = candidateFromAsset(asset(201), { score: 0.8, reason: "because" }, {
      previewUrl: "/p/201", thumbnailUrl: "/t/201", provider: "ww2_archive",
    });
    expect(c.archiveAssetId).toBe(201);
    expect(c.provider).toBe("ww2_archive");
    expect(c.durationSec).toBe(12);
    expect(c.mediaType).toBe("video");
    expect(c.reason).toBe("because");
  });

  it("the log line has counts and ids, never a URL", () => {
    const ranked = rankReplacementCandidates([asset(201)], ctx, urls);
    const line = formatCandidateSearch("vc0", ranked);
    expect(line).toContain("[Replacement]");
    expect(line).toContain("candidates=1");
    expect(line).not.toMatch(/https?:/);
  });
});

/* ═══════════════════════ §3 — the replacement changes NOTHING else ═══════════════════════ */

describe("RONDE 156 §3 — a replacement keeps the slot and touches nothing else", () => {
  const before = timelineWith([clip(0), clip(1), clip(2)]);
  const replaced = replaceTimelineClipSource({
    timeline: before,
    clipId: "vc1",
    source: { provider: "ww2_archive", archiveAssetId: 555, title: "A different shot" },
  });

  it("succeeds", () => {
    expect(replaced.ok).toBe(true);
  });

  /** The whole of §3, as one assertion against the production function. */
  it("has no side effects at all", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replacementSideEffects(before, replaced.timeline, "vc1")).toEqual([]);
  });

  it("really did change the source of the chosen clip", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const track = replaced.timeline.tracks.find((t) => t.kind === "VIDEO");
    const clips = track && track.kind === "VIDEO" ? track.clips : [];
    expect(clips[1]!.source.archiveAssetId).toBe(555);
    expect(clips[1]!.editedByUser).toBe(true);
    // And the neighbours are untouched.
    expect(clips[0]!.source.archiveAssetId).toBe(100);
    expect(clips[2]!.source.archiveAssetId).toBe(102);
  });

  it("keeps the slot's timing, transition, camera and effects", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const track = replaced.timeline.tracks.find((t) => t.kind === "VIDEO");
    const c = track && track.kind === "VIDEO" ? track.clips[1]! : null;
    expect(c!.timelineStart).toBe(4);
    expect(c!.timelineEnd).toBe(8);
    expect(c!.transitionIn).toBe("crossfade");
    expect(c!.motion).toBe("slow_push");
    expect(c!.effects).toHaveLength(1);
  });

  it("refuses a clip id that does not exist", () => {
    const missing = replaceTimelineClipSource({
      timeline: before,
      clipId: "nope",
      source: { provider: "ww2_archive", archiveAssetId: 555 },
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("CLIP_NOT_FOUND");
  });

  /**
   * The detector must actually detect. A test that only ever sees a clean replacement would pass
   * just as happily if `replacementSideEffects` returned [] unconditionally.
   */
  it("DETECTS a side effect when one is introduced", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const mutilated = structuredClone(replaced.timeline);
    const track = mutilated.tracks.find((t) => t.kind === "VIDEO");
    if (track && track.kind === "VIDEO") {
      track.clips[2]!.timelineStart += 1.5;
      track.clips[0]!.transitionIn = "dissolve";
    }
    const problems = replacementSideEffects(before, mutilated, "vc1");
    expect(problems.join(" ")).toContain("moved from");
    expect(problems.join(" ")).toContain("transition changed");
  });

  it("DETECTS a caption that drifted — the silent failure §3 is really about", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const mutilated = structuredClone(replaced.timeline);
    const captions = mutilated.tracks.find((t) => t.kind === "CAPTIONS");
    if (captions && captions.kind === "CAPTIONS") captions.captions[0]!.start += 0.25;
    expect(replacementSideEffects(before, mutilated, "vc1").join(" ")).toContain(
      "CAPTIONS track changed"
    );
  });

  it("DETECTS a second clip being replaced at the same time", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const mutilated = structuredClone(replaced.timeline);
    const track = mutilated.tracks.find((t) => t.kind === "VIDEO");
    if (track && track.kind === "VIDEO") track.clips[0]!.source.archiveAssetId = 999;
    expect(replacementSideEffects(before, mutilated, "vc1").join(" ")).toContain(
      "was replaced too"
    );
  });

  it("DETECTS graphics or audio changing during a replacement", () => {
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const mutilated = structuredClone(replaced.timeline);
    const graphics = mutilated.tracks.find((t) => t.kind === "GRAPHICS");
    if (graphics && graphics.kind === "GRAPHICS") graphics.graphics[0]!.label = "Somebody Else";
    expect(replacementSideEffects(before, mutilated, "vc1").join(" ")).toContain("GRAPHICS track");
  });
});
