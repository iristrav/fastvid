import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, InsertVideo, users, videos } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); }
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

export async function getVideosByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).where(eq(videos.userId, userId)).orderBy(desc(videos.createdAt));
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
  await db.update(videos).set({ progressStep, progressPercent }).where(eq(videos.id, id));
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

/** Mark in-progress videos older than maxAgeMinutes as failed (stuck pipeline recovery) */
export async function expireStuckVideos(maxAgeMinutes = 70) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stuckStatuses = ["pending", "generating_script", "generating_voiceover", "generating_visuals", "generating_effects"] as const;
  let total = 0;
  for (const s of stuckStatuses) {
    const result = await db.update(videos)
      .set({ status: "failed", errorMessage: `Pipeline timed out after ${maxAgeMinutes} minutes`, progressStep: "Timed out" })
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

export async function seedDefaultVoices() {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select({ count: sql<number>`count(*)` }).from(voices);
  if (Number(existing[0]?.count ?? 0) > 0) return; // already seeded

  // Real Fish Audio S2 Pro voices — verified working with the API
  const defaults: InsertVoice[] = [
    { name: "Energetic Male",  description: "American Male — energetic, YouTube-style narrator",  fishAudioReferenceId: "802e3bc2b27e49c2995d23ef70e6ac89", flag: "🇺🇸", sortOrder: 1, isActive: 1 },
    { name: "Adrian",          description: "American Male — deep, authoritative documentary voice", fishAudioReferenceId: "bf322df2096a46f18c579d0baa36f41d", flag: "🇺🇸", sortOrder: 2, isActive: 1 },
    { name: "Ethan",           description: "American Male — clear, conversational narrator",        fishAudioReferenceId: "536d3a5e000945adb7038665781a4aca", flag: "🇺🇸", sortOrder: 3, isActive: 1 },
    { name: "Sarah",           description: "American Female — warm, professional narrator",         fishAudioReferenceId: "933563129e564b19a115bedd57b7406a", flag: "🇺🇸", sortOrder: 4, isActive: 1 },
    { name: "JJK Narrator",    description: "Male — dramatic, cinematic storytelling voice",         fishAudioReferenceId: "179b5cc736974d96913c7849d0bb68c5", flag: "🎙️", sortOrder: 5, isActive: 1 },
    { name: "Jasphina",        description: "Female — clear, expressive English narrator",           fishAudioReferenceId: "e9b134e4c0b547a3894793be502314f1", flag: "🎙️", sortOrder: 6, isActive: 1 },
  ];
  await db.insert(voices).values(defaults);
}
