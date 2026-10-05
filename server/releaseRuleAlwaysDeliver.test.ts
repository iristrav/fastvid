/**
 * RELEASE RULE — NO IDEAL PICTURE FOR ONE OR MORE SENTENCES NEVER BLOCKS THE WHOLE EXPORT.
 *
 * Technical validity is hard; visual quality is not. Renders 616, 621, 629, 630 and 631 were refused
 * by ONE_FOOTAGE_FILLS_FILM — a measurement of how FEW pictures the film had — and the customer got
 * no MP4 at all. That measurement is now a quality note beside the verdict. This file proves:
 *
 *   R1  10 sentences, 8 pictures, 2 without: the planned film is complete and delivered
 *   R2  4 sentences, 1 picture: the film is complete, the share is named, and it is delivered
 *   R3  the pipeline renders such a film; the render job's gate reads the same measure as a note
 *   R4  technical faults still block — with or without the quality note beside them
 *   R5  a technically invalid clip still cannot be delivered
 *   R6  the hard limits that stay: no picture anywhere, nothing verified at all, a blank file
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  chapterCardSeconds,
  deliveryGate,
  filmWithoutPictureRefusal,
  finalTimelineFootageRefusal,
  indefensibleExportConditions,
  primaryGraphicSeconds,
  type FinalTimelineClip,
} from "./deliveryGate";
import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");

const extractors = async () => {
  const vp = await import("./videoPipeline");
  return {
    people: (t: string) => vp.extractPersonNamesFromText(t),
    place: (t: string) => vp.extractVisualPlacePhrase(t),
    action: (t: string) => vp.extractActionCue(t),
    namedEntities: (t: string) => vp.beatNamedEntitiesByKind(t),
  };
};
const beat = (text: string, i: number, at: number): ProductionBeat => ({
  index: i, text, searchQuery: "berlin wall", powerWord: "berlin wall", keywords: [], holdSec: 4,
  visualDescription: "", voiceStartSec: at, voiceEndSec: at + 4,
});
const shot = (n: number) => ({
  facts: { localPath: `/tmp/release-${n}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
  adoption: {
    provider: "internet_archive", providerAssetId: `ia-${n}`, sourceUrl: `https://archive.invalid/${n}.mp4`,
    assetTitle: `shot ${n}`, query: "berlin wall",
  },
});

type Planned = {
  durationSec: number;
  video: FinalTimelineClip[];
  graphics: Array<{ graphicType: string; start: number; end: number; data?: Record<string, unknown> }>;
};

/** Plans a film the way production does: per scene, a picture or `null` for every sentence. */
async function plan(scenesClips: Array<Array<ReturnType<typeof shot> | null>>): Promise<Planned> {
  let at = 0;
  const facts: SceneFacts[] = scenesClips.map((clips, si) => {
    /** No place, number or date: a sentence without a picture gets a drawn card, never an explaining map. */
    const texts = clips.map((_, bi) => `Nobody knew what would happen next, said witness ${"abcdefghij"[si * 5 + bi]}.`);
    /** Sentence times are counted within the scene, as production passes them. */
    const beats = texts.map((t, bi) => beat(t, bi, bi * 4));
    at += texts.length * 4;
    return {
      scene: { index: si, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: texts.length * 4 },
      beats,
      clips: clips as SceneFacts["clips"],
    };
  });
  const built = buildCinematicSceneInputs({ scenes: facts, extractors: await extractors() });
  const { timeline } = runCinematicPipeline({
    videoId: 9001, scenes: built.scenes, includeSubtitles: false, voice: { url: "/tmp/release.mp3", durationSec: at },
    ...(built.primaryGraphics?.length ? { primaryGraphics: built.primaryGraphics } : {}),
  });
  const t = timeline as unknown as {
    durationSec: number;
    tracks: Array<{ kind: string; clips?: FinalTimelineClip[]; graphics?: Planned["graphics"] }>;
  };
  return {
    durationSec: t.durationSec,
    video: t.tracks.find((k) => k.kind === "VIDEO")!.clips!,
    graphics: t.tracks.find((k) => k.kind === "GRAPHICS")?.graphics ?? [],
  };
}

const everySecondHasAPicture = (p: Planned) => {
  const covered = (sec: number) =>
    p.video.some((c) => !c.disabled && c.timelineStart <= sec && sec < c.timelineEnd && c.transform?.opacity !== 0) ||
    p.graphics.some((g) => g.data?.primaryVisual === true && g.start <= sec && sec < g.end);
  for (let s = 0.25; s < p.durationSec; s += 0.5) expect(covered(s), `${s}s has no picture`).toBe(true);
};

/** The gate as the render job asks it, on a file that measured fine. */
const gateOn = (p: Planned, delivered = { exists: true, readable: true, durationSec: p.durationSec, hasVideoStream: true, hasAudioStream: true, sizeBytes: 5_000_000 }) =>
  deliveryGate({
    videoId: 9001,
    route: "cinematic_timeline",
    timelineExists: true,
    clips: p.video.filter((c) => !c.disabled).map((c) => ({
      clipId: c.id, archiveAssetId: 1, provider: "internet_archive", providerAssetId: "x",
      resolved: true, fromArchive: true, isPlaceholder: false,
    })),
    delivered,
    voiceoverSec: p.durationSec,
    footageRefusal: finalTimelineFootageRefusal(
      p.video, undefined, new Map(), primaryGraphicSeconds(p.graphics), chapterCardSeconds(p.graphics)
    ),
  });

describe("R1/R2 — sentences without an ideal picture: the film is complete and delivered", () => {
  it("R1. 10 sentences, 8 with a picture and 2 without → full length, no empty second, delivered", async () => {
    const p = await plan([
      [shot(1), shot(2), null, shot(3), shot(4)],
      [shot(5), shot(6), shot(7), null, shot(8)],
    ]);
    expect(p.durationSec).toBe(40);
    everySecondHasAPicture(p);
    const v = gateOn(p);
    expect(v.allow, v.lines.join("\n")).toBe(true);
  }, 120_000);

  it("R2. 4 sentences and ONE picture → full length, the share is named, and the film is still delivered", async () => {
    const p = await plan([[null, null], [null, shot(1)]]);
    expect(p.durationSec).toBe(16);
    everySecondHasAPicture(p);
    const note = finalTimelineFootageRefusal(p.video, undefined, new Map(), primaryGraphicSeconds(p.graphics), chapterCardSeconds(p.graphics));
    expect(note, "the measurement still names the one footage").toMatch(/one piece of footage/);
    const v = gateOn(p);
    expect(v.allow, v.lines.join("\n")).toBe(true);
    expect(v.lines.join("\n")).toContain("QUALITY_NOTE ONE_FOOTAGE_FILLS_FILM");
  }, 120_000);
});

describe("R3 — the pipeline renders it; the render job reads the same measure as a note", () => {
  it("the share no longer stops the render from being queued", () => {
    expect(PIPE).toContain("if (outcome.ok && cinematicProgress.enabled) {");
    expect(PIPE).not.toContain("!footageRefusal");
    expect(PIPE).not.toContain("cinematicRefusal = `ONE_FOOTAGE_FILLS_FILM");
    expect(PIPE).toContain("QUALITY_NOTE ONE_FOOTAGE_FILLS_FILM — ${footageNote}");
  });

  it("the render job fails only on the gate's verdict, and the share is no failure code", () => {
    expect(WORKER).toContain("footageRefusal: finalTimelineFootageRefusal(");
    expect(WORKER).toContain("return await fail(RENDER_ERROR.RENDER_FAILED, formatDeliveryBlock(gate, job.videoId));");
    const v = deliveryGate({
      videoId: 1, route: "cinematic_timeline", timelineExists: true, clips: [], delivered: null, assetsOnly: true,
      footageRefusal: "one piece of footage (archive:1) fills 100% of the final timeline",
    });
    expect(v.allow).toBe(true);
  });
});

describe("R4/R5 — technical validity stays hard", () => {
  const p: Planned = {
    durationSec: 20,
    video: [{ id: "only", timelineStart: 0, timelineEnd: 20, source: { provider: "ia", archiveAssetId: 1 } }],
    graphics: [],
  };
  const fine = { exists: true, readable: true, durationSec: 20, hasVideoStream: true, hasAudioStream: true, sizeBytes: 5_000_000 };

  it("R4. corrupt, empty, silent, wrong-length or missing output → blocked, the quality note printed beside it", () => {
    for (const delivered of [
      { ...fine, readable: false, sizeBytes: 0 },
      { ...fine, hasVideoStream: false },
      { ...fine, hasAudioStream: false },
      { ...fine, durationSec: 9 },
      { ...fine, exists: false },
    ]) {
      const v = gateOn(p, delivered);
      expect(v.allow, JSON.stringify(delivered)).toBe(false);
      expect(v.lines.join("\n")).toContain("QUALITY_NOTE ONE_FOOTAGE_FILLS_FILM");
    }
  });

  it("R5. a clip that cannot be read, has no archive asset, or is a placeholder → blocked", () => {
    const base = { clipId: "c", archiveAssetId: 1 as number | null, provider: "ia", resolved: true, fromArchive: true, isPlaceholder: false };
    const gate = (clip: typeof base) =>
      deliveryGate({ videoId: 1, route: "cinematic_timeline", timelineExists: true, clips: [clip], delivered: fine, voiceoverSec: 20 });
    expect(gate(base).allow).toBe(true);
    expect(gate({ ...base, resolved: false }).allow).toBe(false);
    expect(gate({ ...base, archiveAssetId: null }).allow).toBe(false);
    expect(gate({ ...base, isPlaceholder: true }).allow).toBe(false);
    expect(deliveryGate({ videoId: 1, route: "cinematic_timeline", timelineExists: false, clips: [base], delivered: fine }).allow).toBe(false);
    expect(deliveryGate({ videoId: 1, route: "cinematic_timeline", timelineExists: true, clips: [base], delivered: fine, cinematicRefusal: "render crashed" }).allow).toBe(false);
  });
});

describe("R6 — the limits that stay hard (unchanged)", () => {
  it("a film with no picture in any scene is still refused before render — the renderer needs one real shot", () => {
    expect(filmWithoutPictureRefusal([[], [null]], () => false)).toBe(0);
    expect(filmWithoutPictureRefusal([[], ["shot.mp4"]], () => false)).toBeNull();
  });

  it("a blank delivered file is still refused", () => {
    expect(deliveryGate({
      videoId: 1, route: "cinematic_timeline", timelineExists: true, clips: [], delivered: null, assetsOnly: true,
      blankPicture: "all 4 sampled frame(s) are black",
    }).allow).toBe(false);
  });

  it("NO_VERIFIED_OWN_VISUAL fires only when not ONE sentence has an approved picture of its own", () => {
    const report = (verifiedOwnVisual: number) => ({
      beatVisuals: { beats: 10, verifiedOwnVisual, ownFootage: verifiedOwnVisual, byCoverage: {}, byVerification: { never_asked: 0 } },
      bySource: {}, totalClips: 0, generatedClips: 0,
    }) as unknown as Parameters<typeof indefensibleExportConditions>[0];
    expect(indefensibleExportConditions(report(1)).map((c) => c.code)).not.toContain("NO_VERIFIED_OWN_VISUAL");
    expect(indefensibleExportConditions(report(0)).map((c) => c.code)).toContain("NO_VERIFIED_OWN_VISUAL");
  });
});
