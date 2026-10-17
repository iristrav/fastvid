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

/** VIDEO 650 — the system's own generated generic footage (genericFootageFallback.ts). */
export const GENERIC_ARCHIVE_SLUG = "generic";

/**
 * VIDEO 662 — the pictures FastVid generates itself (ElevenLabs/Veo video, Stability stills,
 * Replicate). Kept so a render can read them back — render 72's retry lost three approved AI
 * pictures because no archive held them — and never offered as archive footage to another film.
 */
export const AI_ARCHIVE_SLUG = "ai";
/** The generated-picture providers (generatedImageFallback's AI_GENERATED_PROVIDERS), spelled here so this module stays import-free. */
const AI_PLATFORMS: ReadonlySet<string> = new Set(["stability", "elevenlabs_video", "replicate_pvideo"]);

export type AutoArchiveKind = "stock" | "youtube" | "other" | "generic" | "ai";

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
  generic: {
    slug: GENERIC_ARCHIVE_SLUG,
    name: "Generieke beelden",
    description:
      "Rights-clear, non-specific moving footage: the floor under the sourcing ladder (VIDEO 650). " +
      "Clips tagged `generic` here are offered to a sentence nothing else could picture; the " +
      "synthetic colour fields FastVid renders itself are filed here too.",
    isActive: 1,
  },
  ai: {
    slug: AI_ARCHIVE_SLUG,
    name: "AI-beelden",
    description:
      "Pictures FastVid generated itself for a sentence (ElevenLabs/Veo, Stability, Replicate). Kept so " +
      "every shot can be read back from our own storage; never offered as archive footage.",
    isActive: 0,
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
  if (AI_PLATFORMS.has(platform) || [...AI_PLATFORMS].some((p) => note.startsWith(`${p}:`))) return "ai";
  if (platform === "youtube" || platform === "youtube_cc" || note.startsWith("youtube")) return "youtube";
  if (platform === "generic_footage" || note.startsWith("generic_footage:")) return "generic";
  /** the synthetic placeholder is filed with the generic clips so an operator finds and replaces it, never as footage */
  if (platform === "synthetic_placeholder" || note.startsWith("synthetic_placeholder:")) return "generic";
  return "other";
}
