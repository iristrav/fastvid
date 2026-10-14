/**
 * VIDEO 656 — the one-time clean-up of `__drizzle_migrations` (`MIGRATION_DEDUPE=true`).
 *
 * Production: 1470 rows for 66 migrations, and one identity recorded under two hashes (the file
 * as it is now, and an earlier attempt). The clean-up keeps one row per identity, chosen by the
 * file's own hash, and deletes nothing it has no evidence for. Off unless an operator asks.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { planMigrationDedupe, runMigrationsWithGuard, type MigrationDbOps } from "./migrationGuard";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");
const JOURNAL = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ when: number; tag: string }>;
};
const FILE_HASH = new Map(
  JOURNAL.entries
    .filter((e) => fs.existsSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`)))
    .map((e) => [e.when, sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), "utf8"))] as const)
);
const OLD_ATTEMPT = "9a3719f155230f5910737c317128ab4a8c75486022f34033f46754e436aa14a4";

/** Production's shape: every identity many times over, and one identity under an older hash too. */
function productionRows(copies = 22) {
  const rows: Array<{ id: number; hash: string; created_at: number }> = [];
  let id = 1;
  const conflicted = JOURNAL.entries[47]!.when;
  for (let c = 0; c < copies; c++) {
    for (const e of JOURNAL.entries) {
      const hash = e.when === conflicted && c % 2 === 0 ? OLD_ATTEMPT : FILE_HASH.get(e.when)!;
      rows.push({ id: id++, hash, created_at: e.when });
    }
  }
  return { rows, conflicted };
}

function tableOps(rows: Array<{ id: number; hash: string; created_at: number }>) {
  const deleted: number[] = [];
  const ops: MigrationDbOps = {
    async getRecordedMigrations() {
      return rows.map((r) => ({ hash: r.hash, created_at: r.created_at }));
    },
    async getRecordedRows() {
      return rows.map((r) => ({ ...r }));
    },
    async deleteRowsById(ids) {
      deleted.push(...ids);
      const gone = new Set(ids);
      for (let i = rows.length - 1; i >= 0; i--) if (gone.has(rows[i]!.id)) rows.splice(i, 1);
    },
    async tableExists() { return true; },
    async columnExists() { return true; },
    async indexExists() { return true; },
    async fkExists() { return true; },
    async ensureMigrationsTable() {},
    async insertRecord() {},
    async deleteRecord() { throw new Error("no false record in this fixture"); },
    async updateHash() { throw new Error("no hash resync asked for"); },
  };
  return { ops, deleted, rows };
}

const noopMigrate = async () => {};

afterEach(() => {
  delete process.env.MIGRATION_DEDUPE;
});

describe("the plan", () => {
  it("production replayed: one row per migration, and the conflicted one keeps the row matching its file", () => {
    const { rows, conflicted } = productionRows();
    const { deleteIds, unresolved } = planMigrationDedupe(rows, FILE_HASH);
    const kept = rows.filter((r) => !deleteIds.includes(r.id));
    expect(kept).toHaveLength(JOURNAL.entries.length);
    expect(new Set(kept.map((r) => r.created_at)).size).toBe(JOURNAL.entries.length);
    expect(kept.find((r) => r.created_at === conflicted)!.hash).toBe(FILE_HASH.get(conflicted));
    expect(unresolved).toEqual([]);
    /** the lowest id with the right hash, so two processes delete the same rows */
    for (const k of kept) {
      const same = rows.filter((r) => r.created_at === k.created_at && r.hash === k.hash);
      expect(k.id).toBe(Math.min(...same.map((r) => r.id)));
    }
  });

  it("rows that disagree with no row matching the file are all kept: no evidence, no choice", () => {
    const rows = [
      { id: 1, hash: "a".repeat(64), created_at: 1 },
      { id: 2, hash: "b".repeat(64), created_at: 1 },
    ];
    expect(planMigrationDedupe(rows, new Map([[1, "c".repeat(64)]]))).toEqual({ deleteIds: [], unresolved: [1] });
  });

  it("rows that agree but match no file still lose their copies; a single row is never touched", () => {
    const rows = [
      { id: 3, hash: "a".repeat(64), created_at: 1 },
      { id: 4, hash: "a".repeat(64), created_at: 1 },
      { id: 5, hash: "z".repeat(64), created_at: 2 },
    ];
    expect(planMigrationDedupe(rows, new Map())).toEqual({ deleteIds: [4], unresolved: [] });
  });

  it("a second run finds nothing to do", () => {
    const { rows } = productionRows();
    const first = planMigrationDedupe(rows, FILE_HASH);
    const left = rows.filter((r) => !first.deleteIds.includes(r.id));
    expect(planMigrationDedupe(left, FILE_HASH).deleteIds).toEqual([]);
  });
});

describe("in the guard", () => {
  it("with MIGRATION_DEDUPE=true: the table is clean afterwards, and the guard reports it clean", async () => {
    process.env.MIGRATION_DEDUPE = "true";
    const { rows: prod } = productionRows();
    const { ops, deleted, rows } = tableOps(prod);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(deleted.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(JOURNAL.entries.length);
    expect(result.duplicateRows).toBe(0);
    expect(result.hashConflicts).toBe(0);
    expect(result.integrityViolations).toEqual([]);
  });

  it("without it, nothing is deleted and the conflict is still reported (the default is unchanged)", async () => {
    const { rows: prod } = productionRows();
    const { ops, deleted } = tableOps(prod);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(deleted).toEqual([]);
    expect(result.hashConflicts).toBe(1);
    expect(result.duplicateRows).toBeGreaterThan(0);
  });

  it("a dry run deletes nothing, even when asked to clean up", async () => {
    process.env.MIGRATION_DEDUPE = "true";
    const { rows: prod } = productionRows();
    const { ops, deleted } = tableOps(prod);
    await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops, dryRun: true });
    expect(deleted).toEqual([]);
  });
});
