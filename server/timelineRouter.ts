/**
 * RONDE 148 §5/§6/§7/§21/§22 — the editor's API.
 *
 * ── Its own module, on purpose ────────────────────────────────────────────────────────────────
 *
 * `routers.ts` is 2578 lines. Adding four more procedures to it would make the editor's rules
 * findable only by scrolling, and these four have a shared contract worth reading in one piece:
 * GET never writes, SAVE never overwrites, RENDER never renders, and all four ask the SAME
 * ownership question the rest of the video routes ask.
 *
 * ── §21: the authorisation is not new ─────────────────────────────────────────────────────────
 *
 * `requireVideoAccess` is imported from routers.ts rather than reimplemented. A second ownership
 * check is a second thing to get wrong, and the failure mode is that one of them is looser. Every
 * procedure here takes a videoId and resolves it server-side; nothing trusts a client's claim
 * about what it may touch.
 *
 * ── The three rules that shape the routes ────────────────────────────────────────────────────
 *
 *   GET is read-only.      §5. It will BUILD a timeline from the manifest for a video that has
 *                          never been edited, and it will not save that — a person opening a video
 *                          to look at it must not thereby create a version 1 they never asked for.
 *   SAVE validates first.  §6. An invalid timeline is never stored, and the validator is never
 *                          allowed to repair one on the way in.
 *   RENDER returns fast.   §7. It writes a row and returns. Ten minutes of ffmpeg inside an HTTP
 *                          request is a request that times out while the work carries on unseen.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { protectedProcedure, router } from "./_core/trpc";
import {
  claimRenderAttempt,
  createRenderJob,
  getRenderJobById,
  getStoredTimeline,
  getVideoById,
  getVideoScenes,
  listActiveRenderJobsForVideo,
  listRenderJobsForVideo,
  saveVideoTimeline,
} from "./db";
import { requireVideoAccess } from "./videoAccess";
import { timelineFromEditorScenes, timelineRecoverySummary } from "./timelineFromManifest";
import {
  editTimelineText,
  nextTimelineToStore,
  parseStoredTimeline,
  replaceTimelineClipSource,
  storedTimelineIsReadable,
} from "./timelineStore";
import {
  RENDER_ERROR,
  formatRenderJob,
  mayCreateRenderJob,
  type RenderJobStatus,
} from "./renderJobs";
import {
  NON_BLOCKING_ISSUES,
  formatTimelineIssue,
  validateTimeline,
  type TimelineIssue,
} from "./timelineValidator";
import { TIMELINE_SCHEMA_VERSION, type ProjectTimeline } from "./projectTimeline";

/* ═══════════════════════ §22 — errors a caller can act on ═══════════════════════ */

/**
 * A refusal carries a CODE, and the message says what to do about it.
 *
 * §18: "Geen generieke Something went wrong." The client switches on `code` to decide whether to
 * offer a reload (conflict), a list of faults (invalid) or a wait (already running), and shows
 * `message` verbatim — so the message has to be worth showing.
 */
function editorError(
  code: keyof typeof RENDER_ERROR,
  message: string,
  trpcCode: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" = "BAD_REQUEST"
): TRPCError {
  return new TRPCError({ code: trpcCode, message: `${code}: ${message}` });
}

/* ═══════════════════════ the timeline as it goes over the wire ═══════════════════════ */

/**
 * The client may send back any timeline shape; this checks the outline before the validator gets
 * it. Deliberately shallow — `validateTimeline` is the real gate and it reports faults far better
 * than a zod message ever could. What this stops is a payload that would make the validator throw
 * on a missing field instead of reporting it.
 */
const timelinePayload = z.object({
  schemaVersion: z.number().int().optional(),
  version: z.number().int(),
  videoId: z.number().int(),
  durationSec: z.number(),
  format: z.object({ widthPx: z.number(), heightPx: z.number(), fps: z.number() }),
  tracks: z.array(z.record(z.string(), z.unknown())),
  /**
   * RONDE 149 — the look MUST be listed here or it is silently lost on save.
   *
   * `z.object()` strips keys it does not know about, so a field that exists on the type and not in
   * this schema survives the round trip in the browser and vanishes the moment it reaches the
   * server — the person picks a grade, presses Save, and gets no grade and no error. Every field
   * the editor can change belongs in this list.
   */
  look: z
    .object({
      grade: z.enum(["none", "documentary"]),
      strength: z.number().min(0).max(1).optional(),
    })
    .optional(),
  renderedVideoUrl: z.string().optional(),
  createdAt: z.string(),
});

/** Issues, shaped for a person rather than for a log. */
function reportIssues(issues: TimelineIssue[]): Array<{
  code: string;
  track: string;
  elementId: string | null;
  message: string;
  blocking: boolean;
}> {
  return issues.map((i) => ({
    code: i.code,
    track: i.track,
    elementId: i.elementId,
    message: formatTimelineIssue(i),
    blocking: !NON_BLOCKING_ISSUES.has(i.code),
  }));
}

/* ═══════════════════════ reading the current document ═══════════════════════ */

type LoadedTimeline = {
  timeline: ProjectTimeline;
  timelineVersion: number;
  /** Where it came from — the editor tells the user when a timeline is a reconstruction. */
  source: "stored" | "manifest" | "empty";
};

/**
 * The timeline for a video, built if it has never been saved. NEVER written.
 *
 * The derived case is the one that matters: every video rendered before this round has a manifest
 * and no timeline, and `timelineFromEditorScenes` reconstructs one — honestly, marking what it had
 * to estimate. Version 0 says "this is a reconstruction, nobody has saved it", which is a different
 * thing from version 1, and the first SAVE is what turns one into the other.
 */
async function loadTimeline(videoId: number): Promise<LoadedTimeline> {
  const stored = await getStoredTimeline(videoId);
  if (stored && stored.timelineVersion > 0) {
    const parsed = parseStoredTimeline(stored.raw);
    if (parsed && storedTimelineIsReadable(parsed)) {
      return { timeline: parsed, timelineVersion: stored.timelineVersion, source: "stored" };
    }
    /**
     * A stored document this build cannot read is NOT quietly replaced by a reconstruction.
     *
     * Falling through to the manifest would show the person their original cut and let them save
     * over their real edits with it. Refusing is the only answer that cannot lose work.
     */
    throw editorError(
      "TIMELINE_INVALID",
      parsed
        ? `this timeline was saved by a newer version of FastVid (schema ${parsed.schemaVersion}) and cannot be opened here`
        : "the saved timeline is damaged and cannot be opened; nothing was changed",
      "CONFLICT"
    );
  }

  const video = await getVideoById(videoId);
  const scenes = await getVideoScenes(videoId);
  if (scenes?.length) {
    return {
      timeline: timelineFromEditorScenes({
        videoId,
        scenes,
        renderedVideoUrl: video?.videoUrl ?? undefined,
      }),
      timelineVersion: 0,
      source: "manifest",
    };
  }
  return {
    timelineVersion: 0,
    source: "empty",
    timeline: {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      version: 0,
      videoId,
      durationSec: 0,
      format: { widthPx: 1920, heightPx: 1080, fps: 30 },
      tracks: [],
      createdAt: new Date().toISOString(),
    },
  };
}

/* ═══════════════════════ the router ═══════════════════════ */

export const timelineRouter = router({
  /**
   * §5 — everything the editor needs to open a video, in one round trip.
   *
   * READ-ONLY. It does not save the derived timeline, does not bump a version and does not create
   * a job. A GET that wrote would mean opening a video changes it, and two people looking at the
   * same video would fight over a version neither of them edited.
   */
  get: protectedProcedure
    .input(z.object({ videoId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const loaded = await loadTimeline(input.videoId);
      const jobs = await listRenderJobsForVideo(input.videoId, 5);
      const validation = validateTimeline(loaded.timeline);

      return {
        video: {
          id: video.id,
          title: video.title,
          status: video.status,
          /** The generated master. Never overwritten by an edit — §9. */
          videoUrl: video.videoUrl,
          /** The most recent successful edit, when there is one. */
          editedVideoUrl: video.editedVideoUrl,
          editedVideoTimelineVersion: video.editedVideoTimelineVersion,
          thumbnailUrl: video.thumbnailUrl,
          durationHintSec: loaded.timeline.durationSec,
        },
        timeline: loaded.timeline,
        timelineVersion: loaded.timelineVersion,
        timelineSource: loaded.source,
        /**
         * How much of this could actually be re-rendered, said BEFORE someone spends ten minutes
         * finding out. A timeline reconstructed from an old manifest often has clips whose source
         * is long gone, and that is a limitation to show, not a surprise to deliver.
         */
        recovery: timelineRecoverySummary(loaded.timeline),
        issues: reportIssues(validation.issues),
        latestRenderJob: jobs[0] ?? null,
        renderJobs: jobs,
      };
    }),

  /**
   * §6 — save, with optimistic concurrency and a validator that may not be skipped.
   *
   * The order is deliberate: validate, THEN check the version, THEN write. Validating first means
   * a user with a stale version still learns their timeline is broken, rather than being told to
   * reload and discovering the fault afterwards.
   */
  save: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
        timeline: timelinePayload,
        expectedTimelineVersion: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);

      const incoming = input.timeline as unknown as ProjectTimeline;
      /**
       * The timeline's videoId must be the one being saved to.
       *
       * Without this, a client could POST video 7's timeline to video 8 and the render would fetch
       * video 7's assets into video 8's output — an authorisation hole that the ownership check
       * above does not close, because the caller may legitimately own both.
       */
      if (incoming.videoId !== input.videoId) {
        throw editorError(
          "TIMELINE_INVALID",
          `this timeline belongs to video ${incoming.videoId}, not ${input.videoId}`
        );
      }

      const validation = validateTimeline(incoming);
      const blocking = validation.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
      if (blocking.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `TIMELINE_INVALID: ${blocking.length} problem(s) must be fixed before saving — ` +
            blocking.slice(0, 5).map(formatTimelineIssue).join(" | "),
        });
      }

      const stored = await getStoredTimeline(input.videoId);
      const storedVersion = stored?.timelineVersion ?? 0;
      const next = nextTimelineToStore({
        storedVersion,
        expectedVersion: input.expectedTimelineVersion,
        incoming,
      });
      if (!next.ok) {
        throw new TRPCError({ code: "CONFLICT", message: `TIMELINE_VERSION_CONFLICT: ${next.reason}` });
      }

      const write = await saveVideoTimeline({
        id: input.videoId,
        timeline: next.timeline,
        expectedVersion: storedVersion,
        nextVersion: next.timelineVersion,
      });
      /**
       * The write is conditional on the version too, so a save that races another save loses here
       * rather than in the read above. Reporting it as the same conflict is correct: from the
       * user's side it is the same event, and the same reload fixes it.
       */
      if (!write.saved) {
        const now = await getStoredTimeline(input.videoId);
        throw new TRPCError({
          code: "CONFLICT",
          message:
            `TIMELINE_VERSION_CONFLICT: someone else saved version ${now?.timelineVersion ?? "?"} ` +
            "while this save was in flight; nothing was overwritten",
        });
      }

      console.log(
        `[Timeline] video=${input.videoId} saved version ${storedVersion} → ${next.timelineVersion} ` +
          `by user=${ctx.user.id} issues=${validation.issues.length}`
      );
      return {
        ok: true as const,
        timelineVersion: next.timelineVersion,
        timeline: next.timeline,
        issues: reportIssues(validation.issues),
      };
    }),

  /**
   * §7 — create a render job, and return.
   *
   * Every check that can be made cheaply is made here, so a person finds out in a second rather
   * than in ten minutes: the video exists, the timeline exists at the version they name, it
   * validates, its assets are recoverable, and nothing else is already rendering.
   */
  render: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
        timelineVersion: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);

      const loaded = await loadTimeline(input.videoId);
      const active = await listActiveRenderJobsForVideo(input.videoId);
      const verdict = mayCreateRenderJob({
        activeJobs: active.map((j) => ({ id: j.id, status: j.status as RenderJobStatus })),
        timelineVersion: loaded.timelineVersion,
        requestedVersion: input.timelineVersion,
      });
      if (!verdict.ok) {
        throw new TRPCError({
          code: verdict.code === RENDER_ERROR.RENDER_ALREADY_RUNNING ? "CONFLICT" : "CONFLICT",
          message: `${verdict.code}: ${verdict.reason}`,
        });
      }

      const validation = validateTimeline(loaded.timeline);
      const blocking = validation.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
      if (blocking.length > 0) {
        /**
         * `missing_asset` is separated out because it is a different conversation. "Your timeline
         * is malformed" is a bug; "the source for shot 3 is gone" is something the person can fix
         * by replacing that shot, and telling them which code it is decides which they hear.
         */
        const unrecoverable = blocking.filter((i) => i.code === "missing_asset");
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: unrecoverable.length
            ? `ASSET_NOT_REHYDRATABLE: ${unrecoverable.length} clip(s) cannot be fetched again — ` +
              unrecoverable.slice(0, 3).map(formatTimelineIssue).join(" | ")
            : `TIMELINE_INVALID: ` + blocking.slice(0, 5).map(formatTimelineIssue).join(" | "),
        });
      }

      /**
       * The attempt is claimed BEFORE the row is inserted, so a job always carries a number the
       * video has already seen. The other order would let a job exist for a moment with an attempt
       * the video does not know about, which is exactly the window `mayPublishRender` cannot judge.
       */
      const attempt = await claimRenderAttempt(input.videoId);
      if (attempt == null) {
        throw editorError("VIDEO_NOT_FOUND", `video ${input.videoId} could not be claimed`, "NOT_FOUND");
      }
      const job = await createRenderJob({
        videoId: input.videoId,
        requestedByUserId: ctx.user.id,
        timelineVersion: loaded.timelineVersion,
        attempt,
      });
      if (!job) {
        throw editorError("RENDER_FAILED", "the render job could not be created");
      }
      console.log(formatRenderJob(job));
      return { ok: true as const, job };
    }),

  /** §10 — poll one job. The editor shows `progressStep` by name; there is no invented percentage. */
  renderJob: protectedProcedure
    .input(z.object({ videoId: z.number().int().positive(), jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      const job = await getRenderJobById(input.jobId);
      /**
       * The job must belong to the video whose access was just checked. Without this comparison
       * the ownership check is decorative: any authenticated user could read any job by passing a
       * video they own and a jobId they do not.
       */
      if (!job || job.videoId !== input.videoId) {
        throw editorError("VIDEO_NOT_FOUND", `render job ${input.jobId} not found`, "NOT_FOUND");
      }
      return job;
    }),

  /**
   * §16 — change one text or caption element. Local to one element, by construction.
   *
   * A convenience over `save`: the client could send a whole edited timeline, and for a single
   * caption that means shipping the entire document back for one string. This takes the element id
   * and the new text, applies the same version check, and runs the same validator.
   */
  editText: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
        expectedTimelineVersion: z.number().int().min(0),
        elementId: z.string().min(1).max(200),
        text: z.string().max(2000).optional(),
        start: z.number().min(0).optional(),
        end: z.number().min(0).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      const loaded = await loadTimeline(input.videoId);
      const edited = editTimelineText({
        timeline: loaded.timeline,
        elementId: input.elementId,
        text: input.text,
        start: input.start,
        end: input.end,
      });
      if (!edited.ok) throw editorError("TIMELINE_INVALID", edited.reason, "NOT_FOUND");
      return persistEdited({
        videoId: input.videoId,
        expectedVersion: input.expectedTimelineVersion,
        storedVersion: loaded.timelineVersion,
        timeline: edited.timeline,
        userId: ctx.user.id,
        what: `text ${input.elementId}`,
      });
    }),

  /**
   * §17 — replace the source of one shot, keeping its slot.
   *
   * The identity comes from the ARCHIVE ROW, never from the request. That is the same rule
   * `video.replaceClip` established in RONDE 139 and for the same reason: a client that could name
   * its own provider could launder a source into the timeline, and the provenance the whole
   * pipeline is built to prove would become a field anyone can type into.
   */
  replaceClip: protectedProcedure
    .input(
      z.object({
        videoId: z.number().int().positive(),
        expectedTimelineVersion: z.number().int().min(0),
        clipId: z.string().min(1).max(200),
        archiveAssetId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      const { getMediaArchiveAssetById, getMediaArchiveById } = await import("./db");
      const asset = await getMediaArchiveAssetById(input.archiveAssetId);
      if (!asset) {
        throw editorError("ASSET_NOT_REHYDRATABLE", "that archive asset does not exist", "NOT_FOUND");
      }
      const archive = await getMediaArchiveById(asset.archiveId);
      const { editorArchiveMediaUrl } = await import("./archiveMediaStream");

      const loaded = await loadTimeline(input.videoId);
      const replaced = replaceTimelineClipSource({
        timeline: loaded.timeline,
        clipId: input.clipId,
        source: {
          provider: archive?.slug?.trim() || "archive",
          archiveAssetId: asset.id,
          canonicalUrl: editorArchiveMediaUrl(asset.id, { storageUrl: asset.storageUrl }),
          title: asset.title ?? undefined,
        },
      });
      if (!replaced.ok) throw editorError("TIMELINE_INVALID", replaced.reason, "NOT_FOUND");
      return persistEdited({
        videoId: input.videoId,
        expectedVersion: input.expectedTimelineVersion,
        storedVersion: loaded.timelineVersion,
        timeline: replaced.timeline,
        userId: ctx.user.id,
        what: `clip ${input.clipId} → archive asset ${asset.id}`,
      });
    }),
});

/**
 * Validate, version-check and store — shared by the two targeted edits above.
 *
 * They differ only in what they changed, and duplicating the save half would eventually mean one
 * of them forgetting the validator. That is the failure this function exists to make impossible.
 */
async function persistEdited(params: {
  videoId: number;
  expectedVersion: number;
  storedVersion: number;
  timeline: ProjectTimeline;
  userId: number;
  what: string;
}) {
  const validation = validateTimeline(params.timeline);
  const blocking = validation.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
  if (blocking.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `TIMELINE_INVALID: this edit would make the timeline unrenderable — ` +
        blocking.slice(0, 5).map(formatTimelineIssue).join(" | "),
    });
  }

  const next = nextTimelineToStore({
    storedVersion: params.storedVersion,
    expectedVersion: params.expectedVersion,
    incoming: params.timeline,
  });
  if (!next.ok) {
    throw new TRPCError({ code: "CONFLICT", message: `TIMELINE_VERSION_CONFLICT: ${next.reason}` });
  }
  const write = await saveVideoTimeline({
    id: params.videoId,
    timeline: next.timeline,
    expectedVersion: params.storedVersion,
    nextVersion: next.timelineVersion,
  });
  if (!write.saved) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "TIMELINE_VERSION_CONFLICT: another save landed first; nothing was overwritten",
    });
  }
  console.log(
    `[Timeline] video=${params.videoId} ${params.what} → version ${next.timelineVersion} ` +
      `by user=${params.userId}`
  );
  return {
    ok: true as const,
    timelineVersion: next.timelineVersion,
    timeline: next.timeline,
    issues: reportIssues(validation.issues),
  };
}
