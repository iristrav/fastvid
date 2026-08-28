/**
 * FASTVID — migration artifact integrity (RONDE 151)
 *
 * ── The two production failures this file exists for ─────────────────────────────────────────
 *
 * ATTEMPT 1 — a `.sql` on disk with no journal entry:
 *
 *     [Migration] ✓ 47/47 migrations recorded — nothing to apply
 *     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
 *       ✗ [table_missing] discount_codes
 *
 * 48 files, 47 journal entries. drizzle iterates the journal, so the file was never executed — and
 * the log said "nothing to apply" in a tone indistinguishable from a healthy deploy.
 *
 * ATTEMPT 2 — the same file, now registered, but its COMMENT quoted the breakpoint marker:
 *
 *     [Migration] MySQL error code : ER_PARSE_ERROR
 *     near '` is required, not decoration. drizzle-orm's migrator splits a
 *
 * The splitter matches that string anywhere in the file. A sentence explaining the marker was cut
 * in half and the remainder was sent to MySQL as a statement.
 *
 * Both are artifact-level faults: detectable from files on disk, with no database, before anything
 * connects to anything. That is what makes them CI-catchable, and why they never should have
 * reached production.
 *
 * ── How these tests work ─────────────────────────────────────────────────────────────────────
 *
 * Each case builds a throwaway migration folder in a temp dir and runs the real checker over it.
 * Testing against constructed folders rather than the repo's own is what lets the FAILING states
 * be exercised at all — the repo is (and must stay) consistent, so it can only ever prove the
 * pass case.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertMigrationIntegrity,
  checkMigrationIntegrity,
  formatMigrationIntegrity,
} from "./migrationIntegrity";

// Assembled, never written literally: a comment quoting this marker is the attempt-2 bug, and this
// file would otherwise be an example of it.
const BREAKPOINT = `--${">"} statement-breakpoint`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

type Migration = { tag: string; sql?: string };

/** Build a migration folder. `journalTags` defaults to exactly the files, i.e. a healthy set. */
function makeFolder(files: Migration[], journalTags?: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-migint-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  for (const f of files) {
    fs.writeFileSync(path.join(dir, `${f.tag}.sql`), f.sql ?? "SELECT 1;\n");
  }
  const tags = journalTags ?? files.map((f) => f.tag);
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "mysql",
      entries: tags.map((tag, i) => ({
        idx: i,
        version: "5",
        when: 1_700_000_000_000 + i * 1000,
        tag,
        breakpoints: true,
      })),
    })
  );
  return dir;
}

const HEALTHY: Migration[] = [
  { tag: "0000_first" },
  { tag: "0001_second" },
  { tag: "0002_third" },
];

// ─── 1: the healthy case ─────────────────────────────────────────────────────────────────────

describe("migration integrity — 1. files == journal", () => {
  it("PASSES, and says so in one unambiguous line", () => {
    const result = checkMigrationIntegrity(makeFolder(HEALTHY));
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(result.journalCount).toBe(3);
    expect(formatMigrationIntegrity(result)).toBe(
      "[MigrationsIntegrity] ✓ files=3 journal=3 synchronized"
    );
  });

  it("assert does not throw on a healthy set", () => {
    expect(() => assertMigrationIntegrity(makeFolder(HEALTHY))).not.toThrow();
  });
});

// ─── 2, 3, 4, 5, 6, 7, 8, 9: each broken shape ───────────────────────────────────────────────

describe("migration integrity — each broken artifact set is refused", () => {
  it("2. a missing journal entry FAILS", () => {
    const result = checkMigrationIntegrity(
      makeFolder(HEALTHY, ["0000_first", "0001_second"])
    );
    expect(result.ok).toBe(false);
    expect(result.missingJournalEntries).toEqual(["0002_third"]);
    expect(result.missingFilesForJournal).toEqual([]);
  });

  it("3. an orphan journal entry FAILS", () => {
    const result = checkMigrationIntegrity(
      makeFolder(HEALTHY, [...HEALTHY.map((f) => f.tag), "0003_ghost"])
    );
    expect(result.ok).toBe(false);
    expect(result.missingFilesForJournal).toEqual(["0003_ghost"]);
  });

  it("4. a duplicate journal entry FAILS", () => {
    const result = checkMigrationIntegrity(
      makeFolder(HEALTHY, ["0000_first", "0001_second", "0001_second", "0002_third"])
    );
    expect(result.ok).toBe(false);
    expect(result.duplicateJournalEntries).toEqual(["0001_second"]);
  });

  it("5. two files claiming the same number FAILS", () => {
    const result = checkMigrationIntegrity(
      makeFolder([...HEALTHY, { tag: "0002_duplicate_number" }])
    );
    expect(result.ok).toBe(false);
    expect(result.duplicateMigrationNumbers).toEqual([2]);
  });

  it("6. a hole in the numbering FAILS", () => {
    const result = checkMigrationIntegrity(
      makeFolder([{ tag: "0000_first" }, { tag: "0001_second" }, { tag: "0003_fourth" }])
    );
    expect(result.ok).toBe(false);
    expect(result.missingMigrationNumbers).toEqual([2]);
  });

  it("7. journal entries out of order FAIL", () => {
    const dir = makeFolder(HEALTHY);
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.entries[1].idx = 7;
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const result = checkMigrationIntegrity(dir);
    expect(result.ok).toBe(false);
    expect(result.orderingProblems[0]).toContain("idx=7, expected 1");
  });

  it("8. an extra SQL file with no entry FAILS — same shape as case 2", () => {
    const result = checkMigrationIntegrity(
      makeFolder([...HEALTHY, { tag: "0003_forgotten" }], HEALTHY.map((f) => f.tag))
    );
    expect(result.ok).toBe(false);
    expect(result.missingJournalEntries).toEqual(["0003_forgotten"]);
  });

  it("9. a journal entry with no SQL FAILS — same shape as case 3", () => {
    const result = checkMigrationIntegrity(
      makeFolder([{ tag: "0000_first" }], ["0000_first", "0001_absent"])
    );
    expect(result.ok).toBe(false);
    expect(result.missingFilesForJournal).toEqual(["0001_absent"]);
  });

  it("a duplicate `when` FAILS — it is the key the runner matches on", () => {
    const dir = makeFolder(HEALTHY);
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.entries[2].when = journal.entries[1].when;
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const result = checkMigrationIntegrity(dir);
    expect(result.ok).toBe(false);
    expect(result.timestampProblems[0]).toContain("duplicate");
  });
});

// ─── 10 and 11: the exact production states ──────────────────────────────────────────────────

describe("migration integrity — the two deploys that actually failed", () => {
  /** 48 files, 47 journal entries, 0047 absent from the journal. */
  function productionAttempt1(): string {
    const files = Array.from({ length: 48 }, (_, i) => ({
      tag: `${String(i).padStart(4, "0")}_migration`,
    }));
    return makeFolder(files, files.slice(0, 47).map((f) => f.tag));
  }

  it("10. the 48-files/47-journal state FAILS", () => {
    const result = checkMigrationIntegrity(productionAttempt1());
    expect(result.ok).toBe(false);
    expect(result.fileCount).toBe(48);
    expect(result.journalCount).toBe(47);
    expect(result.missingJournalEntries).toEqual(["0047_migration"]);
  });

  it("10b. the migration runner is NEVER reached — assert throws first", () => {
    /**
     * This is the whole ordering fix. Previously the runner ran, reported "nothing to apply", the
     * app started, and schema validation crashed it two steps later. Now nothing touches the
     * database at all.
     */
    expect(() => assertMigrationIntegrity(productionAttempt1())).toThrow(
      /48 file\(s\) vs 47 journal/
    );
  });

  it("10c. the failure log cannot be mistaken for a healthy deploy", () => {
    const report = formatMigrationIntegrity(checkMigrationIntegrity(productionAttempt1()));
    expect(report).toContain("[MigrationsIntegrity] ✗ files=48 journal=47");
    expect(report).toContain('missingJournalEntries=["0047_migration"]');
    expect(report).toContain("[MigrationsIntegrity] DEPLOY BLOCKED");
    // The phrase that made the original failure look fine must not appear anywhere.
    expect(report).not.toContain("nothing to apply");
    expect(report).not.toContain("✓");
    // And it must promise no automatic repair — §10 of the brief.
    expect(report).toContain("no table dropped");
  });

  it("11. the repaired state PASSES", () => {
    const files = Array.from({ length: 48 }, (_, i) => ({
      tag: `${String(i).padStart(4, "0")}_migration`,
    }));
    const result = checkMigrationIntegrity(makeFolder(files));
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(48);
    expect(result.journalCount).toBe(48);
  });

  it("attempt 2: a comment quoting the breakpoint marker FAILS", () => {
    /**
     * The second deploy. The file was registered and the split still produced garbage, because a
     * comment contained the marker and the splitter matches it anywhere.
     */
    const result = checkMigrationIntegrity(
      makeFolder([
        {
          tag: "0000_first",
          sql: `-- The ${BREAKPOINT} marker is required here.\nSELECT 1;\n`,
        },
      ])
    );
    expect(result.ok).toBe(false);
    expect(result.unsafeBreakpointUsage[0]).toContain("0000_first:1");
    expect(formatMigrationIntegrity(result)).toContain("cut in half");
  });

  it("...but the two shapes drizzle-kit itself generates are accepted", () => {
    const result = checkMigrationIntegrity(
      makeFolder([
        {
          tag: "0000_first",
          // The marker alone on a line, and a finished statement followed by it inline.
          sql: `CREATE TABLE a (id int);\n${BREAKPOINT}\nALTER TABLE a ADD b int;${BREAKPOINT}\nSELECT 1;\n`,
        },
      ])
    );
    expect(result.unsafeBreakpointUsage).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ─── the repository's own artifacts ──────────────────────────────────────────────────────────

describe("migration integrity — this repository", () => {
  const REPO_MIGRATIONS = path.join(__dirname, "..", "drizzle");

  it("is consistent right now", () => {
    const result = checkMigrationIntegrity(REPO_MIGRATIONS);
    expect(
      result.ok,
      `integrity failed:\n${formatMigrationIntegrity(result)}`
    ).toBe(true);
  });

  it("0047 is registered and would actually run", () => {
    const result = checkMigrationIntegrity(REPO_MIGRATIONS);
    expect(result.missingJournalEntries).toEqual([]);
    expect(result.fileCount).toBe(result.journalCount);
  });

  it("both entry points check integrity BEFORE running migrations", () => {
    for (const entry of ["_core/index.ts", "worker.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, entry), "utf8");
      const guard = src.indexOf("assertMigrationIntegrity(migrationsFolder);");
      const run = src.indexOf("runMigrationsWithGuard(");
      expect(guard, `${entry}: guard missing`).toBeGreaterThan(-1);
      expect(run, `${entry}: runner missing`).toBeGreaterThan(-1);
      expect(guard, `${entry}: guard must come first`).toBeLessThan(run);
    }
  });

  it("schema validation is still there — the two layers are complementary", () => {
    // Layer 2 caught the original bug and must not be removed in favour of layer 1: it answers a
    // different question, about the live database rather than the artifacts.
    const src = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
    expect(src).toContain("async function validateSchema");
    expect(src).toContain("SCHEMA MISMATCH");
  });

  it("CI blocks a deploy on this, and a developer can run it locally", () => {
    const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("pnpm run migrations:check");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.scripts["migrations:check"]).toBe("tsx scripts/check-migrations.ts");
  });
});
