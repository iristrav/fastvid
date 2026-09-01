/**
 * FASTVID — migration artifact integrity, standalone (RONDE 151)
 *
 *     pnpm run migrations:check
 *
 * The same function the two entry points call before they migrate, runnable without a database.
 * That is the point: this failure class is entirely detectable from two files on disk, so it
 * should be caught at commit time and in CI, and never again at production startup.
 *
 * Run it after `drizzle-kit generate`. The generator writes the `.sql` AND the journal entry
 * together, so a normal generate always passes; this catches the cases where the two came apart —
 * a hand-written migration, an interrupted generate, a merge that kept one side of the pair.
 *
 * Exit 0 = artifacts consistent. Exit 1 = deploy would be blocked.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { assertMigrationIntegrity } from "../server/migrationIntegrity";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "drizzle");

if (!fs.existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
  console.error(`[MigrationsIntegrity] ✗ no journal at ${migrationsFolder}/meta/_journal.json`);
  process.exit(1);
}

try {
  assertMigrationIntegrity(migrationsFolder);
} catch {
  // assertMigrationIntegrity has already printed the itemised report; adding the stack here would
  // bury it under noise that says nothing the report has not already said.
  process.exit(1);
}
