/**
 * RONDE 148 §8/§28/§29 — the worker that turns a queued render job into an MP4.
 *
 * ── The chain, and why every link is an existing module ──────────────────────────────────────
 *
 *     job → timeline (timelineStore)      the document, read back and version-checked
 *         → validate (timelineValidator)  nothing renders from a timeline nobody checked
 *         → rehydrate (assetRehydrator)   identity → the ORIGINAL source file
 *         → render (timelineRenderer)     ffmpeg
 *         → gate (checkRenderedFile)      ffprobe on the result
 *         → upload (storage)              to a job-specific key
 *         → publish (db, fenced)          and only then is it the video's current edit
 *
 * Not one of those is new. This file is the sentences between them, plus the two rules that only
 * make sense at this level: what happens when a step fails, and who is allowed to publish.
 *
 * ── §28: THE SOURCE IS THE ORIGINAL, NEVER THE PREVIOUS MP4 ─────────────────────────────────
 *
 * The tempting shortcut for "change one caption" is to re-encode the existing final.mp4 with new
 * text. It is wrong twice over: every earlier edit is already burned into those pixels, so
 * replacing a shot becomes impossible, and each pass loses a generation of quality. The rehydrator
 * fetches each clip's ORIGINAL source from its identity, which is why RONDE 147 exists at all.
 *
 * ── §29: the output is atomic ────────────────────────────────────────────────────────────────
 *
 * The render writes to a temp file, is measured with ffprobe, is uploaded to a key unique to this
 * job, and only after all three succeed does `editedVideoUrl` move. A failure at any point leaves
 * the previous good edit exactly where it was — a person who renders a broken change should not
 * lose the working video they had ten minutes ago.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  claimQueuedRenderJob,
  finishRenderJob,
  getRenderJobById,
  getVideoById,
  getVideoRenderAttempt,
  getStoredTimeline,
  getVideoScenes,
  listQueuedRenderJobs,
  publishEditedVideo,
  updateRenderJobProgress,
} from "./db";
import {
  RENDER_ERROR,
  formatRenderJob,
  mayPublishRender,
  progressForPhase,
  type RenderErrorCode,
  type RenderPhase,
} from "./renderJobs";
import { parseStoredTimeline, storedTimelineIsReadable } from "./timelineStore";
import { timelineFromEditorScenes } from "./timelineFromManifest";
import { validateTimeline, NON_BLOCKING_ISSUES, formatTimelineIssue } from "./timelineValidator";
import { rehydrateTimelineAssets, formatRehydrationSummary } from "./assetRehydrator";
import { productionRehydrateDeps } from "./rehydrationDeps";
import { renderTimeline, checkRenderedFile, type GraphicsOverlayFile } from "./timelineRenderer";
import { graphicsOverlayAvailable, productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { storagePutFromFile } from "./storage";
import { resolveLocalStorageFilePath } from "./storageLocal";
import { downloadToFileStreaming } from "./videoPipeline";
import type { ProjectTimeline } from "./projectTimeline";
import { audioTrackOf } from "./projectTimeline";

/* ═══════════════════════ the outcome of one job ═══════════════════════ */

export type RenderJobOutcome =
  | { ok: true; outputUrl: string; published: boolean; durationSec: number | null }
  | { ok: false; code: RenderErrorCode; message: string };

/* ═══════════════════════ dependencies, injected so this is testable ═══════════════════════ */

/**
 * Everything that touches the world, in one object.
 *
 * The worker's interesting behaviour is its ORDER and its failure handling, and testing that
 * against real S3 and a real ten-minute render would mean never testing it. Each dependency
 * defaults to the real thing, so production wires itself and a test can replace exactly the one
 * piece it wants to make fail.
 */
export type RenderWorkerDeps = {
  rehydrate: typeof rehydrateTimelineAssets;
  render: typeof renderTimeline;
  check: typeof checkRenderedFile;
  upload: (key: string, filePath: string, contentType: string) => Promise<{ key: string; url: string }>;
  download: (url: string, destPath: string) => Promise<boolean>;
  /** Where work directories go. Overridable so a test does not fight the real temp dir. */
  workRoot: () => string;
  /**
   * RONDE 150 §5/§6 — build the Remotion graphics-overlay function for one render, or null.
   *
   * Null means "this deployment does not do graphics overlays", and every video then takes the
   * libass route exactly as it did before this round. A dependency rather than a direct import so
   * a test can render a real video without a browser, and so a worker with no
   * chrome-headless-shell is a configuration rather than a crash.
   */
  graphicsOverlay: (params: {
    workDir: string;
  }) => ((timeline: ProjectTimeline) => Promise<GraphicsOverlayFile | null>) | null;
};

export function defaultRenderWorkerDeps(): RenderWorkerDeps {
  return {
    rehydrate: rehydrateTimelineAssets,
    render: renderTimeline,
    check: checkRenderedFile,
    /**
     * Asked ONCE, here, rather than inside the render: a worker with no browser should take the
     * libass route without paying for a failed bundle on every job.
     */
    graphicsOverlay: ({ workDir }) =>
      graphicsOverlayAvailable() ? productionGraphicsOverlay({ workDir }) : null,
    upload: (key, filePath, contentType) => storagePutFromFile(key, filePath, contentType),
    download: async (url, destPath) => {
      /**
       * A file this server already holds is COPIED, never fetched.
       *
       * Asking the process to pull its own voiceover back through its own HTTP stack turns a
       * missing APP_URL into a mysterious render failure, and the bytes are right there on disk.
       */
      if (url.startsWith("/local-storage/")) {
        const local = resolveLocalStorageFilePath({ storageUrl: url });
        if (local && fs.existsSync(local)) {
          fs.copyFileSync(local, destPath);
          return true;
        }
        return false;
      }
      /**
       * Everything else goes through the pipeline's own downloader — §26's "no second downloader"
       * — so its timeout, its process-wide byte budget and its logging all apply here unchanged.
       * It resolves to a response rather than a boolean, so success is judged by the file landing.
       */
      await downloadToFileStreaming(url, destPath, 120_000, "renderJob:audio");
      return fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
    },
    workRoot: () => os.tmpdir(),
  };
}

/* ═══════════════════════ loading the document a job names ═══════════════════════ */

export type TimelineForJob =
  | { ok: true; timeline: ProjectTimeline; source: "stored" | "manifest" }
  | { ok: false; code: RenderErrorCode; message: string };

/**
 * The timeline this job is supposed to render.
 *
 * A job names a version, and the stored document must still BE that version. If the timeline moved
 * on between queueing and claiming, the job is stale: rendering what is there now would produce a
 * video of edits nobody asked this job to make, and rendering nothing at all is the honest answer.
 *
 * The manifest fallback exists for a video that has never been saved from the editor — its
 * timeline is derived at version 0, and a render of it is a render of the original cut.
 */
export async function loadTimelineForJob(job: {
  videoId: number;
  timelineVersion: number;
}): Promise<TimelineForJob> {
  const video = await getVideoById(job.videoId);
  if (!video) {
    return { ok: false, code: RENDER_ERROR.VIDEO_NOT_FOUND, message: `video ${job.videoId} not found` };
  }

  const stored = await getStoredTimeline(job.videoId);
  if (stored && stored.timelineVersion > 0) {
    if (stored.timelineVersion !== job.timelineVersion) {
      return {
        ok: false,
        code: RENDER_ERROR.TIMELINE_VERSION_CONFLICT,
        message:
          `job renders timeline version ${job.timelineVersion} but the video now holds ` +
          `${stored.timelineVersion}`,
      };
    }
    const parsed = parseStoredTimeline(stored.raw);
    if (!parsed) {
      return {
        ok: false,
        code: RENDER_ERROR.TIMELINE_NOT_FOUND,
        message: "the stored timeline is not a readable timeline document",
      };
    }
    if (!storedTimelineIsReadable(parsed)) {
      return {
        ok: false,
        code: RENDER_ERROR.TIMELINE_INVALID,
        message: `timeline schemaVersion ${parsed.schemaVersion} is newer than this build reads`,
      };
    }
    return { ok: true, timeline: parsed, source: "stored" };
  }

  if (job.timelineVersion !== 0) {
    return {
      ok: false,
      code: RENDER_ERROR.TIMELINE_NOT_FOUND,
      message: `job renders version ${job.timelineVersion} but no timeline has ever been saved`,
    };
  }
  const scenes = await getVideoScenes(job.videoId);
  if (!scenes?.length) {
    return {
      ok: false,
      code: RENDER_ERROR.TIMELINE_NOT_FOUND,
      message: "this video has neither a saved timeline nor a scene manifest to derive one from",
    };
  }
  return {
    ok: true,
    source: "manifest",
    timeline: timelineFromEditorScenes({
      videoId: job.videoId,
      scenes,
      renderedVideoUrl: video.videoUrl ?? undefined,
    }),
  };
}

/* ═══════════════════════ one job, start to finish ═══════════════════════ */

/** Storage key for a job's output. Job-specific, so a failed render overwrites nothing (§29). */
export function renderOutputKey(videoId: number, jobId: number): string {
  return `videos/${videoId}/edits/render_${jobId}.mp4`;
}

export async function runRenderJob(params: {
  jobId: number;
  deps?: Partial<RenderWorkerDeps>;
}): Promise<RenderJobOutcome> {
  const deps: RenderWorkerDeps = { ...defaultRenderWorkerDeps(), ...params.deps };
  const job = await getRenderJobById(params.jobId);
  if (!job) {
    return { ok: false, code: RENDER_ERROR.VIDEO_NOT_FOUND, message: `render job ${params.jobId} not found` };
  }

  const phase = async (p: RenderPhase) => {
    await updateRenderJobProgress(job.id, p, progressForPhase(p));
  };

  const fail = async (code: RenderErrorCode, message: string): Promise<RenderJobOutcome> => {
    await finishRenderJob({ id: job.id, status: "failed", errorCode: code, errorMessage: message });
    console.error(formatRenderJob({ ...job, status: "failed", errorCode: code }), `— ${message}`);
    return { ok: false, code, message };
  };

  const workDir = fs.mkdtempSync(path.join(deps.workRoot(), `render-${job.id}-`));
  try {
    /* 1. the document */
    const loaded = await loadTimelineForJob(job);
    if (!loaded.ok) return await fail(loaded.code, loaded.message);
    const timeline = loaded.timeline;

    /* 2. validate before spending ten minutes — the whole reason the validator sits here */
    const validation = validateTimeline(timeline);
    const blocking = validation.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
    if (blocking.length > 0) {
      return await fail(
        RENDER_ERROR.TIMELINE_INVALID,
        `${blocking.length} blocking issue(s): ` + blocking.slice(0, 5).map(formatTimelineIssue).join("; ")
      );
    }

    /* 3. §28 — every clip's ORIGINAL source, from its identity */
    await phase("rehydrating");
    /**
     * RONDE 148 §16 — the FULL dependency set, not just a downloader.
     *
     * This call used to pass `{ download }` alone, which meant that in production the rehydrator
     * could reach exactly one of its five routes: the curated archive it holds itself, the media
     * cache that already exists, the Pexels/Pixabay lookups and the YouTube layer were all
     * unreachable because the object literal did not have those keys. Every one of them was built
     * and tested in RONDE 147 and none of them had ever run outside a test.
     */
    /**
     * Built once and shared: the picture's rehydration and the audio fetch below resolve provider
     * identities through the SAME resolver, so a Freesound id means the same thing to both.
     */
    const audioDeps = productionRehydrateDeps({ download: deps.download });
    const rehydration = await deps.rehydrate({
      timeline,
      workDir: path.join(workDir, "assets"),
      deps: audioDeps,
      failFast: true,
    });
    for (const line of formatRehydrationSummary(rehydration)) console.log(line);
    if (!rehydration.ok) {
      const first = rehydration.failures[0]!;
      return await fail(
        RENDER_ERROR.ASSET_NOT_REHYDRATABLE,
        `clip ${first.clipId}: ${first.result.errorCode} — ${first.result.errorMessage}`
      );
    }

    /* 4. audio, when the timeline has any */
    await phase("validating");
    const audioDir = path.join(workDir, "audio");
    fs.mkdirSync(audioDir, { recursive: true });
    const audioClips = [
      ...audioTrackOf(timeline, "VOICE"),
      ...audioTrackOf(timeline, "MUSIC"),
      // RONDE 148 §23 — room tone and atmosphere are their own track now.
      ...audioTrackOf(timeline, "AMBIENT"),
      ...audioTrackOf(timeline, "SFX"),
    ];
    const audioByClip = new Map<string, string>();
    for (const clip of audioClips) {
      /**
       * ENABLE CINEMATIC PRODUCTION + SFX — audio addressed by IDENTITY is fetched too.
       *
       * This loop used to require a URL and `continue` without one. Every SFX and AMBIENT clip is
       * addressed the way video assets are — `provider` + `providerAssetId`, e.g.
       * `freesound:398913` — and carries no URL at all, so both tracks were skipped here in
       * silence: not even the warning below fired, because that only runs when a download of an
       * existing URL fails.
       *
       * The resolver is `providerResolver`, the SAME one the picture's rehydration already uses,
       * reached through the same production deps. Its `freesound` branch has existed since R166 and
       * had no caller on this path. No second fetcher, no second cache, no second key.
       */
      let url = clip.source.canonicalUrl || clip.source.mediaUrl || "";
      if (!url && clip.source.provider && clip.source.providerAssetId) {
        const resolved = await audioDeps.providerResolver?.(clip.source).catch(() => null);
        if (resolved?.ok) url = resolved.url;
        else {
          console.warn(
            `[Audio] job=${job.id} clip=${clip.id} status=UNRESOLVED ` +
              `provider=${clip.source.provider} asset=${clip.source.providerAssetId} ` +
              `reason=${resolved && !resolved.ok ? resolved.code : "no_resolver"}`
          );
          continue;
        }
      }
      if (!url) {
        console.warn(`[Audio] job=${job.id} clip=${clip.id} status=NO_SOURCE`);
        continue;
      }
      const dest = path.join(audioDir, `${clip.id}.mp3`);
      /**
       * A missing audio file is NOT a failed render.
       *
       * The picture is the render; a music bed that could not be fetched is a lesser video, not a
       * lost one, and refusing to produce anything would be the worse trade. The renderer reports
       * which audio it actually used, so the loss is visible rather than silent.
       */
      if (await deps.download(url, dest).catch(() => false)) audioByClip.set(clip.id, dest);
      else console.warn(`[RenderJob] job=${job.id} audio clip ${clip.id} could not be fetched`);
    }
    /**
     * §9 — one line per audio track saying what actually reached the mix.
     *
     * Counted from `audioByClip`, which is the set of files ffmpeg is about to be handed, so this
     * cannot claim a sound the render did not fetch.
     */
    for (const kind of ["VOICE", "MUSIC", "AMBIENT", "SFX"] as const) {
      const clips = audioTrackOf(timeline, kind);
      if (clips.length === 0) continue;
      const fetched = clips.filter((c) => audioByClip.has(c.id));
      console.log(
        `[Audio] job=${job.id} track=${kind} planned=${clips.length} fetched=${fetched.length}` +
          (kind === "SFX"
            ? ` sounds=${fetched.map((c) => c.source.providerAssetId ?? "?").join(",") || "none"}`
            : "")
      );
    }

    /* 5. ffmpeg, with the Remotion graphics layer laid over it when there is one */
    await phase("rendering");
    const outputPath = path.join(workDir, "out.mp4");
    const renderDir = path.join(workDir, "render");
    const overlay = deps.graphicsOverlay({ workDir: renderDir });
    const rendered = await deps.render({
      timeline,
      workDir: renderDir,
      outputPath,
      resolveMedia: async (clip) => rehydration.byClipId.get(clip.id) ?? null,
      resolveAudio: async (id) => audioByClip.get(id) ?? null,
      graphicsOverlay: overlay
        ? async (t) => {
            /**
             * The phase moves HERE, at the moment ffmpeg actually asks for the overlay — not
             * before the render, when we would only be predicting that it will.
             */
            await phase("compositing");
            return overlay(t);
          }
        : undefined,
    });
    console.log(
      `[RenderJob] job=${job.id} graphics drawn by ${rendered.graphicsRenderer}` +
        (rendered.graphicsRenderer === "ffmpeg_ass" && overlay
          ? " (the overlay route was available but did not produce a file — see skipped)"
          : "")
    );

    /* 6. the ffprobe gate — measured, never assumed */
    const check = await deps.check({
      filePath: outputPath,
      timeline,
      expectAudio: audioByClip.size > 0,
    });
    if (!check.ok) {
      return await fail(
        RENDER_ERROR.RENDER_FAILED,
        `the rendered file failed its quality check: ${check.problems.join("; ")}`
      );
    }

    /* 7. upload to a key that belongs to this job alone */
    await phase("uploading");
    const key = renderOutputKey(job.videoId, job.id);
    let outputUrl: string;
    try {
      const put = await deps.upload(key, outputPath, "video/mp4");
      outputUrl = put.url;
    } catch (err) {
      return await fail(RENDER_ERROR.OUTPUT_UPLOAD_FAILED, (err as Error).message);
    }

    /* 8. §2 — may this become the current edit? */
    const currentAttempt = await getVideoRenderAttempt(job.videoId);
    const verdict = mayPublishRender({
      jobAttempt: job.attempt,
      videoRenderAttempt: currentAttempt ?? job.attempt,
    });

    let published = false;
    if (verdict.publish) {
      const result = await publishEditedVideo({
        videoId: job.videoId,
        attempt: job.attempt,
        editedVideoUrl: outputUrl,
        timelineVersion: job.timelineVersion,
      });
      published = result.published;
    }

    /**
     * A superseded render is `completed`, not `failed`.
     *
     * It did everything right and produced a real file; it simply arrived after a newer one. The
     * row keeps its output URL so the video is recoverable, and errorCode says why it is not the
     * current edit — a "failed" here would send someone hunting for a bug that is not there.
     */
    await finishRenderJob({
      id: job.id,
      status: "completed",
      outputUrl,
      progressStep: "completed",
      progress: 100,
      errorCode: published ? null : RENDER_ERROR.RENDER_SUPERSEDED,
      errorMessage: published ? null : (verdict.publish ? "a newer render published first" : verdict.reason),
    });
    console.log(
      formatRenderJob({ ...job, status: "completed", outputUrl, progressStep: "completed" }) +
        ` renderer=timelineRenderer published=${published} clips=${rendered.clipsRendered} ` +
        `duration=${check.durationSec?.toFixed(2) ?? "null"}s`
    );
    return { ok: true, outputUrl, published, durationSec: check.durationSec };
  } catch (err) {
    return await fail(RENDER_ERROR.RENDER_FAILED, (err as Error).message ?? String(err));
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* a leftover work dir is not worth failing a finished render over */
    }
  }
}

/* ═══════════════════════ the poll loop ═══════════════════════ */

let tickInFlight = false;
let pollTimer: NodeJS.Timeout | null = null;

/** How many renders this process runs at once. One by default: ffmpeg is not a light guest. */
export function maxConcurrentRenderJobs(): number {
  const raw = parseInt(process.env.MAX_CONCURRENT_RENDER_JOBS ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

let activeRenderJobs = 0;

export async function processRenderJobTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    while (activeRenderJobs < maxConcurrentRenderJobs()) {
      const queued = await listQueuedRenderJobs(5);
      if (queued.length === 0) break;

      const claimed = await claimQueuedRenderJob(queued[0]!.id);
      // Lost the race to another worker — try the next one rather than stopping.
      if (!claimed) continue;

      activeRenderJobs++;
      console.log(formatRenderJob(claimed));
      void runRenderJob({ jobId: claimed.id })
        .catch((err) => console.error(`[RenderJob] job ${claimed.id} threw:`, err))
        .finally(() => {
          activeRenderJobs--;
          void processRenderJobTick();
        });
    }
  } catch (err) {
    console.warn("[RenderJob] tick error (DB may be unavailable):", (err as Error).message);
  } finally {
    tickInFlight = false;
  }
}

export function startRenderJobWorker(): void {
  if (pollTimer) return;
  const intervalMs = parseInt(process.env.RENDER_JOB_POLL_MS ?? "5000", 10);
  console.log(
    `[RenderJob] worker started — ${maxConcurrentRenderJobs()}/process, poll every ${intervalMs}ms`
  );
  void processRenderJobTick();
  pollTimer = setInterval(() => void processRenderJobTick(), intervalMs);
}

export function stopRenderJobWorker(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
