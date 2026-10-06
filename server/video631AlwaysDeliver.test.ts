/**
 * VIDEO 631 — FASTVID ALWAYS DELIVERS A VALID VIDEO WHEN IT CAN.
 *
 * Render 631 approved six pictures and placed three; the DeliveryGate then refused the film because
 * one footage filled 51 % of the three that were left, and the customer got no MP4 and an internal
 * error code. This file proves each repair and the rules that must not move:
 *
 *   1–3   an approved picture survives its sentence's cap; nothing new is looked at after it
 *   4–7   without an approval the normal fallback runs; a film with footage gets no empty beat
 *   8     ONE_FOOTAGE_FILLS_FILM counts the drawn cards as film, and still names video 612
 *         (since the release rule a quality note, never a block — see releaseRuleAlwaysDeliver)
 *   9–10  technical faults stay a hard block; a valid file passes
 *   11    every beat window of the planned timeline has a picture
 *   12    the customer never reads an internal reason or code
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { beatIdentityKey, checkBeatRelevance, createBeatRelevanceLedger } from "./beatVisualRelevance";
import { rejectionStageForReason } from "./rejectionRegistry";
import { createBeatImageGateState, MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { notAskedReasonForDecline } from "./beatShortlist";
import {
  deliveryGate,
  filmWithoutPictureRefusal,
  finalTimelineFootageRefusal,
  primaryGraphicSeconds,
  chapterCardSeconds,
  type FinalTimelineClip,
} from "./deliveryGate";
import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const DASH = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FIX 1 — a picture approved before the cap is placed; nothing new is looked at after it", () => {
  it("1. FIT before the timeout, preparation finishing after it → the picture is still handed to the push", async () => {
    const { ladderWithinCap, noteApprovedPickForBeat, withSceneFetchTimeout } = await import("./videoPipeline");
    const dedup = {};
    const r = await ladderWithinCap<string>(dedup, 0, 0, (track) =>
      withSceneFetchTimeout(() => track((async () => {
        await wait(10);
        noteApprovedPickForBeat(dedup, 0, 0); // the picture editor said FIT (render 631 s0b0, 16:48:15)
        await wait(80); // the fair-use transform runs past the cap (16:48:17 → 16:48:19)
        return "scene_0_b0_ia_transformed.mp4";
      })()), 40, "video search s0 b0"));
    expect(r.error?.message).toMatch(/exceeded/);
    expect(r.value).toBe("scene_0_b0_ia_transformed.mp4");
    expect(r.keptAfterCap).toBe(true);
  }, 120_000);

  it("2. FIT + prepared, the race lost by milliseconds → the cap cannot remove it; before the cap it is simply returned", async () => {
    const { ladderWithinCap, noteApprovedPickForBeat, withSceneFetchTimeout } = await import("./videoPipeline");
    const dedup = {};
    const late = await ladderWithinCap<string>(dedup, 2, 0, (track) =>
      withSceneFetchTimeout(() => track((async () => {
        noteApprovedPickForBeat(dedup, 2, 0);
        await wait(45);
        return "scene_2_b0_serp_transformed.mp4";
      })()), 40, "scene 2 beat 0"));
    expect(late.value).toBe("scene_2_b0_serp_transformed.mp4");
    const inTime = await ladderWithinCap<string>({}, 1, 1, (track) =>
      withSceneFetchTimeout(() => track(Promise.resolve("in_time.mp4")), 200, "s1b1"));
    expect(inTime).toEqual({ value: "in_time.mp4" });
  }, 120_000);

  /**
   * VIDEO 631 RE-RUN — the turn-over guard is no longer wired in production: 42 of 51 usable
   * candidates were declined `beat_turn_over` and never judged. The mechanism below still works when
   * a caller sets the hook; the production state does not (see the wiring test).
   */
  it("3. the turn-over mechanism: an aborted scope says the turn is over, and a gate given the hook declines", async () => {
    const { sceneTurnIsOver, withSceneFetchTimeout } = await import("./videoPipeline");
    let seenAfterCap: boolean | null = null;
    let seenBefore: boolean | null = null;
    await withSceneFetchTimeout(async () => {
      seenBefore = sceneTurnIsOver();
      await wait(60);
      seenAfterCap = sceneTurnIsOver(); // render 631 s1b4: this is where the late look began
    }, 20, "video search s1 b4").catch(() => null);
    await wait(80);
    expect(seenBefore).toBe(false);
    expect(seenAfterCap).toBe(true);
    expect(sceneTurnIsOver(), "outside any scope nothing is over").toBe(false);

    const state = createBeatImageGateState();
    state.turnOver = () => true;
    const decision = await checkBeatRelevance({
      clipPath: "/nonexistent/s1b4.mp4",
      contentKey: "internet_archive:0a6eadc46db08951",
      ctx: { sceneIndex: 1, beatIndex: 4, beatText: "East Berliners poured through the checkpoint." },
      workDir: "/tmp",
      state,
      ledger: createBeatRelevanceLedger(),
      route: "adopt",
    });
    expect(decision.evaluated).toBe(false);
    expect(decision.declineCause).toBe("BEAT_TURN_OVER");
    expect(state.judgementAttempts, "no model was asked").toBe(0);
    /** NOT_ASKED is never an approval: the adoption guard still refuses it. */
    expect(notAskedReasonForDecline("BEAT_TURN_OVER")).toBe("VISION_BUDGET_EXHAUSTED");
  }, 120_000);

  it("3b. a verdict already given stays usable after the turn is over: the cached FIT is read, no model is asked", async () => {
    const state = createBeatImageGateState();
    state.turnOver = () => true;
    const ctx = { sceneIndex: 1, beatIndex: 4, beatText: "East Berliners poured through the checkpoint." };
    const contentKey = "internet_archive:0a6eadc46db08951";
    state.seen.set(`${contentKey}|${beatIdentityKey(ctx)}`, {
      verdict: "fits", depicts: "A crowd on the Berlin Wall, celebrating.", reason: "matches the line", evaluated: true,
    });
    const decision = await checkBeatRelevance({
      clipPath: "/nonexistent/s1b4_transformed.mp4", contentKey, ctx, workDir: "/tmp", state,
      ledger: createBeatRelevanceLedger(), route: "push", finalSay: true,
    });
    expect(decision.verdict).toBe("fits");
    expect(decision.allowed).toBe(true);
    expect(decision.cached).toBe(true);
    expect(decision.declineCause).toBeUndefined();
    expect(state.judgementAttempts).toBe(0);
  }, 120_000);

  it("technically invalid assets stay refused for every sentence, whatever the turn", async () => {
    const { refusalHoldsForEverySentence } = await import("./videoPipeline");
    for (const reason of ["not_a_valid_video", "mostly_black", "below_size_floor_100_bytes", "pipeline_fallback"]) {
      expect(refusalHoldsForEverySentence(reason), reason).toBe(true);
    }
    expect(rejectionStageForReason("mostly_black")).toBe("technical");
  }, 120_000);

  it("wiring: the pipeline's ladder uses the cap helper, FIT acceptances are counted, the gate does NOT get the turn-over hook", () => {
    expect(PIPE).toContain("const capped = await ladderWithinCap<string>(dedup, sceneIndex, beat.index, (track) =>");
    expect(PIPE).toContain("() => track(beatPrimaryFetch(");
    expect(PIPE).toContain('if (beatEvidence === "FIT" && !requeuedAfterRefusal.has(p)) noteApprovedPickForBeat(dedup, sceneIndex, beatIndex, contentKey);');
    expect(PIPE).not.toContain("state.beatImageGate.turnOver = sceneTurnIsOver;");
    expect(createBeatImageGateState().turnOver, "a fresh gate has no turn-over hook").toBeUndefined();
  });
});

describe("FIX 2 — no approval → the normal fallback; a film with footage has no empty beat", () => {
  it("4. no FIT before the cap → the cap ends the search at once, exactly as before", async () => {
    const { ladderWithinCap, withSceneFetchTimeout } = await import("./videoPipeline");
    const t0 = Date.now();
    const r = await ladderWithinCap<string>({}, 0, 1, (track) =>
      withSceneFetchTimeout(() => track((async () => {
        await wait(300);
        return "never_approved.mp4";
      })()), 30, "video search s0 b1"));
    expect(r.value).toBeNull();
    expect(r.keptAfterCap).toBeUndefined();
    expect(Date.now() - t0, "it did not wait for the ladder").toBeLessThan(250);
  }, 120_000);

  it("5. an approved still is the sentence's picture when no video beats it (render 631 s2b0)", () => {
    const ladder = PIPE.slice(PIPE.indexOf("const approvedStill = still && !isPipelineFallbackClip(still) ? still : null;"));
    expect(ladder.length).toBeGreaterThan(0);
    const end = ladder.indexOf("/** The own archive's clip for a beat");
    const body = ladder.slice(0, end);
    expect(body).toContain("if (!canUseLicensedStockBeat(dedup)) return approvedStill;");
    expect(body.trimEnd().endsWith("return approvedStill;\n}")).toBe(true);
    expect(body, "a licensed stock VIDEO is still preferred over the still").toContain("if (stock && isRealVideoClip(stock)) {");
  });

  const ex = async () => {
    const vp = await import("./videoPipeline");
    return {
      people: (t: string) => vp.extractPersonNamesFromText(t),
      place: (t: string) => vp.extractVisualPlacePhrase(t),
      action: (t: string) => vp.extractActionCue(t),
      namedEntities: (t: string) => vp.beatNamedEntitiesByKind(t),
    };
  };
  const mk = (text: string, i: number): ProductionBeat => ({
    index: i, text, searchQuery: "berlin wall", powerWord: "berlin wall", keywords: [], holdSec: 4,
    visualDescription: "", voiceStartSec: i * 4, voiceEndSec: i * 4 + 4,
  });
  const clip = {
    facts: { localPath: "/tmp/v631-1.mp4", durationSec: 10, widthPx: 1920, heightPx: 1080 },
    adoption: { provider: "internet_archive", providerAssetId: "ia-1", sourceUrl: "https://archive.invalid/1.mp4", assetTitle: "shot", query: "shot" },
  };
  /** Two scenes, four sentences, ONE picture (s1b1): three sentences had no source at all. */
  async function plan() {
    const T0 = ["In 1961 the Berlin Wall divided the city.", "Families were separated for decades."];
    const T1 = ["But how did it end?", "In 1989 crowds tore the Wall down."];
    const f0: SceneFacts = { scene: { index: 0, text: T0.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 }, beats: T0.map(mk), clips: [null, null] as SceneFacts["clips"] };
    const f1: SceneFacts = { scene: { index: 1, text: T1.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 }, beats: T1.map(mk), clips: [null, clip] as SceneFacts["clips"] };
    const built = buildCinematicSceneInputs({ scenes: [f0, f1], extractors: await ex() });
    const { timeline } = runCinematicPipeline({
      videoId: 631, scenes: built.scenes, includeSubtitles: false, voice: { url: "/tmp/v631.mp3", durationSec: 16 },
      ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
    });
    const t = timeline as unknown as {
      durationSec: number;
      tracks: Array<{ kind: string; clips?: Array<{ timelineStart: number; timelineEnd: number; transform?: { opacity?: number } }>; graphics?: Array<{ graphicType: string; start: number; end: number; data?: Record<string, unknown> }> }>;
    };
    return {
      t,
      video: t.tracks.find((k) => k.kind === "VIDEO")!.clips!,
      graphics: t.tracks.find((k) => k.kind === "GRAPHICS")!.graphics!,
    };
  }

  it("6/7. most sources failing → the sentence keeps its last safe picture: a drawn card or the held shot, and the film has its full length", async () => {
    const { t, graphics } = await plan();
    expect(t.durationSec).toBe(16);
    expect(graphics.some((g) => g.graphicType === "chapter_card"), "a sentence with no source has a drawn card").toBe(true);
  }, 120_000);

  it("11. no beat window of the planned film is empty: every second is a shot on screen or a drawn picture", async () => {
    const { t, video, graphics } = await plan();
    const covered = (sec: number) =>
      video.some((c) => c.timelineStart <= sec && sec < c.timelineEnd && c.transform?.opacity !== 0) ||
      graphics.some((g) => g.data?.primaryVisual === true && g.start <= sec && sec < g.end);
    for (let s = 0.25; s < t.durationSec; s += 0.5) expect(covered(s), `${s}s has no picture`).toBe(true);
  }, 120_000);

  it("the honest limit: a film with no picture at all is still refused before render — the renderer needs one real shot", () => {
    expect(filmWithoutPictureRefusal([[], []], () => false)).toBe(0);
    expect(filmWithoutPictureRefusal([[], ["shot.mp4"]], () => false)).toBeNull();
  });
});

describe("FIX 3 — ONE_FOOTAGE_FILLS_FILM measures only what it exists for (a quality note since the release rule)", () => {
  const piece = (id: string, start: number, end: number, archiveAssetId: number): FinalTimelineClip => ({
    id, timelineStart: start, timelineEnd: end, source: { provider: "ww2", archiveAssetId },
  });
  const card = (start: number, end: number) => ({ graphicType: "chapter_card", start, end, data: { primaryVisual: true } });

  it("8a. render 631's film: two footages (8.7 s and 8.5 s) and 45.2 s of drawn cards → delivered", () => {
    const clips = [piece("reichstag_p1", 0, 4.4, 57792), piece("reichstag_p2", 4.4, 8.7, 57792), piece("crowd_a", 8.7, 13.3, 60128), piece("crowd_b", 13.3, 17.2, 60128)];
    const cards = [card(20, 27.04), card(27.04, 31.47), card(31.47, 34.81), card(34.81, 38), card(40, 48.23), card(48.23, 56.07), card(56.07, 59.01), card(59.01, 67.21)];
    expect(chapterCardSeconds(cards)).toBeCloseTo(45.21, 1);
    expect(primaryGraphicSeconds(cards), "a card is still no explaining graphic").toBe(0);
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0), "render 631: cards not counted").toMatch(/fills 51%/);
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0, chapterCardSeconds(cards))).toBeNull();
  });

  it("8b. video 612's shape — one footage cut into fifteen pieces under the whole narration — is still named, cards or not", () => {
    const clips = Array.from({ length: 15 }, (_, i) => piece(`p${i}`, i * 4.74, (i + 1) * 4.74, 612));
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0)).toMatch(/fills 100%/);
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0, 300)).toMatch(/fills 100%/);
  });

  it("8c. one shot plus drawn chapter cards only is still one shot: named — cards never prove footage", () => {
    const clips = [piece("shot", 0, 16, 7)];
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0, chapterCardSeconds([card(16, 36), card(36, 56)]))).toMatch(/fills 100%/);
  });

  it("8d. with two footages, one that dominates the whole film including the cards is still named", () => {
    const clips = [piece("big", 0, 40, 1), piece("small", 40, 45, 2)];
    expect(finalTimelineFootageRefusal(clips, undefined, new Map(), 0, chapterCardSeconds([card(45, 60)]))).toMatch(/one piece of footage \(archive:1/);
    /** And a card is never footage: no footage on screen, nothing to refuse here (the film-without-picture rule decides that). */
    expect(finalTimelineFootageRefusal([], undefined, new Map(), 0, 60)).toBeNull();
  });
});

describe("DELIVERY — technical faults are a hard block; a valid film passes", () => {
  const good = {
    videoId: 631, route: "cinematic_timeline" as const, timelineExists: true,
    clips: [{ clipId: "c1", archiveAssetId: 57792, provider: "ww2", resolved: true, fromArchive: true, isPlaceholder: false }],
    delivered: { exists: true, readable: true, durationSec: 67.9, hasVideoStream: true, hasAudioStream: true, sizeBytes: 9_000_000 },
    voiceoverSec: 67.9,
  };

  it("9. corrupt, missing, silent, wrong-length or placeholder output → blocked", () => {
    const blocked = (patch: Record<string, unknown>) => deliveryGate({ ...good, ...patch } as Parameters<typeof deliveryGate>[0]).allow;
    expect(blocked({ delivered: { ...good.delivered, readable: false, sizeBytes: 0 } })).toBe(false);
    expect(blocked({ delivered: null })).toBe(false);
    expect(blocked({ delivered: { ...good.delivered, hasVideoStream: false } })).toBe(false);
    expect(blocked({ delivered: { ...good.delivered, durationSec: 30 } })).toBe(false);
    expect(blocked({ timelineExists: false })).toBe(false);
    expect(blocked({ clips: [{ ...good.clips[0], resolved: false }] })).toBe(false);
    expect(blocked({ clips: [{ ...good.clips[0], isPlaceholder: true }] })).toBe(false);
    expect(blocked({ blankPicture: "every sample black" })).toBe(false);
  });

  it("10. a technically valid film → SUCCESS", () => {
    const v = deliveryGate(good as Parameters<typeof deliveryGate>[0]);
    expect(v.allow).toBe(true);
  });
});

describe("12 — the customer never reads an internal reason or code", () => {
  it("the dashboard shows one fixed sentence on a failed video, no message text, no code", () => {
    expect(DASH).toContain("{CUSTOMER_FAILED_VIDEO_TEXT}");
    expect(DASH).not.toContain("appErrorText(video.errorMessage)");
    expect(DASH).not.toContain("Code {parseAppErrorCode(");
    expect(DASH).not.toMatch(/CUSTOMER_FAILED_VIDEO_TEXT\s*=\s*"[^"]*\(\d{5}\)/);
  });

  it("the admin page keeps the full technical reason", () => {
    const ADMIN = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "Admin.tsx"), "utf8");
    expect(ADMIN).toContain("{appErrorText(video.errorMessage)}");
    expect(ADMIN).toContain("{data.errorMessage}");
  });
});

describe("unchanged — limits and the Judge", () => {
  it("5 looks per sentence, 120 per render", async () => {
    const { maxRelevanceLooksPerBeat } = await import("./beatVisualRelevance");
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
  });
});
