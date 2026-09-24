/**
 * RONDE 647 — the slug of the separate "Stockbeelden" archive.
 *
 * Its own module, with no imports, so every reader (ingestion, curated sourcing, db) names the same
 * string and a test that mocks `./db` still gets the real value.
 */
export const STOCK_ARCHIVE_SLUG = "stock";
