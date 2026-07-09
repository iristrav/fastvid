/**
 * Migration guard: pre-flights every pending migration before Drizzle runs.
 *
 * MySQL's implicit DDL commit means that when a migration fails mid-run (e.g.,
 * an FK constraint fails after CREATE TABLE already committed), the table exists
 * in the DB but the migration is never recorded in __drizzle_migrations. On the
 * next startup Drizzle re-runs the migration and fails with ER_TABLE_EXISTS_ERROR.
 *
 * This guard detects GHOST (all tables exist, not recorded) and PARTIAL (some
 * tables exist) states, auto-repairs ghosts, and verifies that recorded migration
 * files have not been modified after execution.
 *
 * Features:
 *   - Ghost migration auto-repair
 *   - Partial migration detection with diagnostic
 *   - Migration file integrity verification (sha256)
 *   - Dry-run mode (MIGRATION_DRY_RUN=true)
 *   - Structured MigrationResult for deployment report
 *   - Recovery hints on every MySQL error code
 *   - Dependency-injected DB ops for testability
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface IntegrityViolation {
  tag: string;
  storedHash: string;
  currentHash: string;
}

export interface MigrationResult {
  totalMigrations: number;
  recordedBefore: number;
  recordedAfter: number;
  executedThisDeploy: number;
  ghostsRepaired: number;
  partialsCompleted: number;
  integrityViolations: IntegrityViolation[];
  dryRun: boolean;
  guardMs: number;
  migrateMs: number;
}

/** Injectable DB operations — mock these in tests. */
export interface MigrationDbOps {
  getRecordedMigrations(): Promise<Array<{ hash: string; created_at: number }>>;
  tableExists(tableName: string): Promise<boolean>;
  ensureMigrationsTable(): Promise<void>;
  insertRecord(hash: string, folderMillis: number): Promise<void>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

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

// ─── Real DB ops factory ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDbOps(db: any): MigrationDbOps {
  return {
    async getRecordedMigrations() {
      try {
        const rows = (await db.execute(
          sql`SELECT \`hash\`, \`created_at\` FROM \`__drizzle_migrations\` ORDER BY \`created_at\``
        )) as unknown as Array<{ hash: string; created_at: string | number }>;
        return rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }));
      } catch {
        return [];
      }
    },

    async tableExists(tableName: string) {
      const rows = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} LIMIT 1`
      )) as unknown as unknown[];
      return rows.length > 0;
    },

    async ensureMigrationsTable() {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
          \`id\` serial PRIMARY KEY,
          \`hash\` text NOT NULL,
          \`created_at\` bigint
        )
      `);
    },

    async insertRecord(hash: string, folderMillis: number) {
      await db.execute(
        sql`INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`) VALUES (${hash}, ${folderMillis})`
      );
    },
  };
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function recoveryHint(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "ER_TABLE_EXISTS_ERROR":
      return (
        "Table already exists — the migration was partially applied before this deploy.\n" +
        "  The migration guard should have detected this. If it did not, check __drizzle_migrations\n" +
        "  and ensure the migration SQL uses CREATE TABLE IF NOT EXISTS."
      );
    case "ER_DUP_FIELDNAME":
      return (
        "Column already exists — use an INFORMATION_SCHEMA.COLUMNS check:\n" +
        "  SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE ...) = 0, 'ALTER TABLE ... ADD COLUMN ...', 'SELECT 1');\n" +
        "  PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;"
      );
    case "ER_DUP_KEY_NAME":
    case "ER_DUP_INDEX":
      return (
        "Index already exists — use an INFORMATION_SCHEMA.STATISTICS check:\n" +
        "  SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE ... AND INDEX_NAME = '...') = 0, 'CREATE INDEX ...', 'SELECT 1');\n" +
        "  PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;"
      );
    case "ER_CANNOT_ADD_FOREIGN":
      return (
        "FK constraint failed — orphaned data exists or the referenced table is missing.\n" +
        "  Fix: NULL out orphaned rows before adding the FK:\n" +
        "  UPDATE child c LEFT JOIN parent p ON p.id = c.parentId\n" +
        "  SET c.parentId = NULL WHERE c.parentId IS NOT NULL AND p.id IS NULL;"
      );
    case "ER_NO_REFERENCED_ROW_2":
      return "A FK referenced row does not exist. Check data integrity before applying this migration.";
    case "ER_LOCK_WAIT_TIMEOUT":
      return "Lock timeout — another process may be holding a lock. Check for long-running transactions.";
    default:
      return message
        ? `MySQL error: ${message}`
        : "Check the SQL statement above and the MySQL docs for this error code.";
  }
}

// ─── Main guard ───────────────────────────────────────────────────────────────

export async function runMigrationsWithGuard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  migrationsFolder: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzleMigrate: (db: any, config: { migrationsFolder: string }) => Promise<void>,
  options?: {
    dryRun?: boolean;
    strictIntegrity?: boolean;
    /** Override DB ops (used in tests) */
    dbOps?: MigrationDbOps;
  }
): Promise<MigrationResult> {
  const t0 = Date.now();
  const dryRun = options?.dryRun ?? process.env.MIGRATION_DRY_RUN === "true";
  const strictIntegrity =
    options?.strictIntegrity ?? process.env.MIGRATION_STRICT_INTEGRITY === "true";
  const ops = options?.dbOps ?? createDbOps(db);

  if (dryRun) {
    console.log("[Migration] *** DRY RUN MODE — no database changes will be made ***");
  }

  // Load journal
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  const total = journal.entries.length;
  const milliToEntry = new Map(journal.entries.map((e) => [e.when, e]));

  // Query current DB state
  const recorded = await ops.getRecordedMigrations();
  const recordedMillisSet = new Set(recorded.map((r) => r.created_at));
  const recordedBefore = recorded.length;

  // ── Integrity verification ─────────────────────────────────────────────────
  const integrityViolations: IntegrityViolation[] = [];
  for (const row of recorded) {
    const entry = milliToEntry.get(row.created_at);
    if (!entry) continue; // unknown / orphaned record — skip
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const currentHash = sha256(fs.readFileSync(sqlPath, "utf-8"));
    if (currentHash !== row.hash) {
      integrityViolations.push({
        tag: entry.tag,
        storedHash: row.hash,
        currentHash,
      });
    }
  }

  if (integrityViolations.length > 0) {
    console.warn(
      `[Migration] ⚠  ${integrityViolations.length} migration file(s) modified after execution:`
    );
    for (const v of integrityViolations) {
      console.warn(`[Migration]    ${v.tag}`);
      console.warn(`[Migration]      stored  hash: ${v.storedHash}`);
      console.warn(`[Migration]      current hash: ${v.currentHash}`);
    }
    if (strictIntegrity) {
      throw new Error(
        `[Migration] ABORT: ${integrityViolations.length} migration file(s) have been modified after ` +
          `execution. Set MIGRATION_STRICT_INTEGRITY=false to downgrade to a warning, or restore the ` +
          `original file content. Modified: ${integrityViolations.map((v) => v.tag).join(", ")}`
      );
    }
    console.warn(
      "[Migration]    Set MIGRATION_STRICT_INTEGRITY=true to abort startup on integrity violations."
    );
  }

  // ── Classify pending migrations ────────────────────────────────────────────
  const pendingEntries = journal.entries.filter((e) => !recordedMillisSet.has(e.when));

  if (pendingEntries.length === 0 && integrityViolations.length === 0) {
    console.log(`[Migration] ✓ ${total} migrations recorded — nothing to apply`);
    return {
      totalMigrations: total,
      recordedBefore,
      recordedAfter: recordedBefore,
      executedThisDeploy: 0,
      ghostsRepaired: 0,
      partialsCompleted: 0,
      integrityViolations,
      dryRun,
      guardMs: Date.now() - t0,
      migrateMs: 0,
    };
  }

  if (pendingEntries.length > 0) {
    console.log(
      `[Migration] ${recordedBefore}/${total} migrations recorded — ${pendingEntries.length} pending`
    );
  }

  const analyses: MigrationAnalysis[] = [];
  for (const entry of pendingEntries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    const rawSql = fs.readFileSync(sqlPath, "utf-8");
    const hash = sha256(rawSql);
    const tablesCreated = extractCreatedTableNames(rawSql);

    const tablesFoundInDb: string[] = [];
    if (!dryRun) {
      for (const tbl of tablesCreated) {
        if (await ops.tableExists(tbl)) tablesFoundInDb.push(tbl);
      }
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

  // ── Dry-run output ─────────────────────────────────────────────────────────
  if (dryRun) {
    for (const a of analyses) {
      console.log(`[Migration:DryRun] ${a.tag} [${a.status.toUpperCase()}]${!a.isIdempotent ? " ⚠ NOT IDEMPOTENT" : ""}`);
      if (a.tablesCreated.length > 0) {
        console.log(`[Migration:DryRun]   tables    : [${a.tablesCreated.join(", ")}]`);
        if (a.tablesFoundInDb.length > 0) {
          console.log(`[Migration:DryRun]   in DB     : [${a.tablesFoundInDb.join(", ")}]`);
        }
      }
      const stmts = a.rawSql.split("--> statement-breakpoint");
      console.log(`[Migration:DryRun]   statements: ${stmts.length}`);
      stmts.forEach((s, i) => {
        const trimmed = s.trim().slice(0, 120);
        if (trimmed) console.log(`[Migration:DryRun]   [${i + 1}] ${trimmed}${s.trim().length > 120 ? "…" : ""}`);
      });
    }
    const guardMs = Date.now() - t0;
    return {
      totalMigrations: total,
      recordedBefore,
      recordedAfter: recordedBefore,
      executedThisDeploy: 0,
      ghostsRepaired: 0,
      partialsCompleted: 0,
      integrityViolations,
      dryRun: true,
      guardMs,
      migrateMs: 0,
    };
  }

  // ── Ghost migrations: all tables exist, not recorded ──────────────────────
  if (ghosts.length > 0) {
    console.log(
      `[Migration] ⚠  ${ghosts.length} ghost migration(s) detected — all tables exist but not recorded:`
    );
    for (const a of ghosts) {
      console.log(`[Migration]    ${a.tag}`);
      console.log(`[Migration]      tables : [${a.tablesCreated.join(", ")}] — all found in DB`);
      // A ghost means the migration ran to completion (every table it creates exists).
      // The migration already executed — we just need to record it. Idempotency is
      // irrelevant here because we are NOT re-running the SQL, only inserting the record.
      console.log(`[Migration]      action : auto-repairing history (migration already applied)`);
    }

    await ops.ensureMigrationsTable();
    for (const a of ghosts) {
      await ops.insertRecord(a.hash, a.folderMillis);
      console.log(`[Migration]    ✓ Repaired: ${a.tag} recorded in __drizzle_migrations`);
    }
  }

  // ── Partial migrations: some tables exist, some missing ────────────────────
  if (partials.length > 0) {
    for (const a of partials) {
      const missing = a.tablesCreated.filter((t) => !a.tablesFoundInDb.includes(t));
      console.log(`[Migration] ⚠  Partial migration detected: ${a.tag}`);
      console.log(`[Migration]    Tables in DB  : [${a.tablesFoundInDb.join(", ")}]`);
      console.log(`[Migration]    Tables missing: [${missing.join(", ")}]`);
      if (!a.isIdempotent) {
        throw new Error(
          `[Migration] ABORT: ${a.tag} is partially applied — ` +
            `tables [${a.tablesFoundInDb.join(", ")}] exist but [${missing.join(", ")}] are missing — ` +
            `and the SQL contains no idempotency guards. ` +
            `Manual intervention required: either drop [${a.tablesFoundInDb.join(", ")}] or complete the migration manually.`
        );
      }
      console.log(
        `[Migration]    Idempotent: ✓ — Drizzle will re-run and skip existing objects via IF NOT EXISTS`
      );
    }
  }

  // ── Clean migrations ───────────────────────────────────────────────────────
  if (clean.length > 0) {
    console.log(
      `[Migration] ${clean.length} clean migration(s) to apply: ${clean.map((a) => a.tag).join(", ")}`
    );
  }

  const guardMs = Date.now() - t0;

  // ── Run Drizzle (ghosts are now recorded and will be skipped) ─────────────
  const t1 = Date.now();
  try {
    await drizzleMigrate(db, { migrationsFolder });
  } catch (e) {
    const cause = (e as { cause?: { sqlMessage?: string; code?: string; sql?: string } }).cause;
    const code = cause?.code;
    const sqlMsg = cause?.sqlMessage;
    const failingSql = cause?.sql;

    console.error("[Migration] *** MIGRATION FAILED ***");
    if (code) console.error(`[Migration] MySQL error code : ${code}`);
    if (sqlMsg) console.error(`[Migration] MySQL error      : ${sqlMsg}`);
    if (failingSql) {
      console.error("[Migration] Failing SQL      :");
      failingSql
        .trim()
        .split("\n")
        .slice(0, 20)
        .forEach((line: string) => console.error(`[Migration]   ${line}`));
    }
    console.error("[Migration] Recovery hint    :", recoveryHint(code, sqlMsg));
    throw e;
  }
  const migrateMs = Date.now() - t1;

  // ── Count what was applied ─────────────────────────────────────────────────
  const recordedAfter = (await ops.getRecordedMigrations()).length;
  const executedThisDeploy = recordedAfter - recordedBefore - ghosts.length;

  console.log(
    `[Migration] ✓ ${recordedAfter}/${total} migrations recorded` +
      (ghosts.length > 0 ? ` (${ghosts.length} ghost(s) repaired)` : "") +
      (partials.length > 0 ? ` (${partials.length} partial(s) completed)` : "")
  );

  return {
    totalMigrations: total,
    recordedBefore,
    recordedAfter,
    executedThisDeploy,
    ghostsRepaired: ghosts.length,
    partialsCompleted: partials.length,
    integrityViolations,
    dryRun: false,
    guardMs,
    migrateMs,
  };
}
