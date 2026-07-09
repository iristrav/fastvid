/**
 * Migration guard: detects partially applied migrations before Drizzle runs.
 *
 * MySQL's implicit DDL commit means that when a migration fails mid-run (e.g.,
 * an FK constraint fails after CREATE TABLE already committed), the table exists
 * in the DB but the migration is never recorded in __drizzle_migrations. On the
 * next startup Drizzle re-runs the migration and fails with ER_TABLE_EXISTS_ERROR.
 *
 * This guard pre-flights every pending migration, classifies it as:
 *   CLEAN   — no objects exist, safe to run fresh
 *   GHOST   — all tables exist, migration not recorded (interrupted deploy)
 *   PARTIAL — some tables exist, some missing
 *
 * GHOST migrations are auto-repaired: the migration record is inserted into
 * __drizzle_migrations so Drizzle skips them. This works because all migrations
 * are now idempotent (CREATE TABLE IF NOT EXISTS + INFORMATION_SCHEMA guards),
 * so any remaining work (indexes, FKs) was also already applied in the original
 * partial run (or will be handled by the idempotent statements).
 *
 * PARTIAL migrations are re-run if idempotent (IF NOT EXISTS / INFORMATION_SCHEMA
 * guards will skip existing objects and apply missing ones). Non-idempotent partial
 * migrations abort startup with a detailed diagnostic.
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

type MigrationStatus = "clean" | "ghost" | "partial";

interface MigrationAnalysis {
  idx: number;
  tag: string;
  folderMillis: number;
  sqlPath: string;
  rawSql: string;
  hash: string;
  isIdempotent: boolean;
  tablesCreated: string[];
  tablesFoundInDb: string[];
  status: MigrationStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCreatedTableNames(rawSql: string): string[] {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/gi;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawSql)) !== null) names.push(m[1]);
  return Array.from(new Set(names));
}

function detectIdempotency(rawSql: string): boolean {
  return /IF\s+NOT\s+EXISTS/i.test(rawSql) || /INFORMATION_SCHEMA/i.test(rawSql);
}

async function queryRecordedMillis(db: Db): Promise<Set<number>> {
  try {
    const rows = (await db.execute(
      sql`SELECT \`created_at\` FROM \`__drizzle_migrations\``
    )) as unknown as Array<{ created_at: string | number }>;
    return new Set(rows.map((r) => Number(r.created_at)));
  } catch {
    return new Set();
  }
}

async function tableExistsInDb(db: Db, tableName: string): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} LIMIT 1`
  )) as unknown as unknown[];
  return rows.length > 0;
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
      \`id\` serial PRIMARY KEY,
      \`hash\` text NOT NULL,
      \`created_at\` bigint
    )
  `);
}

async function insertMigrationRecord(db: Db, hash: string, folderMillis: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`) VALUES (${hash}, ${folderMillis})`
  );
}

// ─── Main guard ───────────────────────────────────────────────────────────────

export async function runMigrationsWithGuard(
  db: Db,
  migrationsFolder: string,
  drizzleMigrate: (db: Db, config: { migrationsFolder: string }) => Promise<void>
): Promise<void> {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  const total = journal.entries.length;

  const recordedMillis = await queryRecordedMillis(db);
  const recordedCount = recordedMillis.size;

  const pendingEntries = journal.entries.filter((e) => !recordedMillis.has(e.when));

  if (pendingEntries.length === 0) {
    console.log(`[Migration] ✓ ${total} migrations recorded — nothing to apply`);
    return;
  }

  console.log(
    `[Migration] ${recordedCount}/${total} migrations recorded — ${pendingEntries.length} pending`
  );

  // Analyse each pending migration for partial-apply state
  const analyses: MigrationAnalysis[] = [];
  for (const entry of pendingEntries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    const rawSql = fs.readFileSync(sqlPath, "utf-8");
    const hash = createHash("sha256").update(rawSql).digest("hex");
    const tablesCreated = extractCreatedTableNames(rawSql);

    const tablesFoundInDb: string[] = [];
    for (const tbl of tablesCreated) {
      if (await tableExistsInDb(db, tbl)) tablesFoundInDb.push(tbl);
    }

    let status: MigrationStatus;
    if (tablesCreated.length === 0 || tablesFoundInDb.length === 0) {
      status = "clean";
    } else if (tablesFoundInDb.length === tablesCreated.length) {
      status = "ghost";
    } else {
      status = "partial";
    }

    analyses.push({
      idx: entry.idx,
      tag: entry.tag,
      folderMillis: entry.when,
      sqlPath,
      rawSql,
      hash,
      isIdempotent: detectIdempotency(rawSql),
      tablesCreated,
      tablesFoundInDb,
      status,
    });
  }

  const ghosts = analyses.filter((a) => a.status === "ghost");
  const partials = analyses.filter((a) => a.status === "partial");
  const clean = analyses.filter((a) => a.status === "clean");

  // ── Ghost migrations: all tables exist, not recorded ──────────────────────
  if (ghosts.length > 0) {
    console.log(
      `[Migration] ⚠  ${ghosts.length} interrupted migration(s) detected — tables exist but not recorded:`
    );
    for (const a of ghosts) {
      console.log(`[Migration]    ${a.tag}`);
      console.log(`[Migration]      tables    : [${a.tablesCreated.join(", ")}] — all exist in DB`);
      if (!a.isIdempotent) {
        console.error(`[Migration]      ✗ NOT IDEMPOTENT — cannot auto-repair`);
        throw new Error(
          `[Migration] ABORT: ${a.tag} is a ghost migration (tables exist, not recorded) ` +
            `but the SQL has no IF NOT EXISTS / INFORMATION_SCHEMA guards. ` +
            `Manual fix: either drop tables [${a.tablesCreated.join(", ")}] or manually insert ` +
            `a row into __drizzle_migrations with created_at=${a.folderMillis}.`
        );
      }
      console.log(`[Migration]      idempotent: ✓ — auto-repairing migration history`);
    }

    await ensureMigrationsTable(db);
    for (const a of ghosts) {
      await insertMigrationRecord(db, a.hash, a.folderMillis);
      console.log(`[Migration]    ✓ Repaired: ${a.tag} inserted into __drizzle_migrations`);
    }
  }

  // ── Partial migrations: some tables exist, some missing ────────────────────
  if (partials.length > 0) {
    for (const a of partials) {
      const missing = a.tablesCreated.filter((t) => !a.tablesFoundInDb.includes(t));
      console.log(`[Migration] ⚠  Partial migration: ${a.tag}`);
      console.log(`[Migration]    Tables in DB  : [${a.tablesFoundInDb.join(", ")}]`);
      console.log(`[Migration]    Tables missing: [${missing.join(", ")}]`);

      if (!a.isIdempotent) {
        throw new Error(
          `[Migration] ABORT: ${a.tag} is partially applied (tables [${a.tablesFoundInDb.join(", ")}] ` +
            `exist, [${missing.join(", ")}] missing) and the SQL is not idempotent. ` +
            `Manual intervention required: drop [${a.tablesFoundInDb.join(", ")}] or complete the migration manually.`
        );
      }
      console.log(
        `[Migration]    Migration is idempotent — Drizzle will re-run it; existing objects will be skipped`
      );
    }
  }

  // ── Clean migrations: nothing exists yet ──────────────────────────────────
  if (clean.length > 0) {
    console.log(
      `[Migration] ${clean.length} clean migration(s) queued: ${clean.map((a) => a.tag).join(", ")}`
    );
  }

  // ── Run Drizzle (ghosts are now recorded and will be skipped) ─────────────
  await drizzleMigrate(db, { migrationsFolder });

  // ── Final report ──────────────────────────────────────────────────────────
  const finalRecorded = await queryRecordedMillis(db);
  console.log(`[Migration] ✓ ${finalRecorded.size}/${total} migrations recorded`);
  if (ghosts.length > 0) {
    console.log(`[Migration] ✓ ${ghosts.length} ghost migration(s) auto-repaired`);
  }
  if (partials.length > 0) {
    console.log(`[Migration] ✓ ${partials.length} partial migration(s) completed`);
  }
}
