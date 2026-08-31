/**
 * RONDE 148 §23 — the render job's rules, the timeline store's rules, and the worker's order.
 *
 * ── What is tested with real files and what is not ────────────────────────────────────────────
 *
 * The last block runs the WHOLE worker against real ffmpeg: two real MP4s, a real render, a real
 * ffprobe gate, a real upload (to a temp directory standing in for storage). The database is the
 * one thing replaced, because this environment has no DATABASE_URL — and a worker tested only
 * against mocked ffmpeg would prove nothing about the thing that actually breaks.
 *
 * Everything above it is pure: fencing, transitions, version conflicts, the text edit. Those are
 * where the damage lives — a wrong answer from `mayPublishRender` silently destroys someone's
 * video — so they are tested exhaustively rather than incidentally.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import {
  ACTIVE_STATUSES,
  RENDER_ERROR,
  RENDER_PHASES,
  canTransition,
  formatRenderJob,
  mayCreateRenderJob,
  mayPublishRender,
  progressForPhase,
  renderJobIsActive,
  renderJobIsTerminal,
  type RenderJobStatus,
} from "./renderJobs";
import {
  editTimelineText,
  nextTimelineToStore,
  parseStoredTimeline,
  replaceTimelineClipSource,
  storedTimelineIsReadable,
} from "./timelineStore";
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FORMAT,
  TIMELINE_SCHEMA_VERSION,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";
import { validateTimeline } from "./timelineValidator";
import { renderOutputKey, runRenderJob } from "./renderJobWorker";

/* ═══════════════════════ the database, and only the database ═══════════════════════ */

/**
 * `vi.hoisted` + `vi.mock` at module scope — NOT `vi.doMock` inside `beforeAll`.
 *
 * The first version of this file used doMock and all seven worker tests failed identically with
 * VIDEO_NOT_FOUND: `renderJobWorker` is imported at the top of this file, so it had already bound
 * the real `getRenderJobById` before `beforeAll` ever ran. `vi.mock` is hoisted above the imports,
 * and `vi.hoisted` gives its factory a state object that already exists when it is called.
 *
 * `importOriginal` keeps every other db export real, which is not optional: the worker imports
 * `videoPipeline` for its downloader, and that module pulls dozens of names out of `db`. An ESM
 * named import that a mock does not define is a hard error at import time, so replacing the whole
 * module would fail before a single test ran.
 */
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
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getRenderJobById: async () => (dbState.job ? { ...dbState.job } : null),
  getVideoById: async (id: number) => ({ id, videoUrl: "/local-storage/old.mp4", userId: 1 }),
  getVideoRenderAttempt: async () => dbState.videoRenderAttempt,
  getStoredTimeline: async () =>
    dbState.timeline
      ? {
          raw: JSON.parse(JSON.stringify(dbState.timeline)),
          timelineVersion: dbState.timelineVersion,
        }
      : null,
  getVideoScenes: async () => null,
  updateRenderJobProgress: async (id: number, step: string, progress: number) => {
    if (dbState.job?.id === id) Object.assign(dbState.job, { progressStep: step, progress });
  },
  finishRenderJob: async (p: {
    id: number; status: string; outputUrl?: string | null;
    errorCode?: string | null; errorMessage?: string | null;
  }) => {
    if (dbState.job?.id === p.id) {
      Object.assign(dbState.job, {
        status: p.status,
        outputUrl: p.outputUrl ?? null,
        errorCode: p.errorCode ?? null,
        errorMessage: p.errorMessage ?? null,
      });
    }
  },
  /** The fenced UPDATE, reproduced: it matches no rows once the attempt has moved on. */
  publishEditedVideo: async (p: {
    videoId: number; attempt: number; editedVideoUrl: string; timelineVersion: number;
  }) => {
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
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r148-"));
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
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

/* ═══════════════════════ fixtures ═══════════════════════ */

function clip(i: number, url: string): TimelineVideoClip {
  return {
    id: `vc_${i}`,
    kind: "video",
    source: { provider: "loc", providerAssetId: `item/${i}`, mediaUrl: url },
    timelineStart: i * 3,
    timelineEnd: (i + 1) * 3,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
  };
}

function goodTimeline(videoId = 1): ProjectTimeline {
  const t = emptyTimeline(videoId, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
  t.tracks = [
    { kind: "VIDEO", clips: [clip(0, SOURCE_A), clip(1, SOURCE_B)] },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    {
      kind: "CAPTIONS",
      captions: [
        { id: "cap_0", text: "The Battle Begins", start: 0.5, end: 3, style: DEFAULT_CAPTION_STYLE, animation: "fade" },
      ],
    },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", texts: [] },
  ];
  t.durationSec = 6;
  return t;
}

/* ═══════════════════════ §1 — the status machine ═══════════════════════ */

describe("RenderJob lifecycle", () => {
  it("a job moves queued → running → completed and no further", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("failed", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
  });

  it("a person may give up at either point", () => {
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
  });

  it("queued and running occupy the video; the rest are done with it", () => {
    expect(renderJobIsActive("queued")).toBe(true);
    expect(renderJobIsActive("running")).toBe(true);
    for (const s of ["completed", "failed", "cancelled"] as RenderJobStatus[]) {
      expect(renderJobIsActive(s), s).toBe(false);
      expect(renderJobIsTerminal(s), s).toBe(true);
    }
    expect(ACTIVE_STATUSES.size).toBe(2);
  });

  it("a job never skips straight from queued to completed", () => {
    // Completing without ever running would mean an output nobody produced.
    expect(canTransition("queued", "completed")).toBe(false);
  });
});

/* ═══════════════════════ §10 — progress that is not invented ═══════════════════════ */

describe("§10 — progress is a real fraction of real phases", () => {
  it("every phase has a percentage, and they only go up", () => {
    let last = -1;
    for (const p of RENDER_PHASES) {
      const v = progressForPhase(p);
      expect(v, p).toBeGreaterThanOrEqual(last);
      last = v;
    }
    expect(progressForPhase("queued")).toBe(0);
    expect(progressForPhase("completed")).toBe(100);
  });

  it("the numbers come from the PHASE LIST, so no percentage is made up", () => {
    /**
     * The check that this is a fraction rather than a guess: rendering is the fourth of six
     * phases, so it is exactly 3/5. If anyone ever hard-codes a nicer-looking number here, this
     * fails.
     */
    expect(progressForPhase("rendering")).toBe(Math.round((3 / 5) * 100));
  });
});

/* ═══════════════════════ §2 — fencing, the rule that protects a video ═══════════════════════ */

describe("§2 — an old render can never overwrite a newer one", () => {
  it("a job whose attempt still matches may publish", () => {
    expect(mayPublishRender({ jobAttempt: 3, videoRenderAttempt: 3 }).publish).toBe(true);
  });

  it("A SLOW RENDER THAT FINISHES LAST DOES NOT PUBLISH", () => {
    /**
     * The scenario this whole mechanism exists for. Job 1 starts, the user edits and renders
     * again (job 2, attempt 2), job 2 finishes first, and THEN job 1's ffmpeg returns. Job 1 must
     * not overwrite job 2's output with a video of older edits.
     */
    const verdict = mayPublishRender({ jobAttempt: 1, videoRenderAttempt: 2 });
    expect(verdict.publish).toBe(false);
    if (verdict.publish) return;
    expect(verdict.code).toBe(RENDER_ERROR.RENDER_SUPERSEDED);
    expect(verdict.reason).toContain("a newer render was started");
    expect(verdict.reason).toContain("will not overwrite");
  });

  it("an attempt ahead of the video's is refused rather than trusted", () => {
    // The counter only moves forward, so this state should not occur — and is not guessed at.
    const verdict = mayPublishRender({ jobAttempt: 5, videoRenderAttempt: 2 });
    expect(verdict.publish).toBe(false);
    if (!verdict.publish) expect(verdict.reason).toContain("only moves forward");
  });

  it("every gap of one or more is refused, exhaustively", () => {
    for (let job = 0; job < 8; job++) {
      for (let video = 0; video < 8; video++) {
        expect(mayPublishRender({ jobAttempt: job, videoRenderAttempt: video }).publish, `${job}/${video}`)
          .toBe(job === video);
      }
    }
  });
});

/* ═══════════════════════ §7 — one render at a time ═══════════════════════ */

describe("§7 — a second render is refused while one is active", () => {
  it("a queued job blocks a new one", () => {
    const v = mayCreateRenderJob({
      activeJobs: [{ id: 9, status: "queued" }],
      timelineVersion: 3,
      requestedVersion: 3,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe(RENDER_ERROR.RENDER_ALREADY_RUNNING);
    expect(v.reason).toContain("render job 9");
  });

  it("a running job blocks a new one", () => {
    const v = mayCreateRenderJob({
      activeJobs: [{ id: 4, status: "running" }],
      timelineVersion: 1,
      requestedVersion: 1,
    });
    expect(v.ok).toBe(false);
  });

  it("finished jobs do not block anything", () => {
    const v = mayCreateRenderJob({
      activeJobs: [
        { id: 1, status: "completed" },
        { id: 2, status: "failed" },
        { id: 3, status: "cancelled" },
      ],
      timelineVersion: 2,
      requestedVersion: 2,
    });
    expect(v.ok).toBe(true);
  });

  it("rendering a version the server does not have is refused, not reinterpreted", () => {
    /**
     * Silently rendering "the latest" instead would hand the person a video of edits they never
     * saw — their client is showing version 7 and the file would contain version 8.
     */
    const v = mayCreateRenderJob({ activeJobs: [], timelineVersion: 8, requestedVersion: 7 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe(RENDER_ERROR.TIMELINE_VERSION_CONFLICT);
      expect(v.reason).toContain("reload the editor");
    }
  });
});

/* ═══════════════════════ §3/§6 — versions and the conflict ═══════════════════════ */

describe("§6 — optimistic concurrency", () => {
  it("a save from the current version increments it by exactly one", () => {
    const t = goodTimeline();
    const r = nextTimelineToStore({ storedVersion: 4, expectedVersion: 4, incoming: t });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timelineVersion).toBe(5);
    expect(r.timeline.version).toBe(5);
  });

  it("the FIRST save of a never-edited video goes from 0 to 1", () => {
    const r = nextTimelineToStore({ storedVersion: 0, expectedVersion: 0, incoming: goodTimeline() });
    expect(r.ok && r.timelineVersion).toBe(1);
  });

  it("A STALE SAVE IS REFUSED AND NOTHING IS OVERWRITTEN", () => {
    /**
     * The case §6 names: someone opens version 4, someone else saves 5, the first person presses
     * Save. Last-write-wins would silently discard the second person's work with no error anywhere.
     */
    const r = nextTimelineToStore({ storedVersion: 5, expectedVersion: 4, incoming: goodTimeline() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("TIMELINE_VERSION_CONFLICT");
    expect(r.storedVersion).toBe(5);
    expect(r.expectedVersion).toBe(4);
    expect(r.reason).toContain("nothing was written");
  });

  it("the client cannot name its own version — the server assigns it", () => {
    /**
     * A client that could pick would be able to save two different documents both calling
     * themselves version 5, after which "render version 5" has no single answer.
     */
    const t = goodTimeline();
    t.version = 999;
    const r = nextTimelineToStore({ storedVersion: 2, expectedVersion: 2, incoming: t });
    expect(r.ok && r.timeline.version).toBe(3);
  });

  it("the stored document always carries this build's schema version", () => {
    const t = { ...goodTimeline(), schemaVersion: undefined };
    const r = nextTimelineToStore({ storedVersion: 0, expectedVersion: 0, incoming: t });
    expect(r.ok && r.timeline.schemaVersion).toBe(TIMELINE_SCHEMA_VERSION);
  });
});

describe("reading a stored timeline back", () => {
  it("a real timeline round-trips through JSON", () => {
    const stored = JSON.parse(JSON.stringify(goodTimeline()));
    const parsed = parseStoredTimeline(stored);
    expect(parsed).not.toBeNull();
    expect(parsed!.videoId).toBe(1);
    expect(storedTimelineIsReadable(parsed!)).toBe(true);
  });

  it("anything that is not a timeline comes back null instead of crashing a render", () => {
    for (const junk of [null, undefined, 42, "timeline", [], {}, { videoId: 1 }, { videoId: 1, version: 1 }]) {
      expect(parseStoredTimeline(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("a document from a NEWER build is well-formed and still must not be rendered", () => {
    const future = { ...goodTimeline(), schemaVersion: TIMELINE_SCHEMA_VERSION + 1 };
    expect(parseStoredTimeline(future)).not.toBeNull();
    expect(storedTimelineIsReadable(future)).toBe(false);
  });

  it("a legacy document with no schemaVersion reads as v1 and is fine", () => {
    const legacy = { ...goodTimeline() } as Partial<ProjectTimeline>;
    delete legacy.schemaVersion;
    expect(storedTimelineIsReadable(legacy as ProjectTimeline)).toBe(true);
  });
});

/* ═══════════════════════ §16 — a text edit touches one element ═══════════════════════ */

describe("§16 — editing text changes ONLY that element", () => {
  it("the caption changes and every other object is the same object", () => {
    const before = goodTimeline();
    const videoBefore = before.tracks.find((t) => t.kind === "VIDEO");
    const result = editTimelineText({
      timeline: before,
      elementId: "cap_0",
      text: "The Battle for Europe Begins",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caps = result.timeline.tracks.find((t) => t.kind === "CAPTIONS");
    expect(caps?.kind === "CAPTIONS" && caps.captions[0]!.text).toBe("The Battle for Europe Begins");

    /**
     * Reference equality, not deep equality. A mapped track returns untouched elements as the SAME
     * object, so this cannot pass by accident — and it is the strongest available statement of
     * "nothing else was touched".
     */
    const videoAfter = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    expect(videoAfter).toBe(videoBefore);
  });

  it("the times can be changed without touching the text", () => {
    const r = editTimelineText({ timeline: goodTimeline(), elementId: "cap_0", start: 1, end: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caps = r.timeline.tracks.find((t) => t.kind === "CAPTIONS");
    if (caps?.kind !== "CAPTIONS") throw new Error("no captions track");
    expect(caps.captions[0]!.start).toBe(1);
    expect(caps.captions[0]!.end).toBe(4);
    expect(caps.captions[0]!.text).toBe("The Battle Begins");
  });

  it("the original timeline is not mutated", () => {
    const before = goodTimeline();
    const snapshot = JSON.stringify(before);
    editTimelineText({ timeline: before, elementId: "cap_0", text: "changed" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("an unknown element id is reported, not silently ignored", () => {
    const r = editTimelineText({ timeline: goodTimeline(), elementId: "nope", text: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ELEMENT_NOT_FOUND");
  });

  it("an edit that breaks the timeline is still CAUGHT — by the validator, not by this", () => {
    // The store applies; the validator judges. This is the seam the route relies on.
    const r = editTimelineText({ timeline: goodTimeline(), elementId: "cap_0", start: 5, end: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateTimeline(r.timeline).issues.map((i) => i.code)).toContain("negative_duration");
  });
});

/* ═══════════════════════ §17 — replacement keeps the slot ═══════════════════════ */

describe("§17 — replacing a shot keeps its slot and moves nothing", () => {
  const newSource = {
    provider: "wwii_archive",
    archiveAssetId: 4242,
    canonicalUrl: "/api/archive-media/4242",
    title: "Landing craft, Normandy",
  };

  it("THE SLOT IS UNCHANGED — start, end and duration all survive", () => {
    const before = goodTimeline();
    const r = replaceTimelineClipSource({ timeline: before, clipId: "vc_0", source: newSource });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const track = r.timeline.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind !== "VIDEO") throw new Error("no video track");
    const replaced = track.clips[0]!;
    expect(replaced.timelineStart).toBe(0);
    expect(replaced.timelineEnd).toBe(3);
    expect(replaced.id).toBe("vc_0");
    expect(replaced.transitionIn).toBe("hard_cut");
  });

  it("THE FOLLOWING CLIPS DO NOT MOVE", () => {
    /**
     * The rule that keeps a video watchable. Sliding everything after a replacement means the
     * narration stops matching the picture from that point on — the person asked to change one
     * shot, not to re-time the rest of their video.
     */
    const r = replaceTimelineClipSource({ timeline: goodTimeline(), clipId: "vc_0", source: newSource });
    if (!r.ok) throw new Error("replacement failed");
    const track = r.timeline.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind !== "VIDEO") throw new Error("no video track");
    expect(track.clips[1]!.timelineStart).toBe(3);
    expect(track.clips[1]!.timelineEnd).toBe(6);
    expect(r.timeline.durationSec).toBe(6);
  });

  it("the identity is REPLACED, not merged with the old one", () => {
    /**
     * A merge would leave the previous provider's id attached to the new asset — a laundered
     * source, and exactly what the lineage ledger exists to prevent.
     */
    const r = replaceTimelineClipSource({ timeline: goodTimeline(), clipId: "vc_0", source: newSource });
    if (!r.ok) throw new Error("replacement failed");
    const track = r.timeline.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind !== "VIDEO") throw new Error("no video track");
    expect(track.clips[0]!.source.provider).toBe("wwii_archive");
    expect(track.clips[0]!.source.providerAssetId).toBeUndefined();
    expect(track.clips[0]!.source.archiveAssetId).toBe(4242);
    expect(track.clips[0]!.editedByUser).toBe(true);
  });

  it("the preview stops pointing at the previously rendered MP4", () => {
    // That file still shows the OLD shot; leaving the preview there would show the thing just replaced.
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.previewSource = "rendered_video";
    const r = replaceTimelineClipSource({ timeline: t, clipId: "vc_0", source: newSource });
    if (!r.ok) throw new Error("replacement failed");
    const after = r.timeline.tracks.find((x) => x.kind === "VIDEO");
    expect(after?.kind === "VIDEO" && after.clips[0]!.previewSource).toBe("asset");
  });

  it("§15: an unrecorded trim stays unrecorded rather than becoming 0", () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[0]!.sourceIn = 2;
      track.clips[0]!.sourceOut = 5;
    }
    const r = replaceTimelineClipSource({ timeline: t, clipId: "vc_0", source: newSource });
    if (!r.ok) throw new Error("replacement failed");
    const after = r.timeline.tracks.find((x) => x.kind === "VIDEO");
    if (after?.kind !== "VIDEO") throw new Error("no video track");
    // The OLD trim referred to the OLD media; carrying it over would trim the new asset at times
    // that mean nothing in it.
    expect(after.clips[0]!.sourceIn).toBeUndefined();
    expect(after.clips[0]!.sourceOut).toBeUndefined();
  });

  it("a known trim in the NEW media is kept", () => {
    const r = replaceTimelineClipSource({
      timeline: goodTimeline(),
      clipId: "vc_0",
      source: newSource,
      sourceIn: 10,
      sourceOut: 13,
    });
    if (!r.ok) throw new Error("replacement failed");
    const after = r.timeline.tracks.find((x) => x.kind === "VIDEO");
    expect(after?.kind === "VIDEO" && after.clips[0]!.sourceIn).toBe(10);
  });

  it("the replaced timeline still validates", () => {
    const r = replaceTimelineClipSource({ timeline: goodTimeline(), clipId: "vc_0", source: newSource });
    if (!r.ok) throw new Error("replacement failed");
    expect(validateTimeline(r.timeline).issues).toEqual([]);
  });

  it("an unknown clip id is reported", () => {
    const r = replaceTimelineClipSource({ timeline: goodTimeline(), clipId: "nope", source: newSource });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CLIP_NOT_FOUND");
  });
});

/* ═══════════════════════ §29/§30 — output keys and logging ═══════════════════════ */

describe("§29 — a render's output belongs to that render", () => {
  it("each job writes to its own key, so a failure overwrites nothing", () => {
    expect(renderOutputKey(7, 1)).toBe("videos/7/edits/render_1.mp4");
    expect(renderOutputKey(7, 2)).not.toBe(renderOutputKey(7, 1));
    // And never the generated master's key — §9: videoUrl is not touched by an edit.
    expect(renderOutputKey(7, 1)).not.toContain("final.mp4");
  });
});

describe("§30 — the log line says what happened and leaks nothing", () => {
  it("it carries the job, video, version, attempt and status", () => {
    const line = formatRenderJob({
      id: 12, videoId: 7, timelineVersion: 3, attempt: 2,
      status: "completed", progressStep: "completed",
      outputUrl: "https://cdn.example.com/videos/7/edits/render_12.mp4?X-Amz-Signature=SECRET",
    });
    expect(line).toContain("job=12");
    expect(line).toContain("video=7");
    expect(line).toContain("timelineVersion=3");
    expect(line).toContain("attempt=2");
    expect(line).toContain("status=completed");
  });

  it("A PRESIGNED URL IS NEVER LOGGED IN FULL", () => {
    // A signed URL in a log is a credential in a log, and these lines get pasted into issues.
    const line = formatRenderJob({
      id: 12, videoId: 7, timelineVersion: 3, attempt: 2, status: "completed",
      outputUrl: "https://cdn.example.com/videos/7/edits/render_12.mp4?X-Amz-Signature=SECRET",
    });
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("X-Amz");
    expect(line).toContain("edits/render_12.mp4");
  });
});

/* ═══════════════════════ THE WORKER, WITH REAL FFMPEG ═══════════════════════ */

/**
 * The database is replaced; ffmpeg is not.
 *
 * There is no DATABASE_URL in this environment, so `runRenderJob`'s db calls are mocked with an
 * in-memory row store that behaves like the real one — including the two conditional updates that
 * make fencing work. Everything below the database is real: real MP4s in, a real three-phase
 * render, a real ffprobe gate, and a real file arriving at the "upload".
 */
describe("the render worker, end to end", () => {
  type Row = {
    id: number;
    videoId: number;
    status: RenderJobStatus;
    timelineVersion: number;
    attempt: number;
    progressStep: string;
    progress: number;
    outputUrl: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };

  const uploads: Array<{ key: string; bytes: number }> = [];


  const runWith = async (over: Partial<Row> = {}) => {
    dbState.job = {
      id: 501, videoId: 1, status: "running", timelineVersion: 1, attempt: 1,
      progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null,
      ...over,
    };
    return runRenderJob({
      jobId: dbState.job.id,
      deps: {
        workRoot: () => ROOT,
        // Stands in for the network: the URL the rehydrator derived decides which file arrives.
        download: async (url, dest) => {
          const src = url.includes("item/0") || url.includes(SOURCE_A) ? SOURCE_A : SOURCE_B;
          if (!fs.existsSync(src)) return false;
          fs.copyFileSync(src, dest);
          return true;
        },
        upload: async (key, filePath) => {
          uploads.push({ key, bytes: fs.statSync(filePath).size });
          const dest = path.join(ROOT, key.replace(/\//g, "_"));
          fs.copyFileSync(filePath, dest);
          return { key, url: `/local-storage/${key}` };
        },
      },
    });
  };

  it("REAL FFMPEG: a saved timeline becomes a new MP4 and is published", async () => {
    dbState.timeline = goodTimeline();
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 1;
    dbState.published = null;
    uploads.length = 0;

    const result = await runWith();
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    // A real file, of a real length, measured by the real ffprobe gate.
    expect(result.durationSec).toBeGreaterThan(5.5);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.key).toBe("videos/1/edits/render_501.mp4");
    expect(uploads[0]!.bytes).toBeGreaterThan(1024);
    expect(fs.existsSync(path.join(ROOT, "videos_1_edits_render_501.mp4"))).toBe(true);

    // §9 — it lands in editedVideoUrl, and the generated master is untouched.
    expect(result.published).toBe(true);
    expect(dbState.published?.url).toBe("/local-storage/videos/1/edits/render_501.mp4");
    expect(dbState.published?.version).toBe(1);
    expect(dbState.job?.status).toBe("completed");
  }, 420_000);

  it("A SUPERSEDED RENDER PRODUCES ITS FILE AND DOES NOT PUBLISH", async () => {
    /**
     * The whole point of §2, exercised through the real worker: job 1 finishes after the video has
     * moved to attempt 2. It uploads (the file is real and someone may want it), records why it is
     * not current, and leaves the newer output alone.
     */
    dbState.timeline = goodTimeline();
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 2; // a newer render was started while this one ran
    dbState.published = null;
    uploads.length = 0;

    const result = await runWith({ id: 502, attempt: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.published).toBe(false);
    expect(dbState.published).toBeNull();

    // Completed, not failed: it did everything right and simply arrived second.
    expect(dbState.job?.status).toBe("completed");
    expect(dbState.job?.errorCode).toBe(RENDER_ERROR.RENDER_SUPERSEDED);
    expect(dbState.job?.outputUrl).toContain("render_502.mp4");
  }, 420_000);

  it("a job for a timeline version that has moved on refuses to render", async () => {
    dbState.timeline = goodTimeline();
    dbState.timelineVersion = 5; // saved again since the job was queued
    dbState.published = null;

    const result = await runWith({ id: 503, timelineVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.TIMELINE_VERSION_CONFLICT);
    expect(dbState.job?.status).toBe("failed");
  });

  it("AN INVALID TIMELINE FAILS BEFORE FFMPEG IS EVER RUN", async () => {
    const broken = goodTimeline();
    const track = broken.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    dbState.timeline = broken;
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 1;
    uploads.length = 0;

    const result = await runWith({ id: 504 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.TIMELINE_INVALID);
    expect(result.message).toContain("negative_duration");
    expect(uploads, "nothing was rendered or uploaded").toHaveLength(0);
  });

  it("a clip whose source cannot be fetched fails with the CLIP named", async () => {
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[0]!.source = { provider: "loc", providerAssetId: "item/0", mediaUrl: "https://loc/gone.mp4" };
    }
    dbState.timeline = t;
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 1;

    dbState.job = {
      id: 505, videoId: 1, status: "running", timelineVersion: 1, attempt: 1,
      progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null,
    };
    const result = await runRenderJob({
      jobId: 505,
      deps: { workRoot: () => ROOT, download: async () => false },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.ASSET_NOT_REHYDRATABLE);
    expect(result.message).toContain("vc_0");
    // §8 — enough is stored to understand the failure. Never a silent one.
    expect(dbState.job?.status).toBe("failed");
    expect(dbState.job?.errorCode).toBe(RENDER_ERROR.ASSET_NOT_REHYDRATABLE);
    expect(dbState.job?.errorMessage).toContain("vc_0");
  }, 120_000);

  it("A FAILED UPLOAD DOES NOT DESTROY THE PREVIOUS GOOD EDIT", async () => {
    // §29 — the render succeeded, the upload did not, and the last working video stays current.
    dbState.timeline = goodTimeline();
    dbState.timelineVersion = 1;
    dbState.videoRenderAttempt = 1;
    dbState.published = { url: "/local-storage/previous-good.mp4", version: 0 };

    dbState.job = {
      id: 506, videoId: 1, status: "running", timelineVersion: 1, attempt: 1,
      progressStep: "rehydrating", progress: 0, outputUrl: null, errorCode: null, errorMessage: null,
    };
    const result = await runRenderJob({
      jobId: 506,
      deps: {
        workRoot: () => ROOT,
        download: async (url, dest) => {
          fs.copyFileSync(url.includes("item/0") ? SOURCE_A : SOURCE_B, dest);
          return true;
        },
        upload: async () => {
          throw new Error("S3 refused the object");
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RENDER_ERROR.OUTPUT_UPLOAD_FAILED);
    expect(dbState.published?.url).toBe("/local-storage/previous-good.mp4");
    expect(dbState.job?.errorMessage).toContain("S3 refused");
  }, 420_000);
});
