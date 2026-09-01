/**
 * RONDE 150 — a migration file that is not in the journal does nothing.
 *
 * ── The production failure ───────────────────────────────────────────────────────────────────
 *
 * RONDE 148 added `0047_ronde147_discount_codes.sql` by hand and never registered it in
 * `drizzle/meta/_journal.json`. The deploy log says exactly what that costs:
 *
 *     [Migration] ✓ 47/47 migrations recorded — nothing to apply
 *     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
 *       Table: discount_codes
 *         ✗ [table_missing] discount_codes
 *
 * 48 files on disk, 47 in the journal. drizzle's migrator iterates the JOURNAL, not the folder, so
 * the file was invisible: nothing pending, nothing applied, and the schema validator then refused
 * to start the app because the code declares a table the database does not have. The web service
 * crash-looped.
 *
 * The validator did its job — it caught the drift and refused to run against a database that did
 * not match. What was missing is anything that catches it BEFORE a deploy, which is this file.
 *
 * ── The second defect in the same file ───────────────────────────────────────────────────────
 *
 * It also had no `--> statement-breakpoint` markers and used `CREATE INDEX IF NOT EXISTS`. The
 * first would have sent three statements as one string; the second is MariaDB syntax that MySQL
 * rejects. Neither would have surfaced until the migration actually ran — which, because of the
 * journal omission, it never did. Both are asserted below for every migration, not just this one.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

const journal = (): { entries: JournalEntry[] } => JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
const sqlTags = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -4))
    .sort();

describe("RONDE 150 — every migration on disk is in the journal", () => {
  it("no .sql file is missing from the journal", () => {
    /**
     * This is the assertion that would have stopped the failed deploy. A file the journal does not
     * name is dead weight: it ships, it is never executed, and the mismatch only surfaces when the
     * schema validator refuses to boot in production.
     */
    const tags = new Set(journal().entries.map((e) => e.tag));
    const orphans = sqlTags().filter((t) => !tags.has(t));
    expect(orphans, `these migrations would never run: ${orphans.join(", ")}`).toEqual([]);
  });

  it("no journal entry points at a file that does not exist", () => {
    // The other direction: the migrator would throw on a missing file at startup.
    const files = new Set(sqlTags());
    const dangling = journal().entries.map((e) => e.tag).filter((t) => !files.has(t));
    expect(dangling, `journal names missing files: ${dangling.join(", ")}`).toEqual([]);
  });

  it("`when` is unique and increasing — it is the key the runner matches on", () => {
    // migrationGuard builds `recordedMillisSet` from __drizzle_migrations and treats any entry
    // whose `when` is absent as pending. A duplicate would make two migrations indistinguishable.
    const whens = journal().entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
  });

  it("`idx` is contiguous from zero", () => {
    const idxs = journal().entries.map((e) => e.idx);
    expect(idxs).toEqual(idxs.map((_, i) => i));
  });
});

describe("RONDE 150 — every migration is executable as written", () => {
  /**
   * Comments have to go before anything is counted or pattern-matched.
   *
   * Both checks below were written against the raw text first and both produced false positives:
   * a `;` inside a prose comment looked like a second statement, and the sentence "MySQL does not
   * support CREATE INDEX IF NOT EXISTS" — which 0031 and 0047 both contain, explaining why they
   * use the prepared-statement form — looked like the offending syntax itself. Stripping first is
   * what makes these assertions about the SQL rather than about the documentation.
   */
  const stripComments = (sql: string) =>
    sql
      .split("\n")
      // `--> statement-breakpoint` also begins with `--`, and it is not a comment: it is the
      // marker drizzle splits on. Stripping it would make the breakpoint check below vacuous —
      // every file would look as though it had none.
      .filter((line) => !line.trim().startsWith("--") || line.trim().startsWith("-->"))
      .join("\n");

  const withSql = () =>
    sqlTags().map((tag) => ({
      tag,
      raw: readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8"),
      sql: stripComments(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")),
    }));

  const multiStatement = () =>
    withSql().filter(({ sql }) => sql.split(";").filter((s) => s.trim()).length > 1);

  it("the comment stripper works, or the two checks below prove nothing", () => {
    // A guard on the guard: 0031 documents the MariaDB syntax in prose and must not be flagged.
    const zero31 = withSql().find((m) => m.tag.startsWith("0031"));
    expect(zero31?.raw).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(zero31?.sql).not.toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });

  it("a file with several statements separates them with statement-breakpoint", () => {
    /**
     * drizzle-orm splits on `--> statement-breakpoint` and sends each piece separately. Without
     * the markers the whole file goes as one string and MySQL rejects it — a failure that only
     * appears when the migration actually runs, which can be long after it was written.
     */
    const missing = multiStatement()
      .filter(({ sql }) => !sql.includes("--> statement-breakpoint"))
      .map(({ tag }) => tag);
    expect(missing, `multi-statement migrations without breakpoints: ${missing.join(", ")}`).toEqual([]);
  });

  it("no migration uses CREATE INDEX IF NOT EXISTS — MySQL does not accept it", () => {
    /**
     * MariaDB supports it; MySQL does not. The established idempotent form in this folder goes
     * through INFORMATION_SCHEMA plus a prepared statement — see 0019, 0020, 0023, 0024, 0047.
     */
    const offenders = withSql()
      .filter(({ sql }) => /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(sql))
      .map(({ tag }) => tag);
    expect(offenders, `MariaDB-only syntax in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("RONDE 150 — the discount_codes migration specifically", () => {
  const TAG = "0047_ronde147_discount_codes";
  const sql = () => readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`), "utf8");

  it("is registered, so it will actually be applied", () => {
    const entry = journal().entries.find((e) => e.tag === TAG);
    expect(entry, "the migration that broke the deploy must be in the journal").toBeTruthy();
    expect(entry!.breakpoints).toBe(true);
  });

  it("is idempotent by migrationGuard's own definition", () => {
    // detectIdempotency() accepts either IF NOT EXISTS or INFORMATION_SCHEMA. A partially applied
    // migration that is NOT idempotent makes the guard abort instead of re-running it.
    expect(/IF\s+NOT\s+EXISTS/i.test(sql()) || /INFORMATION_SCHEMA/i.test(sql())).toBe(true);
  });

  it("creates the table the schema declares, with both uniqueness rules", () => {
    const s = sql();
    expect(s).toContain("CREATE TABLE IF NOT EXISTS `discount_codes`");
    expect(s).toContain("UNIQUE(`code`)");
    expect(s).toContain("UNIQUE(`stripePromotionCodeId`)");
    for (const col of [
      "code", "stripeCouponId", "stripePromotionCodeId", "percentOff", "amountOffCents",
      "currency", "isActive", "startsAt", "expiresAt", "maxRedemptions", "timesRedeemed",
      "note", "createdByUserId", "createdAt", "updatedAt",
    ]) {
      expect(s, col).toContain(`\`${col}\``);
    }
  });

  it("creates both indexes through the prepared-statement pattern", () => {
    const s = sql();
    for (const idx of ["discount_codes_isActive_idx", "discount_codes_created_idx"]) {
      expect(s, idx).toContain(idx);
    }
    expect(s).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(s.match(/PREPARE stmt FROM/g)?.length).toBe(2);
    expect(s.match(/DEALLOCATE PREPARE stmt/g)?.length).toBe(2);
  });
});
