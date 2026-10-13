/**
 * VIDEO 650 — the render job's ONE bounded retry after a technical refusal.
 *
 * Video 650 reached the ffprobe gate with a complete, validated timeline and a file at 25 fps
 * instead of 30. The gate refused — correctly — and that refusal was the end of the video, because
 * the worker had no second render and the pipeline's only answer to a failed render job was a new
 * sourcing round. `runRenderJob` now renders the SAME timeline once more (same media, same audio,
 * plain cut joins, a separate output file) when, and only when, the refusal is about the file.
 *
 * What is real here: ffmpeg, the render, the ffprobe gate on the pass path, the upload (to a temp
 * directory). What is replaced: the database (no DATABASE_URL in this environment), and the quality
 * check on the first attempt — a 25 fps encode cannot be forced out of this ffmpeg on demand, so the
 * refusal is scripted while the retry's own file is measured by the real gate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import { RENDER_ERROR } from "./renderJobs";
import { DEFAULT_CAPTION_STYLE, DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { runRenderJob, type RenderWorkerDeps } from "./renderJobWorker";
import { checkRenderedFile, renderTimeline } from "./timelineRenderer";

const dbState = vi.hoisted(() => ({
  job: null as {
    id: number; videoId: number; status: string; timelineVersion: number; attempt: number;
    progressStep: string; progress: number; outputUrl: string | null;
    errorCode: string | null; errorMessage: string | null;
  } | null,
  finishCalls: 0,
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
  getStoredTimeline: async () =>
    dbState.timeline
      ? { raw: JSON.parse(JSON.stringify(dbState.timeline)), timelineVersion: dbState.timelineVersion }
      : null,
  getVideoScenes: async () => null,
  updateRenderJobProgress: async (id: number, step: string, progress: number) => {
    if (dbState.job?.id === id) Object.assign(dbState.job, { progressStep: step, progress });
  },
  finishRenderJob: async (p: {
    id: number; status: string; outputUrl?: string | null; errorCode?: string | null; errorMessage?: string | null;
  }) => {
    dbState.finishCalls += 1;
    if (dbState.job?.id === p.id) {
      Object.assign(dbState.job, {
        status: p.status,
        outputUrl: p.outputUrl ?? null,
        errorCode: p.errorCode ?? null,
        errorMessage: p.errorMessage ?? null,
      });
    }
  },
  publishEditedVideo: async (p: { videoId: number; attempt: number; editedVideoUrl: string; timelineVersion: number }) => {
    if (p.attempt !== dbState.videoRenderAttempt) return { published: false };
    dbState.published = { url: p.editedVideoUrl, version: p.timelineVersion };
    return { published: true };
  },
}));

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";

let ROOT = "";
let SOURCE_A = "";
let SOURCE_B = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v650retry-"));
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
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* not worth a failure */ }
});

function clip(i: number, url: string, approval: "judge_fit" | "none" = "judge_fit"): TimelineVideoClip {
  return {
    id: `vc_${i}`,
    kind: "video",
    source: {
      provider: "loc",
      providerAssetId: `item/${i}`,
      mediaUrl: url,
      archiveAssetId: 59000 + i,
      ...(approval === "judge_fit" ? { contentApproval: "judge_fit" as const } : {}),
    },
    sourceIn: 0,
    sourceOut: 3,
    sceneIndex: 0,
    beatIndex: i,
    timelineStart: i * 3,
    timelineEnd: (i + 1) * 3,
    motion: "none",
    transitionIn: i === 0 ? "hard_cut" : "dissolve",
    transitionOut: "hard_cut",
    previewSource: "asset",
  };
}

function goodTimeline(opts: { uncoveredSentence?: boolean } = {}): ProjectTimeline {
  const t = emptyTimeline(1, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks = [
    /** `uncoveredSentence`: the second clip was never approved for its sentence — a timeline fault. */
    { kind: "VIDEO", clips: [clip(0, SOURCE_A), clip(1, SOURCE_B, opts.uncoveredSentence ? "none" : "judge_fit")] },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [{ id: "cap_0", text: "The Battle Begins", start: 0.5, end: 3, style: DEFAULT_CAPTION_STYLE, animation: "fade" }] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", texts: [] },
  ];
  t.durationSec = 6;
  t.sentences = [
    { sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 3, timingBasis: "measured", text: "The battle begins." },
    { sceneIndex: 0, beatIndex: 1, startSec: 3, endSec: 6, timingBasis: "measured", text: "And it ends." },
  ];
  return t;
}

type RenderCall = { outputPath: string; startRung: string | undefined };

async function runWith(params: {
  timeline: ProjectTimeline;
  /** What the quality check says per call; `"real"` runs the real ffprobe gate. */
  checks: Array<"real" | string>;
  renderThrowsOn?: number;
}) {
  const renderCalls: RenderCall[] = [];
  const uploads: Array<{ key: string; bytes: number }> = [];
  let checkCalls = 0;
  dbState.job = {
    id: 650, videoId: 1, status: "running", timelineVersion: 1, attempt: 1,
    progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null,
  };
  dbState.finishCalls = 0;
  dbState.timeline = params.timeline;
  dbState.timelineVersion = 1;
  dbState.videoRenderAttempt = 1;
  dbState.published = null;
  const deps: Partial<RenderWorkerDeps> = {
    workRoot: () => ROOT,
    download: async (url, dest) => {
      const src = url.includes("item/0") || url.includes(SOURCE_A) ? SOURCE_A : SOURCE_B;
      if (!fs.existsSync(src)) return false;
      fs.copyFileSync(src, dest);
      return true;
    },
    upload: async (key, filePath) => {
      uploads.push({ key, bytes: fs.statSync(filePath).size });
      return { key, url: `/local-storage/${key}` };
    },
    render: async (p) => {
      renderCalls.push({ outputPath: p.outputPath, startRung: p.startRung });
      if (params.renderThrowsOn === renderCalls.length) throw new Error("ffmpeg exited with code 137 (the retry encode)");
      return renderTimeline(p);
    },
    check: async (p) => {
      const scripted = params.checks[checkCalls] ?? "real";
      checkCalls += 1;
      const real = await checkRenderedFile(p);
      if (scripted === "real") return real;
      return { ...real, ok: false, problems: [scripted] };
    },
  };
  const result = await runRenderJob({ jobId: 650, deps });
  return { result, renderCalls, uploads, checkCalls };
}

describe("VIDEO 650 — one bounded render retry after a technical refusal", () => {
  it("the first file fails its check, the retry passes: delivered from the retry, one upload, one job", async () => {
    const { result, renderCalls, uploads, checkCalls } = await runWith({
      timeline: goodTimeline(),
      checks: ["fps 25 ≠ 30", "real"],
    });
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
    expect(renderCalls).toHaveLength(2);
    /** The retry: a separate file, the plain cut rung, the same timeline. */
    expect(renderCalls[0]!.startRung).toBeUndefined();
    expect(renderCalls[1]!.startRung).toBe("cut");
    expect(renderCalls[1]!.outputPath).not.toBe(renderCalls[0]!.outputPath);
    expect(renderCalls[1]!.outputPath).toMatch(/out_retry\.mp4$/);
    expect(checkCalls).toBe(2);
    /** Delivered ONCE, as ONE job. */
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.bytes).toBeGreaterThan(1024);
    expect(dbState.finishCalls).toBe(1);
    expect(dbState.job?.status).toBe("completed");
    expect(dbState.published?.url).toBe("/local-storage/videos/1/edits/render_650.mp4");
  }, 420_000);

  it("both files fail their check: the job fails ONCE, naming both refusals, first one first", async () => {
    const { result, renderCalls, uploads } = await runWith({
      timeline: goodTimeline(),
      checks: ["fps 25 ≠ 30", "avg fps 24.9 ≠ 30"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.RENDER_FAILED);
    expect(result.message).toContain("technical render failure");
    expect(result.message).toContain("first attempt: fps 25 ≠ 30");
    expect(result.message).toContain("retry (plain cut joins): avg fps 24.9 ≠ 30");
    expect(result.message.indexOf("fps 25 ≠ 30")).toBeLessThan(result.message.indexOf("avg fps 24.9"));
    /** Two renders, never a third; nothing uploaded; one failed job. */
    expect(renderCalls).toHaveLength(2);
    expect(uploads).toHaveLength(0);
    expect(dbState.finishCalls).toBe(1);
    expect(dbState.job?.status).toBe("failed");
    expect(dbState.job?.errorMessage).toContain("quality check twice");
  }, 420_000);

  it("the retry render itself throws: both faults in the message, no third attempt, no upload", async () => {
    const { result, renderCalls, uploads } = await runWith({
      timeline: goodTimeline(),
      checks: ["fps 25 ≠ 30", "real"],
      renderThrowsOn: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.RENDER_FAILED);
    expect(result.message).toContain("first attempt: fps 25 ≠ 30");
    expect(result.message).toContain("the retry render threw");
    expect(result.message).toContain("code 137");
    expect(renderCalls).toHaveLength(2);
    expect(uploads).toHaveLength(0);
    expect(dbState.job?.status).toBe("failed");
  }, 420_000);

  it("a refusal about the TIMELINE (a sentence without approved footage) is never retried", async () => {
    const { result, renderCalls, uploads } = await runWith({
      timeline: goodTimeline({ uncoveredSentence: true }),
      checks: ["real", "real"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    /** The delivery gate's refusal, not the file's; no second encode can change the document. */
    expect(result.message).toContain("Delivery blocked");
    expect(result.message).not.toContain("technical render failure");
    expect(result.message).not.toContain("retry");
    expect(renderCalls).toHaveLength(1);
    expect(uploads).toHaveLength(0);
    expect(dbState.job?.status).toBe("failed");
  }, 420_000);
});
