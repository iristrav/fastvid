/**
 * Integration tests for the migration guard.
 *
 * All DB I/O is injected via mock MigrationDbOps — no real MySQL connection needed.
 * Drizzle's migrate() is also injected as a mock. The file system uses real temp dirs
 * so file-reading, sha256, and table-name extraction are tested end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import {
  runMigrationsWithGuard,
  type MigrationDbOps,
  type MigrationResult,
} from "./migrationGuard";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface FakeDbState {
  records: Array<{ hash: string; created_at: number }>;
  existingTables: Set<string>;
}

function makeMockDbOps(state: FakeDbState): MigrationDbOps {
  return {
    async getRecordedMigrations() {
      return [...state.records];
    },
    async tableExists(name: string) {
      return state.existingTables.has(name);
    },
    async ensureMigrationsTable() {
      // no-op for tests
    },
    async insertRecord(hash: string, folderMillis: number) {
      state.records.push({ hash, created_at: folderMillis });
    },
  };
}

/** Create a minimal migrations folder with given migrations. */
function makeMigrationsFolder(
  migrations: Array<{ tag: string; when: number; sql: string }>
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-test-"));
  const metaDir = path.join(dir, "meta");
  fs.mkdirSync(metaDir);

  const journal = {
    version: "7",
    dialect: "mysql",
    entries: migrations.map((m, idx) => ({
      idx,
      version: "5",
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    })),
  };
  fs.writeFileSync(path.join(metaDir, "_journal.json"), JSON.stringify(journal));
  for (const m of migrations) {
    fs.writeFileSync(path.join(dir, `${m.tag}.sql`), m.sql);
  }
  return dir;
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const NOOP_MIGRATE = vi.fn().mockResolvedValue(undefined);

// ─── Test migrations SQL ───────────────────────────────────────────────────────

const IDEMPOTENT_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\` int AUTO_INCREMENT NOT NULL,
  \`email\` varchar(320) NOT NULL,
  CONSTRAINT \`users_id\` PRIMARY KEY(\`id\`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @idx = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_email_idx') = 0,
  'CREATE INDEX \`users_email_idx\` ON \`users\` (\`email\`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @idx; EXECUTE stmt; DEALLOCATE PREPARE stmt;
`.trim();

const NON_IDEMPOTENT_CREATE_TABLE = `
CREATE TABLE \`orders\` (
  \`id\` int AUTO_INCREMENT NOT NULL,
  CONSTRAINT \`orders_id\` PRIMARY KEY(\`id\`)
);
`.trim();

const IDEMPOTENT_ADD_COLUMN = `
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'name') = 0,
  'ALTER TABLE \`users\` ADD COLUMN \`name\` varchar(256)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1; EXECUTE stmt; DEALLOCATE PREPARE stmt;
`.trim();

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("migrationGuard", () => {
  let dir: string;

  afterEach(() => {
    if (dir) cleanupDir(dir);
    vi.clearAllMocks();
  });

  // ── 1. Clean database ────────────────────────────────────────────────────────
  it("clean database: runs all migrations and records them", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: IDEMPOTENT_CREATE_TABLE },
      { tag: "0001_add_column", when: 2000, sql: IDEMPOTENT_ADD_COLUMN },
    ]);

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn().mockImplementation(async () => {
      // Simulate Drizzle recording both migrations
      state.records.push(
        { hash: sha256(IDEMPOTENT_CREATE_TABLE), created_at: 1000 },
        { hash: sha256(IDEMPOTENT_ADD_COLUMN), created_at: 2000 }
      );
    });

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    expect(migrate).toHaveBeenCalledOnce();
    expect(result.totalMigrations).toBe(2);
    expect(result.recordedBefore).toBe(0);
    expect(result.recordedAfter).toBe(2);
    expect(result.executedThisDeploy).toBe(2);
    expect(result.ghostsRepaired).toBe(0);
    expect(result.partialsCompleted).toBe(0);
    expect(result.integrityViolations).toHaveLength(0);
  });

  // ── 2. Already migrated DB ───────────────────────────────────────────────────
  it("existing database: skips migrate() when all migrations are recorded", async () => {
    const sql0 = IDEMPOTENT_CREATE_TABLE;
    const sql1 = IDEMPOTENT_ADD_COLUMN;

    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: sql0 },
      { tag: "0001_add_column", when: 2000, sql: sql1 },
    ]);

    const state: FakeDbState = {
      records: [
        { hash: sha256(sql0), created_at: 1000 },
        { hash: sha256(sql1), created_at: 2000 },
      ],
      existingTables: new Set(["users"]),
    };
    const migrate = vi.fn();

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    // No migrations pending → migrate() not called
    expect(migrate).not.toHaveBeenCalled();
    expect(result.executedThisDeploy).toBe(0);
    expect(result.recordedBefore).toBe(2);
    expect(result.recordedAfter).toBe(2);
  });

  // ── 3. Interrupted migration (ghost) ─────────────────────────────────────────
  it("ghost migration: tables exist but not recorded → auto-repairs history", async () => {
    const sql0 = IDEMPOTENT_CREATE_TABLE; // creates `users`
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: sql0 },
    ]);

    const state: FakeDbState = {
      records: [], // migration not recorded
      existingTables: new Set(["users"]), // but table exists
    };
    const migrate = vi.fn().mockImplementation(async () => {
      // Drizzle sees 0000 now recorded (from repair) and skips it; nothing to apply
    });

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    // Ghost should be repaired (record inserted) and migrate called
    expect(result.ghostsRepaired).toBe(1);
    expect(state.records).toHaveLength(1);
    expect(state.records[0].hash).toBe(sha256(sql0));
    expect(state.records[0].created_at).toBe(1000);
    expect(migrate).toHaveBeenCalledOnce();
  });

  // ── 4. Non-idempotent ghost → abort ──────────────────────────────────────────
  it("non-idempotent ghost: aborts startup with diagnostic", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: NON_IDEMPOTENT_CREATE_TABLE },
    ]);

    const state: FakeDbState = {
      records: [],
      existingTables: new Set(["orders"]),
    };
    const migrate = vi.fn();

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow(/ghost migration.*0000_init.*not idempotent|ABORT.*ghost/i);

    expect(migrate).not.toHaveBeenCalled();
  });

  // ── 5. Partial migration (idempotent) ────────────────────────────────────────
  it("partial migration: some tables exist → warns and lets Drizzle re-run", async () => {
    const twoTableSql = `
CREATE TABLE IF NOT EXISTS \`table_a\` (\`id\` int PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS \`table_b\` (\`id\` int PRIMARY KEY);
`.trim();

    dir = makeMigrationsFolder([
      { tag: "0000_two_tables", when: 1000, sql: twoTableSql },
    ]);

    const state: FakeDbState = {
      records: [],
      existingTables: new Set(["table_a"]), // only first table exists
    };
    const migrate = vi.fn().mockImplementation(async () => {
      state.records.push({ hash: sha256(twoTableSql), created_at: 1000 });
    });

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    // Should proceed (idempotent), not throw
    expect(migrate).toHaveBeenCalledOnce();
    expect(result.partialsCompleted).toBe(1);
  });

  // ── 6. Non-idempotent partial → abort ────────────────────────────────────────
  it("non-idempotent partial: aborts startup with diagnostic", async () => {
    const twoTableSql = `
CREATE TABLE \`table_a\` (\`id\` int PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE \`table_b\` (\`id\` int PRIMARY KEY);
`.trim();

    dir = makeMigrationsFolder([
      { tag: "0000_two_tables", when: 1000, sql: twoTableSql },
    ]);

    const state: FakeDbState = {
      records: [],
      existingTables: new Set(["table_a"]),
    };
    const migrate = vi.fn();

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow(/ABORT.*partially applied|partial migration.*not idempotent/i);

    expect(migrate).not.toHaveBeenCalled();
  });

  // ── 7. Duplicate table (ER_TABLE_EXISTS_ERROR from migrate) ──────────────────
  it("duplicate table error from migrate(): logs recovery hint and re-throws", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: NON_IDEMPOTENT_CREATE_TABLE },
    ]);

    const dupError = Object.assign(new Error("DrizzleQueryError"), {
      cause: {
        code: "ER_TABLE_EXISTS_ERROR",
        sqlMessage: "Table 'orders' already exists",
        sql: "CREATE TABLE `orders` (...)",
      },
    });

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn().mockRejectedValue(dupError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow();

    const calls = consoleError.mock.calls.flat().join(" ");
    expect(calls).toMatch(/ER_TABLE_EXISTS_ERROR/);
    expect(calls).toMatch(/CREATE TABLE IF NOT EXISTS/i);

    consoleError.mockRestore();
  });

  // ── 8. Duplicate column (ER_DUP_FIELDNAME) ───────────────────────────────────
  it("duplicate column error from migrate(): logs recovery hint", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_add_col", when: 1000, sql: "ALTER TABLE `users` ADD COLUMN `email` varchar(320);" },
    ]);

    const dupColError = Object.assign(new Error("DrizzleQueryError"), {
      cause: {
        code: "ER_DUP_FIELDNAME",
        sqlMessage: "Duplicate column name 'email'",
        sql: "ALTER TABLE `users` ADD COLUMN `email` varchar(320);",
      },
    });

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn().mockRejectedValue(dupColError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow();

    const calls = consoleError.mock.calls.flat().join(" ");
    expect(calls).toMatch(/ER_DUP_FIELDNAME/);
    expect(calls).toMatch(/INFORMATION_SCHEMA\.COLUMNS/i);

    consoleError.mockRestore();
  });

  // ── 9. Duplicate index ────────────────────────────────────────────────────────
  it("duplicate index error from migrate(): logs INFORMATION_SCHEMA.STATISTICS hint", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_add_idx", when: 1000, sql: "CREATE INDEX `users_email_idx` ON `users` (`email`);" },
    ]);

    const dupIdxError = Object.assign(new Error("DrizzleQueryError"), {
      cause: {
        code: "ER_DUP_KEY_NAME",
        sqlMessage: "Duplicate key name 'users_email_idx'",
        sql: "CREATE INDEX `users_email_idx` ON `users` (`email`);",
      },
    });

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn().mockRejectedValue(dupIdxError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow();

    const calls = consoleError.mock.calls.flat().join(" ");
    expect(calls).toMatch(/ER_DUP_KEY_NAME/);
    expect(calls).toMatch(/INFORMATION_SCHEMA\.STATISTICS/i);

    consoleError.mockRestore();
  });

  // ── 10. Missing foreign key (ER_CANNOT_ADD_FOREIGN) ──────────────────────────
  it("FK error from migrate(): logs orphaned-data cleanup hint", async () => {
    dir = makeMigrationsFolder([
      {
        tag: "0000_add_fk",
        when: 1000,
        sql: "ALTER TABLE `posts` ADD CONSTRAINT `posts_userId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`);",
      },
    ]);

    const fkError = Object.assign(new Error("DrizzleQueryError"), {
      cause: {
        code: "ER_CANNOT_ADD_FOREIGN",
        sqlMessage: "Cannot add foreign key constraint",
        sql: "ALTER TABLE `posts` ADD CONSTRAINT ...",
      },
    });

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn().mockRejectedValue(fkError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runMigrationsWithGuard(null, dir, migrate, { dbOps: makeMockDbOps(state) })
    ).rejects.toThrow();

    const calls = consoleError.mock.calls.flat().join(" ");
    expect(calls).toMatch(/ER_CANNOT_ADD_FOREIGN/);
    expect(calls).toMatch(/orphaned|parentId|NULL/i);

    consoleError.mockRestore();
  });

  // ── 11. Migration file modified after execution (integrity) ──────────────────
  it("integrity: warns when a recorded migration file has been modified", async () => {
    const originalSql = IDEMPOTENT_CREATE_TABLE;
    const modifiedSql = originalSql + "\n-- accidentally edited after deploy";

    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: modifiedSql }, // file now has modified content
    ]);

    const state: FakeDbState = {
      records: [{ hash: sha256(originalSql), created_at: 1000 }], // hash of original
      existingTables: new Set(["users"]),
    };
    const migrate = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    expect(result.integrityViolations).toHaveLength(1);
    expect(result.integrityViolations[0].tag).toBe("0000_init");

    const warnCalls = consoleWarn.mock.calls.flat().join(" ");
    expect(warnCalls).toMatch(/modified after execution|integrity/i);

    consoleWarn.mockRestore();
  });

  // ── 12. Strict integrity: aborts when enabled ─────────────────────────────────
  it("integrity strict mode: aborts startup on modified migration file", async () => {
    const originalSql = IDEMPOTENT_CREATE_TABLE;
    const modifiedSql = originalSql + "\n-- post-deploy edit";

    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: modifiedSql },
    ]);

    const state: FakeDbState = {
      records: [{ hash: sha256(originalSql), created_at: 1000 }],
      existingTables: new Set(["users"]),
    };
    const migrate = vi.fn();

    await expect(
      runMigrationsWithGuard(null, dir, migrate, {
        dbOps: makeMockDbOps(state),
        strictIntegrity: true,
      })
    ).rejects.toThrow(/ABORT.*modified after execution/i);

    expect(migrate).not.toHaveBeenCalled();
  });

  // ── 13. Dry-run mode ─────────────────────────────────────────────────────────
  it("dry-run: logs what would execute without touching the DB", async () => {
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: IDEMPOTENT_CREATE_TABLE },
    ]);

    const state: FakeDbState = { records: [], existingTables: new Set() };
    const migrate = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.executedThisDeploy).toBe(0);
    expect(migrate).not.toHaveBeenCalled();
    // DB state must not be mutated
    expect(state.records).toHaveLength(0);

    const logCalls = consoleLog.mock.calls.flat().join(" ");
    expect(logCalls).toMatch(/DRY RUN/i);
    expect(logCalls).toMatch(/0000_init/);

    consoleLog.mockRestore();
  });

  // ── 14. Multiple ghost migrations: all auto-repaired in order ────────────────
  it("multiple ghosts: repairs all and calls migrate() once", async () => {
    const sql0 = IDEMPOTENT_CREATE_TABLE;
    const sql1 = `CREATE TABLE IF NOT EXISTS \`posts\` (\`id\` int PRIMARY KEY);`;

    dir = makeMigrationsFolder([
      { tag: "0000_users", when: 1000, sql: sql0 },
      { tag: "0001_posts", when: 2000, sql: sql1 },
    ]);

    const state: FakeDbState = {
      records: [],
      existingTables: new Set(["users", "posts"]),
    };
    const migrate = vi.fn();

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    expect(result.ghostsRepaired).toBe(2);
    expect(state.records).toHaveLength(2);
    expect(migrate).toHaveBeenCalledOnce();
  });

  // ── 15. Hash correctness ──────────────────────────────────────────────────────
  it("stores sha256 of the current SQL file content in repaired records", async () => {
    const sqlContent = IDEMPOTENT_CREATE_TABLE;
    dir = makeMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: sqlContent },
    ]);

    const state: FakeDbState = { records: [], existingTables: new Set(["users"]) };
    await runMigrationsWithGuard(null, dir, vi.fn(), {
      dbOps: makeMockDbOps(state),
    });

    expect(state.records[0].hash).toBe(sha256(sqlContent));
  });

  // ── 16. No-op on fully recorded DB (migrate never called) ────────────────────
  it("fully recorded DB returns result without calling migrate()", async () => {
    const sqlContent = IDEMPOTENT_ADD_COLUMN;
    dir = makeMigrationsFolder([
      { tag: "0000_add_col", when: 5000, sql: sqlContent },
    ]);

    const state: FakeDbState = {
      records: [{ hash: sha256(sqlContent), created_at: 5000 }],
      existingTables: new Set(),
    };
    const migrate = vi.fn();

    const result = await runMigrationsWithGuard(null, dir, migrate, {
      dbOps: makeMockDbOps(state),
    });

    expect(migrate).not.toHaveBeenCalled();
    expect(result.executedThisDeploy).toBe(0);
    expect(result.ghostsRepaired).toBe(0);
  });
});
