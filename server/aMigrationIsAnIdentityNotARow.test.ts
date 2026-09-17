/**
 * RONDE 269 — A MIGRATION IS AN IDENTITY, NOT A ROW.
 *
 * ── The outage this exists to prevent ───────────────────────────────────────────────────────
 *
 *     [Fastvid]   Recorded migrations : 1457/53
 *     [Fastvid]   Guard time          : 447903ms
 *     [Fastvid]   Drizzle migrate     : 648ms
 *     [Fastvid]   Schema validation   : 479ms
 *     [Fastvid] Server running on port 8080        ← 7 min 29 s after boot
 *     Railway healthcheckTimeout: 180s             → killed, restart loop, production DOWN
 *
 * `__drizzle_migrations` held 1457 rows for 53 migrations. The false-record cleanup runs one remote
 * INFORMATION_SCHEMA query PER SCHEMA OBJECT PER ROW, so it ran ~27× more often than there are
 * migrations: roughly 3200 sequential round trips at ~140ms, which is 448 seconds almost exactly.
 *
 * The database was never slow — `Drizzle migrate: 648ms` on the same connection proves that. The
 * query COUNT was wrong, and it grows by ~53 rows per deploy, so the startup time grew with the
 * deployment history until it crossed the healthcheck window.
 *
 * ── What is checked here ────────────────────────────────────────────────────────────────────
 *
 * §1 the canonicaliser keeps every distinct hash instead of collapsing them
 * §2 the guard's expensive work is bounded by MIGRATIONS, not by rows        ← the outage
 * §3 a hash conflict stays visible and is never silently resolved
 * §4 nothing was weakened: no check removed, no threshold moved, no integrity bypass
 * §5 the same identity is recorded once, not once per deploy
 */
import { describe, expect, it } from "vitest";

import {
  canonicaliseRecorded,
  runMigrationsWithGuard,
  type MigrationDbOps,
} from "./migrationGuard";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const GUARD = stripComments(fs.readFileSync(path.join(__dirname, "migrationGuard.ts"), "utf8"));

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The real journal, so the fixture's identities are the identities production uses. */
const JOURNAL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")
) as { entries: Array<{ idx: number; when: number; tag: string }> };

const MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");

/** Hash each real migration file exactly as the guard does, so nothing reads as modified. */
function realHashes(): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of JOURNAL.entries) {
    const p = path.join(MIGRATIONS_DIR, `${e.tag}.sql`);
    if (fs.existsSync(p)) out.set(e.when, sha256(fs.readFileSync(p, "utf8")));
  }
  return out;
}

/**
 * A counting stand-in for the database.
 *
 * Not a mock of the guard's logic — `MigrationDbOps` is the injection seam the module declares for
 * exactly this ("Injectable DB operations — mock these in tests"). Every schema-object lookup is
 * counted, because the count IS the thing that took production down.
 */
function countingOps(rows: Array<{ hash: string; created_at: number }>) {
  const calls = { objectChecks: 0, inserts: 0, deletes: 0, reads: 0 };
  const ops: MigrationDbOps = {
    async getRecordedMigrations() {
      calls.reads++;
      return rows.map((r) => ({ ...r }));
    },
    async tableExists() {
      calls.objectChecks++;
      return true;
    },
    async columnExists() {
      calls.objectChecks++;
      return true;
    },
    async indexExists() {
      calls.objectChecks++;
      return true;
    },
    async fkExists() {
      calls.objectChecks++;
      return true;
    },
    async ensureMigrationsTable() {},
    async insertRecord() {
      calls.inserts++;
    },
    async deleteRecord() {
      calls.deletes++;
    },
    async updateHash() {},
  };
  return { ops, calls };
}

/** Every identity recorded once, with the hash its file actually has. The healthy database. */
function healthyRows() {
  return [...realHashes().entries()].map(([created_at, hash]) => ({ created_at, hash }));
}

/** The production shape: each identity repeated, all copies agreeing. */
function duplicatedRows(copies: number) {
  const base = healthyRows();
  const out: Array<{ hash: string; created_at: number }> = [];
  for (let i = 0; i < copies; i++) for (const r of base) out.push({ ...r });
  return out;
}

const noopMigrate = async () => {};

/* ═══════════ 1. the canonicaliser loses nothing ═══════════ */

describe("R269 §1 — rows collapse to identities without discarding a hash", () => {
  it("one row per identity is unchanged", () => {
    const r = canonicaliseRecorded([
      { created_at: 1, hash: "a" },
      { created_at: 2, hash: "b" },
    ]);
    expect(r.canonical).toHaveLength(2);
    expect(r.duplicateRows).toBe(0);
    expect(r.hashConflicts).toBe(0);
  });

  it("AGREEING DUPLICATES ARE COUNTED, NOT TREATED AS A CONFLICT", () => {
    const r = canonicaliseRecorded([
      { created_at: 1, hash: "a" },
      { created_at: 1, hash: "a" },
      { created_at: 1, hash: "a" },
    ]);
    expect(r.canonical).toHaveLength(1);
    expect(r.canonical[0]!.rowCount).toBe(3);
    expect(r.canonical[0]!.hashes).toEqual(["a"]);
    expect(r.duplicateRows).toBe(2);
    expect(r.hashConflicts).toBe(0);
  });

  it("DISAGREEING DUPLICATES KEEP EVERY HASH — this is the line a Map would have crossed", () => {
    /**
     * `new Map(rows.map(r => [r.created_at, r.hash]))` collapses these in one expression and keeps
     * whichever row was read last. That is the defect this codebase keeps rediscovering: the
     * disagreement is thrown away before anybody can read it.
     */
    const r = canonicaliseRecorded([
      { created_at: 1, hash: "first" },
      { created_at: 1, hash: "second" },
    ]);
    expect(r.canonical[0]!.hashes).toEqual(["first", "second"]);
    expect(r.hashConflicts).toBe(1);
    expect(r.canonical[0]!.rowCount).toBe(2);
  });

  it("and an empty table is not a conflict", () => {
    const r = canonicaliseRecorded([]);
    expect(r.canonical).toEqual([]);
    expect(r.duplicateRows).toBe(0);
    expect(r.hashConflicts).toBe(0);
  });
});

/* ═══════════ 2. the outage: work is bounded by migrations, not rows ═══════════ */

describe("R269 §2 — the guard's cost does not grow with the deployment history", () => {
  it("A HEALTHY DATABASE DOES A BOUNDED NUMBER OF SCHEMA-OBJECT CHECKS", async () => {
    const { ops, calls } = countingOps(healthyRows());
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(result.recordedBefore).toBe(JOURNAL.entries.length);
    expect(result.duplicateRows).toBe(0);
    /** Every object of every migration, once. The honest baseline for the comparison below. */
    expect(calls.objectChecks).toBeGreaterThan(0);
  });

  it("AND 27 COPIES OF EVERY ROW COST THE SAME — this is the 448 seconds", async () => {
    /**
     * The production ratio: 1457 rows for 53 migrations. Before this round the inner loop ran once
     * per ROW, so this fixture would do 27× the work of the one above. The assertion is equality,
     * not "less than": the number of migrations is what bounds the guard, and the row count must
     * not enter into it at all.
     */
    const healthy = countingOps(healthyRows());
    await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: healthy.ops });

    const duplicated = countingOps(duplicatedRows(27));
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, {
      dbOps: duplicated.ops,
    });

    expect(duplicated.calls.objectChecks).toBe(healthy.calls.objectChecks);
    /** The redundancy is reported rather than hidden by the repair. */
    expect(result.physicalRows).toBe(JOURNAL.entries.length * 27);
    expect(result.duplicateRows).toBe(JOURNAL.entries.length * 26);
    expect(result.recordedBefore).toBe(JOURNAL.entries.length);
  });

  it("the canonical count is what `N/53 recorded` reports, not the row count", async () => {
    /**
     * Production printed `1457/53`, a numerator of rows over a denominator of migrations. The
     * ratio was unreadable; `recordedAfter` is now counted the same way `recordedBefore` is.
     */
    const { ops } = countingOps(duplicatedRows(27));
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(result.recordedAfter).toBe(JOURNAL.entries.length);
    expect(result.recordedAfter).toBeLessThanOrEqual(result.totalMigrations);
    /** And `executedThisDeploy` cannot be a rows-minus-identities subtraction any more. */
    expect(result.executedThisDeploy).toBe(0);
  });

  it("AND NO MIGRATION IS CONSIDERED PENDING JUST BECAUSE ITS ROW WAS DE-DUPLICATED", async () => {
    const { ops, calls } = countingOps(duplicatedRows(27));
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(result.executedThisDeploy).toBe(0);
    expect(result.ghostsRepaired).toBe(0);
    expect(calls.deletes, "a redundant row was mistaken for a false record").toBe(0);
  });
});

/* ═══════════ 3. a conflict stays a conflict ═══════════ */

describe("R269 §3 — disagreement is reported, never resolved by arrival order", () => {
  it("TWO HASHES FOR ONE IDENTITY IS AN INTEGRITY VIOLATION", async () => {
    const rows = healthyRows();
    const victim = rows[10]!;
    rows.push({ created_at: victim.created_at, hash: "a".repeat(64) });

    const { ops } = countingOps(rows);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });

    expect(result.hashConflicts).toBe(1);
    const tag = JOURNAL.entries.find((e) => e.when === victim.created_at)!.tag;
    const v = result.integrityViolations.find((x) => x.tag === tag);
    expect(v, "the conflicting identity produced no violation").toBeTruthy();
    /** Both hashes are in the report — a reader can see WHAT disagrees, not just that it does. */
    expect(v!.storedHash).toContain("CONFLICT");
    expect(v!.storedHash).toContain("a".repeat(64));
  });

  it("ONE VIOLATION PER IDENTITY, NOT ONE PER ROW", async () => {
    /**
     * Production reported 0047 twice for one file, which reads as two separate problems. It was
     * one file recorded by two rows.
     */
    const rows = healthyRows();
    const victim = rows[10]!;
    for (let i = 0; i < 5; i++) rows.push({ created_at: victim.created_at, hash: "b".repeat(64) });

    const { ops } = countingOps(rows);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    const tag = JOURNAL.entries.find((e) => e.when === victim.created_at)!.tag;
    expect(result.integrityViolations.filter((x) => x.tag === tag)).toHaveLength(1);
  });

  it("a file modified after execution is still reported, exactly as before", async () => {
    const rows = healthyRows();
    rows[10] = { created_at: rows[10]!.created_at, hash: "c".repeat(64) };

    const { ops } = countingOps(rows);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    const tag = JOURNAL.entries.find((e) => e.when === rows[10]!.created_at)!.tag;
    const v = result.integrityViolations.find((x) => x.tag === tag);
    expect(v).toBeTruthy();
    expect(v!.storedHash).toBe("c".repeat(64));
    expect(v!.storedHash).not.toContain("CONFLICT");
  });

  it("AND `recordedAfter` IS COUNTED IN IDENTITIES ON THE FULL PATH TOO", async () => {
    /**
     * A mutation survived the first version of this file and exposed a real gap: every other
     * fixture here has no pending migrations AND no violations, so the guard takes its
     * "nothing to apply" early return and the post-migrate counting code is never reached.
     *
     * An integrity violation disables that early return, which is what makes this the one fixture
     * that runs the whole guard. Without it, `recordedAfter` could go back to counting ROWS and
     * report 1431 migrations recorded out of 53 with nothing to catch it.
     */
    const rows = duplicatedRows(27);
    rows.push({ created_at: rows[10]!.created_at, hash: "d".repeat(64) });

    const { ops } = countingOps(rows);
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });

    expect(result.integrityViolations.length, "the early return was taken after all").toBeGreaterThan(0);
    expect(result.recordedAfter).toBe(JOURNAL.entries.length);
    expect(result.recordedAfter).toBeLessThanOrEqual(result.totalMigrations);
    expect(result.physicalRows).toBe(rows.length);
    expect(result.executedThisDeploy).toBe(0);
  });

  it("AND A CLEAN DATABASE REPORTS NO VIOLATION AT ALL", async () => {
    const { ops } = countingOps(healthyRows());
    const result = await runMigrationsWithGuard(null, MIGRATIONS_DIR, noopMigrate, { dbOps: ops });
    expect(result.integrityViolations).toEqual([]);
    expect(result.hashConflicts).toBe(0);
  });
});

/* ═══════════ 4. nothing was weakened ═══════════ */

describe("R269 §4 — a bound was fixed, not a check removed", () => {
  it("STRICT INTEGRITY STILL ABORTS", () => {
    expect(GUARD).toContain('process.env.MIGRATION_STRICT_INTEGRITY === "true"');
    expect(GUARD).toContain("[Migration] ABORT:");
  });

  it("the false-record cleanup still exists and still deletes real false records", () => {
    expect(GUARD).toContain("const exists = await checkObjectExists(obj, ops);");
    expect(GUARD).toContain("DDL was never executed");
    expect(GUARD).toContain("await ops.deleteRecord(row.created_at);");
  });

  it("and it walks IDENTITIES — the one line that ends the outage", () => {
    const at = GUARD.indexOf("let falseRecordsFound = 0;");
    expect(at).toBeGreaterThan(0);
    expect(GUARD.slice(at, at + 500)).toContain("for (const row of canonical)");
  });

  it("THE INTEGRITY CHECK STILL HASHES THE REAL FILE — no hash is taken on trust", () => {
    expect(GUARD).toContain("const currentHash = sha256(fs.readFileSync(sqlPath, \"utf-8\"));");
  });

  it("0047 IS NOT WAVED THROUGH — nothing marks a mismatch as acceptable", () => {
    expect(GUARD).not.toContain("0047");
    expect(GUARD, "a hash was excused by name").not.toMatch(/ronde147|discount_codes/i);
  });

  it("and the healthcheck timeout was not raised", () => {
    const railway = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "railway.json"), "utf8")
    ) as { deploy: { healthcheckPath: string; healthcheckTimeout: number } };
    expect(railway.deploy.healthcheckTimeout).toBe(180);
    /** §8 — the probe points at the endpoint whose own comment calls it a liveness probe. */
    expect(railway.deploy.healthcheckPath).toBe("/api/health/live");
  });
});

/* ═══════════ 5. the same identity is recorded once ═══════════ */

describe("R269 §5 — recording a migration twice does not add a row", () => {
  it("THE INSERT IS CONDITIONAL ON THE IDENTITY NOT BEING RECORDED", () => {
    const at = GUARD.indexOf("async insertRecord(");
    expect(at).toBeGreaterThan(0);
    /** `stripComments` blanks in place, so the slice must clear the doc comment's own length. */
    const body = GUARD.slice(at, at + 2400);
    expect(body).toContain("WHERE NOT EXISTS");
    /** Backticks are escaped in the source because the SQL sits in a template literal. */
    expect(body).toContain("created_at");
    expect(body).toMatch(/WHERE[\s\S]{0,80}created_at/);
  });

  it("and it is still an INSERT — no constraint was added to the bookkeeping table", () => {
    /**
     * A UNIQUE key on `created_at` would be the obvious alternative and is the wrong move here:
     * it is a destructive schema change on the migration table, and it would fail outright while
     * 1457 duplicate rows still exist.
     */
    const at = GUARD.indexOf("async insertRecord(");
    const body = GUARD.slice(at, at + 2400);
    expect(body).toContain("INSERT INTO");
    expect(body).not.toContain("ALTER TABLE");
    expect(GUARD).not.toContain("ADD UNIQUE");
  });

  it("the liveness endpoint the probe now uses does no database work", () => {
    const core = stripComments(
      fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8")
    );
    const at = core.indexOf('app.get("/api/health/live"');
    expect(at, "the liveness endpoint is gone").toBeGreaterThan(0);
    const handler = core.slice(at, at + 260);
    expect(handler).toContain("res.status(200)");
    expect(handler, "the liveness probe acquired an await").not.toContain("await");
  });
});
