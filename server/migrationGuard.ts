/**
 * Migration guard: full schema-object reconciliation before Drizzle runs.
 *
 * Problem: MySQL's implicit DDL commit means that when a migration fails mid-run,
 * previously executed DDL (CREATE TABLE, ADD COLUMN, etc.) is already committed but
 * __drizzle_migrations is never updated. On the next startup Drizzle tries to re-run
 * those statements and fails with ER_TABLE_EXISTS_ERROR / ER_DUP_FIELDNAME / etc.
 *
 * This also covers the "legacy database" case: a DB that was created via drizzle push
 * or a SQL dump has all schema objects in place but __drizzle_migrations is empty or
 * incomplete. In that case the guard reconstructs migration history from INFORMATION_SCHEMA.
 *
 * Reconciliation strategy (per pending migration):
 *   1. Extract ALL schema objects the migration creates or modifies:
 *      tables, columns, indexes, FKs, unique constraints.
 *   2. Check INFORMATION_SCHEMA to see which objects already exist.
 *   3. Classify as GHOST (all exist), PARTIAL (some), or CLEAN (none).
 *   4. GHOST → auto-repair by inserting the record. Drizzle then skips it.
 *   5. PARTIAL idempotent → let Drizzle re-run (IF NOT EXISTS guards protect it).
 *   6. PARTIAL non-idempotent → abort with diagnosis.
 *   7. CLEAN → let Drizzle run normally.
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
  // Extended checks for full schema-object reconciliation (optional for backward compat):
  columnExists?(table: string, column: string): Promise<boolean>;
  indexExists?(table: string, indexName: string): Promise<boolean>;
  fkExists?(constraintName: string): Promise<boolean>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

type MigrationStatus = "clean" | "ghost" | "partial";

interface SchemaObject {
  kind: "table" | "column" | "index" | "fk";
  /** Table name context (empty for table/fk kinds when unknown) */
  table: string;
  /** Table name for 'table' kind; column/index/fk name otherwise */
  name: string;
}

interface MigrationAnalysis {
  idx: number;
  tag: string;
  folderMillis: number;
  sqlPath: string;
  rawSql: string;
  hash: string;
  isIdempotent: boolean;
  schemaObjects: SchemaObject[];
  existingObjects: SchemaObject[];
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

    async columnExists(table: string, column: string) {
      const rows = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLUMN_NAME = ${column} LIMIT 1`
      )) as unknown as unknown[];
      return rows.length > 0;
    },

    async indexExists(table: string, indexName: string) {
      const rows = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = ${indexName} LIMIT 1`
      )) as unknown as unknown[];
      return rows.length > 0;
    },

    async fkExists(constraintName: string) {
      const rows = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ${constraintName} LIMIT 1`
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

// ─── Schema object extraction ─────────────────────────────────────────────────

/**
 * Extract all schema objects (tables, columns, indexes, FKs) that a migration
 * creates or modifies. Used to determine migration status via INFORMATION_SCHEMA.
 *
 * Note: INFORMATION_SCHEMA patterns inside string literals (idempotent migrations)
 * may produce false extractions, but that's harmless: if the object already exists
 * the migration is still correctly classified as GHOST/PARTIAL.
 */
function extractSchemaObjects(rawSql: string): SchemaObject[] {
  const objects: SchemaObject[] = [];
  const seen = new Set<string>();

  const add = (obj: SchemaObject) => {
    const key = `${obj.kind}:${obj.table}:${obj.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      objects.push(obj);
    }
  };

  // CREATE TABLE [IF NOT EXISTS] `name`
  Array.from(rawSql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/gi)).forEach(
    (m) => add({ kind: "table", table: "", name: m[1] })
  );

  // ALTER TABLE `t` ... ADD [COLUMN] `col` (not CONSTRAINT / KEY / INDEX / UNIQUE)
  Array.from(
    rawSql.matchAll(
      /ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bADD\s+(?!CONSTRAINT\b)(?!KEY\b)(?!INDEX\b)(?!UNIQUE\b)(?:COLUMN\s+)?`([^`]+)`/gi
    )
  ).forEach((m) => add({ kind: "column", table: m[1], name: m[2] }));

  // ALTER TABLE `t` ... MODIFY [COLUMN] `col`
  Array.from(
    rawSql.matchAll(/ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bMODIFY\s+(?:COLUMN\s+)?`([^`]+)`/gi)
  ).forEach((m) => add({ kind: "column", table: m[1], name: m[2] }));

  // ALTER TABLE `t` ... CHANGE [COLUMN] `old` `new` — check the NEW column name
  Array.from(
    rawSql.matchAll(
      /ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bCHANGE\s+(?:COLUMN\s+)?`[^`]+`\s+`([^`]+)`/gi
    )
  ).forEach((m) => add({ kind: "column", table: m[1], name: m[2] }));

  // ADD CONSTRAINT `name` FOREIGN KEY
  Array.from(rawSql.matchAll(/ADD\s+CONSTRAINT\s+`([^`]+)`\s+FOREIGN\s+KEY/gi)).forEach((m) =>
    add({ kind: "fk", table: "", name: m[1] })
  );

  // ALTER TABLE `t` ... ADD CONSTRAINT `name` UNIQUE  (unique index)
  Array.from(
    rawSql.matchAll(
      /ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bADD\s+CONSTRAINT\s+`([^`]+)`\s+UNIQUE/gi
    )
  ).forEach((m) => add({ kind: "index", table: m[1], name: m[2] }));

  // CREATE [UNIQUE] INDEX `name` ON `table`
  Array.from(
    rawSql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`\s+ON\s+`([^`]+)`/gi)
  ).forEach((m) => add({ kind: "index", table: m[2], name: m[1] }));

  return objects;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectIdempotency(rawSql: string): boolean {
  return /IF\s+NOT\s+EXISTS/i.test(rawSql) || /INFORMATION_SCHEMA/i.test(rawSql);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function checkObjectExists(obj: SchemaObject, ops: MigrationDbOps): Promise<boolean | null> {
  switch (obj.kind) {
    case "table":
      return ops.tableExists(obj.name);
    case "column":
      return ops.columnExists ? ops.columnExists(obj.table, obj.name) : null;
    case "index":
      return ops.indexExists ? ops.indexExists(obj.table, obj.name) : null;
    case "fk":
      return ops.fkExists ? ops.fkExists(obj.name) : null;
  }
}

function recoveryHint(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "ER_TABLE_EXISTS_ERROR":
      return (
        "Table already exists — the migration was partially applied before this deploy.\n" +
        "  Ensure the migration SQL uses CREATE TABLE IF NOT EXISTS."
      );
    case "ER_DUP_FIELDNAME":
      return (
        "Column already exists — use an INFORMATION_SCHEMA.COLUMNS check:\n" +
        "  SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE ...) = 0,\n" +
        "    'ALTER TABLE ... ADD COLUMN ...', 'SELECT 1');\n" +
        "  PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;"
      );
    case "ER_DUP_KEY_NAME":
    case "ER_DUP_INDEX":
      return (
        "Index already exists — use an INFORMATION_SCHEMA.STATISTICS check:\n" +
        "  SET @s = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE ...) = 0,\n" +
        "    'CREATE INDEX ...', 'SELECT 1');\n" +
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
      return "Lock timeout — another process may be holding a lock.";
    default:
      return message ?? "Check the SQL statement and the MySQL docs for this error code.";
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
    if (!entry) continue;
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const currentHash = sha256(fs.readFileSync(sqlPath, "utf-8"));
    if (currentHash !== row.hash) {
      integrityViolations.push({ tag: entry.tag, storedHash: row.hash, currentHash });
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
        `[Migration] ABORT: ${integrityViolations.length} migration file(s) modified after ` +
          `execution. Modified: ${integrityViolations.map((v) => v.tag).join(", ")}`
      );
    }
    console.warn(
      "[Migration]    Set MIGRATION_STRICT_INTEGRITY=true to abort on integrity violations."
    );
  }

  // ── Classify pending migrations ────────────────────────────────────────────
  const pendingEntries = journal.entries.filter((e) => !recordedMillisSet.has(e.when));

  if (pendingEntries.length === 0 && integrityViolations.length === 0) {
    console.log(`[Migration] ✓ ${total}/${total} migrations recorded — nothing to apply`);
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
    console.log("[Migration] Running schema reconciliation...");
  }

  const analyses: MigrationAnalysis[] = [];
  for (const entry of pendingEntries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    const rawSql = fs.readFileSync(sqlPath, "utf-8");
    const hash = sha256(rawSql);
    const schemaObjects = extractSchemaObjects(rawSql);

    const existingObjects: SchemaObject[] = [];
    let checkableTotal = 0;
    let unverifiableTotal = 0;

    if (!dryRun && schemaObjects.length > 0) {
      for (const obj of schemaObjects) {
        const exists = await checkObjectExists(obj, ops);
        if (exists === null) {
          // Existence cannot be verified (ops method unavailable).
          unverifiableTotal++;
          continue;
        }
        checkableTotal++;
        if (exists) existingObjects.push(obj);
      }
    }

    let status: MigrationStatus;
    if (dryRun || schemaObjects.length === 0) {
      // Dry run, or nothing to reconcile → let Drizzle decide.
      status = "clean";
    } else if (unverifiableTotal > 0) {
      // At least one object cannot be verified. Never record-without-run in
      // this case: if some checkable objects exist it is a genuine partial,
      // otherwise treat as clean and let Drizzle run the migration.
      status = existingObjects.length > 0 ? "partial" : "clean";
    } else if (checkableTotal > 0 && existingObjects.length === checkableTotal) {
      // Every object the migration defines is checkable AND confirmed present.
      status = "ghost";
    } else if (existingObjects.length === 0) {
      status = "clean";
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
      schemaObjects,
      existingObjects,
      status,
    });
  }

  const ghosts = analyses.filter((a) => a.status === "ghost");
  const partials = analyses.filter((a) => a.status === "partial");
  const clean = analyses.filter((a) => a.status === "clean");

  // ── Reconciliation report ──────────────────────────────────────────────────
  console.log(`[Migration] Reconciliation result:`);
  for (const a of analyses) {
    const objSummary = summarizeObjects(a.schemaObjects);
    const statusLabel =
      a.status === "ghost"
        ? "GHOST → auto-repair"
        : a.status === "partial"
          ? `PARTIAL (${a.existingObjects.length}/${a.schemaObjects.length} objects exist)${a.isIdempotent ? " [idempotent — safe to re-run]" : " ⚠ NOT IDEMPOTENT"}`
          : `CLEAN → will run${a.isIdempotent ? " [idempotent]" : ""}`;
    console.log(`[Migration]   ${a.tag.padEnd(50)} ${statusLabel}`);
    if (objSummary) {
      console.log(`[Migration]     objects: ${objSummary}`);
    }
  }
  console.log(
    `[Migration] Summary: ${ghosts.length} ghost(s) to repair, ${partials.length} partial(s), ${clean.length} clean`
  );

  // ── Dry-run exit ───────────────────────────────────────────────────────────
  if (dryRun) {
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

  // ── Ghost auto-repair: insert records for fully-applied migrations ──────────
  if (ghosts.length > 0) {
    console.log(`[Migration] Auto-repairing ${ghosts.length} ghost migration(s)...`);
    await ops.ensureMigrationsTable();
    for (const a of ghosts) {
      await ops.insertRecord(a.hash, a.folderMillis);
      console.log(`[Migration]   ✓ ${a.tag} — recorded in __drizzle_migrations`);
    }
  }

  // ── Partial migration checks ───────────────────────────────────────────────
  for (const a of partials) {
    const missingObjects = a.schemaObjects.filter(
      (o) =>
        !a.existingObjects.some((e) => e.kind === o.kind && e.table === o.table && e.name === o.name)
    );
    const missingDesc = missingObjects.map((o) => `${o.kind}:${o.name}`).join(", ");
    const existsDesc = a.existingObjects.map((o) => `${o.kind}:${o.name}`).join(", ");
    console.log(`[Migration] ⚠  Partial migration: ${a.tag}`);
    console.log(`[Migration]    Existing : ${existsDesc}`);
    console.log(`[Migration]    Missing  : ${missingDesc}`);
    if (!a.isIdempotent) {
      throw new Error(
        `[Migration] ABORT: ${a.tag} is partially applied and NOT idempotent.\n` +
          `  Existing objects: ${existsDesc}\n` +
          `  Missing objects:  ${missingDesc}\n` +
          `  Manual fix: drop [${a.existingObjects.map((o) => o.name).join(", ")}] or complete the migration manually.\n` +
          `  Long-term fix: make the migration idempotent with IF NOT EXISTS / INFORMATION_SCHEMA guards.`
      );
    }
    console.log(`[Migration]    Idempotent ✓ — Drizzle will re-run safely`);
  }

  // ── Clean migrations ───────────────────────────────────────────────────────
  if (clean.length > 0) {
    console.log(
      `[Migration] Running ${clean.length} clean migration(s): ${clean.map((a) => a.tag).join(", ")}`
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
  const executedThisDeploy = Math.max(0, recordedAfter - recordedBefore - ghosts.length);

  console.log(
    `[Migration] ✓ ${recordedAfter}/${total} migrations recorded` +
      (ghosts.length > 0 ? ` (${ghosts.length} ghost(s) repaired)` : "") +
      (partials.length > 0 ? ` (${partials.length} partial(s) re-run)` : "") +
      (executedThisDeploy > 0 ? ` (${executedThisDeploy} new)` : "")
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

// ─── Formatting helpers ───────────────────────────────────────────────────────

function summarizeObjects(objects: SchemaObject[]): string {
  if (objects.length === 0) return "";
  const tables = objects.filter((o) => o.kind === "table").map((o) => o.name);
  const columns = objects
    .filter((o) => o.kind === "column")
    .map((o) => `${o.table}.${o.name}`);
  const indexes = objects.filter((o) => o.kind === "index").map((o) => o.name);
  const fks = objects.filter((o) => o.kind === "fk").map((o) => o.name);
  const parts: string[] = [];
  if (tables.length) parts.push(`tables[${tables.join(",")}]`);
  if (columns.length) parts.push(`cols[${columns.slice(0, 4).join(",")}${columns.length > 4 ? `…+${columns.length - 4}` : ""}]`);
  if (indexes.length) parts.push(`idx[${indexes.join(",")}]`);
  if (fks.length) parts.push(`fk[${fks.join(",")}]`);
  return parts.join(" ");
}
