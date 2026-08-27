import { and, asc, desc, eq, gt, getTableColumns, inArray, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import * as fs from "fs";
import { PIPELINE_ERROR, appErrorMessage } from "@shared/appErrors";
import {
  PIPELINE_PROCESSING_STATUSES,
  USER_ACTIVE_VIDEO_STATUSES,
  USER_IN_FLIGHT_VIDEO_STATUSES,
  readQueueConfig,
} from "@shared/videoQueue";
import { isShortVideoLength, normalizeVideoLength } from "@shared/videoLengths";
import { validateFinalVideoForExport, resolveStoredVideoLocalPath, validateFinalVideoPlayable } from "./finalVideoGate";
import { maxPipelineWallClockMin, maxPipelineWallClockHardMin, visualStageWallClockMin, pipelineWallClockLimitEnabled, pipelineProgressStallRecoveryEnabled, pipelineProgressStallThresholdMs, pipelineMaxStallRecoveries, pipelineMinutesPerVideoMinute, pipelineWallClockGraceFactor, pipelineComposeGraceMs, PIPELINE_UNLIMITED_MS } from "./sourcingPolicy";
import type { Video } from "../drizzle/schema";
import { InsertInviteCode, InsertUser, InsertVideo, InsertPasswordResetToken, inviteCodes, users, videos, passwordResetTokens, llmSpendByUser } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// connectionLimit must comfortably exceed MAX_CONCURRENT_JOBS (each active render writes progress
// frequently) plus the web process's own request traffic and the periodic background sweeps
// (failAllStalledPipelines, runStuckVideoCheck) sharing this same pool. Default is
// MAX_CONCURRENT_JOBS + 10 fixed overhead for those non-render consumers — override via env only
// if a future worker/replica topology genuinely needs a different value.
function dbPoolConnectionLimit(): number {
  const raw = process.env.DB_POOL_CONNECTION_LIMIT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 200) return n;
  }
  return readQueueConfig().maxConcurrentJobs + 10;
}

// queueLimit bounds how many callers can wait for a connection before the pool fails fast with
// an explicit error instead of hanging forever.
function dbPoolQueueLimit(): number {
  const raw = process.env.DB_POOL_QUEUE_LIMIT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 10 && n <= 1000) return n;
  }
  return 100;
}

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
        connectionLimit: dbPoolConnectionLimit(),
        queueLimit: dbPoolQueueLimit(),
        waitForConnections: true,
        connectTimeout: 10_000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      });
      // TS sees two structurally different `Pool` types here: mysql2/promise's Pool (used at
      // runtime, the documented drizzle-orm/mysql2 pattern) vs. the plain mysql2 Pool that
      // drizzle's own generic signature infers by default — a known type-resolution quirk
      // between the two mysql2 subpaths, not a real runtime mismatch (drizzle-orm/mysql2 is
      // built specifically to wrap a mysql2/promise pool).
      _db = drizzle(pool) as unknown as ReturnType<typeof drizzle>;
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

/** Per-user LLM usage rows (Phase 1 "AI Gateway" tracking, see llmBudget.ts recordLlmUsage),
 *  most recent day first — for admin inspection, no enforcement yet. */
export async function getUserLlmSpend(userId: number, limitRows = 90) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(llmSpendByUser)
    .where(eq(llmSpendByUser.userId, userId))
    .orderBy(desc(llmSpendByUser.day))
    .limit(limitRows);
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

/** Look up the owning video row for a stored `/local-storage/<file>` URL, used to
 *  authorize direct static-file requests for final video files. */
export async function getVideoByVideoUrl(videoUrl: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(videos).where(eq(videos.videoUrl, videoUrl)).limit(1);
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
const USER_ACTIVE_STATUS_LIST = [...USER_ACTIVE_VIDEO_STATUSES];

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

/** Returns a map of userId → active-job count for all provided userIds in one query. */
export async function countProcessingVideosByUsers(
  userIds: number[]
): Promise<Map<number, number>> {
  if (!userIds.length) return new Map();
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select({ userId: videos.userId, count: sql<number>`count(*)` })
    .from(videos)
    .where(and(inArray(videos.userId, userIds), inArray(videos.status, PROCESSING_STATUS_LIST)))
    .groupBy(videos.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.count)]));
}

/**
 * RONDE 109 — userId → "has a render underway" count, for the queue picker.
 *
 * Same shape as countProcessingVideosByUsers, one status wider: it also counts
 * `awaiting_approval`. See USER_ACTIVE_VIDEO_STATUSES for why — a full run sits in that status
 * for a second or two mid-render, and a picker tick landing in that window would otherwise read
 * the user as idle and start their next queued video alongside the one already running.
 */
export async function countActiveVideosByUsers(userIds: number[]): Promise<Map<number, number>> {
  if (!userIds.length) return new Map();
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select({ userId: videos.userId, count: sql<number>`count(*)` })
    .from(videos)
    .where(and(inArray(videos.userId, userIds), inArray(videos.status, USER_ACTIVE_STATUS_LIST)))
    .groupBy(videos.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.count)]));
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

/**
 * RONDE 109 — 1-based position among THIS USER's own queued videos.
 *
 * getVideoQueuePosition above is the platform-wide FIFO position, which is the honest number for
 * "when will a worker get to this" but a confusing one to show a person: "position 7" when they
 * queued three videos reads as a fault. Their own line is the thing they can reason about, so the
 * dashboard shows this one and the global position stays available for the admin.
 */
export async function getUserQueuePosition(videoId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const video = await getVideoById(videoId);
  if (!video || video.status !== "queued") return null;

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(videos)
    .where(
      and(
        eq(videos.userId, video.userId),
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
      generationAttempt: sql`${videos.generationAttempt} + 1`,
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

/** Cheap PK lookup for fencing checks — avoids a full row fetch on every progress-write. */
export async function getVideoGenerationAttempt(id: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ generationAttempt: videos.generationAttempt })
    .from(videos)
    .where(eq(videos.id, id));
  return row?.generationAttempt ?? null;
}

/** Atomically bump the fencing token — call at the start of any code path that starts a fresh
 *  run over a video id outside the normal queue-claim flow (e.g. a direct retry), so a still-running
 *  zombie from a previous attempt can detect it's been superseded. Returns the new attempt number. */
export async function bumpGenerationAttempt(id: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  await db
    .update(videos)
    .set({ generationAttempt: sql`${videos.generationAttempt} + 1` })
    .where(eq(videos.id, id));
  return (await getVideoGenerationAttempt(id)) ?? 0;
}

/** True if this run has been superseded (a newer attempt claimed the video, or it was
 *  explicitly cancelled) and should stop writing progress — regardless of which process
 *  (web dyno vs. worker dyno) the check runs in, since it's backed by the DB, not memory. */
export async function isGenerationRunSuperseded(videoId: number, myAttempt: number): Promise<boolean> {
  const { isVideoGenerationCancelRequested, requestVideoGenerationCancel } = await import("./videoGenerationCancel");
  if (isVideoGenerationCancelRequested(videoId)) return true;
  const current = await getVideoGenerationAttempt(videoId);
  const superseded = current !== null && current !== myAttempt;
  if (superseded) {
    // Latch the in-memory flag so any other code in THIS process checking this video id
    // (e.g. server/videoPipeline.ts's exec(), which can't re-derive myAttempt on its own)
    // sees the same verdict immediately, without each caller needing its own DB round-trip.
    requestVideoGenerationCancel(videoId);
  }
  return superseded;
}

export async function updateVideoStatus(id: number, status: InsertVideo["status"], extra?: {
  script?: string; voiceoverUrl?: string; videoUrl?: string;
  thumbnailUrl?: string; metadata?: unknown; errorMessage?: string; title?: string;
  progressStep?: string; progressPercent?: number; generationStartedAt?: Date;
  scriptApproved?: number; customVoiceoverUrl?: string;
}) {
  const db = await getDb();
  if (!db) return;
  if (extra?.progressPercent == null) {
    await db.update(videos).set({ status, ...extra }).where(eq(videos.id, id));
    return;
  }
  /**
   * RONDE 107 — a progress percent may go up, or start over. It may never slip.
   *
   * The number is written from a dozen places with fixed values (5, 28, 29, 30, 100), and the
   * pipeline does not visit them in a single ascending order: a render at 45% that reaches a
   * stage hard-coded to 29 wrote 29, and the badge on the user's video stepped backwards. A
   * progress bar that goes down is not a smaller claim, it is a broken one — the viewer stops
   * believing any of it.
   *
   * A RESET is a different thing from a slip, and the write says which it is without any call
   * site having to be changed:
   *
   *   · a new run     — `generationStartedAt` is set in the same write, so this IS the start of
   *                     a generation and its percent is authoritative
   *   · not running   — queued, pending or failed: the video is not mid-render, and whatever the
   *                     lifecycle change says the percent is, is the percent
   *   · anything else — a tick. It may raise the stored value and may never lower it.
   */
  const isNewRun = extra.generationStartedAt != null;
  const isNotRunning = status === "queued" || status === "pending" || status === "failed";
  const { progressPercent, ...restExtra } = extra;
  await db
    .update(videos)
    .set({
      status,
      ...restExtra,
      progressPercent:
        isNewRun || isNotRunning
          ? progressPercent
          : // GREATEST in SQL rather than read-then-write: two workers and an out-of-order poll
            // must not be able to interleave into a decrease.
            sql`GREATEST(COALESCE(${videos.progressPercent}, 0), ${progressPercent})`,
    })
    .where(eq(videos.id, id));
}

/**
 * Lightweight helper to update only the progress fields without changing status.
 *
 * RONDE 107: this is the tick path — it can only ever mean "we got further", so the stored
 * percent is raised and never lowered. A restart goes through updateVideoStatus, which knows
 * from the write itself whether it is starting a new run.
 */
export async function updateVideoProgress(id: number, progressStep: string, progressPercent: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(videos)
    .set({
      progressStep,
      progressPercent: sql`GREATEST(COALESCE(${videos.progressPercent}, 0), ${progressPercent})`,
      updatedAt: new Date(),
    })
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
 * Exported (visibility only, F3-47) so expireStuckVideos() below and videoQueue.ts's job
 * watchdog can reuse the same activity-staleness definition instead of each inventing their own.
 */
export function pipelineStallThresholdMs(
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
  const staleProgress = Date.now() - updatedAt >= threshold;
  // F3-47: this used to also fail a video once total elapsed time (regardless of whether
  // updatedAt was still fresh) passed its target wall-clock budget (overTotalBudget) — the
  // same "total elapsed, not actual staleness" check videoPipeline.ts's
  // assertPipelineWithinBudget used to enforce in-process. A render still actively updating
  // its progress must not be marked failed purely for running longer than its target budget.
  // staleProgress (real "no heartbeat" stall detection, driven by pipelineStallThresholdMs)
  // is unchanged below — that's what still catches a genuinely stuck/crashed render.
  if (!staleProgress) return video;

  const step = video.progressStep ?? "unknown step";
  if (pipelineProgressStallRecoveryEnabled()) {
    const meta = readVideoMetadataObject(video);
    const prior = typeof meta.stallRecoveries === "number" ? meta.stallRecoveries : 0;
    const nextRecovery = prior + 1;
    if (nextRecovery <= pipelineMaxStallRecoveries()) {
      return requeueStalledPipeline(video, step, nextRecovery);
    }
  }

  const reason = `Generation stalled at "${step}" for over ${Math.round(threshold / 60000)} minutes`;
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
export async function recoverAllStuckVideos(onRequeued?: () => void): Promise<{ completed: number; failed: number }> {
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

  // Bulk-refresh in one query instead of N individual GETs
  const refreshedIds = stuck.map((v) => v.id);
  const refreshed = refreshedIds.length
    ? await db.select().from(videos).where(inArray(videos.id, refreshedIds))
    : [];
  const refreshedMap = new Map(refreshed.map((v) => [v.id, v]));

  let failed = 0;
  for (const v of stuck) {
    const rv = refreshedMap.get(v.id);
    if (!rv || rv.status === "completed" || rv.status === "failed") continue;
    await updateVideoStatus(rv.id, "queued", {
      errorMessage: "",
      progressStep: "Waiting in queue…",
      progressPercent: 0,
    });
    failed++;
  }

  if (completed > 0 || failed > 0) {
    console.log(`[PipelineRecovery] Recovered ${completed} completed, re-queued ${failed} orphaned job(s)`);
    if (failed > 0) onRequeued?.();
  }
  return { completed, failed };
}

/**
 * Mark in-progress videos as failed once they're old enough that even their own (video-length
 * -specific) wall-clock budget can't explain why they're still running — the absolute
 * last-resort catch, behind the wall-clock hard cap and the updatedAt-based stall detector.
 *
 * maxAgeMinutes is a FLOOR, not the actual cutoff: a flat age limit doesn't make sense across
 * video lengths (a 1-min video's whole budget is ~26 min; a 10-min video's is 100+ min), so the
 * real per-row threshold is max(maxAgeMinutes, that video's own hard-cap-derived budget × 1.5
 * safety margin). Without this, a flat 20-minute sweep (the periodic default) would fail every
 * video of every length that's still legitimately within its own, much larger budget.
 */
export async function expireStuckVideos(maxAgeMinutes = 95) {
  const db = await getDb();
  if (!db) return 0;
  const stuckStatuses = IN_PROGRESS_STATUSES.filter(
    (s) => s !== "awaiting_approval" && s !== "queued"
  );
  // Cheap floor for the query itself — the real per-video decision happens below.
  const floorCutoff = new Date(Date.now() - Math.min(maxAgeMinutes, 15) * 60 * 1000);
  const candidates = await db
    .select()
    .from(videos)
    .where(and(inArray(videos.status, stuckStatuses), sql`${videos.generationStartedAt} < ${floorCutoff}`));

  let total = 0;
  for (const v of candidates) {
    if (!v.generationStartedAt) continue;
    const startedAt = new Date(v.generationStartedAt).getTime();
    const perVideoMaxMs =
      (maxPipelineWallClockHardMin(v.videoLength) * 60_000 + pipelineComposeGraceMs(v.videoLength)) * 1.5;
    const effectiveMaxMs = Math.max(perVideoMaxMs, maxAgeMinutes * 60_000);
    if (Date.now() - startedAt < effectiveMaxMs) continue;
    // F3-47: age past effectiveMaxMs alone used to fail the video here even if it was still
    // actively updating its progress — this is meant to be the "old enough that not even its
    // own wall-clock budget explains it" catch, not a second age-only cap. Same staleness
    // definition failPipelineIfStalled() uses (pipelineStallThresholdMs, driven by updatedAt) —
    // a render still updating updatedAt within that window keeps running regardless of age.
    const updatedAt = v.updatedAt ? new Date(v.updatedAt).getTime() : startedAt;
    const staleProgress = Date.now() - updatedAt >= pipelineStallThresholdMs(v.videoLength, v.status);
    if (!staleProgress) continue;
    const effectiveMaxMinutes = Math.round(effectiveMaxMs / 60_000);
    await db.update(videos)
      .set({
        status: "failed",
        errorMessage: appErrorMessage(
          PIPELINE_ERROR.STUCK_TIMEOUT,
          `Pipeline timed out after ${effectiveMaxMinutes} minutes`
        ),
        progressStep: "Timed out",
      })
      .where(eq(videos.id, v.id));
    total++;
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
  /**
   * False when `url` is a worker-local render temp path (e.g. a still/blur-fill clip or an
   * unrecognized source) rather than a stable, always-reachable URL — that temp file is deleted
   * once the render's workDir is swept, so the editor must not try to load `url` directly for
   * these entries. Omitted (undefined) means true/unknown, matching existing manifests written
   * before this field existed.
   */
  available?: boolean;
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
  MediaArchiveAsset,
  mediaArchiveAssets,
  visualSearchMemory,
  mediaArchives,
  backfillCursors,
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
  // Exclude annotationJson — it's large (can be 50KB+ per row) and no bulk caller needs it.
  // Use getMediaArchiveAssetById() to load the annotation for a single specific asset.
  const { annotationJson: _skip, ...cols } = getTableColumns(mediaArchiveAssets);
  return db
    .select(cols)
    .from(mediaArchiveAssets)
    .where(and(eq(mediaArchiveAssets.archiveId, archiveId), eq(mediaArchiveAssets.isActive, 1)))
    .orderBy(desc(mediaArchiveAssets.sortOrder), desc(mediaArchiveAssets.id));
}

/** Paginated archive assets for the admin list view — excludes annotationJson to avoid loading
 *  large JSON blobs for all rows at once (which can exceed MySQL packet limits for big archives). */
export async function listMediaArchiveAssetsPaginated(
  archiveId: number,
  opts: { limit: number; offset: number; search?: string; tag?: string }
): Promise<{ items: Omit<MediaArchiveAsset, "annotationJson">[]; total: number }> {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };

  // Select all columns EXCEPT annotationJson — not needed for list display.
  const { annotationJson: _skip, ...listColumns } = getTableColumns(mediaArchiveAssets);
  const q = opts.search?.trim();
  const tag = opts.tag?.trim();
  const searchConditions = [];
  if (q) {
    searchConditions.push(
      or(
        like(mediaArchiveAssets.title, `%${q}%`),
        sql`JSON_SEARCH(${mediaArchiveAssets.tags}, 'one', ${`%${q}%`}) IS NOT NULL`
      )
    );
  }
  if (tag) {
    searchConditions.push(
      sql`JSON_SEARCH(${mediaArchiveAssets.tags}, 'one', ${`%${tag}%`}) IS NOT NULL`
    );
  }
  const baseWhere = and(
    eq(mediaArchiveAssets.archiveId, archiveId),
    eq(mediaArchiveAssets.isActive, 1),
    ...searchConditions
  );

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mediaArchiveAssets)
    .where(baseWhere);
  const total = Number(countRow?.count ?? 0);

  const rows = await db
    .select(listColumns)
    .from(mediaArchiveAssets)
    .where(baseWhere)
    .orderBy(desc(mediaArchiveAssets.sortOrder), desc(mediaArchiveAssets.id))
    .limit(opts.limit)
    .offset(opts.offset);

  return { items: rows, total };
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
  const newId = (result as unknown as [{ insertId: number }])[0]?.insertId as number;

  // Async on-ingest annotation — fire-and-forget, never blocks the insert.
  if (newId && process.env.CLIP_ANNOTATOR_ENABLED !== "false") {
    setImmediate(async () => {
      try {
        const { annotateAsset, ANNOTATION_VERSION } = await import("./clipAnnotator");
        const dbConn = await getDb();
        if (!dbConn) return;
        const rows = await dbConn
          .select()
          .from(mediaArchiveAssets)
          .where(eq(mediaArchiveAssets.id, newId))
          .limit(1);
        const asset = rows[0];
        if (!asset || asset.annotationVersion === ANNOTATION_VERSION) return;
        const annotation = await annotateAsset(asset);
        await dbConn.update(mediaArchiveAssets).set({
          annotationJson: annotation,
          editorialScore: annotation.editorialScore.total,
          annotationVersion: ANNOTATION_VERSION,
        }).where(eq(mediaArchiveAssets.id, newId));
        console.log(`[ClipAnnotator] Asset ${newId} geannoteerd bij ingestie (score ${annotation.editorialScore.total})`);
      } catch (err) {
        console.warn(`[ClipAnnotator] On-ingest annotatie mislukt voor asset ${newId}:`, (err as Error).message?.slice(0, 80));
      }
    });
  }

  return newId;
}

export async function updateMediaArchiveAsset(id: number, data: Partial<InsertMediaArchiveAsset>) {
  const db = await getDb();
  if (!db) return;
  await db.update(mediaArchiveAssets).set(data).where(eq(mediaArchiveAssets.id, id));
}

/** F3-26: look up an already-ingested archive asset by its web source URL hash, so a repeat
 *  web-sourcing hit reuses the existing asset instead of re-downloading/re-archiving it. */
export async function findMediaArchiveAssetBySourceUrlHash(sourceUrlHash: string): Promise<MediaArchiveAsset | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(mediaArchiveAssets)
    .where(eq(mediaArchiveAssets.sourceUrlHash, sourceUrlHash))
    .limit(1);
  return rows[0] ?? null;
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
  InsertVisualQueryExpansionCacheRow,
  visualQueryExpansionCache,
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

export async function getVisualQueryExpansionCacheByIntentHash(intentHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(visualQueryExpansionCache)
    .where(eq(visualQueryExpansionCache.intentHash, intentHash))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createVisualQueryExpansionCache(data: InsertVisualQueryExpansionCacheRow) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(visualQueryExpansionCache).values(data);
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

// ─── Visual Matching Engine V2 — resumable backfill cursor ────────────────────

/** Reads the persisted lastProcessedId for one (jobName, provider, model, embeddingVersion)
 *  combination, so a crashed backfill can resume mid-scan instead of starting at id 0 and
 *  rescanning every page. Returns 0 (start from the beginning) when no cursor exists yet,
 *  or when DATABASE_URL is unset — same "degrade to no-op" pattern as the rest of V2. */
export async function getBackfillCursor(jobName: string, provider: string, model: string, embeddingVersion: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select()
    .from(backfillCursors)
    .where(
      and(
        eq(backfillCursors.jobName, jobName),
        eq(backfillCursors.provider, provider),
        eq(backfillCursors.model, model),
        eq(backfillCursors.embeddingVersion, embeddingVersion)
      )
    )
    .limit(1);
  return rows[0]?.lastProcessedId ?? 0;
}

/** Upserts the cursor after each processed page. Plain insert-then-update via the unique
 *  (jobName, provider, model, embeddingVersion) key — no native upsert needed since this is
 *  called at low frequency (once per backfill page, not per asset). */
export async function setBackfillCursor(jobName: string, provider: string, model: string, embeddingVersion: string, lastProcessedId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select({ id: backfillCursors.id })
    .from(backfillCursors)
    .where(
      and(
        eq(backfillCursors.jobName, jobName),
        eq(backfillCursors.provider, provider),
        eq(backfillCursors.model, model),
        eq(backfillCursors.embeddingVersion, embeddingVersion)
      )
    )
    .limit(1);
  if (existing[0]) {
    await db.update(backfillCursors).set({ lastProcessedId }).where(eq(backfillCursors.id, existing[0].id));
  } else {
    await db.insert(backfillCursors).values({ jobName, provider, model, embeddingVersion, lastProcessedId });
  }
}

export async function deleteMediaArchiveAssets(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return 0;
  const uniqueIds = [...new Set(ids)];
  const chunkSize = 500;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    // RONDE 12 (admin "Delete failed"): two tables carry a foreign key to media_archive_assets —
    // media_archive_asset_embeddings.assetId and visual_search_memory.assetId — so MySQL rejects
    // the asset DELETE while any child row still points at it (the exact error seen in the admin).
    // Remove the dependent rows first, then the asset. visual_search_memory.assetId is nullable,
    // so it is cleared (set null) rather than deleting the learned query/source memory; the
    // embedding rows are asset-specific and are deleted outright.
    await db.delete(mediaArchiveAssetEmbeddings).where(inArray(mediaArchiveAssetEmbeddings.assetId, chunk));
    await db
      .update(visualSearchMemory)
      .set({ assetId: null })
      .where(inArray(visualSearchMemory.assetId, chunk));
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
