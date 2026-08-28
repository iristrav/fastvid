/**
 * FASTVID — migration artifact integrity (RONDE 151)
 *
 * ── The deploy this exists to prevent ────────────────────────────────────────────────────────
 *
 *     [Migration] ✓ 47/47 migrations recorded — nothing to apply
 *     [SchemaValidation] *** SCHEMA MISMATCH — ABORTING STARTUP ***
 *       Table: discount_codes
 *         ✗ [table_missing] discount_codes
 *
 * 48 `.sql` files on disk, 47 entries in `meta/_journal.json`. drizzle-orm's migrator iterates the
 * JOURNAL, not the folder, so a file the journal does not name is invisible to it: nothing
 * pending, nothing applied, and a cheerful success line. The schema validator then refused to boot
 * against a database missing a table the code declares, and the web service crash-looped.
 *
 * Every individual component behaved correctly. drizzle applied every migration it knew about; the
 * validator caught the drift and refused to run. What was missing is anyone asking whether the
 * migration ARTIFACTS were internally consistent before trusting a count derived from them.
 *
 * ── Why this is a separate layer ─────────────────────────────────────────────────────────────
 *
 * This is emphatically NOT a second migration engine. It reads two things off disk — the file
 * listing and the journal — and compares them. drizzle keeps sole responsibility for ordering,
 * execution and tracking; `migrationGuard` keeps its ghost/partial reconciliation against the
 * database. This layer answers one question that neither of them can:
 *
 *     "is the artifact set we are about to trust complete and self-consistent?"
 *
 * It touches no database, which is what lets the same function run in CI and on a laptop, before
 * anything has connected to anything.
 *
 * ── The rule it enforces ─────────────────────────────────────────────────────────────────────
 *
 * "No pending migrations" may never again be read as "the migration system is healthy". Files must
 * equal journal before a count derived from either means anything.
 */
import fs from "fs";
import path from "path";

/** One journal entry, as drizzle-kit writes it. */
export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type MigrationIntegrityResult = {
  ok: boolean;
  fileCount: number;
  journalCount: number;
  /** A `.sql` on disk with no journal entry — the RONDE 150 failure. Never executed. */
  missingJournalEntries: string[];
  /** A journal entry whose `.sql` is absent — the migrator throws on it at startup. */
  missingFilesForJournal: string[];
  /** The same tag listed twice in the journal. */
  duplicateJournalEntries: string[];
  /** Two files claiming the same NNNN prefix. */
  duplicateMigrationNumbers: number[];
  /** A hole in the NNNN sequence: 0044, 0045, 0047 with no 0046. */
  missingMigrationNumbers: number[];
  /** `idx` values that are not 0,1,2,… in order. */
  orderingProblems: string[];
  /** `when` values that repeat or run backwards — the key the runner matches on. */
  timestampProblems: string[];
  /**
   * A migration whose text would be cut into something that is not SQL.
   *
   * drizzle splits on the breakpoint marker ANYWHERE in the file, comments included. A comment
   * quoting the marker gets cut in half and the remainder is handed to MySQL as a statement.
   */
  unsafeBreakpointUsage: string[];
};

/**
 * The string drizzle splits a migration on.
 *
 * Assembled from pieces on purpose. Writing the literal here would put it in a file this check
 * also has to scan in principle, and — more to the point — it is the exact mistake being guarded
 * against: quoting the marker in prose is what broke the deploy.
 */
const BREAKPOINT_MARKER = `--${">"} statement-breakpoint`;

const OK_RESULT_FIELDS: ReadonlyArray<keyof MigrationIntegrityResult> = [
  "missingJournalEntries",
  "missingFilesForJournal",
  "duplicateJournalEntries",
  "duplicateMigrationNumbers",
  "missingMigrationNumbers",
  "orderingProblems",
  "timestampProblems",
  "unsafeBreakpointUsage",
];

/** The migration tags present on disk, sorted, without the `.sql` suffix. */
export function readMigrationFiles(migrationsFolder: string): string[] {
  return fs
    .readdirSync(migrationsFolder)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -4))
    .sort();
}

export function readJournal(migrationsFolder: string): { entries: JournalEntry[] } {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  return JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
}

/** The leading NNNN of a tag, or null when it does not start with four digits. */
function migrationNumber(tag: string): number | null {
  const m = /^(\d{4})/.exec(tag);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Compare the files on disk with the journal. Pure, synchronous, no database.
 *
 * Deliberately reports EVERY problem it finds rather than returning on the first one: a deploy is
 * blocked either way, and an operator fixing this at 2am should see the whole picture in one pass
 * instead of rediscovering it one restart at a time.
 */
export function checkMigrationIntegrity(migrationsFolder: string): MigrationIntegrityResult {
  const files = readMigrationFiles(migrationsFolder);
  const journal = readJournal(migrationsFolder);
  const entries = journal.entries ?? [];
  const tags = entries.map((e) => e.tag);
  const fileSet = new Set(files);
  const tagSet = new Set(tags);

  const missingJournalEntries = files.filter((f) => !tagSet.has(f));
  const missingFilesForJournal = tags.filter((t) => !fileSet.has(t));
  const duplicateJournalEntries = [...new Set(tags.filter((t, i) => tags.indexOf(t) !== i))];

  const numbers = files.map(migrationNumber).filter((n): n is number => n !== null);
  const duplicateMigrationNumbers = [
    ...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i)),
  ].sort((a, b) => a - b);
  const highest = numbers.length ? Math.max(...numbers) : -1;
  const present = new Set(numbers);
  const missingMigrationNumbers: number[] = [];
  for (let n = 0; n <= highest; n++) if (!present.has(n)) missingMigrationNumbers.push(n);

  const orderingProblems: string[] = [];
  entries.forEach((e, i) => {
    if (e.idx !== i) orderingProblems.push(`${e.tag}: idx=${e.idx}, expected ${i}`);
  });

  /**
   * `when` is not decoration: migrationGuard builds the set of already-applied migrations from
   * `__drizzle_migrations` and treats any entry whose `when` is absent from it as pending. A
   * duplicate makes two migrations indistinguishable to that comparison; a value that runs
   * backwards means the journal order and the chronological order disagree.
   */
  const timestampProblems: string[] = [];
  const seenWhen = new Map<number, string>();
  let previousWhen = -Infinity;
  for (const e of entries) {
    const clash = seenWhen.get(e.when);
    if (clash) timestampProblems.push(`${e.tag}: duplicate "when" (${e.when}) shared with ${clash}`);
    else seenWhen.set(e.when, e.tag);
    if (e.when < previousWhen) {
      timestampProblems.push(`${e.tag}: "when" (${e.when}) is earlier than the entry before it`);
    }
    previousWhen = e.when;
  }

  /**
   * The hazard that broke attempt 2 at deploying 0047.
   *
   * A line containing the marker is safe in exactly two shapes: the marker alone on its own line
   * (what drizzle-kit generates), or a finished statement followed by it (`ALTER TABLE …;` plus
   * the marker, which drizzle-kit also generates). Anything else — most importantly a COMMENT that
   * quotes the marker — gets split mid-text, and the fragment after the cut goes to MySQL as SQL.
   */
  const unsafeBreakpointUsage: string[] = [];
  for (const tag of files) {
    const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
    sql.split("\n").forEach((line, i) => {
      if (!line.includes(BREAKPOINT_MARKER)) return;
      const trimmed = line.trim();
      if (trimmed === BREAKPOINT_MARKER) return;
      const before = trimmed.slice(0, trimmed.indexOf(BREAKPOINT_MARKER)).trim();
      // A completed statement immediately before the marker is the generator's own inline form.
      if (before.endsWith(";")) return;
      unsafeBreakpointUsage.push(
        `${tag}:${i + 1}: the breakpoint marker appears mid-line — the split would cut this text`
      );
    });
  }

  const result: MigrationIntegrityResult = {
    ok: true,
    fileCount: files.length,
    journalCount: entries.length,
    missingJournalEntries,
    missingFilesForJournal,
    duplicateJournalEntries,
    duplicateMigrationNumbers,
    missingMigrationNumbers,
    orderingProblems,
    timestampProblems,
    unsafeBreakpointUsage,
  };
  result.ok = OK_RESULT_FIELDS.every((k) => (result[k] as unknown[]).length === 0);
  return result;
}

/**
 * The log lines. One line on success, an itemised block on failure.
 *
 * The wording matters as much as the check. The failure this replaces printed
 * "✓ 47/47 migrations recorded — nothing to apply" — a success message for a broken state. Nothing
 * here can be mistaken for a healthy deploy: the counts are always shown together, and every empty
 * category is printed too, so "missingJournalEntries=[]" is visible evidence rather than silence.
 */
export function formatMigrationIntegrity(result: MigrationIntegrityResult): string {
  if (result.ok) {
    return `[MigrationsIntegrity] ✓ files=${result.fileCount} journal=${result.journalCount} synchronized`;
  }
  const lines = [
    `[MigrationsIntegrity] ✗ files=${result.fileCount} journal=${result.journalCount}`,
    `  missingJournalEntries=${JSON.stringify(result.missingJournalEntries)}`,
    `  missingFilesForJournal=${JSON.stringify(result.missingFilesForJournal)}`,
    `  duplicateJournalEntries=${JSON.stringify(result.duplicateJournalEntries)}`,
    `  duplicateMigrationNumbers=${JSON.stringify(result.duplicateMigrationNumbers)}`,
    `  missingMigrationNumbers=${JSON.stringify(result.missingMigrationNumbers)}`,
  ];
  if (result.orderingProblems.length) {
    lines.push(`  orderingProblems=${JSON.stringify(result.orderingProblems)}`);
  }
  if (result.timestampProblems.length) {
    lines.push(`  timestampProblems=${JSON.stringify(result.timestampProblems)}`);
  }
  if (result.unsafeBreakpointUsage.length) {
    lines.push(`  unsafeBreakpointUsage=${JSON.stringify(result.unsafeBreakpointUsage)}`);
    lines.push(
      "  The statement separator is matched anywhere in the file, comments included. A comment " +
        "quoting it is cut in half and the remainder is executed as SQL."
    );
  }
  lines.push("  databaseMigrationState=unknown — integrity is checked before any database work");
  lines.push("");
  lines.push("[MigrationsIntegrity] DEPLOY BLOCKED");
  lines.push("  Action required: repair the migration artifact set before deploying.");
  if (result.missingJournalEntries.length) {
    lines.push(
      `  A .sql file with no journal entry is NEVER executed — drizzle iterates meta/_journal.json, ` +
        `not the folder. Regenerate with drizzle-kit, or add the entry, and commit both together.`
    );
  }
  if (result.missingFilesForJournal.length) {
    lines.push(
      `  A journal entry with no .sql file makes the migrator throw at startup. Restore the file ` +
        `or remove the entry.`
    );
  }
  lines.push(
    "  Nothing has been changed automatically: no SQL was guessed, no table dropped, no migration " +
      "history rewritten."
  );
  return lines.join("\n");
}

/**
 * Fail fast, before the migration runner and before any database connection.
 *
 * Throwing here is the whole point. The previous ordering let a broken artifact set produce a
 * success line, start the app, and only fail at schema validation — by which time the process was
 * half up and the real cause was two screens further back in the log.
 */
export function assertMigrationIntegrity(migrationsFolder: string): MigrationIntegrityResult {
  const result = checkMigrationIntegrity(migrationsFolder);
  if (result.ok) {
    console.log(formatMigrationIntegrity(result));
    return result;
  }
  console.error(formatMigrationIntegrity(result));
  throw new Error(
    `Migration artifact integrity failed: ${result.fileCount} file(s) vs ${result.journalCount} ` +
      `journal entry/entries — see [MigrationsIntegrity] above`
  );
}
