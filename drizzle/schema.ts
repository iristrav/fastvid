import { float, index, int, json, longtext, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

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
export const videos = mysqlTable(
  "videos",
  {
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
  generationAttempt: int("generationAttempt").default(0).notNull(), // fencing token — bumped each time a fresh run claims this video, so a stale/zombie run (e.g. after a stall-requeue) can detect it's been superseded and stop writing
  videoScenes: json("videoScenes"),                          // scene manifest for editor: [{sceneIndex, narration, durationMs, clips:[{url,type,source}], thumbnailUrl}]
  editedVideoUrl: varchar("editedVideoUrl", { length: 1024 }), // URL of re-rendered edited video (if user edited)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    statusCreatedAtIdx: index("videos_status_createdAt_idx").on(t.status, t.createdAt),
    userIdCreatedAtIdx: index("videos_userId_createdAt_idx").on(t.userId, t.createdAt),
    userIdStatusIdx:    index("videos_userId_status_idx").on(t.userId, t.status),
  })
);

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

export const mediaArchiveAssets = mysqlTable(
  "media_archive_assets",
  {
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
  // F3-26: structured web-sourcing provenance, additive alongside the older free-text
  // sourceNote/licenseNote (kept unchanged so every existing row/reader stays valid). Null for
  // admin-uploaded assets and any pre-F3-26 row — only auto-ingested web assets populate these.
  sourceUrl: text("sourceUrl"),
  /** SHA256 of sourceUrl — same urlHash-lookup convention as mediaAssetCache, since a raw URL
   *  can exceed MySQL's indexable prefix length. Used to detect "already ingested" duplicates
   *  before re-downloading/re-archiving the same web asset. */
  sourceUrlHash: varchar("sourceUrlHash", { length: 64 }),
  sourcePlatform: varchar("sourcePlatform", { length: 64 }),
  sourceCreator: varchar("sourceCreator", { length: 256 }),
  licenseUrl: varchar("licenseUrl", { length: 512 }),
  downloadedAt: timestamp("downloadedAt"),
  originalQuery: varchar("originalQuery", { length: 512 }),
  matchedQuery: varchar("matchedQuery", { length: 512 }),
  /** Recognized entities (people/orgs/places/events) tied to this asset, e.g. ["Justin Bieber"]. */
  entities: json("entities").$type<string[]>(),
  /** General topics tied to this asset, e.g. ["music", "pop culture"]. */
  topics: json("topics").$type<string[]>(),
  width: int("width"),
  height: int("height"),
  durationSec: int("durationSec"),
  sortOrder: int("sortOrder").default(0).notNull(),
  isActive: int("isActive").default(1).notNull(),
  /** Cached overlay-filter verdict: null = not yet checked, 0 = clean, 1 = baked edit text detected. */
  hasBakedEditText: int("hasBakedEditText"),
  /**
   * RONDE 118 — when the asset's preview was last proven readable. Null = never checked.
   *
   * Same convention as hasBakedEditText above: a nullable column where null means "no verdict
   * yet", so every row that predates the check keeps its current behaviour until a sweep looks
   * at it, rather than being retroactively declared broken.
   */
  previewCheckedAt: timestamp("previewCheckedAt"),
  /**
   * Why the preview is unusable, e.g. "no_preview_frame". Null = no known problem.
   *
   * isActive is what actually keeps an asset out of candidate selection — this says WHY, so an
   * operator opening the archive can tell a deactivated-because-broken asset from one that was
   * switched off deliberately.
   */
  previewIssue: varchar("previewIssue", { length: 64 }),
  /** Full editorial annotation produced by the clip annotator at ingest time.
   *  Null = not yet annotated. Never re-computed unless annotationVersion changes. */
  annotationJson: json("annotationJson").$type<import("./annotationTypes").ClipAnnotation>(),
  /** Editorial quality score 0–100. Derived from annotationJson on first write,
   *  then nudged ±1 by adopt/reject feedback. Used as a ranking signal during retrieval. */
  editorialScore: int("editorialScore"),
  /** Version string of the annotator that produced annotationJson, e.g. "v1".
   *  Lets the backfill re-annotate only rows produced by older versions. */
  annotationVersion: varchar("annotationVersion", { length: 16 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // Phase 12: filterMediaArchiveAssets/listMediaArchiveAssetsPaginated (db.ts) filter on
    // archiveId+isActive repeatedly with no index — a full table scan that worsens as the
    // archive library grows, unlike videos' equivalent well-indexed filter columns.
    archiveIdIsActiveIdx: index("media_archive_assets_archiveId_isActive_idx").on(t.archiveId, t.isActive),
    // F3-26: fast "has this web source already been ingested" lookup before re-downloading.
    sourceUrlHashIdx: index("media_archive_assets_sourceUrlHash_idx").on(t.sourceUrlHash),
  })
);

export type MediaArchiveAsset = typeof mediaArchiveAssets.$inferSelect;
export type InsertMediaArchiveAsset = typeof mediaArchiveAssets.$inferInsert;

// ─── F3-26: Visual Search Memory (query/entity/source learning loop) ──────────
/** Remembers which (entity, query, source) combinations previously found usable footage, so a
 *  future beat about the same entity/topic can reuse a proven query+source instead of
 *  rediscovering it from scratch. One row per distinct (entity, query, source) combination —
 *  repeated successful hits increment usageCount instead of inserting duplicate rows. */
export const visualSearchMemory = mysqlTable(
  "visual_search_memory",
  {
    id: int("id").autoincrement().primaryKey(),
    /** Canonical entity name, e.g. "Justin Bieber". */
    entity: varchar("entity", { length: 256 }).notNull(),
    /** person | organization | place | event | topic */
    entityType: varchar("entityType", { length: 32 }).notNull(),
    /** Broader topic/domain this search was for, when distinct from the entity itself. */
    topic: varchar("topic", { length: 256 }),
    /** The search query actually used, e.g. "Justin Bieber 2015 interview". */
    query: varchar("query", { length: 512 }).notNull(),
    /** Provider name, e.g. "internet_archive", "wikimedia", "pexels", "youtube_cc". */
    source: varchar("source", { length: 64 }).notNull(),
    sourceUrl: text("sourceUrl"),
    /** The archive asset this query/source combination produced, when it succeeded. */
    assetId: int("assetId").references(() => mediaArchiveAssets.id),
    success: int("success").notNull().default(1),
    /** 0-100 quality signal for this hit, when available (e.g. editorial/vision score). */
    qualityScore: int("qualityScore"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastUsedAt: timestamp("lastUsedAt").defaultNow().onUpdateNow().notNull(),
    usageCount: int("usageCount").notNull().default(1),
    /** SHA256 of `${entity}|${source}|${query}` (lowercased/trimmed) — same hash-based unique-key
     *  convention as archiveContentGaps.keywordHash, since a composite unique index across three
     *  varchar columns this wide could exceed MySQL's indexable key-length limit. Used for the
     *  onDuplicateKeyUpdate upsert that increments usageCount instead of inserting duplicates. */
    dedupeKeyHash: varchar("dedupeKeyHash", { length: 64 }).notNull().unique(),
  },
  (t) => ({
    entityIdx: index("visual_search_memory_entity_idx").on(t.entity),
  })
);

export type VisualSearchMemoryRow = typeof visualSearchMemory.$inferSelect;
export type InsertVisualSearchMemoryRow = typeof visualSearchMemory.$inferInsert;

// ─── Visual Matching Engine V2: VideoContext + VisualIntent caches ────────────
/** One row per distinct topic — reused across videos sharing the same subject/era. */
export const visualContextCache = mysqlTable(
  "visual_context_cache",
  {
  id: int("id").autoincrement().primaryKey(),
  topicHash: varchar("topicHash", { length: 128 }).notNull(),
  contextJson: json("contextJson").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  // Phase 12: every lookup filters by topicHash (db.ts) — was an unindexed full table scan.
  // Plain (non-unique) index: a unique constraint would additionally require confirming no
  // duplicate-hash rows already exist in production, out of scope for this low-risk pass.
  (t) => ({ topicHashIdx: index("visual_context_cache_topicHash_idx").on(t.topicHash) })
);
export type VisualContextCacheRow = typeof visualContextCache.$inferSelect;
export type InsertVisualContextCacheRow = typeof visualContextCache.$inferInsert;

/** One row per distinct beat intent — reused when an identical beat is re-analyzed. */
export const visualIntentCache = mysqlTable(
  "visual_intent_cache",
  {
  id: int("id").autoincrement().primaryKey(),
  intentHash: varchar("intentHash", { length: 128 }).notNull(),
  intentJson: json("intentJson").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  // Phase 12: see visual_context_cache above — same unindexed-lookup issue.
  (t) => ({ intentHashIdx: index("visual_intent_cache_intentHash_idx").on(t.intentHash) })
);
export type VisualIntentCacheRow = typeof visualIntentCache.$inferSelect;
export type InsertVisualIntentCacheRow = typeof visualIntentCache.$inferInsert;

/** One row per distinct beat intent's LLM query expansion (Phase 3 hybrid query generation,
 *  queryGeneration.ts) — reused whenever the same intent (by intentHash) needs its ranked
 *  queries regenerated, so an identical beat never re-triggers the LLM call twice. */
export const visualQueryExpansionCache = mysqlTable(
  "visual_query_expansion_cache",
  {
  id: int("id").autoincrement().primaryKey(),
  intentHash: varchar("intentHash", { length: 128 }).notNull(),
  queriesJson: json("queriesJson").$type<Array<{ query: string; category: string }>>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  // Phase 12: see visual_context_cache above — same unindexed-lookup issue.
  (t) => ({ intentHashIdx: index("visual_query_expansion_cache_intentHash_idx").on(t.intentHash) })
);
export type VisualQueryExpansionCacheRow = typeof visualQueryExpansionCache.$inferSelect;
export type InsertVisualQueryExpansionCacheRow = typeof visualQueryExpansionCache.$inferInsert;

// ─── Visual Matching Engine V2 — Embedding infrastructure (stage 3) ───────────
/** Permanent embedding cache, keyed by subject (asset id, or a content hash for ad-hoc
 *  text like a search query) + model + embedding_version, so an embedding is computed at
 *  most once per (subject, model, version) triple regardless of provider churn. */
export const embeddingCache = mysqlTable(
  "embedding_cache",
  {
  id: int("id").autoincrement().primaryKey(),
  subjectId: varchar("subjectId", { length: 128 }).notNull(),
  /** Which embedding provider produced this vector, e.g. "voyage". Defaults to "voyage" for
   *  rows written before this column existed. */
  provider: varchar("provider", { length: 64 }).default("voyage").notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  embeddingVersion: varchar("embeddingVersion", { length: 32 }).notNull(),
  embedding: json("embedding").$type<number[]>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  // Phase 12: lookups filter on subjectId+model+embeddingVersion together (db.ts) — was
  // unindexed. Plain composite index, matching the query's own column order.
  (t) => ({
    subjectModelVersionIdx: index("embedding_cache_subjectId_model_embeddingVersion_idx")
      .on(t.subjectId, t.model, t.embeddingVersion),
  })
);
export type EmbeddingCacheRow = typeof embeddingCache.$inferSelect;
export type InsertEmbeddingCacheRow = typeof embeddingCache.$inferInsert;

/** Per-asset embedding storage for the own-archive library. Infrastructure only for stage
 *  3 — no backfill is run yet, so this table starts empty in production. Old and new rows
 *  (different provider/model/embeddingVersion) coexist side by side; nothing deletes a row
 *  on its own — a backfill re-run with a new version just adds new rows alongside old ones. */
export const mediaArchiveAssetEmbeddings = mysqlTable("media_archive_asset_embeddings", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("assetId").notNull().references(() => mediaArchiveAssets.id),
  /** Which embedding provider produced this vector, e.g. "voyage". Defaults to "voyage" for
   *  rows written before this column existed. */
  provider: varchar("provider", { length: 64 }).default("voyage").notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  embeddingVersion: varchar("embeddingVersion", { length: 32 }).notNull(),
  embedding: json("embedding").$type<number[]>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MediaArchiveAssetEmbeddingRow = typeof mediaArchiveAssetEmbeddings.$inferSelect;
export type InsertMediaArchiveAssetEmbeddingRow = typeof mediaArchiveAssetEmbeddings.$inferInsert;

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

/** One row per distinct search keyword that fell back to Pexels/Pixabay because no good
 *  archive match existed — surfaces which topics the archive is missing (Media Archive admin). */
export const archiveContentGaps = mysqlTable("archive_content_gaps", {
  id: int("id").autoincrement().primaryKey(),
  keywordHash: varchar("keywordHash", { length: 64 }).notNull().unique(),
  keyword: varchar("keyword", { length: 256 }).notNull(),
  sampleBeatText: varchar("sampleBeatText", { length: 512 }),
  hitCount: int("hitCount").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
});

export type ArchiveContentGap = typeof archiveContentGaps.$inferSelect;
export type InsertArchiveContentGap = typeof archiveContentGaps.$inferInsert;

// ─── Visual Matching Engine V2 — resumable backfill cursor ────────────────────
/** One row per (jobName, provider, model, embeddingVersion) combination. Lets a
 *  multi-million-asset backfill resume from lastProcessedId after a crash instead of
 *  rescanning every page from the start. Only ever written by
 *  server/visualMatchingV2/embeddings/archiveEmbeddingBackfill.ts. */
export const backfillCursors = mysqlTable("backfill_cursors", {
  id: int("id").autoincrement().primaryKey(),
  jobName: varchar("jobName", { length: 128 }).notNull(),
  provider: varchar("provider", { length: 64 }).notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  embeddingVersion: varchar("embeddingVersion", { length: 32 }).notNull(),
  lastProcessedId: int("lastProcessedId").default(0).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BackfillCursor = typeof backfillCursors.$inferSelect;
export type InsertBackfillCursor = typeof backfillCursors.$inferInsert;

// ─── Visual Matching Engine V2 — Beat selection traces ────────────────────────
/** One row per beat selection call. The full SelectorTrace JSON is stored in `payload`
 *  alongside denormalised index columns for fast queries without parsing JSON.
 *  Retention is controlled at the application layer (e.g. a nightly cron deletes rows
 *  older than N days). No foreign-key to beats — beats may not exist in all envs. */
export const beatSelectionTraces = mysqlTable("beat_selection_traces", {
  id: int("id").autoincrement().primaryKey(),
  /** UUID generated at write time — unique per trace for integrity checks and dedup. */
  traceId: varchar("traceId", { length: 64 }).notNull().unique(),
  beatId: varchar("beatId", { length: 256 }).notNull(),
  videoId: varchar("videoId", { length: 256 }),
  /** UUID of the enclosing pipeline run — join key for VideoQualityReport. */
  pipelineRunId: varchar("pipelineRunId", { length: 64 }),
  selectedCandidateId: varchar("selectedCandidateId", { length: 256 }),
  needsResearch: int("needsResearch").default(0).notNull(),
  researchReason: varchar("researchReason", { length: 64 }),
  confidenceTier: varchar("confidenceTier", { length: 32 }),
  confidence: varchar("confidence", { length: 32 }),
  overallScore: int("overallScore"),
  winnerSource: varchar("winnerSource", { length: 64 }),
  candidateCount: int("candidateCount").notNull(),
  durationMs: int("durationMs").notNull(),
  tieBreakApplied: int("tieBreakApplied").default(0).notNull(),
  traceVersion: varchar("traceVersion", { length: 32 }).notNull(),
  selectorVersion: varchar("selectorVersion", { length: 32 }).notNull(),
  visionVersion: varchar("visionVersion", { length: 32 }).notNull(),
  rankingVersion: varchar("rankingVersion", { length: 32 }).notNull(),
  promptVersion: varchar("promptVersion", { length: 64 }).notNull(),
  schemaVersion: varchar("schemaVersion", { length: 16 }).notNull(),
  engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
  pipelineVersion: varchar("pipelineVersion", { length: 64 }).notNull(),
  host: varchar("host", { length: 256 }).notNull(),
  workerId: varchar("workerId", { length: 128 }).notNull(),
  /** SHA256 of the serialized payload for integrity checks, deduplication, and export. */
  traceHash: varchar("traceHash", { length: 64 }).notNull(),
  contentType: varchar("contentType", { length: 64 }).notNull(),
  payload: longtext("payload").notNull(),
  startedAt: timestamp("startedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BeatSelectionTraceRow = typeof beatSelectionTraces.$inferSelect;
export type InsertBeatSelectionTraceRow = typeof beatSelectionTraces.$inferInsert;

// ─── Visual Matching Engine V2 — Pipeline run traces ─────────────────────────
/** One row per complete video-scene pipeline run. Captures run-level aggregates and
 *  stage timings for VideoQualityReport, separate from per-beat BeatSelectionTrace. */
export const pipelineRunTraces = mysqlTable("pipeline_run_traces", {
  id: int("id").autoincrement().primaryKey(),
  pipelineRunId: varchar("pipelineRunId", { length: 64 }).notNull().unique(),
  videoId: varchar("videoId", { length: 256 }).notNull(),
  pipelineVersion: varchar("pipelineVersion", { length: 64 }).notNull(),
  beatsProcessed: int("beatsProcessed").notNull(),
  beatsSelected: int("beatsSelected").notNull(),
  beatsResearchRequired: int("beatsResearchRequired").notNull(),
  totalDurationMs: int("totalDurationMs").notNull(),
  videoContextMs: int("videoContextMs").notNull(),
  visualIntentMs: int("visualIntentMs").notNull(),
  retrievalTotalMs: int("retrievalTotalMs").notNull(),
  clipTotalMs: int("clipTotalMs").notNull(),
  rankingTotalMs: int("rankingTotalMs").notNull(),
  visionTotalMs: int("visionTotalMs").notNull(),
  selectionTotalMs: int("selectionTotalMs").notNull(),
  startedAt: timestamp("startedAt").notNull(),
  completedAt: timestamp("completedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PipelineRunTraceRow = typeof pipelineRunTraces.$inferSelect;
export type InsertPipelineRunTraceRow = typeof pipelineRunTraces.$inferInsert;

// ─── Visual Matching Engine V2 — Selection feedback ───────────────────────────
/** Human feedback on individual beat selections. Third, independent data source —
 *  never modifies beat_selection_traces or pipeline_run_traces (traces are immutable).
 *  Links to traces by (pipelineRunId, beatId) reference only. */
export const selectionFeedback = mysqlTable("selection_feedback", {
  id: int("id").autoincrement().primaryKey(),
  pipelineRunId: varchar("pipelineRunId", { length: 64 }).notNull(),
  beatId: varchar("beatId", { length: 256 }).notNull(),
  /** The candidate being evaluated — typically the selected one, but may be a rejected
   *  candidate when the reviewer flags a missed alternative. */
  candidateId: varchar("candidateId", { length: 256 }).notNull(),
  feedbackType: mysqlEnum("feedbackType", [
    "correct", "wrong", "acceptable", "preferred_candidate",
    "duplicate", "bad_crop", "wrong_time_period", "wrong_location",
    "wrong_subject", "low_quality", "not_relevant", "other",
  ]).notNull(),
  comment: text("comment"),
  createdBy: varchar("createdBy", { length: 320 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  /** Version metadata — captured at submission so feedback can be grouped by the exact
   *  engine configuration that produced the selection being reviewed. */
  pipelineVersion: varchar("pipelineVersion", { length: 64 }),
  engineVersion: varchar("engineVersion", { length: 32 }),
  visionModel: varchar("visionModel", { length: 128 }),
  embeddingModel: varchar("embeddingModel", { length: 128 }),
  rankingConfigVersion: varchar("rankingConfigVersion", { length: 32 }),
});

export type SelectionFeedbackRow = typeof selectionFeedback.$inferSelect;
export type InsertSelectionFeedbackRow = typeof selectionFeedback.$inferInsert;

/** Full event log for every create/update/delete on selection_feedback rows.
 *  Keeps selection_feedback as current state; this table is the audit trail. */
export const selectionFeedbackEvents = mysqlTable("selection_feedback_events", {
  id: int("id").autoincrement().primaryKey(),
  feedbackId: int("feedbackId").notNull().references(() => selectionFeedback.id),
  eventType: mysqlEnum("eventType", ["created", "updated", "deleted", "restored"]).notNull(),
  /** Full JSON snapshot of the selection_feedback row at the time of the event. */
  snapshot: longtext("snapshot").notNull(),
  /** Identity of the person or system that triggered this event. */
  actor: varchar("actor", { length: 320 }).notNull(),
  changedAt: timestamp("changedAt").defaultNow().notNull(),
});

export type SelectionFeedbackEventRow = typeof selectionFeedbackEvents.$inferSelect;
export type InsertSelectionFeedbackEventRow = typeof selectionFeedbackEvents.$inferInsert;

// ─── Media Asset Cache ────────────────────────────────────────────────────────
/** One row per distinct source URL. Caches raw downloaded assets in R2/S3 so
 *  the same Pexels, Wikimedia, or Archive.org asset is never re-downloaded.
 *  Active only when ENABLE_MEDIA_CACHE=true and S3 storage is configured. */
export const mediaAssetCache = mysqlTable("media_asset_cache", {
  id: int("id").autoincrement().primaryKey(),
  /** SHA256 of the source URL — used as the lookup key. */
  urlHash: varchar("urlHash", { length: 64 }).notNull().unique(),
  /** Full source URL for debugging and cache management. */
  sourceUrl: text("sourceUrl").notNull(),
  /** Relative key in R2/S3 where the asset is stored. */
  r2Key: varchar("r2Key", { length: 512 }).notNull(),
  contentType: varchar("contentType", { length: 64 }).notNull().default("application/octet-stream"),
  fileSizeBytes: int("fileSizeBytes").notNull().default(0),
  /** Duration in seconds for video assets; null for images. Stored as FLOAT (fractional seconds). */
  durationSec: float("durationSec"),
  /** Bump to invalidate all entries (e.g. if encoding settings change). */
  cacheVersion: varchar("cacheVersion", { length: 32 }).notNull().default("1"),
  hitCount: int("hitCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastHitAt: timestamp("lastHitAt").defaultNow().notNull(),
});

export type MediaAssetCacheRow = typeof mediaAssetCache.$inferSelect;
export type InsertMediaAssetCacheRow = typeof mediaAssetCache.$inferInsert;

// ─── Scene Candidate Cache ────────────────────────────────────────────────────
/** One row per (normalised query, source, cacheVersion). Caches search API
 *  responses so Pexels/Wikimedia/Archive.org are not re-queried for the same
 *  topic across videos. expiresAt is compared at read time; expired rows are
 *  replaced on next write. */
export const sceneCandidateCache = mysqlTable(
  "scene_candidate_cache",
  {
  id: int("id").autoincrement().primaryKey(),
  /** SHA256 of normalised(queryText + "|" + source + "|" + cacheVersion). */
  queryHash: varchar("queryHash", { length: 64 }).notNull(),
  /** Original query text for debugging. */
  queryText: varchar("queryText", { length: 512 }).notNull(),
  /** Provider: "pexels" | "pixabay" | "wikimedia" | "archive". */
  source: varchar("source", { length: 32 }).notNull(),
  /** Bump to invalidate entries when retrieval logic changes. */
  cacheVersion: varchar("cacheVersion", { length: 32 }).notNull(),
  /** JSON array of CachedCandidate objects. */
  candidatesJson: longtext("candidatesJson").notNull(),
  hitCount: int("hitCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** Application-managed TTL (typically 7 days). */
  expiresAt: timestamp("expiresAt").notNull(),
  },
  // P0 fix 2: getCandidatePool (sceneCandidateCache.ts) filters on
  // queryHash+source+expiresAt together on every lookup — was unindexed, a full table scan
  // that gets worse as this cross-render cache accumulates rows. Composite index matching the
  // query's own column order, same "Phase 12" pattern already used for the other cache tables
  // in this file (visual_context_cache, visual_intent_cache, etc.).
  (t) => ({
    queryHashSourceExpiresIdx: index("scene_candidate_cache_queryHash_source_expiresAt_idx").on(
      t.queryHash, t.source, t.expiresAt
    ),
  })
);

export type SceneCandidateCacheRow = typeof sceneCandidateCache.$inferSelect;
export type InsertSceneCandidateCacheRow = typeof sceneCandidateCache.$inferInsert;

// ─── Beat Semantic Profile Cache ───────────────────────────────────────────────
/** One row per (normalised beat text + video title + literal visual, cacheVersion).
 *  Caches the LLM's structured visual-search extraction (entities, search tiers,
 *  topic domain) for a beat so identical/near-identical beats — most commonly a
 *  retry of the same video — don't re-pay for the same LLM call. Mirrors the
 *  in-process Map cache in semanticVisualMatching.ts, but survives process
 *  restarts and is shared across worker replicas. */
export const beatSemanticCache = mysqlTable("beat_semantic_cache", {
  id: int("id").autoincrement().primaryKey(),
  /** SHA256 of normalised(beatText + "|" + videoTitle + "|" + cacheVersion). */
  cacheKey: varchar("cacheKey", { length: 64 }).notNull(),
  /** Bump to invalidate entries when the extraction prompt/shape changes. */
  cacheVersion: varchar("cacheVersion", { length: 32 }).notNull(),
  /** JSON-serialized BeatSemanticProfile. */
  profileJson: text("profileJson").notNull(),
  hitCount: int("hitCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BeatSemanticCacheRow = typeof beatSemanticCache.$inferSelect;
export type InsertBeatSemanticCacheRow = typeof beatSemanticCache.$inferInsert;

// ─── LLM Daily Spend Tracker ────────────────────────────────────────────────────
/** One row per UTC calendar day. Accumulates an estimated USD cost (in cents, to
 *  avoid float drift) across every LLM call from every process (web + all worker
 *  replicas) so a daily budget can be enforced application-side — provider
 *  dashboard "hard limits" are not reliably hard-stopping traffic as of 2026. See
 *  server/_core/llmBudget.ts. */
export const llmSpendDaily = mysqlTable("llm_spend_daily", {
  id: int("id").autoincrement().primaryKey(),
  /** UTC calendar day, "YYYY-MM-DD". Enforced unique at the DB level (see migration). */
  day: varchar("day", { length: 10 }).notNull(),
  spentUsdCents: int("spentUsdCents").notNull().default(0),
  callCount: int("callCount").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type LlmSpendDailyRow = typeof llmSpendDaily.$inferSelect;

/** Per-user companion to llm_spend_daily (Phase 1 "AI Gateway" work — tracking only, no
 *  enforcement yet). One row per (userId, day, model); written alongside the existing global
 *  llm_spend_daily row so today's global daily-budget cap is unaffected. See
 *  server/_core/llmBudget.ts recordLlmUsage(). */
export const llmSpendByUser = mysqlTable(
  "llm_spend_by_user",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id),
    day: varchar("day", { length: 10 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    promptTokens: int("promptTokens").notNull().default(0),
    completionTokens: int("completionTokens").notNull().default(0),
    spentUsdCents: int("spentUsdCents").notNull().default(0),
    callCount: int("callCount").notNull().default(0),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    userIdDayIdx: index("llm_spend_by_user_userId_day_idx").on(t.userId, t.day),
    userDayModelUnique: uniqueIndex("llm_spend_by_user_userId_day_model_unique").on(t.userId, t.day, t.model),
  })
);

export type LlmSpendByUserRow = typeof llmSpendByUser.$inferSelect;

// ─── Editorial Review ──────────────────────────────────────────────────────────

export const editorialReviews = mysqlTable(
  "editorial_reviews",
  {
    id: int("id").autoincrement().primaryKey(),
    videoId: varchar("videoId", { length: 128 }).notNull(),
    videoTitle: varchar("videoTitle", { length: 512 }),
    overallScore: int("overallScore").notNull(),
    scores: json("scores").notNull(),
    sourcing: json("sourcing").notNull(),
    feedback: json("feedback").notNull(),
    autoImprovements: json("autoImprovements").notNull(),
    topIssues: json("topIssues").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    videoIdIdx: index("editorial_reviews_videoId_idx").on(t.videoId),
    createdIdx: index("editorial_reviews_created_idx").on(t.createdAt),
  })
);

export type EditorialReviewRow = typeof editorialReviews.$inferSelect;

// ─── Discount Codes ───────────────────────────────────────────────────────────
/**
 * RONDE 147 — discount codes that are REAL codes, not a local table that checkout ignores.
 *
 * The billing flow already creates its Stripe Checkout session with `allow_promotion_codes: true`,
 * so Stripe's own promotion-code box is on the payment page and already honours anything Stripe
 * knows about. Building a second, FastVid-side discount concept would have meant a code that looks
 * valid in the admin panel and does nothing when a customer types it — exactly the outcome the
 * brief rules out.
 *
 * So the admin page creates the code IN STRIPE (a Coupon carrying the discount, plus a Promotion
 * Code carrying the customer-facing string) and this table mirrors it. The mirror is what makes an
 * overview page possible without an API round-trip per row, and it is what holds FastVid's own
 * bookkeeping — who created a code, and when. Stripe stays the source of truth for redemptions.
 *
 * `stripePromotionCodeId` is unique: one row per Stripe promotion code, so a failed create cannot
 * leave two rows pointing at the same object.
 */
export const discountCodes = mysqlTable(
  "discount_codes",
  {
    id: int("id").autoincrement().primaryKey(),
    /** The string a customer types at checkout. Stored uppercase; unique. */
    code: varchar("code", { length: 64 }).notNull().unique(),
    /** The Stripe Coupon holding the actual discount. */
    stripeCouponId: varchar("stripeCouponId", { length: 128 }).notNull(),
    /** The Stripe Promotion Code holding the customer-facing string. */
    stripePromotionCodeId: varchar("stripePromotionCodeId", { length: 128 }).notNull().unique(),
    /** Percentage off, 1–100. Null when this is a fixed-amount code. */
    percentOff: int("percentOff"),
    /** Fixed amount off in the smallest currency unit. Null when this is a percentage code. */
    amountOffCents: int("amountOffCents"),
    /** ISO currency for amountOffCents; null for percentage codes. */
    currency: varchar("currency", { length: 8 }),
    /** 1 = redeemable, 0 = switched off. Mirrors the Stripe promotion code's `active`. */
    isActive: int("isActive").default(1).notNull(),
    /** Optional first moment the code may be used. Null = immediately. */
    startsAt: timestamp("startsAt"),
    /** Optional expiry. Null = no expiry. */
    expiresAt: timestamp("expiresAt"),
    /** Optional cap on total redemptions. Null = unlimited. */
    maxRedemptions: int("maxRedemptions"),
    /** Last known redemption count from Stripe. Refreshed when the admin list is read. */
    timesRedeemed: int("timesRedeemed").default(0).notNull(),
    /** Optional internal label — what this code is for. Never shown to customers. */
    note: varchar("note", { length: 256 }),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    activeIdx: index("discount_codes_isActive_idx").on(t.isActive),
    createdIdx: index("discount_codes_created_idx").on(t.createdAt),
  })
);

export type DiscountCode = typeof discountCodes.$inferSelect;
export type InsertDiscountCode = typeof discountCodes.$inferInsert;
