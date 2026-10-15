/**
 * VIDEO 650 — END TO END, WITH EVERY PRIMARY SOURCE DISABLED.
 *
 * No YouTube, no archive hit, no open source, no stock, no key for any generator: a sentence that
 * nothing could picture ends under the floor of the ladder — a synthetic generic clip rendered by
 * this process (genericFootageFallback.ts) — and the render worker turns that timeline into a real
 * MP4 that the quality check, the coverage check and the delivery gate accept, and that the fps rule
 * of VIDEO 650 holds for. The database is replaced (as in ronde148RenderJob.test.ts); ffmpeg, the
 * probe gate, the coverage check and the delivery gate are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { DEFAULT_CAPTION_STYLE, DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { runRenderJob } from "./renderJobWorker";
import { makeSyntheticMotionClip, clipHasMotion } from "./genericFootageFallback";
import { replicateVideoConfigured } from "./replicateVideoGeneration";
import { elevenLabsVideoConfigured } from "./elevenLabsVideoGeneration";

/** VIDEO 656 — a contact sheet is stored next to the film; "one upload" means one upload of the FILM. */
const filmUploads = <T,>(u: readonly T[]): T[] =>
  u.filter((x) => (typeof x === "string" ? x : (x as unknown as { key: string }).key).endsWith(".mp4"));

const dbState = vi.hoisted(() => ({
  job: null as { id: number; videoId: number; status: string; timelineVersion: number; attempt: number; progressStep: string; progress: number; outputUrl: string | null; errorCode: string | null; errorMessage: string | null } | null,
  videoRenderAttempt: 1,
  timeline: null as unknown,
  timelineVersion: 1,
  published: null as { url: string; version: number } | null,
}));
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async () => (dbState.job ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: "/local-storage/old.mp4", userId: 1 }),
  getVideoRenderAttempt: async () => dbState.videoRenderAttempt,
  getStoredTimeline: async () => (dbState.timeline ? { raw: JSON.parse(JSON.stringify(dbState.timeline)), timelineVersion: dbState.timelineVersion } : null),
  getVideoScenes: async () => null,
  updateRenderJobProgress: async (id: number, step: string, progress: number) => { if (dbState.job?.id === id) Object.assign(dbState.job, { progressStep: step, progress }); },
  touchRunningRenderJob: async () => true,
  finishRenderJob: async (p: { id: number; status: string; outputUrl?: string | null; errorCode?: string | null; errorMessage?: string | null }) => {
    if (dbState.job?.id === p.id) Object.assign(dbState.job, { status: p.status, outputUrl: p.outputUrl ?? null, errorCode: p.errorCode ?? null, errorMessage: p.errorMessage ?? null });
  },
  publishEditedVideo: async (p: { videoId: number; attempt: number; editedVideoUrl: string; timelineVersion: number }) => {
    if (p.attempt !== dbState.videoRenderAttempt) return { published: false };
    dbState.published = { url: p.editedVideoUrl, version: p.timelineVersion };
    return { published: true };
  },
}));

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
let ROOT = "";
let REAL = "";
let GENERIC = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v650e2e-"));
  REAL = path.join(ROOT, "real.mp4");
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", REAL]);
  GENERIC = path.join(ROOT, "scene_0_generic_b1.mp4");
  const made = await makeSyntheticMotionClip(FFMPEG, { output: GENERIC, durationSec: 4, widthPx: 320, heightPx: 180, fps: 30, seed: 650 });
  expect(made).toEqual({ ok: true });
}, 300_000);
afterAll(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* not worth a failure */ } });

function clip(
  i: number,
  url: string,
  approval: "judge_fit" | "judge_acceptable" | "generic_footage",
  provider: string,
  /** FIX 1+2 — the text check the pipeline writes on every picture it places. */
  textCheck: "clean" | "unchecked" = "clean"
): TimelineVideoClip {
  return {
    id: `vc_${i}`, kind: "video",
    source: { provider, providerAssetId: `item/${i}`, mediaUrl: url, archiveAssetId: 59000 + i, contentApproval: approval, textCheck },
    sourceIn: 0, sourceOut: 3, sceneIndex: 0, beatIndex: i, timelineStart: i * 3, timelineEnd: (i + 1) * 3,
    motion: "none", transitionIn: i === 0 ? "hard_cut" : "dissolve", transitionOut: "hard_cut", previewSource: "asset",
  };
}

describe("VIDEO 650 — a film delivered on the generic floor, end to end", () => {
  it("no generator is configured in this environment (the primary sources are off by construction)", () => {
    expect(process.env.REPLICATE_API_TOKEN ?? "").toBe("");
    expect(replicateVideoConfigured()).toBe(false);
    expect(elevenLabsVideoConfigured()).toBe(false);
  });

  /** One real sentence and one sentence on the generic floor, rendered by the real worker. */
  async function renderFloorFilm(floorApproval: "judge_acceptable" | "generic_footage", floorText: "clean" | "unchecked") {
    const t: ProjectTimeline = emptyTimeline(1, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 30 });
    t.tracks = [
      /** both carry the local provider the worker harness (ronde148) rehydrates from disk */
      { kind: "VIDEO", clips: [clip(0, REAL, "judge_fit", "loc"), clip(1, GENERIC, floorApproval, "loc", floorText)] },
      { kind: "VOICE", clips: [] }, { kind: "MUSIC", clips: [] }, { kind: "SFX", clips: [] },
      { kind: "CAPTIONS", captions: [{ id: "cap_0", text: "Delivered on the floor", start: 0.5, end: 3, style: DEFAULT_CAPTION_STYLE, animation: "fade" }] },
      { kind: "TEXT", texts: [] }, { kind: "GRAPHICS", texts: [] },
    ];
    t.durationSec = 6;
    t.sentences = [
      { sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 3, timingBasis: "measured", text: "The real one." },
      { sceneIndex: 0, beatIndex: 1, startSec: 3, endSec: 6, timingBasis: "measured_silence", text: "The one nothing could picture." },
    ];
    dbState.timeline = t;
    dbState.job = { id: 650, videoId: 1, status: "running", timelineVersion: 1, attempt: 1, progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null };
    dbState.published = null;
    const uploads: string[] = [];
    const logs: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    const result = await runRenderJob({
      jobId: 650,
      deps: {
        workRoot: () => ROOT,
        download: async (url, dest) => { const src = url.includes("real.mp4") || url.includes("item/0") ? REAL : GENERIC; fs.copyFileSync(src, dest); return true; },
        upload: async (key, filePath) => { const dest = path.join(ROOT, key.replace(/\//g, "_")); fs.copyFileSync(filePath, dest); uploads.push(dest); return { key, url: `/local-storage/${key}` }; },
      },
    });
    spies.forEach((sp) => sp.mockRestore());
    return { result, uploads, logs };
  }

  /**
   * FIX 1+2 (14 October) — a generic clip is footage like any other: it reaches a pipeline film only
   * after the picture editor judged it for its sentence (here: acceptable) and the text check passed.
   */
  it("REAL FFMPEG: one real sentence, one sentence on generic footage that passed both checks — rendered, checked at 30 fps, covered, allowed, published", async () => {
    const { result, uploads, logs } = await renderFloorFilm("judge_acceptable", "clean");
    const seen = (needle: string) => logs.filter((l) => l.includes(needle)).slice(0, 4).join("\n") || "(no line)";
    if (process.env.V650_E2E_LOG) fs.writeFileSync(process.env.V650_E2E_LOG, logs.join("\n"));
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.published).toBe(true);
    expect(filmUploads(uploads)).toHaveLength(1);
    /** the VIDEO 650 rule on the delivered file: 30 fps, average and nominal, a dissolve join and all */
    const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,duration", "-of", "json", uploads[0]!]);
    const st = (JSON.parse(stdout).streams ?? [])[0];
    const rational = (x: string) => { const [n, d] = String(x).split("/").map(Number); return d ? n / d : NaN; };
    expect(rational(st.r_frame_rate)).toBeCloseTo(30, 1);
    expect(rational(st.avg_frame_rate)).toBeCloseTo(30, 1);
    expect(Math.abs(Number(st.nb_frames) - Number(st.duration) * 30)).toBeLessThanOrEqual(2);
    expect((await clipHasMotion(FFMPEG, uploads[0]!)).moving).toBe(true);
    /** the coverage line names the floor sentence as acceptable footage, and the gate enforced both checks */
    expect(logs.some((l) => l.includes("[SentenceCoverage] video=1 s0b1") && l.includes("status=covered") && l.includes("kinds=acceptable_footage")), seen("s0b1")).toBe(true);
    expect(logs.some((l) => l.includes("QUALITY_NOTE ACCEPTABLE_FOOTAGE sentences=1")), seen("QUALITY_NOTE")).toBe(true);
    expect(logs.some((l) => l.includes("DELIVERY_GATE_PASS") && l.includes("pictureChecks=enforced")), seen("DELIVERY_GATE")).toBe(true);
    expect(logs.some((l) => l.includes("FINAL_FILE 320x180 fps=30")), seen("FINAL_FILE")).toBe(true);
    expect(logs.some((l) => l.includes("[SentenceCoverage] video=1 s0b1") && l.includes("timing=measured_silence")), seen("s0b1")).toBe(true);
  }, 600_000);

  /** VIDEO 659 (owner's rule, 15 October: a video must always succeed) — delivered, the missing check named. */
  it("REAL FFMPEG: generic footage nobody judged for its sentence — the film is delivered, and the gate names the missing check", async () => {
    const { result, uploads, logs } = await renderFloorFilm("generic_footage", "unchecked");
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
    expect(logs.some((l) => l.includes("QUALITY_PROBLEM PICTURE_NOT_CHECKED") && l.includes("clip=vc_1"))).toBe(true);
    expect(logs.some((l) => l.includes("DELIVERY_GATE_PASS") && l.includes("pictureChecks=enforced"))).toBe(true);
    expect(filmUploads(uploads)).toHaveLength(1);
    expect(dbState.published).not.toBeNull();
  }, 600_000);
});
