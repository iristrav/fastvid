/**
 * THE YOUTUBE CHAIN, END TO END — AN APPROVED YOUTUBE CLIP REACHES THE DELIVERED MP4 AND COVERS ITS SENTENCE.
 *
 * The whole render worker, real ffmpeg, the real spot check on the real output file, the real
 * DeliveryGate — the ronde148 harness; the database is the one thing replaced. The "YouTube clip" is
 * a provenance-marked clip (`provider: youtube_cc`, an archive handle, the picture editor's
 * `judge_fit` mark) whose pixels are a known red, so that the delivered file can be read back frame by
 * frame and SHOW the clip under its sentence rather than the test trusting the timeline.
 *
 *   1. approved YouTube clip → placed → rendered → visible in the output exactly under its sentence →
 *      zero placeholder frames → the gate delivers.
 *   2. the sentence runs past the clip → SENTENCE_NOT_COVERED, named as a quality problem; since
 *      VIDEO 653 the film is still published (the customer replaces the shot in the editor).
 *   3. the clip has no Judge verdict → SENTENCE_COVERAGE_UNPROVEN.
 *   4. a real chapter card (Remotion-rendered, see the fixture) is in the FILE while the timeline calls
 *      it approved footage → the frame scan finds it → PLACEHOLDER_IN_FILE. The file, not the plan.
 *
 * No network, no provider, no credits: every byte here is made by ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { type RenderJobStatus } from "./renderJobs";
import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { runRenderJob } from "./renderJobWorker";
import { scanForPlaceholderGround } from "./postRenderSpotCheck";
import { sentenceCoverage } from "./sentenceCoverage";

/** VIDEO 656 — a contact sheet is stored next to the film; "one upload" means one upload of the FILM. */
const filmUploads = <T,>(u: readonly T[]): T[] =>
  u.filter((x) => (typeof x === "string" ? x : (x as unknown as { key: string }).key).endsWith(".mp4"));

/* ═══════════════════════ the database, and only the database (ronde148) ═══════════════════════ */

const dbState = vi.hoisted(() => ({
  job: null as {
    id: number; videoId: number; status: string; timelineVersion: number; attempt: number;
    progressStep: string; progress: number; outputUrl: string | null;
    errorCode: string | null; errorMessage: string | null;
  } | null,
  videoRenderAttempt: 1,
  timeline: null as unknown,
  timelineVersion: 1,
  published: null as { url: string; version: number } | null,
  /** `media_archive_assets`, by id: the archive handle every production clip carries, and the route the rehydrator reads first. */
  archiveUrls: {} as Record<number, string>,
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async () => (dbState.job ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: "/local-storage/old.mp4", userId: 1 }),
  getVideoRenderAttempt: async () => dbState.videoRenderAttempt,
  getStoredTimeline: async () =>
    dbState.timeline ? { raw: JSON.parse(JSON.stringify(dbState.timeline)), timelineVersion: dbState.timelineVersion } : null,
  getVideoScenes: async () => null,
  getMediaArchiveAssetById: async (id: number) =>
    dbState.archiveUrls[id] ? { id, storageUrl: dbState.archiveUrls[id], storageKey: null, mediaType: "video" } : null,
  updateRenderJobProgress: async (id: number, step: string, progress: number) => {
    if (dbState.job?.id === id) Object.assign(dbState.job, { progressStep: step, progress });
  },
  finishRenderJob: async (p: { id: number; status: string; outputUrl?: string | null; errorCode?: string | null; errorMessage?: string | null }) => {
    if (dbState.job?.id === p.id) {
      Object.assign(dbState.job, { status: p.status, outputUrl: p.outputUrl ?? null, errorCode: p.errorCode ?? null, errorMessage: p.errorMessage ?? null });
    }
  },
  publishEditedVideo: async (p: { videoId: number; attempt: number; editedVideoUrl: string; timelineVersion: number }) => {
    if (p.attempt !== dbState.videoRenderAttempt) return { published: false };
    dbState.published = { url: p.editedVideoUrl, version: p.timelineVersion };
    return { published: true };
  },
}));

/* ═══════════════════════ the files ═══════════════════════ */

let ROOT = "";
let YOUTUBE_RED = "";
let STOCK_GREEN = "";
let REAL_CARD = "";
const FIXTURES = path.join(__dirname, "..", "tests", "fixtures", "video-quality");

const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "yt-e2e-"));
  /** a known red with grain (so the encoder has something to encode and the file is a real file) */
  YOUTUBE_RED = path.join(ROOT, "youtube_red.mp4");
  ff(["-f", "lavfi", "-i", "color=c=0xC02020:s=320x180:r=25:d=4,noise=alls=18:allf=t+u", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", YOUTUBE_RED]);
  STOCK_GREEN = path.join(ROOT, "stock_green.mp4");
  ff(["-f", "lavfi", "-i", "color=c=0x20A040:s=320x180:r=25:d=4,noise=alls=18:allf=t+u", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", STOCK_GREEN]);
  /** the chapter card as Remotion drew it, 4 s of it */
  REAL_CARD = path.join(ROOT, "real_card.mp4");
  ff(["-loop", "1", "-framerate", "25", "-t", "4", "-i", path.join(FIXTURES, "primary-card-wide-title.png"), "-vf", "format=yuv420p,setsar=1", "-c:v", "libx264", "-preset", "ultrafast", REAL_CARD]);
}, 120_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

/** The mean colour of the delivered file at one second. */
function meanRgbAt(file: string, atSec: number): [number, number, number] {
  const raw = execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", atSec.toFixed(3), "-i", file, "-vframes", "1", "-vf", "scale=16:9,format=rgb24", "-f", "rawvideo", "pipe:1"]);
  const sum = [0, 0, 0];
  const px = raw.length / 3;
  for (let i = 0; i < px; i++) for (let c = 0; c < 3; c++) sum[c]! += raw[i * 3 + c]!;
  return [sum[0]! / px, sum[1]! / px, sum[2]! / px];
}

type ClipSpec = { id: string; file: string; start: number; end: number; beat: number; approved?: boolean; provider?: string; providerAssetId?: string };
function clip(c: ClipSpec): TimelineVideoClip {
  /** the clip was ingested: its archive row points at "storage", which the download stand-in serves by file name */
  dbState.archiveUrls[59100 + c.beat] = `https://archive.test/media/${path.basename(c.file)}`;
  return {
    id: c.id,
    kind: "video",
    source: {
      provider: c.provider ?? "youtube_cc",
      providerAssetId: c.providerAssetId ?? `yt_${c.id}`,
      mediaUrl: c.file,
      archiveAssetId: 59100 + c.beat,
      /** FIX 1+2 — an approved pipeline picture carries both checks; "not approved" carries neither. */
      ...(c.approved === false ? {} : { contentApproval: "judge_fit" as const, textCheck: "clean" as const }),
    },
    sourceIn: 0,
    sourceOut: c.end - c.start,
    sceneIndex: 0,
    beatIndex: c.beat,
    timelineStart: c.start,
    timelineEnd: c.end,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
  } as TimelineVideoClip;
}

/** Two spoken sentences, measured; the YouTube clip under the first, another picture under the second. */
function film(opts: { sentenceOneEnd?: number; approved?: boolean; second?: string } = {}): ProjectTimeline {
  const t = emptyTimeline(1, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks = [
    {
      kind: "VIDEO",
      clips: [
        clip({ id: "vc_yt", file: YOUTUBE_RED, start: 0, end: 3, beat: 0, approved: opts.approved, providerAssetId: "dQw4w9WgXcQ" }),
        clip({ id: "vc_two", file: opts.second ?? STOCK_GREEN, start: 3, end: 6, beat: 1 }),
      ],
    },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", texts: [] },
  ];
  t.durationSec = 6;
  t.sentences = [
    { sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: opts.sentenceOneEnd ?? 3, timingBasis: "measured", text: "In 2008 Tesla delivered the Roadster." },
    { sceneIndex: 0, beatIndex: 1, startSec: opts.sentenceOneEnd ?? 3, endSec: 6, timingBasis: "measured", text: "The industry took notice." },
  ];
  return t;
}

/* ═══════════════════════ the worker, end to end ═══════════════════════ */

describe("an approved YouTube clip reaches the delivered MP4 and covers its sentence", () => {
  type Row = { id: number; videoId: number; status: RenderJobStatus; timelineVersion: number; attempt: number; progressStep: string; progress: number; outputUrl: string | null; errorCode: string | null; errorMessage: string | null };
  const uploads: Array<{ key: string; file: string }> = [];

  const runWith = async (timeline: ProjectTimeline, over: Partial<Row> = {}) => {
    dbState.timeline = timeline;
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 1;
    dbState.published = null;
    uploads.length = 0;
    dbState.job = {
      id: 701, videoId: 1, status: "running", timelineVersion: 1, attempt: 1,
      progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null,
      ...over,
    };
    return runRenderJob({
      jobId: dbState.job.id,
      deps: {
        workRoot: () => ROOT,
        /** stands in for the network: the URL the rehydrator derived is the file that arrives */
        download: async (url, dest) => {
          const src = [YOUTUBE_RED, STOCK_GREEN, REAL_CARD].find((f) => url.includes(path.basename(f)));
          if (!src || !fs.existsSync(src)) return false;
          fs.copyFileSync(src, dest);
          return true;
        },
        upload: async (key, filePath) => {
          const dest = path.join(ROOT, key.replace(/\//g, "_"));
          fs.copyFileSync(filePath, dest);
          uploads.push({ key, file: dest });
          return { key, url: `/local-storage/${key}` };
        },
      },
    });
  };

  it("1. REAL FFMPEG: the YouTube clip is placed, covers its sentence, is VISIBLE in the output under it, no frame is the ground — delivered", async () => {
    const timeline = film();
    /** what the timeline says, before any render */
    const coverage = sentenceCoverage(timeline);
    expect(coverage.proven).toBe(true);
    expect(coverage.sentences[0]).toMatchObject({ key: "s0b0", status: "covered", coveredSec: 3, approvedFootageSec: 3 });

    const result = await runWith(timeline);
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.published).toBe(true);
    expect(dbState.job?.status).toBe("completed");
    expect(filmUploads(uploads)).toHaveLength(1);
    const delivered = uploads[0]!.file;
    expect(fs.existsSync(delivered)).toBe(true);

    /** the file, read back: red under the first sentence, green under the second — the clip is where its sentence is */
    for (const t of [0.5, 1.5, 2.5]) {
      const [r, g, b] = meanRgbAt(delivered, t);
      expect(r, `t=${t}`).toBeGreaterThan(120);
      expect(r - g, `t=${t}`).toBeGreaterThan(60);
      expect(r - b, `t=${t}`).toBeGreaterThan(60);
    }
    for (const t of [3.5, 4.5, 5.5]) {
      const [r, g] = meanRgbAt(delivered, t);
      expect(g, `t=${t}`).toBeGreaterThan(r + 60);
    }
    /** every frame of the delivered file, read: not one is the blue-grey ground */
    const scan = await scanForPlaceholderGround(delivered, [], result.durationSec ?? 6);
    expect(scan.complete).toBe(true);
    expect(scan.framesSampled).toBeGreaterThanOrEqual(140);
    expect(scan.placeholderFrames).toBe(0);
    expect(scan.placeholderSec).toBe(0);
  }, 420_000);

  /**
   * VIDEO 653 — ALWAYS A FILM (owner's rule, 14 October). The three findings below are still made,
   * on the delivered file, sentence by sentence; they are now QUALITY_PROBLEM lines on a film that
   * is published, for the customer to replace in the editor, instead of a refusal.
   */
  const deliveredWithProblem = async (timeline: ProjectTimeline) => {
    const spy = vi.spyOn(console, "log");
    try {
      const result = await runWith(timeline);
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      return { result, logged };
    } finally {
      spy.mockRestore();
    }
  };

  it("2. the sentence runs 1.5 s past the clip: SENTENCE_NOT_COVERED — named, and the film is published", async () => {
    const { result, logged } = await deliveredWithProblem(film({ sentenceOneEnd: 4.5 }));
    expect(result.ok).toBe(true);
    expect(logged).toMatch(/QUALITY_PROBLEM SENTENCE_NOT_COVERED[^\n]*s0b0/);
    expect(dbState.published).not.toBeNull();
    expect(filmUploads(uploads)).toHaveLength(1);
  }, 420_000);

  /**
   * FIX 1+2 — a pipeline film whose timeline holds a picture without both mandatory checks is not
   * delivered with it (before Fix 1+2 it was published, the missing verdict only named). The render
   * worker has no sourcing to replace a picture with; the replacement is the pipeline's, before the
   * timeline (`enforceMandatoryChecks` and the fallback rungs). Here the gate names the clip.
   */
  it("3. the same clip without the picture editor's verdict is not delivered: PICTURE_NOT_CHECKED names the clip, nothing is published", async () => {
    const result = await runWith(film({ approved: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("PICTURE_NOT_CHECKED");
    expect(result.message).toContain("clip=vc_yt");
    expect(result.message).not.toContain("clip=vc_two");
    expect(dbState.published).toBeNull();
    expect(filmUploads(uploads)).toHaveLength(0);
  }, 420_000);

  it("4. the timeline calls the second picture approved footage, but the FILE holds a real chapter card: PLACEHOLDER_IN_FILE — the file is what is checked", async () => {
    const timeline = film({ second: REAL_CARD });
    /** on paper this film is fine */
    expect(sentenceCoverage(timeline).proven).toBe(true);
    const { result, logged } = await deliveredWithProblem(timeline);
    expect(result.ok).toBe(true);
    expect(logged).toContain("QUALITY_PROBLEM PLACEHOLDER_IN_FILE");
    expect(logged).toMatch(/\d+ of \d+ frame\(s\) show the blue-grey chapter-card ground: [23]\.\d\ds where exactly 0\.00s is allowed/);
    expect(dbState.published).not.toBeNull();
    expect(filmUploads(uploads)).toHaveLength(1);
  }, 420_000);
});
