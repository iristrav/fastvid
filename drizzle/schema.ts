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
