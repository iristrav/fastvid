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
  /**
   * RONDE 269 — how many PHYSICAL rows `__drizzle_migrations` holds, and how many of them are
   * redundant copies of an identity already recorded.
   *
   * `recordedBefore`/`recordedAfter` count CANONICAL migrations, which is what "N/53 recorded"
   * was always meant to say. Production printed `1457/53` because it counted rows, and a
   * denominator of 53 against a numerator of 1457 is not a ratio anybody can read.
   *
   * The duplicate count is not hidden by that repair — it is reported here, on purpose, because
   * it is the finding. Zero on a healthy database.
   */
  physicalRows: number;
  duplicateRows: number;
  /** Identities recorded more than once with DIFFERENT hashes. See `canonicaliseRecorded`. */
  hashConflicts: number;
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
  deleteRecord(folderMillis: number): Promise<void>;
  updateHash(folderMillis: number, newHash: string): Promise<void>;
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
  /**
   * RONDE 178 — this object is TRANSFORMED by the migration, not created by it.
   *
   * A MODIFY/CHANGE COLUMN changes a column that already exists, so its existence proves nothing
   * about whether the migration ran. See the ghost classification below for what that cost.
   */
  transform?: boolean;
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
        // db.execute() returns the raw mysql2 tuple [RowDataPacket[], FieldPacket[]].
        // The actual rows are at index 0.
        const res = (await db.execute(
          sql`SELECT \`hash\`, \`created_at\` FROM \`__drizzle_migrations\` ORDER BY \`created_at\``
        )) as unknown as [Array<{ hash: string; created_at: string | number }>, unknown];
        const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
        return rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }));
      } catch {
        return [];
      }
    },

    async tableExists(tableName: string) {
      const res = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} LIMIT 1`
      )) as unknown as [unknown[], unknown];
      const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
      return rows.length > 0;
    },

    async columnExists(table: string, column: string) {
      const res = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLUMN_NAME = ${column} LIMIT 1`
      )) as unknown as [unknown[], unknown];
      const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
      return rows.length > 0;
    },

    async indexExists(table: string, indexName: string) {
      const res = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = ${indexName} LIMIT 1`
      )) as unknown as [unknown[], unknown];
      const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
      return rows.length > 0;
    },

    async fkExists(constraintName: string) {
      const res = (await db.execute(
        sql`SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ${constraintName} LIMIT 1`
      )) as unknown as [unknown[], unknown];
      const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
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
      /**
       * RONDE 269 — RECORD AN IDENTITY ONCE, NOT ONCE PER DEPLOY.
       *
       * Production reached 1457 rows for 53 migrations: ~27 redundant copies each, one round per
       * deploy. A plain INSERT cannot tell "record this migration" from "record it again", and the
       * table has no unique key on `created_at` to refuse the second one — so every ghost repair
       * that re-recorded an already-recorded identity added a row, and the guard's own startup cost
       * grew with the deployment history.
       *
       * The conditional insert makes this operation idempotent, which is what the caller always
       * meant by it. It does not add a constraint and does not rewrite the table: a schema change
       * on the migration bookkeeping table is exactly the kind of destructive repair this round is
       * forbidden to make, and it would fail anyway while the duplicates are still there.
       *
       * This stops the guard from adding duplicates. It cannot stop drizzle's own migrator from
       * inserting its record, which is by design — that write is drizzle's to make.
       */
      await db.execute(
        sql`INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`)
            SELECT ${hash}, ${folderMillis} FROM DUAL
            WHERE NOT EXISTS (
              SELECT 1 FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${folderMillis}
            )`
      );
    },

    async deleteRecord(folderMillis: number) {
      await db.execute(
        sql`DELETE FROM \`__drizzle_migrations\` WHERE \`created_at\` = ${folderMillis}`
      );
    },

    async updateHash(folderMillis: number, newHash: string) {
      await db.execute(
        sql`UPDATE \`__drizzle_migrations\` SET \`hash\` = ${newHash} WHERE \`created_at\` = ${folderMillis}`
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

  /**
   * ALTER TABLE `t` ... MODIFY / CHANGE [COLUMN] `col`
   *
   * RONDE 178 — marked as a TRANSFORM, which is what took production down.
   *
   * These two were extracted exactly like an ADD COLUMN, and a column's existence was then read as
   * "the migration already ran". For an ADD that inference is sound: the column is there because
   * the migration put it there. For a MODIFY it is worthless — the column is there because the
   * migration is about to change it, and it was there before too.
   *
   * So every MODIFY migration was classified GHOST, recorded as executed, and never run. Migration
   * 0048 (durationSec int → float) was the first MODIFY this repository ever had, which is why a
   * latent fault of this size had never fired: all 47 migrations before it were CREATE TABLE or
   * ADD COLUMN. The schema validator then correctly found int where the code said float and aborted
   * startup, on every boot, with no way to self-heal — the migration was already recorded, so the
   * runner skipped it too.
   */
  Array.from(
    rawSql.matchAll(/ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bMODIFY\s+(?:COLUMN\s+)?`([^`]+)`/gi)
  ).forEach((m) => add({ kind: "column", table: m[1], name: m[2], transform: true }));

  // CHANGE renames as well as retypes; the new name may not exist yet, but the OLD one does, so
  // presence is just as uninformative here.
  Array.from(
    rawSql.matchAll(
      /ALTER\s+TABLE\s+`([^`]+)`[^;]*?\bCHANGE\s+(?:COLUMN\s+)?`[^`]+`\s+`([^`]+)`/gi
    )
  ).forEach((m) => add({ kind: "column", table: m[1], name: m[2], transform: true }));

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

/**
 * RONDE 269 — ONE MIGRATION IDENTITY, HOWEVER MANY ROWS RECORD IT.
 *
 * ── What production measured ────────────────────────────────────────────────────────────────
 *
 *     [Fastvid]   Recorded migrations : 1457/53
 *     [Fastvid]   Guard time          : 447903ms
 *     [Fastvid]   Drizzle migrate     : 648ms
 *     [Fastvid] Server running on port 8080      ← 7 min 29 s after boot
 *     Railway healthcheckTimeout: 180s           → container killed, restart loop
 *
 * `__drizzle_migrations` held 1457 rows for 53 migrations. Every loop below that walked `recorded`
 * therefore ran 27× more often than there are migrations — and the false-record cleanup runs one
 * remote INFORMATION_SCHEMA query PER SCHEMA OBJECT PER ROW. At ~2.2 objects per migration that is
 * roughly 3200 sequential round trips at ~140ms each, which is the 448 seconds almost exactly.
 *
 * The database was never slow. The query COUNT was 27× too high, and it grows by ~53 rows every
 * deploy — so the startup time grows with the deployment history until it crosses the healthcheck
 * window, which is what happened.
 *
 * ── Why canonicalise rather than de-duplicate the table ─────────────────────────────────────
 *
 * Deleting rows is a separate, data-touching decision that needs its own evidence. This makes the
 * GUARD correct regardless of how many redundant rows exist: the work it does is bounded by the
 * number of migrations, which is what it was always meant to be bounded by. A database that is
 * never cleaned up still starts in seconds.
 *
 * ── The one thing this must not do ──────────────────────────────────────────────────────────
 *
 * A plain `new Map(rows.map(r => [r.created_at, r.hash]))` would collapse these rows in one line
 * and SILENTLY DISCARD every hash but the last. That is exactly the failure this codebase keeps
 * finding: the answer is computed, and the disagreement is thrown away before anyone can read it.
 * Two rows for one identity carrying DIFFERENT hashes is an integrity problem and has to stay
 * visible, so every distinct hash is kept and the conflict is counted.
 */
export type CanonicalRecord = {
  created_at: number;
  /** Every DISTINCT stored hash for this identity, in first-seen order. Never collapsed to one. */
  hashes: string[];
  /** Physical rows carrying this identity. 1 on a healthy database. */
  rowCount: number;
};

export type CanonicalRecorded = {
  canonical: CanonicalRecord[];
  /** Rows beyond the first for each identity — pure bookkeeping redundancy. */
  duplicateRows: number;
  /** Identities whose duplicate rows DISAGREE about the hash. A real integrity problem. */
  hashConflicts: number;
};

export function canonicaliseRecorded(
  recorded: ReadonlyArray<{ hash: string; created_at: number }>
): CanonicalRecorded {
  const byIdentity = new Map<number, CanonicalRecord>();
  for (const row of recorded) {
    const existing = byIdentity.get(row.created_at);
    if (!existing) {
      byIdentity.set(row.created_at, { created_at: row.created_at, hashes: [row.hash], rowCount: 1 });
      continue;
    }
    existing.rowCount += 1;
    /** Kept, not overwritten — a second hash for one identity is the thing worth knowing. */
    if (!existing.hashes.includes(row.hash)) existing.hashes.push(row.hash);
  }
  const canonical = [...byIdentity.values()].sort((a, b) => a.created_at - b.created_at);
  return {
    canonical,
    duplicateRows: recorded.length - canonical.length,
    hashConflicts: canonical.filter((c) => c.hashes.length > 1).length,
  };
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
  const resyncHashes = process.env.MIGRATION_RESYNC_HASHES === "true";
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
  const recordedRows = await ops.getRecordedMigrations();
  /**
   * RONDE 269 — collapse rows to IDENTITIES before anything expensive reads them.
   *
   * Everything below walks `canonical`, so the guard's cost is bounded by the number of
   * migrations rather than by how many redundant rows the deployment history has accumulated.
   * See `canonicaliseRecorded` for the 448-second production measurement that forced this, and
   * for why the distinct hashes are kept instead of collapsed.
   */
  const { canonical, duplicateRows, hashConflicts } = canonicaliseRecorded(recordedRows);
  const recordedMillisSet = new Set(canonical.map((r) => r.created_at));
  const recordedBefore = canonical.length;

  if (duplicateRows > 0) {
    console.warn(
      `[Migration] ⚠  ${recordedRows.length} rows in __drizzle_migrations for ${canonical.length} ` +
        `migration(s) — ${duplicateRows} redundant row(s). The guard works on identities, so this ` +
        `costs no startup time, but the table is carrying history it does not need.`
    );
  }

  // ── Integrity verification ─────────────────────────────────────────────────
  const integrityViolations: IntegrityViolation[] = [];
  for (const rec of canonical) {
    const entry = milliToEntry.get(rec.created_at);
    if (!entry) continue;
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const currentHash = sha256(fs.readFileSync(sqlPath, "utf-8"));
    /**
     * Two different questions, kept apart:
     *
     *   · the identity's rows DISAGREE with each other  → a conflict, reported as such and never
     *     silently resolved in favour of whichever row happened to be read last;
     *   · the rows agree and disagree with the FILE     → the ordinary "modified after execution"
     *     violation this check has always reported.
     *
     * Both are violations. Only the wording differs, and one violation is now raised per IDENTITY
     * rather than per row — production printed 0047 twice for one file, which read as two problems.
     */
    if (rec.hashes.length > 1) {
      integrityViolations.push({
        tag: entry.tag,
        storedHash: `CONFLICT(${rec.hashes.join(" | ")})`,
        currentHash,
      });
      continue;
    }
    if (currentHash !== rec.hashes[0]) {
      integrityViolations.push({ tag: entry.tag, storedHash: rec.hashes[0]!, currentHash });
    }
  }

  if (hashConflicts > 0) {
    console.warn(
      `[Migration] ⚠  ${hashConflicts} migration identity(ies) recorded with MORE THAN ONE hash — ` +
        `the duplicate rows disagree about what was executed. Listed above; nothing is chosen ` +
        `automatically.`
    );
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
    if (resyncHashes && !dryRun) {
      for (const v of integrityViolations) {
        const entry = journal.entries.find((e) => e.tag === v.tag);
        if (!entry) continue;
        await ops.updateHash(entry.when, v.currentHash);
        console.log(`[Migration]    Resynced hash for ${v.tag}`);
      }
      console.log("[Migration]  ✓ Hash resync complete — unset MIGRATION_RESYNC_HASHES to resume normal mode");
    } else if (strictIntegrity) {
      throw new Error(
        `[Migration] ABORT: ${integrityViolations.length} migration file(s) modified after ` +
          `execution. Modified: ${integrityViolations.map((v) => v.tag).join(", ")}`
      );
    } else {
      console.warn(
        "[Migration]    Set MIGRATION_RESYNC_HASHES=true to update stored hashes, or MIGRATION_STRICT_INTEGRITY=true to abort."
      );
    }
  }

  // ── False-record cleanup ───────────────────────────────────────────────────
  // Previous deploys may have inserted records into __drizzle_migrations without
  // running the DDL (due to the mysql2 tuple-unwrap bug). Detect and remove them
  // so Drizzle will re-run the missing DDL on this startup.
  if (!dryRun) {
    let falseRecordsFound = 0;
    /**
     * RONDE 269 — `canonical`, not `recordedRows`. THIS is the loop that cost 448 seconds: it
     * runs a remote INFORMATION_SCHEMA query per schema object, and it used to do that once per
     * physical row. 53 identities instead of 1457 rows is the whole repair.
     */
    for (const row of canonical) {
      const entry = milliToEntry.get(row.created_at);
      if (!entry) continue;
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) continue;
      const rawSql = fs.readFileSync(sqlPath, "utf-8");
      const schemaObjects = extractSchemaObjects(rawSql);
      if (schemaObjects.length === 0) continue;

      // Check whether any schema object defined by this migration is missing.
      let anyMissing = false;
      for (const obj of schemaObjects) {
        const exists = await checkObjectExists(obj, ops);
        if (exists === false) {
          anyMissing = true;
          break;
        }
        // exists === null means no check method — skip this object
      }

      if (anyMissing) {
        falseRecordsFound++;
        console.warn(
          `[Migration] ⚠  Removing false record for ${entry.tag} — DDL was never executed`
        );
        if (ops.deleteRecord) {
          await ops.deleteRecord(row.created_at);
        }
        recordedMillisSet.delete(row.created_at);
      }
    }
    if (falseRecordsFound > 0) {
      console.warn(
        `[Migration] ⚠  Removed ${falseRecordsFound} false record(s) — Drizzle will re-run their DDL`
      );
    }
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
      physicalRows: recordedRows.length,
      duplicateRows,
      hashConflicts,
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

    if (!dryRun && schemaObjects.length > 0) {
      for (const obj of schemaObjects) {
        const exists = await checkObjectExists(obj, ops);
        if (exists === null) continue; // method not available in ops — skip from count
        checkableTotal++;
        if (exists) existingObjects.push(obj);
      }
    }

    /**
     * RONDE 178 — a migration that TRANSFORMS an existing object can never be a ghost.
     *
     * Ghosting means "these objects are already there, so this migration must have run" and then
     * recording it as executed. That reasoning only holds for objects the migration CREATES. A
     * MODIFY COLUMN's target exists either way, so the evidence is empty — and recording it is
     * unrecoverable, because the runner then skips it forever.
     *
     * Letting it run instead is safe in both directions: re-applying `MODIFY COLUMN x float` to a
     * column that is already float is a no-op in MySQL, whereas skipping it leaves the schema wrong
     * with no second chance.
     */
    const hasTransform = schemaObjects.some((o) => o.transform);

    let status: MigrationStatus;
    if (dryRun || checkableTotal === 0) {
      // No checkable objects or dry run → assume clean (let Drizzle decide)
      status = "clean";
    } else if (hasTransform) {
      status = "clean";
    } else if (existingObjects.length === checkableTotal && checkableTotal === schemaObjects.length) {
      // GHOST only when every object was checkable AND every one exists
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
      physicalRows: recordedRows.length,
      duplicateRows,
      hashConflicts,
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
  /**
   * RONDE 269 — counted the same way `recordedBefore` is, or the subtraction is meaningless.
   *
   * This used to be a ROW count while `recordedBefore` is now an IDENTITY count, and subtracting
   * one from the other would report 1404 migrations "executed this deploy" on the production
   * database. Both sides are canonical; the physical total is reported separately, not mixed in.
   */
  const afterRows = await ops.getRecordedMigrations();
  const afterCanonical = canonicaliseRecorded(afterRows);
  const recordedAfter = afterCanonical.canonical.length;
  const executedThisDeploy = Math.max(0, recordedAfter - recordedBefore - ghosts.length);

  console.log(
    `[Migration] ✓ ${recordedAfter}/${total} migrations recorded` +
      (ghosts.length > 0 ? ` (${ghosts.length} ghost(s) repaired)` : "") +
      (partials.length > 0 ? ` (${partials.length} partial(s) re-run)` : "") +
      (executedThisDeploy > 0 ? ` (${executedThisDeploy} new)` : "")
  );

  return {
    totalMigrations: total,
    physicalRows: afterRows.length,
    duplicateRows: afterCanonical.duplicateRows,
    hashConflicts: afterCanonical.hashConflicts,
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
