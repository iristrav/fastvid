/**
 * RONDE 178 — the migration that was recorded as executed and never ran.
 *
 * ── What happened in production ──────────────────────────────────────────────────────────────
 *
 * Every boot, from 2026-08-30 20:37 onwards:
 *
 *     [Migration]   0048_ronde177_archive_trim_duration   GHOST → auto-repair
 *     [Migration]     objects: cols[media_archive_assets.durationSec]
 *     [Migration]   ✓ 0048_ronde177_archive_trim_duration — recorded in __drizzle_migrations
 *     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
 *       ✗ [type] media_archive_assets.durationSec   expected: float   actual: int
 *     [Fastvid] Fatal startup error — exiting so Railway marks the deployment failed
 *
 * The site was down for roughly twelve hours, and it could not recover on its own: the migration
 * had been RECORDED, so the runner skipped it on every subsequent boot too.
 *
 * ── The mechanism ────────────────────────────────────────────────────────────────────────────
 *
 * The guard's reconciliation extracts the schema objects a migration touches and asks the live
 * database whether they exist. When they all do, it concludes the migration must already have run
 * — a GHOST — and records it without executing it.
 *
 * That inference is sound for CREATE TABLE and ADD COLUMN: the object is there because the
 * migration put it there. It is worthless for MODIFY COLUMN, where the column exists precisely
 * because the migration is about to change it, and existed before as well.
 *
 * `extractSchemaObjects` handled MODIFY and CHANGE — it emitted them as plain `column` objects,
 * indistinguishable from an ADD. So every MODIFY migration was guaranteed to be ghosted. 0048 was
 * the first MODIFY this repository ever had; all 47 before it were CREATE TABLE or ADD COLUMN,
 * which is why a fault this size had never fired once.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * A migration that TRANSFORMS an existing object can never be classified as a ghost. It is left to
 * run, which is safe in both directions: re-applying `MODIFY COLUMN x float` to a column that is
 * already float is a no-op, whereas skipping it leaves the schema wrong with no second chance.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { runMigrationsWithGuard, type MigrationDbOps } from "./migrationGuard";

/**
 * A database that answers about COLUMNS, which the existing harness deliberately does not.
 *
 * Without columnExists the guard cannot check a column at all, so `checkableTotal` is 0 and every
 * column migration is classified "clean" — the production failure is unreachable. Modelling
 * columns is what makes this test able to reproduce it.
 */
function makeOps(state: {
  records: Array<{ hash: string; created_at: number }>;
  tables: Set<string>;
  columns: Set<string>;
}): MigrationDbOps {
  return {
    async getRecordedMigrations() {
      return [...state.records];
    },
    async tableExists(name: string) {
      return state.tables.has(name);
    },
    async columnExists(table: string, column: string) {
      return state.columns.has(`${table}.${column}`);
    },
    async indexExists(table: string) {
      return state.tables.has(table);
    },
    async ensureMigrationsTable() {},
    async insertRecord(hash: string, created_at: number) {
      state.records.push({ hash, created_at });
    },
    async deleteRecord(created_at: number) {
      state.records = state.records.filter((r) => r.created_at !== created_at);
    },
    async updateHash() {},
  };
}

function folderWith(tag: string, when: number, sql: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r178-mig-"));
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "mysql",
      entries: [{ idx: 0, version: "5", when, tag, breakpoints: true }],
    })
  );
  fs.writeFileSync(path.join(dir, `${tag}.sql`), sql);
  return dir;
}

/** The production migration, verbatim in shape. */
const MODIFY_COLUMN_SQL =
  "ALTER TABLE `media_archive_assets`\n  MODIFY COLUMN `durationSec` float NULL;";

const ADD_COLUMN_SQL = "ALTER TABLE `media_archive_assets` ADD COLUMN `previewIssue` varchar(64);";

describe("RONDE 178 — a MODIFY COLUMN migration is never ghosted", () => {
  it("THE OUTAGE: the guard used to record 0048 as executed without running it", async () => {
    /**
     * The exact production state: the table and the column both exist (durationSec is there, as an
     * int), and the migration is pending. Before the fix this produced one ghost and zero
     * executions — which is what took the site down.
     */
    const dir = folderWith("0048_ronde177_archive_trim_duration", 1787900200000, MODIFY_COLUMN_SQL);
    try {
      const state = {
        records: [],
        tables: new Set(["media_archive_assets"]),
        columns: new Set(["media_archive_assets.durationSec"]),
      };
      const migrate = vi.fn().mockResolvedValue(undefined);
      const result = await runMigrationsWithGuard({}, dir, migrate, { dbOps: makeOps(state) });

      expect(result.ghostsRepaired, "a MODIFY migration must never be ghosted").toBe(0);
      expect(migrate, "the migration has to actually run").toHaveBeenCalled();
      // Nothing was written to __drizzle_migrations by the guard itself — Drizzle records it after
      // executing it, which is the only order that can be trusted.
      expect(state.records).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a CHANGE COLUMN is treated the same way", async () => {
    // CHANGE renames as well as retypes, so the new name may not even exist yet — but the old one
    // does, and presence is just as uninformative.
    const dir = folderWith(
      "9999_change_col",
      1787900400000,
      "ALTER TABLE `media_archive_assets` CHANGE COLUMN `durationSec` `durationSeconds` float NULL;"
    );
    try {
      const state = {
        records: [],
        tables: new Set(["media_archive_assets"]),
        columns: new Set(["media_archive_assets.durationSeconds"]),
      };
      const migrate = vi.fn().mockResolvedValue(undefined);
      const result = await runMigrationsWithGuard({}, dir, migrate, { dbOps: makeOps(state) });
      expect(result.ghostsRepaired).toBe(0);
      expect(migrate).toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSION GUARD: an ADD COLUMN whose column exists IS still ghosted", async () => {
    /**
     * The other half of the guarantee, and the reason the fix is narrow. Ghosting exists because a
     * database restored from a dump already has the objects while __drizzle_migrations is empty —
     * without it every such deploy would fail on "column already exists". That behaviour must
     * survive; only the inference about TRANSFORMS is wrong.
     */
    const dir = folderWith("9998_add_col", 1787900500000, ADD_COLUMN_SQL);
    try {
      const state = {
        records: [],
        tables: new Set(["media_archive_assets"]),
        columns: new Set(["media_archive_assets.previewIssue"]),
      };
      const result = await runMigrationsWithGuard({}, dir, vi.fn().mockResolvedValue(undefined), {
        dbOps: makeOps(state),
      });
      expect(result.ghostsRepaired, "ADD COLUMN ghosting is what makes a restored dump deployable").toBe(1);
      expect(state.records).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an ADD COLUMN whose column does NOT exist still runs normally", async () => {
    const dir = folderWith("9997_add_col_new", 1787900600000, ADD_COLUMN_SQL);
    try {
      const state = {
        records: [],
        tables: new Set(["media_archive_assets"]),
        columns: new Set<string>(),
      };
      const migrate = vi.fn().mockResolvedValue(undefined);
      const result = await runMigrationsWithGuard({}, dir, migrate, { dbOps: makeOps(state) });
      expect(result.ghostsRepaired).toBe(0);
      expect(migrate).toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RONDE 178 — the repair migration that gets production back up", () => {
  const read = (rel: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, "..", rel), "utf8");
  };

  it("0049 re-applies what 0048 never did", () => {
    /**
     * 0048 now carries a row in __drizzle_migrations on production, so the runner will never
     * execute it again however the guard behaves. A forward migration is the only thing that can
     * still apply the change.
     */
    const sql = read("drizzle/0049_ronde178_archive_trim_duration_repair.sql");
    expect(sql).toContain("ALTER TABLE `media_archive_assets`");
    expect(sql.toLowerCase()).toContain("modify column `durationsec` float");
  });

  it("...and the journal knows about it, or it never runs", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: { tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0049_ronde178_archive_trim_duration_repair");
    // It must come after 0048, not replace it: 0048 stays recorded on production.
    expect(tags.indexOf("0049_ronde178_archive_trim_duration_repair")).toBeGreaterThan(
      tags.indexOf("0048_ronde177_archive_trim_duration")
    );
  });

  it("the schema still declares float — the code side of the mismatch is unchanged", () => {
    const schema = read("drizzle/schema.ts");
    const start = schema.indexOf("export const mediaArchiveAssets = mysqlTable(");
    const next = schema.indexOf("mysqlTable(", start + 60);
    const block = schema.slice(start, next === -1 ? schema.length : next);
    expect(block).toContain('durationSec: float("durationSec")');
  });

  it("re-running the repair is harmless, which is why it may be a plain ALTER", () => {
    // MODIFY COLUMN to float on a column that is already float is a no-op in MySQL, and int → float
    // is a lossless widening. No IF-EXISTS wrapper is needed and none is used.
    const sql = read("drizzle/0049_ronde178_archive_trim_duration_repair.sql");
    expect(sql).not.toContain("IF NOT EXISTS");
    expect(sql).not.toContain("INFORMATION_SCHEMA");
  });
});
