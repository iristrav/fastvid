/**
 * RONDE 146 §2/§3 — WHERE DID THIS PICTURE COME FROM, written down permanently.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * `buildEditorScenesFromPipeline` is handed a resolver and calls exactly one thing on it:
 * `lineage.providerFor(clipPath)` — the provider's NAME. At that same instant the ledger record
 * also holds `providerAssetId`, `sourceUrl`, `originalUrl` and `assetTitle`, put there by the
 * downloader from the provider's own API response. All four are dropped, and the ledger is
 * in-memory, so when the render ends they are gone for good.
 *
 * The result: a finished video knows that a clip came from "wikimedia" and has no way to say
 * WHICH FILE. RONDE 145 measured that as the reason no existing render can be re-rendered.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *
 * IDENTITY IS TAKEN FROM THE ADOPTION RECORD, NEVER RECONSTRUCTED FROM A FILENAME.
 *
 * Every field here comes from the ledger entry that the downloader opened with the provider's own
 * data in hand (RONDE 88's `tagPathWithProviderAsset`). Nothing is parsed out of a path, nothing
 * is inferred from a directory, and a field the provider did not supply comes back `null` rather
 * than guessed. RONDE 86/87 removed filename inference from provenance once already; this must
 * not quietly bring it back through a new door.
 *
 * The one thing this module DERIVES is `sourcePageUrl`, and only from the provider name plus the
 * provider's own id — `pexels` + `12345` is `https://www.pexels.com/video/12345/`. That is a
 * documented URL shape applied to an id the API gave us, not a guess about where a file came from.
 */
import type { AssetSourceIdentity } from "./projectTimeline";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";

/** The subset of a lineage record this module reads. Structural, so tests need no ledger. */
export type AdoptionRecordFacts = {
  provider: string | null;
  providerAssetId?: string;
  sourceUrl?: string;
  originalUrl?: string;
  assetTitle?: string;
  archiveAssetId?: number;
};

/**
 * The Commons FILE TITLE behind a Wikimedia identifier — the only durable handle that provider has.
 *
 * ── The assumption this replaces ────────────────────────────────────────────────────────────
 *
 * Two readers — `sourcePageUrlFor` below and `rehydrationUrlFor` in the rehydrator — were written
 * against the comment "the assetId IS the File: title for this provider". `fetchWikimediaVideos`
 * honours that. `fetchWikimediaImages` did not: it tagged its downloads with the MEDIA URL, on
 * both its live-search and its cached-pool path, so every Wikimedia PICTURE in the system carries
 * a URL where a title is expected.
 *
 * What that cost is render 589. Its opening clip's identity was
 * `wikimedia:https://upload.wikimedia.org/.../Kardashian-Jenner_family_tree.png?utm_source=...`,
 * the rehydrator built `Special:FilePath/https%3A%2F%2Fupload.wikimedia.org%2F…`, Commons answered
 * no such file, and `failFast` ended the cinematic render on its first clip. The compose montage
 * was delivered instead. The rights page was equally wrong: `wiki/File:https%3A%2F%2F…`.
 *
 * ── Why a translator and not only a fix at the source ───────────────────────────────────────
 *
 * The tagging call sites are corrected too, so new renders record the title. But every timeline
 * ALREADY STORED carries the URL form, and those are the renders a person reopens in the editor.
 * A stored identity is not migrated by fixing the writer. So this reads both forms.
 *
 * It is a translation and not a guess: for `upload.wikimedia.org` the last path segment IS the
 * file name Commons indexes it under (with `/thumb/` the segment BEFORE the generated
 * `<N>px-` rendition), and `wiki/File:` and `Special:FilePath/` carry the title literally. A URL
 * on any other host, or one with nothing after the last slash, returns null rather than a title
 * that is nearly right — the same rule `sourcePageUrlFor` already applies to every other provider.
 */
export function wikimediaFileTitleFrom(providerAssetId: string): string | null {
  const raw = providerAssetId.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return raw.startsWith("File:") ? raw.slice(5).trim() || null : raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const decode = (s: string): string | null => {
    try {
      const out = decodeURIComponent(s).trim();
      return out || null;
    } catch {
      return s.trim() || null;
    }
  };

  if (host === "upload.wikimedia.org") {
    /** A thumbnail's own name is `<width>px-<file>`; the file itself is the segment before it. */
    const isThumb = segments.includes("thumb");
    const name = isThumb ? segments[segments.length - 2] : segments[segments.length - 1];
    return name ? decode(name) : null;
  }
  if (host.endsWith("wikimedia.org") || host.endsWith("wikipedia.org")) {
    const wiki = segments.indexOf("wiki");
    const tail = wiki >= 0 ? segments.slice(wiki + 1).join("/") : "";
    const title = decode(tail);
    if (!title) return null;
    if (title.startsWith("Special:FilePath/")) return title.slice("Special:FilePath/".length) || null;
    if (title.startsWith("File:")) return title.slice(5) || null;
    return null;
  }
  return null;
}

/**
 * The human-facing page for an asset, when the provider has one and its shape is documented.
 *
 * Only the providers whose page URL is a pure function of the id are listed. Wikimedia's is too —
 * `File:<title>` — and the title is the assetId there, so it is included. Everything else returns
 * null, because a page URL that is nearly right is worse than none: it sends a person doing a
 * rights check to the wrong place with no signal that it is wrong.
 */
export function sourcePageUrlFor(provider: string, providerAssetId: string): string | null {
  const p = provider.trim().toLowerCase();
  const id = providerAssetId.trim();
  if (!id) return null;
  switch (p) {
    case "pexels":
      return /^\d+$/.test(id) ? `https://www.pexels.com/video/${id}/` : null;
    case "pixabay":
      return /^\d+$/.test(id) ? `https://pixabay.com/videos/${id}/` : null;
    case "youtube":
    case "youtube_cc":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    case "wikimedia": {
      /**
       * The title, whichever form this render recorded it in. `wikimediaFileTitleFrom` answers
       * null for an id no title can be read out of, and null is what this function owes a rights
       * check it cannot address correctly.
       */
      const title = wikimediaFileTitleFrom(id);
      return title ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(`File:${title}`)}` : null;
    }
    case "internet_archive":
      return `https://archive.org/details/${encodeURIComponent(id)}`;
    default:
      // loc, nara, nasa, europeana, openverse, sepiasearch, media_ccc, gdelt_tv, flickr, vimeo,
      // unsplash, serpapi, curated — either the id already IS a URL (loc/nara), or the page shape
      // is not a documented function of the id. Both are answered honestly with null.
      return null;
  }
}

/**
 * Build the permanent identity for one adopted clip.
 *
 * `null` for a record the ledger never had: that is the honest answer for a clip this render
 * cannot account for, and `identityIsRehydratable` below reports it as such rather than letting a
 * half-filled identity look complete.
 */
export function identityFromAdoption(
  facts: AdoptionRecordFacts | null | undefined
): AssetSourceIdentity | null {
  if (!facts) return null;
  const provider = facts.provider?.trim().toLowerCase() || UNVERIFIED_PROVIDER;
  const providerAssetId = facts.providerAssetId?.trim() || undefined;

  const identity: AssetSourceIdentity = { provider };
  if (providerAssetId) identity.providerAssetId = providerAssetId;
  if (facts.archiveAssetId != null) identity.archiveAssetId = facts.archiveAssetId;

  /**
   * `sourceUrl` from the ledger is the provider's MEDIA url — `videoFile.link` for Pexels,
   * `imageInfo.url` for Wikimedia, and so on. It goes in `mediaUrl`, which is what it is.
   *
   * It is explicitly NOT the identity. A Pexels CDN link expires and a YouTube stream URL expires
   * within hours; the id is what survives, which is why §11 of the brief insists a temporary
   * download URL may never be the primary handle.
   */
  const mediaUrl = facts.sourceUrl?.trim() || facts.originalUrl?.trim() || undefined;
  if (mediaUrl) identity.mediaUrl = mediaUrl;

  if (providerAssetId) {
    const page = sourcePageUrlFor(provider, providerAssetId);
    if (page) identity.sourcePageUrl = page;
  }
  const title = facts.assetTitle?.trim();
  if (title) identity.title = title;
  return identity;
}

/**
 * Can this identity be turned back into a file later?
 *
 * §15 — an old manifest must not pretend. Three ways to be recoverable, in descending strength:
 *
 *   · an archive asset id     this system holds the file and serves it itself
 *   · a media URL             a direct link that may or may not still resolve
 *   · provider + provider id  enough to ask the provider again, which is what the future
 *                             rehydrator will do
 *
 * A clip with only a provider NAME is none of those, and answering `false` for it is the point of
 * the function. UNVERIFIED is never rehydratable whatever else it carries: a provider FastVid
 * could not prove is not a provider it can go back to.
 */
export function identityIsRehydratable(
  identity: AssetSourceIdentity | null | undefined
): boolean {
  if (!identity) return false;
  if (identity.archiveAssetId != null) return true;
  /**
   * Compared case-insensitively, and that is not fussiness.
   *
   * `UNVERIFIED_PROVIDER` is the string "UNVERIFIED", and `identityFromAdoption` lower-cases every
   * provider name on the way in — so a strict `===` never matched and an UNVERIFIED clip with a
   * media URL was reported as recoverable. Caught by this round's own test, which is what the test
   * was for.
   */
  if (identity.provider?.toUpperCase() === UNVERIFIED_PROVIDER) return false;
  if (identity.mediaUrl) return true;
  return Boolean(identity.provider && identity.providerAssetId);
}

/** One line per adopted clip, for the render log. Never prints a key or a query string. */
export function formatAssetIdentity(
  sceneIndex: number,
  clipIndex: number,
  identity: AssetSourceIdentity | null
): string {
  if (!identity) {
    return `[AssetIdentity] s${sceneIndex}c${clipIndex} provider=unknown rehydratable=false — ` +
      "this clip has no adoption record and cannot be recovered";
  }
  // Host only, never the full media URL: it routinely carries a signed token, and this line goes
  // to a log. Same rule the open-web policy follows.
  let host: string | null = null;
  if (identity.mediaUrl) {
    try {
      host = new URL(identity.mediaUrl).hostname;
    } catch {
      host = null;
    }
  }
  return (
    `[AssetIdentity] s${sceneIndex}c${clipIndex} provider=${identity.provider} ` +
    `assetId=${identity.providerAssetId ?? "null"} ` +
    `archiveAssetId=${identity.archiveAssetId ?? "null"} ` +
    `mediaHost=${host ?? "null"} ` +
    `page=${identity.sourcePageUrl ? "yes" : "null"} ` +
    `rehydratable=${identityIsRehydratable(identity)}`
  );
}

/** How much of a finished render could be fetched again. Printed once per render. */
export function formatIdentityCoverage(
  identities: ReadonlyArray<AssetSourceIdentity | null>
): string {
  const total = identities.length;
  const recoverable = identities.filter((i) => identityIsRehydratable(i)).length;
  const byProvider = new Map<string, number>();
  for (const i of identities) {
    const key = i?.provider ?? "unknown";
    byProvider.set(key, (byProvider.get(key) ?? 0) + 1);
  }
  const breakdown = [...byProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}=${n}`)
    .join(" ");
  return (
    `[AssetIdentity] TOTAL clips=${total} rehydratable=${recoverable} ` +
    `unrecoverable=${total - recoverable} ${breakdown}`
  );
}
