/**
 * RONDE 647 — the slug of the separate "Stockbeelden" archive.
 *
 * Its own module, with no imports, so every reader (ingestion, curated sourcing, db) names the same
 * string and a test that mocks `./db` still gets the real value.
 */
export const STOCK_ARCHIVE_SLUG = "stock";

/**
 * RONDE 648 — where an AUTOMATIC ingest goes, by the kind of its source.
 *
 * Until now it went to the most recently updated active archive, which is how archive 36,
 * "Stockbeelden", came to hold 57 YouTube segments and no stock. A hand upload names its archive
 * and never reaches this; only a clip FastVid found and archived itself does.
 */
export const YOUTUBE_ARCHIVE_SLUG = "youtube";
export const OTHER_ARCHIVE_SLUG = "overig";

export type AutoArchiveKind = "stock" | "youtube" | "other";

export const AUTO_ARCHIVES: Record<AutoArchiveKind, { slug: string; name: string; description: string; isActive: number }> = {
  stock: {
    slug: STOCK_ARCHIVE_SLUG,
    name: "Stockbeelden",
    description:
      "Stock shots (Pexels, Pixabay) used in delivered films. Kept so every shot can be read back " +
      "from our own storage; never offered as archive footage.",
    isActive: 0,
  },
  youtube: {
    slug: YOUTUBE_ARCHIVE_SLUG,
    name: "YouTube",
    description: "YouTube segments FastVid fetched and archived automatically.",
    isActive: 1,
  },
  other: {
    slug: OTHER_ARCHIVE_SLUG,
    name: "Overig",
    description:
      "Automatically archived footage from other sources (Wikimedia, Internet Archive, Openverse, ...).",
    isActive: 1,
  },
};

/** The kind of an automatic ingest, read from what the ingest says about its own source. */
export function autoArchiveKind(meta: { sourcePlatform?: string | null; sourceNote: string }): AutoArchiveKind {
  const platform = (meta.sourcePlatform ?? "").toLowerCase();
  const note = meta.sourceNote.toLowerCase();
  if (platform === "pexels" || platform === "pixabay" || note.startsWith("pexels:") || note.startsWith("pixabay:")) {
    return "stock";
  }
  if (platform === "youtube" || platform === "youtube_cc" || note.startsWith("youtube")) return "youtube";
  return "other";
}
