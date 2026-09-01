/**
 * RONDE 212 — every foreign key the code declares must exist in a migration.
 *
 * ── The production outage this comes from ────────────────────────────────────────────────────
 *
 * The Railway web service crash-looped. The log:
 *
 *     Table: render_jobs
 *       ✗ [fk_missing] render_jobs
 *           expected : FK (videoId) → videos(id)
 *           actual   : no matching FK found
 *           migration: 0050_ronde148_render_jobs.sql
 *     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
 *     [Fastvid] Fatal startup error — exiting so Railway marks the deployment failed
 *
 * `drizzle/schema.ts` declares `videoId: int("videoId").notNull().references(() => videos.id)`.
 * `0050_ronde148_render_jobs.sql` creates the table with that column and never emits the
 * constraint. `validateSchema` compares the two at boot and — correctly — refuses to start.
 *
 * ── Why this test is about the CLASS and not the instance ────────────────────────────────────
 *
 * This is the second time. `0043_f326_visual_search_memory_fk_repair.sql` exists because
 * `0042` did exactly the same thing to `visual_search_memory.assetId`, and its header describes
 * the bug in the same words. Two occurrences of one mistake, each found by a deployment failing
 * rather than by a test.
 *
 * A test pinning "render_jobs has its FK" would not have caught 0042 and will not catch the next
 * one. So this walks every `.references()` in the schema and requires a matching FOREIGN KEY
 * somewhere in the migrations — the check that would have caught both, and catches the eleventh
 * table for free.
 *
 * It is a TEXT comparison against the migration SQL, deliberately: it needs no database, so it
 * runs in CI and locally, which is the whole point of catching this before a deploy rather than
 * during one.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SCHEMA = fs.readFileSync("drizzle/schema.ts", "utf8");

/** Every migration's SQL, concatenated — a constraint may be added by any of them. */
const MIGRATION_SQL = fs
  .readdirSync("drizzle")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => fs.readFileSync(path.join("drizzle", f), "utf8"))
  .join("\n");

/** The drizzle variable name → the SQL table name it declares. */
function tableNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SCHEMA.matchAll(/export const (\w+)\s*=\s*mysqlTable\(\s*"([^"]+)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

type Declared = { column: string; refVar: string; refColumn: string };

/** Every `.references(() => Table.column)` in the schema, with the column that owns it. */
function declaredForeignKeys(): Declared[] {
  const out: Declared[] = [];
  for (const m of SCHEMA.matchAll(
    /(\w+):\s*\w+\("([^"]+)"[^,\n]*\)[^\n]*?\.references\(\(\)\s*=>\s*(\w+)\.(\w+)/g
  )) {
    out.push({ column: m[2]!, refVar: m[3]!, refColumn: m[4]! });
  }
  return out;
}

describe("R212 — the migrations create every foreign key the schema declares", () => {
  const tables = tableNames();
  const declared = declaredForeignKeys();

  /**
   * A guard on the guard. If the regexes above ever stop matching — a formatting change, a move to
   * a different declaration style — this file would pass by finding nothing to check, which is the
   * most dangerous way for a test to be green.
   */
  it("actually finds the schema's tables and foreign keys", () => {
    expect(Object.keys(tables).length, "no mysqlTable declarations parsed").toBeGreaterThan(20);
    expect(declared.length, "no .references() declarations parsed").toBeGreaterThanOrEqual(10);
  });

  it("resolves every referenced table to a real table name", () => {
    for (const fk of declared) {
      expect(tables[fk.refVar], `${fk.column} references unknown table ${fk.refVar}`).toBeTruthy();
    }
  });

  /**
   * The rule itself. One test per declared key, so a failure names the column rather than saying
   * "some foreign key is missing" — which is the difference between a five-minute fix and an hour
   * of bisecting a schema file.
   */
  for (const fk of declaredForeignKeys()) {
    const refTable = tableNames()[fk.refVar] ?? fk.refVar;
    it(`(${fk.column}) → ${refTable}(${fk.refColumn}) is created by a migration`, () => {
      const pattern = new RegExp(
        `FOREIGN KEY\\s*\\(\`?${fk.column}\`?\\)\\s*REFERENCES\\s*\`?${refTable}\`?`,
        "i"
      );
      expect(
        pattern.test(MIGRATION_SQL),
        `drizzle/schema.ts declares .references(() => ${fk.refVar}.${fk.refColumn}) on "${fk.column}", ` +
          `but no migration contains FOREIGN KEY (${fk.column}) REFERENCES ${refTable}. ` +
          `validateSchema will report fk_missing and refuse to start.`
      ).toBe(true);
    });
  }
});

/* ═══════════════════════ the migration set stays internally consistent ═══════════════════════ */

describe("R212 — every migration file is registered, and every registration has a file", () => {
  const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const files = fs
    .readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();

  /**
   * The failure this prevents is quiet: an unregistered .sql file simply never runs, so the
   * database silently lacks whatever it contained until something else fails much later.
   */
  it("the journal and the directory describe the same set", () => {
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);
  });

  it("indexes are unique and contiguous from zero", () => {
    const idx = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(new Set(idx).size, "duplicate migration index").toBe(idx.length);
    expect(idx).toEqual(idx.map((_, i) => i));
  });
});
