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
  mergeVideoMetadata,
  publishEditedVideo,
  readVideoMetadataObject,
  updateRenderJobProgress,
} from "./db";
import {
  LINEAGE_SNAPSHOT_METADATA_KEY,
  recordDeliveredLineage,
  type LineageStore,
} from "./visualLineageSnapshot";
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
import { deliveredCutCheckEnabled, formatCutCheck, scanDeliveredCuts } from "./deliveredCutCheck";
import {
  classifyFfmpegFailure,
  formatFfmpegFailure,
  SAFE_RENDER_ANSWERS,
} from "./ffmpegFailureClass";
import { safeRenderTimeline, formatSafeRender } from "./timelineRepair";
import { formatOverlayInk } from "./graphicsOverlayInk";
import { graphicsOverlayAvailable, productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { storagePutFromFile } from "./storage";
import { checkFileAvSync, formatAvSync, type AvSyncResult } from "./avSyncCheck";
import {
  TARGET_LUFS,
  formatLoudness,
  loudnessNeedsAttention,
  normaliseDeliveredLoudness,
  type LoudnessResult,
} from "./audioLoudness";
import {
  postRenderSpotCheckEnabled,
  spotCheckFinalVideo,
  type PostRenderSpotCheckResult,
} from "./postRenderSpotCheck";
import { resolveLocalStorageFilePath } from "./storageLocal";
import { resolveArchiveObjectFetchUrl } from "./archiveAssetLoad";
import { downloadToFileStreaming, isPipelineFallbackClip } from "./videoPipeline";
import {
  deliveryGate,
  formatDeliveryBlock,
  TIMELINE_ARCHIVE_REFERENCE,
} from "./deliveryGate";
import type { ProjectTimeline } from "./projectTimeline";
import { audioTrackOf, videoTrack } from "./projectTimeline";

/* ═══════════════════════ the outcome of one job ═══════════════════════ */

export type RenderJobOutcome =
  | {
      ok: true;
      outputUrl: string;
      published: boolean;
      durationSec: number | null;
      /**
       * The content check on the DELIVERED file, or null when it was switched off or threw.
       *
       * Returned rather than only logged so the caller can put it in the quality report — the
       * report used to describe the compose montage, which after the cutover is not the file
       * anybody receives.
       */
      spotCheck: PostRenderSpotCheckResult | null;
      /**
       * Whether the picture and the sound start and stop together, measured on the delivered file.
       * Null only when the probe itself threw. See `avSyncCheck.ts`.
       */
      avSync: AvSyncResult | null;
      /**
       * The clips the join actually consumed — this file's own input list.
       *
       * The pipeline proves FINAL_VIDEO from the input list of the concat that produced the
       * validated output. On the compose route that is `finalConcatInputs`; on this route it is
       * this. Without it the pipeline had to prove the delivered file's contents from the montage
       * it discarded, which reported a clip this renderer could not recover as being in the video.
       */
      renderedClipIds: string[];
    }
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
  /**
   * RONDE 122 §2 — the persisted lineage of the render this job is finishing.
   *
   * A dependency for the same reason every other one here is: the job's delivery accounting is a
   * pure join between a snapshot and a clip list, and a test must be able to drive it without a
   * database. `read` returns whatever the metadata bag holds — parsing and judging it is
   * `parseLineageSnapshot`'s job, so a missing or unreadable snapshot arrives here as data.
   */
  lineage: LineageStore;
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
       * RONDE 648 — the narration is an object KEY, not a URL.
       *
       * Render 604 (job 23, 11:00): `[Voice] narration on the timeline duration=81.11s`, then
       * `audio clip voice_c3ba5ecb50 could not be fetched`, and the film was delivered without its
       * voice. On S3 `storagePutFromFile` returns `/manus-storage/<key>`, and a relative path handed
       * to `fetch` is an invalid URL. The archive's read-back had the same defect in render 594; the
       * one resolver it got is used here too. Null means there is no signed URL to be had.
       */
      if (url.startsWith("/manus-storage/")) {
        const signed = await resolveArchiveObjectFetchUrl({ storageUrl: url, storageKey: null });
        if (!signed) return false;
        url = signed;
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
    /**
     * `videos.metadata` is where the pipeline already stores its qualityReport and its render
     * report, so the lineage snapshot lives beside them rather than in a table of its own. The
     * merge is additive — nothing else in the bag is touched by writing this key.
     */
    lineage: {
      read: async (videoId) =>
        readVideoMetadataObject(await getVideoById(videoId))[LINEAGE_SNAPSHOT_METADATA_KEY],
      write: async (videoId, snapshot) =>
        mergeVideoMetadata(videoId, { [LINEAGE_SNAPSHOT_METADATA_KEY]: snapshot }),
    },
  };
}

/* ═══════════════════════ what is actually under the voice ═══════════════════════ */

export type AudioBed = {
  /** Tracks with at least one clip the renderer could actually fetch. */
  present: string[];
  /** Tracks the plan filled and the renderer could not recover, with counts. */
  lost: string[];
  /** True when the narration plays over nothing at all for the whole film. */
  bare: boolean;
  line: string;
};

/**
 * WHAT A VIEWER WILL HEAR UNDER THE NARRATION, STATED RATHER THAN ASSUMED.
 *
 * ── The two ways a documentary ends up bare ─────────────────────────────────────────────────
 *
 * This build has no music catalogue. `cinematicAmbient` says so plainly and leaves the MUSIC track
 * empty rather than laying down the synthesised sine bed the compose route used — which is the
 * right call, because a sine drone is not music. But it means the delivered film's bed is
 * ambience and sound effects alone.
 *
 * And those can vanish silently. An AMBIENT or SFX clip is addressed by identity —
 * `freesound:401178` — and needs FREESOUND_API_KEY to resolve. Without it the clip is planned,
 * carried into the timeline, and then skipped at fetch time with one line in a `skipped` array
 * that nothing printed. A ten-minute documentary of voice over silence would render, pass every
 * check, and look correct in every report.
 *
 * ── Why this is a description and not a gate ────────────────────────────────────────────────
 *
 * A documentary scored with room tone and no music is a legitimate film. So is one deliberately
 * played dry. Refusing to deliver either would be this function making an editorial decision it
 * has no standing to make. What it will not do is let the answer be discovered from the video:
 * `bare` is stated on its own line, and the caller decides what that is worth.
 */
export function describeAudioBed(params: {
  timeline: ProjectTimeline;
  /** Clip ids the renderer actually holds a file for. */
  recovered: ReadonlySet<string>;
}): AudioBed {
  const present: string[] = [];
  const lost: string[] = [];
  for (const kind of ["MUSIC", "AMBIENT", "SFX"] as const) {
    const clips = audioTrackOf(params.timeline, kind).filter((c) => !c.disabled);
    if (clips.length === 0) continue;
    const got = clips.filter((c) => params.recovered.has(c.id)).length;
    if (got > 0) present.push(`${kind.toLowerCase()}=${got}`);
    if (got < clips.length) lost.push(`${kind.toLowerCase()}=${clips.length - got}`);
  }
  const voice = audioTrackOf(params.timeline, "VOICE").filter((c) => !c.disabled).length;
  const bare = present.length === 0;
  return {
    present,
    lost,
    bare,
    line:
      `[RenderJob] audioBed voice=${voice} ` +
      `${present.length ? present.join(" ") : "nothing under the narration"}` +
      (lost.length ? ` UNRECOVERED(${lost.join(" ")})` : ""),
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

export const RENDER_CLIP_DROPPED = "RENDER_CLIP_DROPPED";

/**
 * ROUND 596 — TAKE ONE REFUSED CLIP OUT OF THIS RENDER, LOUDLY.
 *
 * ── The rule it serves ──────────────────────────────────────────────────────────────────────
 *
 * "Een individuele video/clip die faalt, mag NOOIT de volledige productie laten falen." A clip
 * that cannot be fetched, or that the validator refuses, is removed from THIS RENDER'S INPUT and
 * the render continues on everything else. It is not accepted, not substituted and not repaired.
 *
 * ── Why `disabled` and not a splice ─────────────────────────────────────────────────────────
 *
 * `disabled` is the timeline's own word for a clip that is present in the plan and not in the
 * render: `videoTrack(...).filter(c => !c.disabled)` is how every reader in this codebase already
 * asks, and `renderTimeline` already skips a clip whose media is unavailable and records it under
 * `skipped`. Removing the element instead would rewrite the stored plan — the timeline
 * architecture §11 forbids touching — and would erase the evidence of what was lost.
 *
 * The neighbouring clips keep their own timeline positions. The film is shorter by this clip's
 * slot and is correct everywhere else; it does not shift, stretch or reflow to hide the loss.
 *
 * ── The flag lives for this render only ─────────────────────────────────────────────────────
 *
 * `runRenderJob` loads the timeline and never writes it back, so a clip removed here is removed
 * from THIS attempt and from nothing else. That is deliberate: a provider that was down for ten
 * minutes must not permanently edit a plan the person can re-render tomorrow.
 *
 * ── What is written down ────────────────────────────────────────────────────────────────────
 *
 * One line per clip, with the asset's identity and the reason verbatim. A silently shorter film is
 * exactly the "stille substitutie" this programme refuses, so the drop is never quiet.
 *
 * Returns how many clips were actually removed — a clip id the timeline does not carry removes
 * nothing, and the caller's "is there anything left" check must be able to see that.
 */
export function disableClipsForRender(
  timeline: ProjectTimeline,
  drops: ReadonlyArray<{ clipId: string; reason: string }>,
  jobId: number
): number {
  const byId = new Map(videoTrack(timeline).map((c) => [c.id, c]));
  let removed = 0;
  for (const drop of drops) {
    const clip = byId.get(drop.clipId);
    if (!clip || clip.disabled) continue;
    clip.disabled = true;
    removed++;
    console.warn(
      `[RenderJob] job=${jobId} ${RENDER_CLIP_DROPPED} clip=${drop.clipId} ` +
        `provider=${clip.source.provider} ` +
        `providerAssetId=${clip.source.providerAssetId ?? "null"} ` +
        `archiveAssetId=${clip.source.archiveAssetId ?? "null"} ` +
        `slot=${clip.timelineStart.toFixed(2)}-${clip.timelineEnd.toFixed(2)}s ` +
        `reason="${drop.reason}" — removed from this render's input; the rest of the film continues`
    );
  }
  return removed;
}

export async function runRenderJob(params: {
  jobId: number;
  deps?: Partial<RenderWorkerDeps>;
  /**
   * Clip id → a file this process ALREADY holds, for a render started by the run that produced it.
   *
   * ── Why this exists ─────────────────────────────────────────────────────────────────────────
   *
   * The pipeline downloads, probes, judges and adopts every clip, and then plans a timeline over
   * exactly those files. The render job that follows used to start from nothing and re-fetch all of
   * them — from an archive row, a provider API, a cache — even though the bytes were sitting on the
   * same disk, in the same process, seconds old.
   *
   * Render 564 is what that costs. Two clips needed the archive, one row's storage read came back
   * empty, `failFast` stopped the render, and `ASSET_NOT_REHYDRATABLE` killed a video whose every
   * frame had already been downloaded successfully. Re-fetching an asset we hold is not a safety
   * measure; it is a second chance to fail.
   *
   * This is the SAME seam as `recordClipAdopt`, the still/moving counters and the beat verdicts: a
   * fact one route establishes and the next route does not receive. The fix is the same shape —
   * carry it rather than re-derive it.
   *
   * Only a render that starts inside the producing run can pass this. The poll loop renders jobs
   * whose work directories are long gone, so it passes nothing and rehydration behaves exactly as
   * it always has. `rehydrateAsset` re-checks that each path exists and is non-empty before
   * trusting it, so a stale entry costs a fetch, never a wrong file.
   */
  existingByClipId?: Map<string, string>;
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
    /**
     * ROUND 596, ZERO-FAIL §1 — ONE BAD CLIP LEAVES THE FILM; IT DOES NOT END THE FILM.
     *
     * `missing_asset` is a fact about ONE video clip, and the whole render was refused over it.
     * Renders 594 and 595 both died here or at the rehydration step below, each time naming a
     * single clip, each time with a dozen good ones behind it that were never attempted.
     *
     * So a per-clip fault is now answered per clip: the clip is removed from this render's input
     * and everything else proceeds. Nothing is relaxed to make that true — the clip is refused
     * exactly as hard as before, and `disableClipsForRender` writes down which ones and why. What
     * changes is the blast radius.
     *
     * The job still fails when the fault is GLOBAL: a structural problem that is not about one
     * clip, or a timeline with no picture left at all. Those are handled below.
     */
    const perClipFaults = blocking.filter((i) => i.code === "missing_asset" && i.elementId);
    const globalFaults = blocking.filter((i) => !(i.code === "missing_asset" && i.elementId));
    if (globalFaults.length > 0) {
      return await fail(
        RENDER_ERROR.TIMELINE_INVALID,
        `${globalFaults.length} blocking issue(s): ` +
          globalFaults.slice(0, 5).map(formatTimelineIssue).join("; ")
      );
    }
    if (perClipFaults.length > 0) {
      const dropped = disableClipsForRender(
        timeline,
        perClipFaults.map((i) => ({ clipId: i.elementId!, reason: `${i.code}: ${i.reason}` })),
        job.id
      );
      if (videoTrack(timeline).filter((c) => !c.disabled).length === 0) {
        /**
         * Nothing is left to photograph. This is the genuine global fault the zero-fail rule keeps
         * — "geen bruikbare media/fallback meer" — and it names every clip that got it here.
         */
        return await fail(
          RENDER_ERROR.TIMELINE_INVALID,
          `every video clip was refused (${dropped} removed): ` +
            perClipFaults.slice(0, 5).map(formatTimelineIssue).join("; ")
        );
      }
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
    /**
     * ROUND 596, ZERO-FAIL §2 — `failFast` WAS THE SECOND PLACE ONE CLIP ENDED A RENDER.
     *
     * It stopped at the FIRST unrecoverable asset and reported that one, so nobody ever learned
     * what the other fourteen clips would have done, and one clip's provider outage was
     * indistinguishable from a broken render. Render 595 ended on `clip vc_999c384232` with four
     * archive-backed clips waiting behind it.
     *
     * `failFast: false` recovers everything recoverable and reports every failure. A clip that
     * could not be recovered is then removed from this render's input — `renderTimeline` already
     * skips a clip whose `resolveMedia` answers null and says so in `skipped`, so the film is
     * shorter by that shot and complete everywhere else. No gate is softened: the clip is refused
     * for exactly the reason it was refused before.
     */
    const rehydration = await deps.rehydrate({
      timeline,
      workDir: path.join(workDir, "assets"),
      deps: audioDeps,
      failFast: false,
      existingByClipId: params.existingByClipId,
    });
    for (const line of formatRehydrationSummary(rehydration)) console.log(line);
    if (rehydration.failures.length > 0) {
      disableClipsForRender(
        timeline,
        rehydration.failures.map((f) => ({
          clipId: f.clipId,
          reason: `${f.result.errorCode} — ${f.result.errorMessage}`,
        })),
        job.id
      );
    }
    /**
     * The one genuine global fault on this step: not a single clip came back. That is a storage or
     * a network outage rather than a bad clip, and there is no film to make without a picture.
     */
    if (rehydration.byClipId.size === 0) {
      const first = rehydration.failures[0];
      return await fail(
        RENDER_ERROR.ASSET_NOT_REHYDRATABLE,
        `no clip could be recovered (${rehydration.failures.length} failed)` +
          (first ? `; first: clip ${first.clipId}: ${first.result.errorCode} — ${first.result.errorMessage}` : "")
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

    /** RONDE 630 — what the safe pass gave up, printed beside the renderer's own `skipped` list. */
    const skippedFromSafeRender: string[] = [];

    /* 5. ffmpeg, with the Remotion graphics layer laid over it when there is one */
    await phase("rendering");
    const outputPath = path.join(workDir, "out.mp4");
    const renderDir = path.join(workDir, "render");
    const overlay = deps.graphicsOverlay({ workDir: renderDir });
    const renderWith = (t: typeof timeline) =>
      deps.render({
        timeline: t,
        workDir: renderDir,
        outputPath,
        resolveMedia: async (clip) => rehydration.byClipId.get(clip.id) ?? null,
        resolveAudio: async (id) => audioByClip.get(id) ?? null,
        graphicsOverlay: overlay
          ? async (tl) => {
              /**
               * The phase moves HERE, at the moment ffmpeg actually asks for the overlay — not
               * before the render, when we would only be predicting that it will.
               */
              await phase("compositing");
              return overlay(tl);
            }
          : undefined,
      });

    /**
     * RONDE 630 — SAFE_RENDER, which is where a technical failure stops costing the film.
     *
     * Render 599 reached this line with eleven segments of validated real media and produced
     * nothing, because the graph that joins them refused. RONDE 628 gave that join a ladder to climb
     * down; this is the rung below it, for when the flourishes themselves are implicated — an effect
     * chain, a camera move, a transition mode this footage will not take.
     *
     * The second attempt renders the SAME timeline with those three removed and everything else
     * untouched: every clip, its source, its in and out points, its position, and the whole audio,
     * caption, text and graphics content. Same story, same narration, same footage, same length.
     *
     * Two conditions, and both matter:
     *
     *   · `safeRenderWouldChangeAnything` — a timeline that is already plain gets no second attempt,
     *     because re-running an identical render to hear the same refusal is the blind retry this
     *     round is explicitly not;
     *   · the failure is CLASSIFIED first, and a class that a simpler treatment cannot answer is
     *     re-thrown immediately. A missing input file, an exhausted disk or an undecodable asset is
     *     not made renderable by dropping a zoompan, and attempting it would spend a second full
     *     render to fail the same way.
     *
     * If the safe attempt also fails, the FIRST error is thrown. That one names the original fault;
     * the second names whatever the simplified graph tripped over on the way past it.
     */
    let rendered: Awaited<ReturnType<typeof renderTimeline>>;
    try {
      rendered = await renderWith(timeline);
    } catch (renderErr) {
      const diagnosis = classifyFfmpegFailure(renderErr);
      const safe = safeRenderTimeline(timeline);
      const treatable = SAFE_RENDER_ANSWERS.has(diagnosis.cls);
      console.error(
        formatFfmpegFailure("render", diagnosis) +
          ` safeRenderApplicable=${treatable && safe.changes.length > 0}`
      );
      if (!treatable || safe.changes.length === 0) throw renderErr;
      for (const line of formatSafeRender(safe)) console.warn(line);
      await phase("rendering");
      try {
        rendered = await renderWith(safe.timeline);
      } catch {
        throw renderErr;
      }
      console.warn(
        `[SafeRender] SAFE_RENDER_SUCCEEDED job=${job.id} — the film was rendered without its ` +
          `effects, camera moves and transitions after ${diagnosis.cls}; the pictures and the ` +
          `audio are the ones the plan chose`
      );
      skippedFromSafeRender.push(
        `safe_render: the planned treatment would not render (${diagnosis.cls}), so the film was ` +
          `cut plainly — same clips, same sources, same length, no effects or transitions`
      );
    }
    console.log(
      `[RenderJob] job=${job.id} graphics drawn by ${rendered.graphicsRenderer}` +
        (rendered.graphicsRenderer === "ffmpeg_ass" && overlay
          ? " (the overlay route was available but did not produce a file — see skipped)"
          : "")
    );
    /**
     * RONDE 112 — the one graphics number that is an OBSERVATION rather than a prediction.
     *
     * `planned` and `rendered` both come from asking the vocabulary what it can draw. This line
     * comes from reading the alpha channel of the file that was composited. It is printed only on
     * the route that composites one, because on the libass route there is no overlay to read and a
     * line saying so would be noise pretending to be a measurement.
     */
    if (rendered.graphicsOverlayInk) {
      console.log(
        `[RenderJob] job=${job.id} ${formatOverlayInk(rendered.graphicsOverlayInk)}`
      );
    }
    /**
     * THE TWO STAGES `graphicsLifecycle` DECLARED AND NOTHING COULD EVER WRITE.
     *
     * That module joins the plan to the renderer over four stages — PLANNED, TRANSLATED,
     * RENDER_INPUT, DRAWN — and takes `inputIds`/`drawnIds` to reach the last two. It never got
     * them: `renderGraphicsOverlay` returned `graphicsDrawn: number`, `GraphicsOverlayFile` kept
     * only a path and a skip list, and `RenderedTimeline` carried neither. So every render stopped
     * at TRANSLATED and published
     *
     *     [Graphics] lifecycle planned=6 translated=5 renderInput=0 drawn=0
     *
     * which reads as a renderer that refused five graphics and was in fact a question nobody put to
     * it. The plan-time line above is printed before any render exists and is right to say nothing;
     * this is the other half, printed where the answer finally exists.
     *
     * Counts and the ids, because the ids are what the plan can be joined against. Still the
     * renderer's own predicate rather than a frame inspection — `[OverlayInk]` above is the only
     * line here that read pixels, and it answers for the whole overlay.
     */
    if (rendered.graphicRenderIds) {
      const { input, drawn } = rendered.graphicRenderIds;
      const notDrawn = input.filter((id) => !drawn.includes(id));
      console.log(
        `[Graphics] job=${job.id} renderInput=${input.length} drawn=${drawn.length}` +
          (notDrawn.length > 0
            ? ` receivedNotDrawn=${notDrawn.length} e.g. ${notDrawn.slice(0, 3).join(",")}`
            : "")
      );
    }
    /**
     * WHAT THIS RENDER ACTUALLY EXECUTED — one line, everything the renderer measured.
     *
     * ── Why this was missing ────────────────────────────────────────────────────────────────
     *
     * `RenderedTimeline` carries `captionsDrawn`, `textsDrawn`, `transitionsRendered`,
     * `camerasExecuted` and `duckedTracks`. Every one of them is a real count taken while ffmpeg
     * ran, and the job printed none of them. So the questions "did the cinematic editing actually
     * happen", "were there transitions or just cuts", "was anything ducked", "did the captions get
     * drawn" could each only be answered by inferring from what was ABSENT from the log — which is
     * exactly the guesswork this codebase keeps removing.
     *
     * A film that planned twelve crossfades and executed zero now says so on the line that says it
     * finished.
     *
     * ── What this line does NOT prove ───────────────────────────────────────────────────────
     *
     * That the pixels are in the file. These are counts of what the renderer was given and drew,
     * not an inspection of the output. Proving a caption is legible in a delivered MP4
     * needs OCR over sampled frames, and claiming it without that would be the fabricated
     * validation this codebase has spent rounds removing. The A/V check below measures the
     * container; nothing here or anywhere else reads the picture back for text.
     */
    console.log(
      `[RenderJob] job=${job.id} executed clips=${rendered.clipsRendered} ` +
        `cameras=${rendered.camerasExecuted}/${rendered.camerasPlanned} ` +
        `transitions=${rendered.transitionsRendered} ` +
        `captions=${rendered.captionsDrawn} texts=${rendered.textsDrawn} ` +
        `audioTracks=${rendered.audioTracks} ducked=${rendered.duckedTracks} ` +
        `ffmpegCommands=${rendered.ffmpegCommands}`
    );
    /**
     * The editorial silences, each stated once.
     *
     * A montage of pure hard cuts and a montage whose crossfades all failed are the same file and
     * a different problem. Same for a film with no camera movement, and for an audio mix where
     * nothing ducked under the narrator.
     */
    if (rendered.clipsRendered > 1 && rendered.transitionsRendered === 0) {
      console.warn(
        `[RenderJob] job=${job.id} NO_TRANSITIONS — ${rendered.clipsRendered} shots joined by ` +
          "hard cuts alone. Either the plan asked for none, or none of them could be executed."
      );
    }
    /**
     * A film with no camera movement, and WHICH of the two reasons it is.
     *
     * The plan asked for stillness, or it asked for movement the renderer could not produce. Those
     * are an editorial outcome and a defect respectively, and a count of zero reads the same for
     * both — the earlier version of this warning sent a reader to the renderer when the answer is
     * almost always in the plan. A feature-length run measured 159 shots, 159 holds and zero moves:
     * 124 of them planned as `medium`, whose camera rule holds unless the pacing is "exciting", and
     * 35 as archive video, held by an explicit rule. Nothing had failed.
     */
    if (rendered.clipsRendered > 0 && rendered.camerasExecuted === 0) {
      console.warn(
        `[RenderJob] job=${job.id} NO_CAMERA_MOVEMENT — every shot is static. ` +
          (rendered.camerasPlanned === 0
            ? "The PLAN asked for no movement at all: every shot is a deliberate hold. That is a " +
              "legitimate documentary answer and it is also what a film of nothing but medium " +
              "shots produces, so it is worth knowing which one this is."
            : `The plan asked for ${rendered.camerasPlanned} move(s) and NONE was executed — ` +
              "that is a renderer failure, not an editorial choice.")
      );
    }
    if (rendered.audioTracks > 1 && rendered.duckedTracks === 0) {
      console.warn(
        `[RenderJob] job=${job.id} NOTHING_DUCKED — ${rendered.audioTracks} audio tracks and no ` +
          "sidechain compression. The narrator is competing with the bed rather than sitting over it."
      );
    }
    /**
     * Everything the renderer could not carry, said out loud.
     *
     * `rendered.skipped` has always been populated — an audio clip with no source, an effect this
     * renderer cannot execute, an overlay that did not appear — and nothing printed it. A render
     * that silently dropped its whole ambience track looked identical to one that never planned any.
     */
    for (const s of [...skippedFromSafeRender, ...(rendered.skipped ?? [])]) {
      console.warn(`[RenderJob] job=${job.id} not carried: ${s}`);
    }
    const bed = describeAudioBed({ timeline, recovered: new Set(audioByClip.keys()) });
    console.log(bed.line);
    if (bed.bare) {
      console.warn(
        `[RenderJob] job=${job.id} AUDIO_BED_EMPTY — the narration plays over silence for the ` +
          "whole film. This build has no music catalogue, and no ambience or SFX was recovered " +
          "(FREESOUND_API_KEY resolves those)."
      );
    }

    /* 6a. the ffprobe gate — measured, never assumed */
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

    /**
     * 6b. DO THE TWO STREAMS LINE UP?
     *
     * `checkRenderedFile` above asks about each stream on its own — is there video, is there
     * audio, is the container the right shape. It cannot see a film whose narration runs four
     * seconds past its picture, or one that opens on silence, or one whose voice was cut
     * mid-word by a mux bounded by the wrong stream. That last one is not hypothetical: it is
     * exactly what a dropped beat used to do here.
     *
     * Cheap enough to run unconditionally — two ffprobe reads and one silencedetect pass — and it
     * is the check whose absence a viewer notices first.
     */
    /**
     * RONDE 222 — IS IT LOUD ENOUGH TO HEAR?
     *
     * The sibling of 6b, and the same argument: the envelope check knows whether the sound lines up
     * with the picture and has never known how loud it is. Render 574 delivered -41.2 LUFS against
     * a -14 LUFS target.
     *
     * Before 6b deliberately, so the envelope is measured on the file that ships. The pass swaps
     * the file only when the correction measures closer to target, and it never fails the job: an
     * unlevelled film is still a film, and the reason goes on the line.
     */
    const loudness = await normaliseDeliveredLoudness(outputPath).catch(
      (err): LoudnessResult => ({
        outcome: "failed",
        beforeLufs: null,
        afterLufs: null,
        targetLufs: TARGET_LUFS,
        reason: `the loudness pass threw: ${(err as Error)?.message?.slice(0, 140)}`,
      })
    );
    {
      const line = formatLoudness(loudness);
      if (loudnessNeedsAttention(loudness)) console.warn(`[RenderJob] job=${job.id} ${line}`);
      else console.log(line);
    }

    const avSync = await checkFileAvSync(outputPath).catch(() => null);
    if (avSync) {
      for (const line of formatAvSync(avSync)) {
        if (avSync.ok) console.log(line);
        else console.warn(`[RenderJob] job=${job.id} ${line}`);
      }
    }

    /**
     * 6c. THE CONTENT CHECK — on the file that will actually be delivered.
     *
     * ── Why this had to move ────────────────────────────────────────────────────────────────
     *
     * `checkRenderedFile` above is a container check: does the file exist, does it carry the
     * streams, is it the right size and shape, is it as long as the plan says. It cannot tell a
     * finished documentary from six minutes of black.
     *
     * The check that CAN — `blackdetect`, `freezedetect`, `silencedetect` over a full linear decode
     * — has existed for a long time and ran on `finalVideoPath`, the compose montage. When delivery
     * moved to this route, the montage stopped being the deliverable and every content check stayed
     * pointed at it. The delivered file's only inspection was ffprobe.
     *
     * ── Why it reports and does not block ───────────────────────────────────────────────────
     *
     * The same policy the compose path has always had. A spot check is a description, and its
     * warnings are frequently about material that is legitimately dark or legitimately quiet — a
     * night-time archive shot, a held beat before a chapter card. Failing a finished render on one
     * would throw away a good video over a heuristic. It is recorded, logged and returned, and the
     * caller decides.
     *
     * It runs before the work directory is swept, because after that the file is gone.
     */
    let spotCheck: PostRenderSpotCheckResult | null = null;
    if (postRenderSpotCheckEnabled()) {
      spotCheck = await spotCheckFinalVideo(outputPath).catch(() => null);
      if (spotCheck) {
        console.log(
          `[RenderJob] video=${job.videoId} job=${job.id} contentCheck ok=${spotCheck.ok} ` +
            `black=${spotCheck.blackSegments} freeze=${spotCheck.freezeSegments} ` +
            `silent=${spotCheck.silentSegments} frames=${spotCheck.framesChecked}`
        );
        for (const w of spotCheck.warnings) {
          console.warn(`[RenderJob] video=${job.videoId} job=${job.id} contentCheck: ${w}`);
        }
      }
    }

    /**
     * RONDE 654 — every change of picture in the delivered file should be one of the edit's own
     * cuts. Measured here, on the file itself, before the work directory is swept; logged, never
     * blocking. See `deliveredCutCheck.ts`.
     */
    if (deliveredCutCheckEnabled()) {
      const cuts = await scanDeliveredCuts(outputPath, timeline);
      if (cuts) {
        const line = formatCutCheck({ videoId: job.videoId, jobId: job.id, changes: cuts.changes.length, unexpected: cuts.unexpected });
        if (cuts.unexpected.length) console.warn(line);
        else console.log(line);
      } else {
        console.warn(`[CutCheck] video=${job.videoId} job=${job.id} could not scan the delivered file`);
      }
    }

    /**
     * 6d. THE DELIVERY GATE — the last thing asked before this file becomes a video.
     *
     * ── Why here, before the upload ─────────────────────────────────────────────────────────
     *
     * A file that may not be published should not be uploaded either. Blocking after the upload
     * would leave an object in storage that nothing points at and that the next run would have to
     * reason about.
     *
     * ── What it adds over the checks above, and what it does not repeat ─────────────────────
     *
     * `checkRenderedFile` is the container check and stays the authority on the file: exists,
     * streams, size, duration against the TIMELINE. `spotCheckFinalVideo` describes the content and
     * deliberately does not block. Neither has ever been able to answer the question this gate
     * asks — can every picture in this film be produced again from FastVid's own archive, or does
     * the render depend on a provider still being reachable? That question is about the TIMELINE
     * and its assets, not about the bytes, and nothing was asking it.
     *
     * The facts are the ones already measured. Nothing is probed twice: `check` supplies the file,
     * `rehydration` supplies what each clip resolved to and where from, and the voiceover length
     * comes from the VOICE track the renderer just used. §12's "no second QC framework" is why
     * this reads those three rather than opening ffprobe again.
     */
    const voiceEnd = audioTrackOf(timeline, "VOICE").reduce(
      (max, c) => Math.max(max, c.end ?? 0),
      0
    );
    const gate = deliveryGate({
      videoId: job.videoId,
      /** This worker renders the authoritative timeline; there is no other route through here. */
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: videoTrack(timeline)
        .filter((c) => !c.disabled)
        .map((clip) => {
          const local = rehydration.byClipId.get(clip.id) ?? null;
          const result = rehydration.results.find((r) => r.clipId === clip.id)?.result;
          /**
           * "It came from our own storage" is read from the route that PRODUCED the bytes, never
           * from the identity — the identity says what the rehydrator intended to do, and the
           * provenance says what it did.
           */
          const fromArchive =
            result?.status === "ok" && result.provenance.includes("archive");
          return {
            clipId: clip.id,
            archiveAssetId: clip.source.archiveAssetId ?? null,
            provider: clip.source.provider,
            providerAssetId: clip.source.providerAssetId ?? null,
            resolved: Boolean(local),
            fromArchive,
            /** One authority for "this depicts nothing" — the pipeline's own predicate. */
            isPlaceholder: local ? isPipelineFallbackClip(local) : false,
          };
        }),
      delivered: {
        exists: check.fileExists,
        readable: check.fileExists && check.sizeBytes > 0,
        durationSec: check.durationSec,
        hasVideoStream: check.hasVideo,
        hasAudioStream: check.hasAudio,
        sizeBytes: check.sizeBytes,
      },
      /** Null when this film has no narration — then there is nothing to align to. */
      voiceoverSec: voiceEnd > 0 ? voiceEnd : null,
    });
    for (const line of gate.lines) {
      if (gate.allow) console.log(line);
      else console.error(`[RenderJob] job=${job.id} ${line}`);
    }
    /**
     * §22 — one line per clip naming the archive asset the render actually used, so a production
     * log can be read for the chain rather than inferred from its absence. Only on the pass path:
     * a blocked delivery has already printed a line per failing clip and does not need both.
     */
    if (gate.allow) {
      for (const clip of videoTrack(timeline).filter((c) => !c.disabled)) {
        console.log(
          `[RenderJob] ${TIMELINE_ARCHIVE_REFERENCE} video=${job.videoId} clip=${clip.id} ` +
            `archiveAssetId=${clip.source.archiveAssetId ?? "none"} ` +
            `provider=${clip.source.provider} ` +
            `providerAssetId=${clip.source.providerAssetId ?? "none"}`
        );
      }
    } else {
      return await fail(RENDER_ERROR.RENDER_FAILED, formatDeliveryBlock(gate, job.videoId));
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

    /**
     * RONDE 122 §2 — the delivery, written where every failure path has already returned.
     *
     * The upload has a URL, the publish verdict is in and the job row says completed. Nothing
     * below this point can turn the render back into a failure, and nothing above it can reach
     * here without having succeeded — which is what makes DELIVERED a fact rather than an
     * intention.
     */
    await recordDeliveredLineage({
      store: deps.lineage,
      job,
      clips: videoTrack(timeline),
      renderedClipIds: rendered.renderedClipIds,
      published,
    });

    return {
      ok: true,
      outputUrl,
      published,
      durationSec: check.durationSec,
      spotCheck,
      avSync,
      renderedClipIds: rendered.renderedClipIds,
    };
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

/**
 * RONDE 640 — how many renders this process is running, for the YouTube prefetch.
 *
 * The prefetch downloads through the same layer a render's rehydration does, and it must never
 * compete with one. It asks this, and the generation queue's own count, before every segment.
 */
export function activeRenderJobCount(): number {
  return activeRenderJobs;
}

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
