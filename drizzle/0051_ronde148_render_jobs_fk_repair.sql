-- Repair migration for 0050_ronde148_render_jobs.sql.
--
-- ── The defect ──────────────────────────────────────────────────────────────────────────────
--
-- 0050's CREATE TABLE declares `videoId int NOT NULL` and stops there. It never emits the FOREIGN
-- KEY that drizzle/schema.ts declares on the very same column:
--
--     videoId: int("videoId").notNull().references(() => videos.id)
--
-- So the live database and the code schema disagree, `schemaAuditor` reports
-- `[fk_missing] render_jobs — expected FK (videoId) → videos(id)`, and `validateSchema` aborts
-- startup by design. The production web service crash-looped on exactly this:
--
--     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
--     [Fastvid] Fatal startup error — exiting so Railway marks the deployment failed
--
-- This is a gap in 0050's SQL itself, not a partially applied migration. 0050 is already applied
-- and registered and is deliberately left untouched — the same decision 0043 made about 0042, and
-- for the same reason: editing an applied migration changes its hash, which is what produces the
-- "migration file(s) modified after execution" warnings already visible in the deploy log.
--
-- ── Why the orphan sweep is a DELETE here and a NULL in 0043 ────────────────────────────────
--
-- 0043 repaired the identical class of bug on `visual_search_memory.assetId`, which is NULLABLE —
-- so an orphaned value could simply be nulled. `render_jobs.videoId` is NOT NULL, so that option
-- does not exist: a row pointing at a deleted video either goes, or the FK cannot be added.
--
-- Such a row is already unusable. The worker claims jobs by joining to the video it must render,
-- and the editor loads a job through its video; a job whose video no longer exists can never run
-- and can never be displayed. Deleting it removes a record of an unrunnable job, not data anybody
-- can reach. Expected to be a no-op: the editor route has never run in production.
--
-- Fully idempotent — safe against a database that already has the FK, and safe to re-run.
SET @db = DATABASE();
--> statement-breakpoint

-- Step 1: remove render_jobs rows whose videoId points at no existing video, so the constraint
-- below can be added. No-op when there are none.
DELETE r FROM `render_jobs` r
LEFT JOIN `videos` v ON v.id = r.videoId
WHERE v.id IS NULL;
--> statement-breakpoint

-- Step 2: add the missing FK exactly as the code declares it. `.references(() => videos.id)` sets
-- no .onDelete()/.onUpdate(), so no ON DELETE/ON UPDATE clause is written here either — InnoDB's
-- own default (RESTRICT) applies, and no referential behaviour is invented beyond the declaration.
-- The constraint name follows drizzle's convention, `{table}_{column}_{refTable}_{refColumn}_fk`,
-- so a future `drizzle-kit generate` recognises it as the same constraint rather than emitting a
-- duplicate. Guarded so this is a no-op when the constraint is already present.
SET @addFk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = @db
     AND CONSTRAINT_NAME   = 'render_jobs_videoId_videos_id_fk') = 0,
  'ALTER TABLE `render_jobs` ADD CONSTRAINT `render_jobs_videoId_videos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addFk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
