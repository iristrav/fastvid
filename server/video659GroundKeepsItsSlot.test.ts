/**
 * VIDEO 659 (fix A) — A GRAPHIC'S GROUND NEVER SHORTENS THE FILM.
 *
 * Production, 15 October, job 66: the map opening (0.00–5.89 s) stood on a copy of the AI video
 * adopted for ANOTHER sentence (`vc_6024c34caf_graphic1`, provider elevenlabs_video). Asked by the
 * card's sentence, the pipeline found no file for it; the render could not fetch an AI video again,
 * dropped the ground, and the film came out 66.00 s against a 71.89 s plan — refused twice.
 *
 *   1. the ground finds its shot's file even though that shot belongs to another sentence;
 *   2. the right asset — never another video of the card's sentence;
 *   3. a ground that still cannot be recovered keeps its slot: the film keeps its length (real render);
 *   4. a real shot that is missing is still dropped, and the final check still refuses a short film.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { localFilesForTimelineClips, pickLocalFileByIdentity, sameAssetIdentity } from "./cinematicPipelineInputs";
import { groundFillIdentity, recoverGraphicGrounds, withOnlyVideoClip } from "./renderJobWorker";
import { rehydrateTimelineAssets } from "./assetRehydrator";
import { checkRenderedFile, renderTimeline } from "./timelineRenderer";
import { DEFAULT_FORMAT, emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { resolveFFmpegBin } from "./ffmpegBinary";

const AI = { provider: "elevenlabs_video", providerAssetId: "8feed4d249931054" };
const OTHER = { provider: "youtube_cc", providerAssetId: "yt-other" };
const exists = () => true;

const clip = (id: string, source: Record<string, unknown>, start: number, end: number, beat: number, extra: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id, kind: "video", source, timelineStart: start, timelineEnd: end, sceneIndex: 0, beatIndex: beat,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", ...extra,
  }) as TimelineVideoClip;

/* ═══════════ 1 + 2 — the pipeline offers the ground its shot's file ═══════════ */

describe("A1/A2 — a graphic's ground takes the file of the shot it was made from", () => {
  /** Sentence 0 is a card on a copy of sentence 1's AI shot; sentence 0 also holds one unrelated video. */
  const clips = [
    clip("vc_6024c34caf_graphic1", AI, 0, 5.89, 0, { transform: { opacity: 0 } }),
    clip("vc_6024c34caf", AI, 18.48, 24.91, 1),
    clip("vc_other", OTHER, 5.89, 10, 0),
  ];
  const byBeat: Record<string, Array<{ path: string; adoption: { providerAssetId: string } }>> = {
    "0:0": [{ path: "/w/other.mp4", adoption: { providerAssetId: "yt-other" } }],
    "0:1": [{ path: "/w/ai.mp4", adoption: { providerAssetId: "8feed4d249931054" } }],
  };
  const localPathFor = (s: number, b: number) => byBeat[`${s}:${b}`]?.[0]?.path ?? null;

  it("the 659 case: the ground of sentence 0 gets sentence 1's AI file", () => {
    const map = localFilesForTimelineClips({ clips, localPathFor, exists });
    expect(map.get("vc_6024c34caf")).toBe("/w/ai.mp4");
    expect(map.get("vc_6024c34caf_graphic1")).toBe("/w/ai.mp4");
  });

  it("never the card's sentence's other video, even when that sentence holds exactly one file", () => {
    const withoutShot = clips.filter((c) => c.id !== "vc_6024c34caf");
    const map = localFilesForTimelineClips({ clips: withoutShot, localPathFor, exists });
    expect(map.get("vc_6024c34caf_graphic1")).toBeUndefined();
    expect(map.get("vc_other")).toBe("/w/other.mp4");
  });

  it("without its shot on the plan, the ground finds the same asset by identity across sentences", () => {
    const withoutShot = clips.filter((c) => c.id !== "vc_6024c34caf");
    const all = Object.values(byBeat).flat();
    const map = localFilesForTimelineClips({
      clips: withoutShot, localPathFor, exists,
      localPathForIdentity: (c) => pickLocalFileByIdentity(all as never, c),
    });
    expect(map.get("vc_6024c34caf_graphic1")).toBe("/w/ai.mp4");
  });

  it("identity matching never hands out a different asset", () => {
    const all = [{ path: "/w/other.mp4", adoption: { providerAssetId: "yt-other" } }];
    expect(pickLocalFileByIdentity(all as never, { source: AI })).toBeNull();
    expect(pickLocalFileByIdentity(all as never, { source: { provider: "x" } })).toBeNull();
    expect(sameAssetIdentity(AI, OTHER)).toBe(false);
    expect(sameAssetIdentity(AI, { ...AI })).toBe(true);
    expect(sameAssetIdentity({ provider: "a", providerAssetId: "1" }, { provider: "b", providerAssetId: "1" })).toBe(false);
  });

  it("a ground whose shot is a different asset does not borrow that shot's file", () => {
    const mismatched = [clip("vc_x_graphic1", AI, 0, 3, 0, { transform: { opacity: 0 } }), clip("vc_x", OTHER, 3, 6, 1)];
    const map = localFilesForTimelineClips({ clips: mismatched, localPathFor: (s, b) => (b === 1 ? "/w/other.mp4" : null), exists });
    expect(map.get("vc_x")).toBe("/w/other.mp4");
    expect(map.get("vc_x_graphic1")).toBeUndefined();
  });

  it("is wired into the pipeline's offer", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("localPathForIdentity: (clip) => inputsModule.pickLocalFileByIdentity([...localFilesByBeat.values()].flat(), clip),");
  });
});

/* ═══════════ the render keeps a ground's slot ═══════════ */

function timelineFor(groundOpacity = 0): ProjectTimeline {
  const t = emptyTimeline(659, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks[0] = {
    kind: "VIDEO",
    clips: [
      clip("vc_ai_graphic1", AI, 0, 3, 0, { transform: { opacity: groundOpacity } }),
      clip("vc_real", { provider: "curated", archiveAssetId: 1 }, 3, 6, 1, { sourceIn: 0, sourceOut: 3 }),
    ],
  } as never;
  t.durationSec = 6;
  return t;
}
const failure = (clipId: string) => ({ clipId, result: { errorCode: "REHYDRATION_UNSUPPORTED_PROVIDER" } });

describe("A — recoverGraphicGrounds", () => {
  it("uses the shot's own file when the shot is on the plan and recovered", async () => {
    const t = timelineFor();
    videoTrack(t).push(clip("vc_ai", AI, 10, 12, 2));
    const byClipId = new Map([["vc_ai", "/w/ai.mp4"]]);
    let drew = 0;
    const r = await recoverGraphicGrounds({ timeline: t, failures: [failure("vc_ai_graphic1")], byClipId, drawGround: async () => (drew++, "/w/drawn.mp4"), jobId: 1 });
    expect(r.remaining).toEqual([]);
    expect(r.recovered).toEqual([{ clipId: "vc_ai_graphic1", how: "shot_file" }]);
    expect(byClipId.get("vc_ai_graphic1")).toBe("/w/ai.mp4");
    expect(drew).toBe(0);
  });

  it("draws a ground of the slot's length when nothing else holds the asset", async () => {
    const t = timelineFor();
    const byClipId = new Map<string, string>();
    const r = await recoverGraphicGrounds({ timeline: t, failures: [failure("vc_ai_graphic1")], byClipId, drawGround: async () => "/w/drawn.mp4", jobId: 1 });
    expect(r.recovered).toEqual([{ clipId: "vc_ai_graphic1", how: "drawn_ground" }]);
    expect(groundFillIdentity({ timelineStart: 0, timelineEnd: 5.89 })).toEqual({ provider: "synthetic_placeholder", providerAssetId: "synthetic-p0-6s" });
  });

  it("a real shot is never 'recovered' — it stays a failure and is dropped as before", async () => {
    const t = timelineFor();
    const r = await recoverGraphicGrounds({ timeline: t, failures: [failure("vc_real")], byClipId: new Map(), drawGround: async () => "/w/drawn.mp4", jobId: 1 });
    expect(r.remaining.map((f) => f.clipId)).toEqual(["vc_real"]);
    expect(r.recovered).toEqual([]);
  });

  it("a ground that is visible (opacity above 0) is a picture, not a ground — not filled", async () => {
    const t = timelineFor(1);
    const r = await recoverGraphicGrounds({ timeline: t, failures: [failure("vc_ai_graphic1")], byClipId: new Map(), drawGround: async () => "/w/drawn.mp4", jobId: 1 });
    expect(r.remaining.map((f) => f.clipId)).toEqual(["vc_ai_graphic1"]);
  });

  it("when even drawing fails, the ground stays a failure (and the duration check decides)", async () => {
    const r = await recoverGraphicGrounds({ timeline: timelineFor(), failures: [failure("vc_ai_graphic1")], byClipId: new Map(), drawGround: async () => null, jobId: 1 });
    expect(r.remaining.map((f) => f.clipId)).toEqual(["vc_ai_graphic1"]);
  });

  it("runs before the drop in runRenderJob, and the drop still names what it removes", () => {
    const worker = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    const recover = worker.indexOf("const grounds = await recoverGraphicGrounds({");
    const drop = worker.indexOf("disableClipsForRender(", recover);
    expect(recover).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(recover);
    expect(worker).toContain("PICTURE_SHORT");
  });
});

/* ═══════════ 3 + 4 — a real render ═══════════ */

describe("A3/A4 — real render: the ground keeps the film's length; a missing shot is still refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v659-ground-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const red = path.join(dir, "red.mp4");
  execFileSync(resolveFFmpegBin(), ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=4:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", red]);

  const render = async (t: ProjectTimeline, files: Map<string, string>, name: string) => {
    const out = path.join(dir, `${name}.mp4`);
    await renderTimeline({
      timeline: t,
      workDir: path.join(dir, `work_${name}`),
      outputPath: out,
      resolveMedia: async (c) => (c.disabled ? null : files.get(c.id) ?? null),
    });
    return checkRenderedFile({ filePath: out, timeline: t, expectAudio: false });
  };

  it("A3: the unrecoverable AI ground is drawn at its slot's length and the 6 s film stays 6 s", async () => {
    const t = timelineFor();
    const byClipId = new Map([["vc_real", red]]);
    const r = await recoverGraphicGrounds({
      timeline: t,
      failures: [failure("vc_ai_graphic1")],
      byClipId,
      drawGround: async (c) => {
        const drawn = await rehydrateTimelineAssets({
          timeline: withOnlyVideoClip(t, { ...c, source: groundFillIdentity(c) }),
          workDir: path.join(dir, "assets"),
          deps: { download: async () => false },
          failFast: true,
        });
        return drawn.byClipId.get(c.id) ?? null;
      },
      jobId: 1,
    });
    expect(r.recovered.map((x) => x.how)).toEqual(["drawn_ground"]);
    const check = await render(t, byClipId, "kept");
    expect(check.problems ?? [], JSON.stringify(check)).toEqual([]);
    expect(check.ok).toBe(true);
    expect(Math.abs((check.durationSec ?? 0) - 6)).toBeLessThan(0.2);
  }, 120_000);

  it("A4: a missing real shot is still dropped, the film comes out short, and the final check refuses it", async () => {
    const t = timelineFor();
    videoTrack(t)[1]!.disabled = true; // the real shot could not be recovered
    const check = await render(t, new Map([["vc_ai_graphic1", red]]), "short");
    expect(check.ok).toBe(false);
    expect((check.problems ?? []).join(" ")).toMatch(/duration/);
  }, 120_000);
});
