import { and, asc, desc, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import * as fs from "fs";
import { PIPELINE_ERROR, appErrorMessage } from "@shared/appErrors";
import { PIPELINE_PROCESSING_STATUSES, USER_IN_FLIGHT_VIDEO_STATUSES } from "@shared/videoQueue";
import { isShortVideoLength, normalizeVideoLength } from "@shared/videoLengths";
import { validateFinalVideoForExport, resolveStoredVideoLocalPath, validateFinalVideoPlayable } from "./finalVideoGate";
import { maxPipelineWallClockMin, maxPipelineWallClockHardMin, visualStageWallClockMin, pipelineWallClockLimitEnabled, pipelineProgressStallRecoveryEnabled, pipelineProgressStallThresholdMs, pipelineMaxStallRecoveries, pipelineMinutesPerVideoMinute, pipelineWallClockGraceFactor, pipelineComposeGraceMs, PIPELINE_UNLIMITED_MS } from "./sourcingPolicy";
import type { Video } from "../drizzle/schema";
import { InsertInviteCode, InsertUser, InsertVideo, InsertPasswordResetToken, inviteCodes, users, videos, passwordResetTokens } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    const dbUrl = process.env.DATABASE_URL;
    // Only connect to MySQL URLs — skip PostgreSQL or other DBs
    if (!dbUrl.startsWith("mysql://") && !dbUrl.startsWith("mysql2://")) {
      console.warn("[Database] DATABASE_URL is not a MySQL URL (got:", dbUrl.split("://")[0] + "://...), skipping DB connection");
      return null;
    }
    try {
      // Explicit pool + keep-alive so dead sockets left behind by a DB-side
      // blip (e.g. a volume resize) get detected and replaced instead of hanging.
      const mysql = await import("mysql2/promise");
      const pool = mysql.createPool({
        uri: dbUrl,
        connectionLimit: 15,
        waitForConnections: true,
        connectTimeout: 10_000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      });
      _db = drizzle(pool);
    }
    catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized; updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createUser(data: InsertUser) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(users).values(data);
  const insertId = (result as unknown as [{ insertId: number }])[0]?.insertId;
  return insertId as number;
}

export async function updateUserPassword(userId: number, passwordHash: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateUserLastSignedIn(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, userId));
}

// ─── Invite Codes ─────────────────────────────────────────────────────────────

export async function getInviteCodeByCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createInviteCode(data: InsertInviteCode) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(inviteCodes).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function getAllInviteCodes() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt));
}

export async function markInviteCodeUsed(code: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(inviteCodes).set({ usedByUserId: userId, usedAt: new Date(), isActive: 0 }).where(eq(inviteCodes.code, code));
}

export async function deactivateInviteCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(inviteCodes).set({ isActive: 0 }).where(eq(inviteCodes.id, id));
}

export async function deleteInviteCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getAllUsers(limit = 100, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt)).limit(limit).offset(offset);
}

export async function updateUserSubscription(userId: number, data: {
  subscriptionStatus?: "active" | "inactive" | "cancelled";
  subscriptionStartDate?: Date | null;
  subscriptionEndDate?: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set(data).where(eq(users.id, userId));
}

export async function getUserByStripeCustomerId(stripeCustomerId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateUserRole(userId: number, role: "user" | "admin") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function getUserStats() {
  const db = await getDb();
  if (!db) return { total: 0, active: 0, inactive: 0 };
  const [totalResult] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const [activeResult] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.subscriptionStatus, "active"));
  return {
    total: Number(totalResult?.count ?? 0),
    active: Number(activeResult?.count ?? 0),
    inactive: Number(totalResult?.count ?? 0) - Number(activeResult?.count ?? 0),
  };
}

// ─── Videos ───────────────────────────────────────────────────────────────────

export async function createVideo(data: InsertVideo) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(videos).values(data);
  const insertId = (result as unknown as [{ insertId: number }])[0]?.insertId;
  return insertId;
}

export async function getVideoById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export function readVideoMetadataObject(video?: { metadata?: unknown } | null): Record<string, unknown> {
  const metadata = video?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** Merge keys into videos.metadata without dropping fields saved earlier in the pipeline. */
export async function mergeVideoMetadata(id: number, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const video = await getVideoById(id);
  const merged = { ...readVideoMetadataObject(video), ...patch };
  await db.update(videos).set({ metadata: merged, updatedAt: new Date() }).where(eq(videos.id, id));
}

export async function getVideosByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).where(eq(videos.userId, userId)).orderBy(desc(videos.createdAt));
}

const PROCESSING_STATUS_LIST = [...PIPELINE_PROCESSING_STATUSES];
const USER_IN_FLIGHT_STATUS_LIST = [...USER_IN_FLIGHT_VIDEO_STATUSES];

export async function countUserInFlightVideos(userId: number, exceptVideoId?: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [
    eq(videos.userId, userId),
    inArray(videos.status, USER_IN_FLIGHT_STATUS_LIST),
  ];
  if (exceptVideoId != null) {
    conditions.push(sql`${videos.id} <> ${exceptVideoId}`);
  }
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(and(...conditions));
  return Number(row?.count ?? 0);
}

export async function countGlobalProcessingVideos(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(inArray(videos.status, PROCESSING_STATUS_LIST));
  return Number(row?.count ?? 0);
}

export async function countUserProcessingVideos(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(and(eq(videos.userId, userId), inArray(videos.status, PROCESSING_STATUS_LIST)));
  return Number(row?.count ?? 0);
}

export async function countUserQueuedVideos(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(and(eq(videos.userId, userId), eq(videos.status, "queued")));
  return Number(row?.count ?? 0);
}

export async function countUserAwaitingScriptApproval(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(and(eq(videos.userId, userId), eq(videos.status, "awaiting_approval")));
  return Number(row?.count ?? 0);
}

export async function listQueuedVideosOrdered(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(videos)
    .where(eq(videos.status, "queued"))
    .orderBy(videos.createdAt, videos.id)
    .limit(limit);
}

/** 1-based position among all queued jobs (FIFO). */
export async function getVideoQueuePosition(videoId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const video = await getVideoById(videoId);
  if (!video || video.status !== "queued") return null;

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(
      and(
        eq(videos.status, "queued"),
        sql`(${videos.createdAt} < ${video.createdAt} OR (${videos.createdAt} = ${video.createdAt} AND ${videos.id} < ${videoId}))`
      )
    );
  return Number(row?.count ?? 0) + 1;
}

/** Atomically move a queued video into processing. Returns the video if claimed. */
export async function claimQueuedVideo(videoId: number, progressStep: string): Promise<Video | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .update(videos)
    .set({
      status: "generating_script",
      progressStep,
      progressPercent: 1,
      generationStartedAt: new Date(),
      errorMessage: "",
    })
    .where(and(eq(videos.id, videoId), eq(videos.status, "queued")));

  const affected = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  if (!affected) return undefined;
  // Fresh claim starts a brand-new run — clear any stall-requeue cancel flag left over from a
  // prior (possibly zombie) run of this same video id so this new run isn't born pre-cancelled.
  const { clearVideoGenerationCancel } = await import("./videoGenerationCancel");
  clearVideoGenerationCancel(videoId);
  return getVideoById(videoId);
}

export async function updateVideoStatus(id: number, status: InsertVideo["status"], extra?: {
  script?: string; voiceoverUrl?: string; videoUrl?: string;
  thumbnailUrl?: string; metadata?: unknown; errorMessage?: string; title?: string;
  progressStep?: string; progressPercent?: number; generationStartedAt?: Date;
  scriptApproved?: number; customVoiceoverUrl?: string;
}) {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set({ status, ...extra }).where(eq(videos.id, id));
}

/** Lightweight helper to update only the progress fields without changing status */
export async function updateVideoProgress(id: number, progressStep: string, progressPercent: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(videos)
    .set({ progressStep, progressPercent, updatedAt: new Date() })
    .where(eq(videos.id, id));
}

/** Mark an in-flight video as cancelled (user or admin request). */
export async function cancelVideoGeneration(id: number): Promise<boolean> {
  const video = await getVideoById(id);
  if (!video) return false;
  if (video.status === "completed" || video.status === "failed") return false;
  if (video.status === "pending" || video.status === "queued" || video.status === "awaiting_approval") {
    await updateVideoStatus(id, "failed", {
      errorMessage: "Generation cancelled",
      progressStep: "Cancelled",
      progressPercent: 0,
    });
    return true;
  }
  const { requestVideoGenerationCancel } = await import("./videoGenerationCancel");
  requestVideoGenerationCancel(id);
  await updateVideoStatus(id, "failed", {
    errorMessage: "Generation cancelled",
    progressStep: "Cancelled",
    progressPercent: 0,
  });
  return true;
}

/** Refresh updatedAt while a long clip search runs (prevents false stall kills). */
export async function touchVideoProgress(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set({ updatedAt: new Date() }).where(eq(videos.id, id));
}

export interface ProgressLogEntry {
  step: string;          // human-readable step name
  startedAt: number;    // Unix ms
  completedAt?: number; // Unix ms, set when done
  status: 'pending' | 'active' | 'done' | 'error';
}

/** Replace the full progressLog array in the DB (called after each step update) */
export async function updateVideoProgressLog(id: number, log: ProgressLogEntry[]) {
  const db = await getDb();
  if (!db) return;
  // Use raw SQL to avoid Drizzle type inference lag after schema migration
  await db.execute(
    sql`UPDATE videos SET progressLog = ${JSON.stringify(log)} WHERE id = ${id}`
  );
}

export async function deleteVideo(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(videos).where(eq(videos.id, id));
}

export async function updateVideoTitle(id: number, title: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set({ title }).where(eq(videos.id, id));
}

export async function deleteAllFailedVideosForUser(userId: number) {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(videos).where(
    and(eq(videos.userId, userId), eq(videos.status, "failed"))
  );
  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}

const IN_PROGRESS_STATUSES = [
  "pending",
  "queued",
  "generating_script",
  "awaiting_approval",
  "generating_voiceover",
  "generating_visuals",
  "generating_effects",
] as const;

const ORPHANED_PIPELINE_STATUSES = IN_PROGRESS_STATUSES.filter(
  (s) => s !== "awaiting_approval" && s !== "pending"
) as readonly ("generating_script" | "generating_voiceover" | "generating_visuals" | "generating_effects")[];

export { ORPHANED_PIPELINE_STATUSES };

/**
 * No DB heartbeat for this long → treat as failed.
 * Visual search may run many minutes per scene (celebrity/GDELT/YouTube); use a long window there.
 */
function pipelineStallThresholdMs(
  videoLength: string | null | undefined,
  status?: string | null
): number {
  const progressMs = pipelineProgressStallThresholdMs(videoLength, status);
  if (!pipelineWallClockLimitEnabled()) {
    return progressMs;
  }
  const visualSearch = status === "generating_visuals";
  const length = normalizeVideoLength(videoLength);
  const visualCap = visualStageWallClockMin(length) * 60 * 1000;
  const totalCap = maxPipelineWallClockHardMin(length) * 60 * 1000;
  let wallMs: number;
  if (isShortVideoLength(length)) {
    wallMs = visualSearch ? visualCap : totalCap;
  } else if (length === "8-10") {
    wallMs = visualSearch ? visualCap : 35 * 60 * 1000;
  } else {
    wallMs = visualSearch ? Math.min(visualCap, totalCap - 5 * 60 * 1000) : 45 * 60 * 1000;
  }
  return Math.min(progressMs, wallMs);
}

async function requeueStalledPipeline(video: Video, step: string, recoveries: number): Promise<Video> {
  const label = `Re-queued after stall (${recoveries}/${pipelineMaxStallRecoveries()}) at "${step}"`;
  // The "stalled" detection can be a false positive (event-loop/CPU contention rather than a
  // truly dead process) — if the original pipeline run is actually still alive, flag it to stop
  // writing progress so it can't race the freshly re-queued run and clobber its higher percent.
  const { requestVideoGenerationCancel } = await import("./videoGenerationCancel");
  requestVideoGenerationCancel(video.id);
  await mergeVideoMetadata(video.id, { stallRecoveries: recoveries });
  await updateVideoStatus(video.id, "queued", {
    errorMessage: "",
    progressStep: label,
    progressPercent: 0,
    generationStartedAt: new Date(),
  });
  const { enqueueVideoJob } = await import("./videoQueue");
  await enqueueVideoJob(video.id, "🔄 Re-queued — worker will retry...");
  console.warn(`[Pipeline] Video ${video.id} re-queued after progress stall at "${step}" (${recoveries}/${pipelineMaxStallRecoveries()})`);
  const refreshed = await getVideoById(video.id);
  return refreshed ?? video;
}

/**
 * Mark in-progress videos as failed when progress has not advanced (updatedAt stale).
 */
export async function failPipelineIfStalled(video: Video): Promise<Video> {
  if (video.status === "completed" || video.status === "failed") return video;
  if (video.status === "awaiting_approval" || video.status === "pending" || video.status === "queued") return video;
  if (!IN_PROGRESS_STATUSES.includes(video.status as (typeof IN_PROGRESS_STATUSES)[number])) {
    return video;
  }

  const updatedAt = video.updatedAt ? new Date(video.updatedAt).getTime() : Date.now();
  const threshold = pipelineStallThresholdMs(video.videoLength, video.status);
  const startedAt = video.generationStartedAt
    ? new Date(video.generationStartedAt).getTime()
    : updatedAt;
  const totalHardMs =
    maxPipelineWallClockHardMin(video.videoLength) * 60 * 1000 +
    pipelineComposeGraceMs(video.videoLength);
  const totalElapsed = Date.now() - startedAt;
  const staleProgress = Date.now() - updatedAt >= threshold;
  const overTotalBudget =
    pipelineWallClockLimitEnabled() && totalElapsed >= totalHardMs;
  if (!staleProgress && !overTotalBudget) return video;

  const step = video.progressStep ?? "unknown step";
  if (staleProgress && !overTotalBudget && pipelineProgressStallRecoveryEnabled()) {
    const meta = readVideoMetadataObject(video);
    const prior = typeof meta.stallRecoveries === "number" ? meta.stallRecoveries : 0;
    const nextRecovery = prior + 1;
    if (nextRecovery <= pipelineMaxStallRecoveries()) {
      return requeueStalledPipeline(video, step, nextRecovery);
    }
  }

  const reason = overTotalBudget
    ? `Generation exceeded ${Math.round(totalHardMs / 60000)} minute wall-clock budget`
    : `Generation stalled at "${step}" for over ${Math.round(threshold / 60000)} minutes`;
  await updateVideoStatus(video.id, "failed", {
    errorMessage: appErrorMessage(PIPELINE_ERROR.STUCK_TIMEOUT, reason),
    progressStep: "Failed — generation stalled",
    progressPercent: 0,
  });
  console.warn(`[Pipeline] Video ${video.id} failed: ${reason}`);
  const refreshed = await getVideoById(video.id);
  return refreshed ?? video;
}

/** Scan in-flight pipelines — re-queue zombies or fail on hard stall / wall-clock cap. */
export async function failAllStalledPipelines(): Promise<{ failed: number; requeued: number }> {
  const db = await getDb();
  if (!db) return { failed: 0, requeued: 0 };
  const activeStatuses = IN_PROGRESS_STATUSES.filter(
    (s) => s !== "awaiting_approval" && s !== "pending" && s !== "queued"
  );
  const rows = await db.select().from(videos).where(inArray(videos.status, [...activeStatuses]));
  let failed = 0;
  let requeued = 0;
  for (const v of rows) {
    const before = v.status;
    const after = await failPipelineIfStalled(v);
    if (before === after.status) continue;
    if (after.status === "failed") failed++;
    else if (before !== "queued" && after.status === "queued") requeued++;
  }
  return { failed, requeued };
}

/** Locate a finished MP4 on disk when videoUrl was never persisted (Railway local storage). */
export async function findStoredVideoUrl(videoId: number): Promise<string | null> {
  try {
    const { LOCAL_UPLOADS_DIR } = await import("./storageLocal");
    if (!fs.existsSync(LOCAL_UPLOADS_DIR)) return null;
    const prefix = `videos_${videoId}_final`;
    const match = fs
      .readdirSync(LOCAL_UPLOADS_DIR)
      .find((f) => f.startsWith(prefix) && f.endsWith(".mp4"));
    return match ? `/local-storage/${match}` : null;
  } catch {
    return null;
  }
}

/**
 * Fix videos stuck in generating_* after the MP4 was saved but the final status write failed
 * (common after Railway redeploy or OOM during upload/finalization).
 */
export async function recoverVideoCompletionState(video: Video): Promise<Video> {
  if (video.status === "completed" || video.status === "failed") return video;

  let videoUrl = video.videoUrl;
  if (!videoUrl) {
    videoUrl = await findStoredVideoUrl(video.id);
  }

  if (videoUrl) {
    const localPath = resolveStoredVideoLocalPath(videoUrl);
    if (localPath) {
      const validation = await validateFinalVideoPlayable(localPath, video.videoLength);
      if (!validation.ok) {
        console.warn(
          `[Recovery] Video ${video.id}: stored MP4 fails export check — not marking completed (${validation.reasons.slice(0, 2).join("; ")})`
        );
        return video;
      }
    }
    await updateVideoStatus(video.id, "completed", {
      videoUrl,
      progressStep: "Video complete!",
      progressPercent: 100,
    });
    const refreshed = await getVideoById(video.id);
    return refreshed ?? video;
  }

  const progressPercent = video.progressPercent ?? 0;
  const log = (video.progressLog ?? []) as ProgressLogEntry[];
  const logLooksFinalized = log.some(
    (e) =>
      e.step.includes("Video complete") ||
      e.step.includes("Uploading final video") ||
      e.step.includes("Complete!")
  );
  const staleFinalize =
    video.status === "generating_effects" &&
    (progressPercent >= 90 || logLooksFinalized);

  if (staleFinalize && video.updatedAt) {
    const staleMs = Date.now() - new Date(video.updatedAt).getTime();
    if (staleMs > 12 * 60 * 1000) {
      await updateVideoStatus(video.id, "failed", {
        errorMessage: appErrorMessage(
          PIPELINE_ERROR.SERVER_RESTART,
          "Generation was interrupted during finalization. Please retry"
        ),
        progressStep: "Interrupted — please retry",
        progressPercent: 0,
      });
      const refreshed = await getVideoById(video.id);
      return refreshed ?? video;
    }
  }

  return video;
}

/** On server startup: recover finished uploads, then fail orphaned in-progress pipelines. */
export async function recoverAllStuckVideos(): Promise<{ completed: number; failed: number }> {
  const db = await getDb();
  if (!db) return { completed: 0, failed: 0 };

  const stuck = await db
    .select()
    .from(videos)
    .where(inArray(videos.status, [...ORPHANED_PIPELINE_STATUSES]));

  let completed = 0;
  for (const v of stuck) {
    const before = v.status;
    const after = await recoverVideoCompletionState(v);
    if (before !== "completed" && after.status === "completed") completed++;
  }

  let failed = 0;
  for (const v of stuck) {
    const refreshed = await getVideoById(v.id);
    if (!refreshed || refreshed.status === "completed" || refreshed.status === "failed") continue;
    await updateVideoStatus(refreshed.id, "queued", {
      errorMessage: "",
      progressStep: "Re-queued after server restart",
      progressPercent: 0,
    });
    failed++;
  }

  if (completed > 0 || failed > 0) {
    console.log(`[PipelineRecovery] Recovered ${completed} completed, re-queued ${failed} orphaned job(s)`);
  }
  return { completed, failed };
}

/** Mark in-progress videos older than maxAgeMinutes as failed (stuck pipeline recovery) */
export async function expireStuckVideos(maxAgeMinutes = 95) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stuckStatuses = IN_PROGRESS_STATUSES.filter(
    (s) => s !== "awaiting_approval" && s !== "queued"
  );
  let total = 0;
  for (const s of stuckStatuses) {
    const result = await db.update(videos)
      .set({
        status: "failed",
        errorMessage: appErrorMessage(
          PIPELINE_ERROR.STUCK_TIMEOUT,
          `Pipeline timed out after ${maxAgeMinutes} minutes`
        ),
        progressStep: "Timed out",
      })
      .where(and(eq(videos.status, s), sql`${videos.generationStartedAt} < ${cutoff}`));
    total += (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
  }
  return total;
}

export async function getAllVideos(limit = 100, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).orderBy(desc(videos.createdAt)).limit(limit).offset(offset);
}


export async function searchVideos(opts: {
  query?: string;
  status?: string;
  userId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const { query, status, userId, limit = 100, offset = 0 } = opts;
  const conditions = [];
  if (status && status !== "all") conditions.push(sql`${videos.status} = ${status}`);
  if (userId) conditions.push(eq(videos.userId, userId));
  if (query) {
    // Support #VID-XXXX format
    const vidMatch = query.match(/^#?VID-?(\d+)$/i);
    if (vidMatch) {
      conditions.push(eq(videos.id, parseInt(vidMatch[1], 10)));
    } else {
      // Support raw numeric ID (video ID or user ID)
      const numMatch = query.match(/^#?(\d+)$/);
      if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        conditions.push(or(eq(videos.id, n), eq(videos.userId, n)));
      } else {
        const likePattern = `%${query}%`;
        conditions.push(or(
          like(videos.prompt, likePattern),
          like(videos.title, likePattern),
        ));
      }
    }
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  // Join with users to include user name and email
  return db
    .select({
      id: videos.id,
      userId: videos.userId,
      prompt: videos.prompt,
      videoLength: videos.videoLength,
      status: videos.status,
      title: videos.title,
      script: videos.script,
      metadata: videos.metadata,
      videoUrl: videos.videoUrl,
      errorMessage: videos.errorMessage,
      progressStep: videos.progressStep,
      progressPercent: videos.progressPercent,
      createdAt: videos.createdAt,
      updatedAt: videos.updatedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(videos)
    .leftJoin(users, eq(videos.userId, users.id))
    .where(where)
    .orderBy(desc(videos.createdAt))
    .limit(limit)
    .offset(offset);
}
export async function getVideoStats() {
  const db = await getDb();
  if (!db) return { total: 0, completed: 0, failed: 0, pending: 0 };
  const [totalResult] = await db.select({ count: sql<number>`count(*)` }).from(videos);
  const [completedResult] = await db.select({ count: sql<number>`count(*)` }).from(videos).where(eq(videos.status, "completed"));
  const [failedResult] = await db.select({ count: sql<number>`count(*)` }).from(videos).where(eq(videos.status, "failed"));
  return {
    total: Number(totalResult?.count ?? 0),
    completed: Number(completedResult?.count ?? 0),
    failed: Number(failedResult?.count ?? 0),
    pending: Number(totalResult?.count ?? 0) - Number(completedResult?.count ?? 0) - Number(failedResult?.count ?? 0),
  };
}

// ─── Voices ───────────────────────────────────────────────────────────────────

import { InsertVoice, voices } from "../drizzle/schema";

export async function getAllVoices() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(voices).where(eq(voices.isActive, 1)).orderBy(voices.sortOrder, voices.id);
}

export async function getAllVoicesAdmin() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(voices).orderBy(voices.sortOrder, voices.id);
}

export async function getVoiceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(voices).where(eq(voices.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createVoice(data: InsertVoice) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(voices).values(data);
  const insertId = (result as unknown as [{ insertId: number }])[0]?.insertId;
  return insertId;
}

export async function updateVoice(id: number, data: Partial<InsertVoice>) {
  const db = await getDb();
  if (!db) return;
  await db.update(voices).set(data).where(eq(voices.id, id));
}

export async function deleteVoice(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(voices).where(eq(voices.id, id));
}

// ElevenLabs premade voice IDs — always available on any ElevenLabs account
const ELEVENLABS_DEFAULT_VOICES = [
  { name: "Michael",  description: "American Male — natural, YouTube-style narrator",           fishAudioReferenceId: "pNInz6obpgDQGcFmaJgB", flag: "🇺🇸", sortOrder: 1, isActive: 1 },
  { name: "Adam",     description: "American Male — deep, authoritative documentary voice",     fishAudioReferenceId: "ErXwobaYiN019PkySvjV", flag: "🇺🇸", sortOrder: 2, isActive: 1 },
  { name: "Heart",    description: "American Female — warm, friendly narrator",                 fishAudioReferenceId: "21m00Tcm4TlvDq8ikWAM", flag: "🇺🇸", sortOrder: 3, isActive: 1 },
  { name: "Bella",    description: "American Female — clear, professional narrator",            fishAudioReferenceId: "EXAVITQu4vr4xnSDxMaL", flag: "🇺🇸", sortOrder: 4, isActive: 1 },
  { name: "George",   description: "British Male — elegant, documentary-style narrator",       fishAudioReferenceId: "JBFqnCBsd6RMkjVDRZzb", flag: "🇬🇧", sortOrder: 5, isActive: 1 },
  { name: "Lewis",    description: "British Male — calm, authoritative narrator",              fishAudioReferenceId: "TX3LPaxmHKxFdv7VOQHJ", flag: "🇬🇧", sortOrder: 6, isActive: 1 },
] as const;

export async function seedDefaultVoices() {
  const db = await getDb();
  if (!db) return;
  // Always upsert voices by name so ElevenLabs IDs are kept current even after Fish Audio migration
  for (const v of ELEVENLABS_DEFAULT_VOICES) {
    const existing = await db.select().from(voices).where(eq(voices.name, v.name)).limit(1);
    if (existing.length === 0) {
      await db.insert(voices).values(v as InsertVoice);
    } else if (existing[0].fishAudioReferenceId !== v.fishAudioReferenceId) {
      // Update stale Fish Audio ID to correct ElevenLabs ID
      await db.update(voices).set({ fishAudioReferenceId: v.fishAudioReferenceId, flag: v.flag, sortOrder: v.sortOrder }).where(eq(voices.name, v.name));
    }
  }
}

// ─── Password Reset Tokens ────────────────────────────────────────────────────

export async function createPasswordResetToken(data: InsertPasswordResetToken) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(passwordResetTokens).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function getPasswordResetTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.token, token)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function markPasswordResetTokenAsUsed(tokenId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, tokenId));
}

export async function deleteExpiredPasswordResetTokens() {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(passwordResetTokens).where(sql`${passwordResetTokens.expiresAt} < NOW()`);
  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}

// ─── Editor ───────────────────────────────────────────────────────────────────

export interface EditorClip {
  url: string;
  type: "video" | "image";
  source: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Media archive asset id when source is archive. */
  archiveAssetId?: number;
  storageUrl?: string;
  title?: string;
}

export interface EditorScene {
  sceneIndex: number;
  title?: string;
  narration: string;
  durationMs: number;
  clips: EditorClip[];
  thumbnailUrl?: string; // first clip thumbnail
  chapterTitle?: string; // if this scene is preceded by a chapter card
}

export async function updateVideoScenes(id: number, scenes: EditorScene[]) {
  const db = await getDb();
  if (!db) return;
  await db.execute(
    sql`UPDATE videos SET videoScenes = ${JSON.stringify(scenes)} WHERE id = ${id}`
  );
}

export async function updateEditedVideoUrl(id: number, editedVideoUrl: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set({ editedVideoUrl }).where(eq(videos.id, id));
}

export async function getVideoScenes(id: number): Promise<EditorScene[] | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select({ videoScenes: videos.videoScenes }).from(videos).where(eq(videos.id, id)).limit(1);
  if (!result.length || !result[0].videoScenes) return null;
  return result[0].videoScenes as EditorScene[];
}

export type VideoEditorSettings = {
  enableSubtitles: boolean;
  backgroundMusicUrl: string | null;
};

export function readVideoEditorSettings(video: {
  enableSubtitles?: number | null;
  metadata?: unknown;
}): VideoEditorSettings {
  const meta = (video.metadata ?? {}) as { backgroundMusicUrl?: string };
  return {
    enableSubtitles: video.enableSubtitles !== 0,
    backgroundMusicUrl: meta.backgroundMusicUrl ?? null,
  };
}

export async function updateVideoEditorSettings(
  id: number,
  settings: { enableSubtitles?: boolean; backgroundMusicUrl?: string | null }
) {
  const db = await getDb();
  if (!db) return;
  const video = await getVideoById(id);
  if (!video) return;
  const meta = { ...((video.metadata ?? {}) as Record<string, unknown>) };
  if (settings.backgroundMusicUrl !== undefined) {
    if (settings.backgroundMusicUrl) {
      meta.backgroundMusicUrl = settings.backgroundMusicUrl;
    } else {
      delete meta.backgroundMusicUrl;
    }
  }
  const patch: Record<string, unknown> = { metadata: meta, updatedAt: new Date() };
  if (settings.enableSubtitles !== undefined) {
    patch.enableSubtitles = settings.enableSubtitles ? 1 : 0;
  }
  await db.update(videos).set(patch).where(eq(videos.id, id));
}

// ─── Media Archives ───────────────────────────────────────────────────────────

import {
  InsertMediaArchive,
  InsertMediaArchiveAsset,
  mediaArchiveAssets,
  mediaArchives,
} from "../drizzle/schema";

export function normalizeMediaTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => (typeof t === "string" ? t : t == null ? "" : String(t)).trim().toLowerCase()).filter(Boolean))
  );
}

export function slugifyArchiveName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return base || "archive";
}

export async function getAllMediaArchives() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(mediaArchives).orderBy(desc(mediaArchives.updatedAt), desc(mediaArchives.id));
}

export async function getMediaArchiveById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(mediaArchives).where(eq(mediaArchives.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getMediaArchiveBySlug(slug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(mediaArchives).where(eq(mediaArchives.slug, slug)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createMediaArchiveUnique(data: Omit<InsertMediaArchive, "slug"> & { slugBase: string }) {
  const db = await getDb();
  if (!db) return undefined;
  let slug = slugifyArchiveName(data.slugBase);
  let attempt = 0;
  while (attempt < 20) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
    const existing = await getMediaArchiveBySlug(candidate);
    if (!existing) {
      slug = candidate;
      break;
    }
    attempt++;
  }
  const { slugBase: _ignored, ...rest } = data;
  const result = await db.insert(mediaArchives).values({ ...rest, slug });
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function updateMediaArchive(id: number, data: Partial<InsertMediaArchive>) {
  const db = await getDb();
  if (!db) return;
  await db.update(mediaArchives).set(data).where(eq(mediaArchives.id, id));
}

export async function deleteMediaArchive(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(mediaArchiveAssets).where(eq(mediaArchiveAssets.archiveId, id));
  await db.delete(mediaArchives).where(eq(mediaArchives.id, id));
}

export async function getMediaArchiveAssets(archiveId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mediaArchiveAssets)
    .where(and(eq(mediaArchiveAssets.archiveId, archiveId), eq(mediaArchiveAssets.isActive, 1)))
    .orderBy(desc(mediaArchiveAssets.sortOrder), desc(mediaArchiveAssets.id));
}

/** Paginated active video assets — avoids loading the full archive for CLIP backfill. */
export async function listActiveVideoArchiveAssetsBatch(afterId: number, limit: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mediaArchiveAssets)
    .where(
      and(
        eq(mediaArchiveAssets.isActive, 1),
        eq(mediaArchiveAssets.mediaType, "video"),
        gt(mediaArchiveAssets.id, afterId)
      )
    )
    .orderBy(asc(mediaArchiveAssets.id))
    .limit(limit);
}

/** Paginated active assets of any media type (video + image) — used by the Visual Matching
 *  Engine V2 archive embedding backfill, a standalone script (see
 *  server/visualMatchingV2/embeddings/archiveEmbeddingBackfill.ts). Not called from any
 *  worker startup path. */
export async function listActiveMediaArchiveAssetsBatch(afterId: number, limit: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(mediaArchiveAssets)
    .where(and(eq(mediaArchiveAssets.isActive, 1), gt(mediaArchiveAssets.id, afterId)))
    .orderBy(asc(mediaArchiveAssets.id))
    .limit(limit);
}

export async function getMediaArchiveAssetById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(mediaArchiveAssets).where(eq(mediaArchiveAssets.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createMediaArchiveAsset(data: InsertMediaArchiveAsset) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(mediaArchiveAssets).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function updateMediaArchiveAsset(id: number, data: Partial<InsertMediaArchiveAsset>) {
  const db = await getDb();
  if (!db) return;
  await db.update(mediaArchiveAssets).set(data).where(eq(mediaArchiveAssets.id, id));
}

export async function deleteMediaArchiveAsset(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(mediaArchiveAssets).where(eq(mediaArchiveAssets.id, id));
}

// ─── Visual Matching Engine V2: VideoContext + VisualIntent caches ────────────

import {
  InsertVisualContextCacheRow,
  InsertVisualIntentCacheRow,
  visualContextCache,
  visualIntentCache,
  InsertEmbeddingCacheRow,
  InsertMediaArchiveAssetEmbeddingRow,
  embeddingCache,
  mediaArchiveAssetEmbeddings,
} from "../drizzle/schema";

export async function getVisualContextCacheByTopicHash(topicHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(visualContextCache)
    .where(eq(visualContextCache.topicHash, topicHash))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createVisualContextCache(data: InsertVisualContextCacheRow) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(visualContextCache).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function getVisualIntentCacheByIntentHash(intentHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(visualIntentCache)
    .where(eq(visualIntentCache.intentHash, intentHash))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createVisualIntentCache(data: InsertVisualIntentCacheRow) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(visualIntentCache).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

// ─── Visual Matching Engine V2: Embedding cache + own-archive asset embeddings (stage 3) ──

export async function getEmbeddingCache(subjectId: string, model: string, embeddingVersion: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(embeddingCache)
    .where(
      and(
        eq(embeddingCache.subjectId, subjectId),
        eq(embeddingCache.model, model),
        eq(embeddingCache.embeddingVersion, embeddingVersion)
      )
    )
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createEmbeddingCache(data: InsertEmbeddingCacheRow) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(embeddingCache).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

/** Asset IDs that already have a current embedding (matching provider/model/version) —
 *  used by the incremental backfill to skip assets that don't need re-embedding. */
export async function listMediaArchiveAssetIdsWithEmbedding(
  provider: string,
  model: string,
  embeddingVersion: string
): Promise<Set<number>> {
  const db = await getDb();
  if (!db) return new Set();
  const rows = await db
    .select({ assetId: mediaArchiveAssetEmbeddings.assetId })
    .from(mediaArchiveAssetEmbeddings)
    .where(
      and(
        eq(mediaArchiveAssetEmbeddings.provider, provider),
        eq(mediaArchiveAssetEmbeddings.model, model),
        eq(mediaArchiveAssetEmbeddings.embeddingVersion, embeddingVersion)
      )
    );
  return new Set(rows.map((r) => r.assetId));
}

export async function getMediaArchiveAssetEmbedding(assetId: number, model: string, embeddingVersion: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(mediaArchiveAssetEmbeddings)
    .where(
      and(
        eq(mediaArchiveAssetEmbeddings.assetId, assetId),
        eq(mediaArchiveAssetEmbeddings.model, model),
        eq(mediaArchiveAssetEmbeddings.embeddingVersion, embeddingVersion)
      )
    )
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createMediaArchiveAssetEmbedding(data: InsertMediaArchiveAssetEmbeddingRow) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(mediaArchiveAssetEmbeddings).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function deleteMediaArchiveAssets(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return 0;
  const uniqueIds = [...new Set(ids)];
  const chunkSize = 500;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    await db.delete(mediaArchiveAssets).where(inArray(mediaArchiveAssets.id, chunk));
  }
  return uniqueIds.length;
}

/** Delete all assets in an archive (optionally filtered by the same search as listAssets). */
export async function deleteAllMediaArchiveAssets(
  archiveId: number,
  opts?: { search?: string }
): Promise<number> {
  let assets = await getMediaArchiveAssets(archiveId);
  if (opts?.search?.trim()) {
    assets = filterMediaArchiveAssets(assets, { search: opts.search });
  }
  const ids = assets.map((a) => a.id);
  return deleteMediaArchiveAssets(ids);
}

export async function countMediaArchiveAssets(archiveId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(mediaArchiveAssets)
    .where(and(eq(mediaArchiveAssets.archiveId, archiveId), eq(mediaArchiveAssets.isActive, 1)));
  return Number(rows[0]?.count ?? 0);
}

/** Fast aggregate for health checks — avoids loading thousands of asset rows. */
export async function summarizeActiveArchiveCounts(): Promise<{
  archiveCount: number;
  totalAssets: number;
  videoAssets: number;
}> {
  const db = await getDb();
  if (!db) return { archiveCount: 0, totalAssets: 0, videoAssets: 0 };
  const archives = await getAllMediaArchives();
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mediaArchiveAssets)
    .where(eq(mediaArchiveAssets.isActive, 1));
  const [videoRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mediaArchiveAssets)
    .where(and(eq(mediaArchiveAssets.isActive, 1), eq(mediaArchiveAssets.mediaType, "video")));
  return {
    archiveCount: archives.length,
    totalAssets: Number(totalRow?.count ?? 0),
    videoAssets: Number(videoRow?.count ?? 0),
  };
}

/** Filter assets by tag/title search (used by admin UI and future pipeline). */
export function filterMediaArchiveAssets<
  T extends { title?: string | null; tags?: string[] | null }
>(assets: T[], opts: { search?: string; tag?: string }): T[] {
  const q = opts.search?.trim().toLowerCase();
  const tag = opts.tag?.trim().toLowerCase();
  return assets.filter((asset) => {
    if (tag) {
      const tags = (asset.tags ?? []).map((t) => t.toLowerCase());
      if (!tags.some((t) => t.includes(tag))) return false;
    }
    if (q) {
      const title = (asset.title ?? "").toLowerCase();
      const tags = (asset.tags ?? []).join(" ").toLowerCase();
      if (!title.includes(q) && !tags.includes(q)) return false;
    }
    return true;
  });
}
