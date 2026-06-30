import { int, json, longtext, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) — kept for backwards compatibility, nullable for standalone auth. */
  openId: varchar("openId", { length: 64 }).unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }).unique(),
  passwordHash: varchar("passwordHash", { length: 256 }), // bcrypt hash for standalone auth
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  subscriptionStatus: mysqlEnum("subscriptionStatus", ["active", "inactive", "cancelled"]).default("inactive").notNull(),
  subscriptionStartDate: timestamp("subscriptionStartDate"),
  subscriptionEndDate: timestamp("subscriptionEndDate"),
  stripeCustomerId: varchar("stripeCustomerId", { length: 128 }),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Invite Codes ─────────────────────────────────────────────────────────────
export const inviteCodes = mysqlTable("invite_codes", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  createdByUserId: int("createdByUserId"), // admin who created it (null = seeded)
  usedByUserId: int("usedByUserId"),       // user who redeemed it
  usedAt: timestamp("usedAt"),
  isActive: int("isActive").default(1).notNull(), // 1 = valid, 0 = revoked
  note: varchar("note", { length: 256 }),          // optional label (e.g. "For John")
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InviteCode = typeof inviteCodes.$inferSelect;
export type InsertInviteCode = typeof inviteCodes.$inferInsert;

// ─── Videos ───────────────────────────────────────────────────────────────────
export const videos = mysqlTable("videos", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  title: varchar("title", { length: 512 }),
  prompt: text("prompt").notNull(),
  videoLength: varchar("videoLength", { length: 16 }).notNull(),
  status: mysqlEnum("status", [
    "pending",
    "queued",
    "generating_script",
    "awaiting_approval",
    "generating_voiceover",
    "generating_visuals",
    "generating_effects",
    "completed",
    "failed",
  ]).default("pending").notNull(),
  videoType: mysqlEnum("videoType", ["documentary", "listicle", "tutorial", "explainer"]).default("documentary").notNull(),
  scriptApproved: int("scriptApproved").default(0).notNull(), // 0=pending, 1=approved, 2=rejected
  customVoiceoverUrl: varchar("customVoiceoverUrl", { length: 1024 }), // user-uploaded audio
  voiceId: varchar("voiceId", { length: 128 }), // Fish Audio reference ID selected by user
  enableSubtitles: int("enableSubtitles").default(1).notNull(), // 1 = subtitles on, 0 = off
  script: longtext("script"),
  voiceoverUrl: varchar("voiceoverUrl", { length: 1024 }),
  videoUrl: varchar("videoUrl", { length: 1024 }),
  thumbnailUrl: varchar("thumbnailUrl", { length: 1024 }),
  metadata: json("metadata"),
  errorMessage: text("errorMessage"),
  progressStep: varchar("progressStep", { length: 256 }),   // e.g. "Writing script..."
  progressPercent: int("progressPercent").default(0),       // 0-100
  progressLog: json("progressLog"),                         // array of {step, startedAt, completedAt?, status}
  generationStartedAt: timestamp("generationStartedAt"),    // when pipeline started
  videoScenes: json("videoScenes"),                          // scene manifest for editor: [{sceneIndex, narration, durationMs, clips:[{url,type,source}], thumbnailUrl}]
  editedVideoUrl: varchar("editedVideoUrl", { length: 1024 }), // URL of re-rendered edited video (if user edited)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = typeof videos.$inferInsert;

// ─── Voices ───────────────────────────────────────────────────────────────────
export const voices = mysqlTable("voices", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  description: varchar("description", { length: 256 }),
  fishAudioReferenceId: varchar("fishAudioReferenceId", { length: 128 }).notNull(),
  exampleAudioUrl: varchar("exampleAudioUrl", { length: 1024 }),
  flag: varchar("flag", { length: 8 }).default("🇺🇸"),   // emoji flag
  isActive: int("isActive").default(1).notNull(),          // 1 = active, 0 = hidden
  sortOrder: int("sortOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Voice = typeof voices.$inferSelect;
export type InsertVoice = typeof voices.$inferInsert;

// ─── Password Reset Tokens ────────────────────────────────────────────────────
export const passwordResetTokens = mysqlTable("password_reset_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  token: varchar("token", { length: 256 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ─── Media Archives (curated niche libraries) ────────────────────────────────
export const mediaArchives = mysqlTable("media_archives", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  description: text("description"),
  /** Topic tags for matching videos to this archive, e.g. ["titanic", "maritime"] */
  nicheTags: json("nicheTags").$type<string[]>(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  isActive: int("isActive").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MediaArchive = typeof mediaArchives.$inferSelect;
export type InsertMediaArchive = typeof mediaArchives.$inferInsert;

export const mediaArchiveAssets = mysqlTable("media_archive_assets", {
  id: int("id").autoincrement().primaryKey(),
  archiveId: int("archiveId").notNull().references(() => mediaArchives.id),
  title: varchar("title", { length: 512 }),
  mediaType: mysqlEnum("mediaType", ["video", "image"]).notNull(),
  mixKind: mysqlEnum("mixKind", ["real_video", "photo", "stock", "screenshot", "motion_graphics"]).default("photo").notNull(),
  mimeType: varchar("mimeType", { length: 128 }).notNull(),
  storageUrl: varchar("storageUrl", { length: 1024 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  /** Searchable tags, e.g. ["titanic", "deck", "1912"] */
  tags: json("tags").$type<string[]>(),
  sourceNote: varchar("sourceNote", { length: 512 }),
  licenseNote: varchar("licenseNote", { length: 256 }),
  width: int("width"),
  height: int("height"),
  durationSec: int("durationSec"),
  sortOrder: int("sortOrder").default(0).notNull(),
  isActive: int("isActive").default(1).notNull(),
  /** Cached overlay-filter verdict: null = not yet checked, 0 = clean, 1 = baked edit text detected. */
  hasBakedEditText: int("hasBakedEditText"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MediaArchiveAsset = typeof mediaArchiveAssets.$inferSelect;
export type InsertMediaArchiveAsset = typeof mediaArchiveAssets.$inferInsert;

// ─── Visual Matching Engine V2: VideoContext + VisualIntent caches ────────────
/** One row per distinct topic — reused across videos sharing the same subject/era. */
export const visualContextCache = mysqlTable("visual_context_cache", {
  id: int("id").autoincrement().primaryKey(),
  topicHash: varchar("topicHash", { length: 128 }).notNull(),
  contextJson: json("contextJson").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type VisualContextCacheRow = typeof visualContextCache.$inferSelect;
export type InsertVisualContextCacheRow = typeof visualContextCache.$inferInsert;

/** One row per distinct beat intent — reused when an identical beat is re-analyzed. */
export const visualIntentCache = mysqlTable("visual_intent_cache", {
  id: int("id").autoincrement().primaryKey(),
  intentHash: varchar("intentHash", { length: 128 }).notNull(),
  intentJson: json("intentJson").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type VisualIntentCacheRow = typeof visualIntentCache.$inferSelect;
export type InsertVisualIntentCacheRow = typeof visualIntentCache.$inferInsert;

// ─── Niche / channel requests ─────────────────────────────────────────────────
export const nicheRequests = mysqlTable("niche_requests", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id),
  contactEmail: varchar("contactEmail", { length: 320 }),
  requestType: mysqlEnum("requestType", ["onboarding", "new_channel"]).default("onboarding").notNull(),
  nicheTitle: varchar("nicheTitle", { length: 256 }).notNull(),
  channelName: varchar("channelName", { length: 256 }),
  videoFormat: varchar("videoFormat", { length: 32 }),
  titleStructure: text("titleStructure"),
  topics: text("topics"),
  subniches: text("subniches"),
  description: text("description"),
  status: mysqlEnum("status", ["pending", "approved", "in_progress", "ready", "rejected"]).default("pending").notNull(),
  adminNotes: text("adminNotes"),
  linkedArchiveId: int("linkedArchiveId"),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NicheRequest = typeof nicheRequests.$inferSelect;
export type InsertNicheRequest = typeof nicheRequests.$inferInsert;
export type NicheRequestStatus = NicheRequest["status"];
export type NicheRequestType = NicheRequest["requestType"];
