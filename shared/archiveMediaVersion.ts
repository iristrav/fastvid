/**
 * RONDE 177 — the preview URL has to change when the file behind it changes.
 *
 * ── Why a trim looked like it was never saved ─────────────────────────────────────────────────
 *
 * An archive clip is previewed through one stable address:
 *
 *     /api/admin/archive/media/57330
 *
 * and that endpoint answers with `Cache-Control: private, max-age=3600` (or a 307 to a signed URL
 * with max-age=300). The address is built from the asset id alone, so it is byte-identical before
 * and after a trim.
 *
 * So the operator marks a range, clicks "Bijknippen toepassen", gets a success toast, the row is
 * really rewritten, `listAssets` is really invalidated and refetched — and the <video> element is
 * handed the exact same `src` it had a second ago. The browser does not go and ask: it replays the
 * untrimmed clip out of its own cache, for the next hour. Everything worked and the result was
 * invisible, which is indistinguishable from "hij slaat het bijknippen niet op".
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * Put the file's identity in the URL. `storagePut` gives every write a fresh random key suffix, so
 * the storage key IS the version: it changes on exactly the events that change the bytes, and on
 * no others. A clip that was not touched keeps its address and stays cached, which is what the
 * hour-long cache is for.
 *
 * The server ignores the parameter — the route still resolves the asset by its id. The token exists
 * to be different, not to be read.
 *
 * This lives in shared/ for the same reason validateTrimRange does (RONDE 108): the admin grid, the
 * editor manifest and the stream helper all build this URL, and three copies of the rule is how one
 * of them silently stops matching.
 */

/** The parts of an asset row that say which bytes it currently points at. */
export type ArchiveMediaIdentity = {
  storageUrl?: string | null;
  storageKey?: string | null;
  /** Included so a re-encode that somehow reuses a key still busts the cache. */
  durationSec?: number | null;
};

/**
 * A short, stable token for the asset's current file.
 *
 * djb2 rather than sha256: this is a cache key, not a security boundary, and it has to be
 * computable in the browser without pulling in a hash library.
 */
export function archiveMediaVersion(asset: ArchiveMediaIdentity): string {
  const identity =
    `${asset.storageKey ?? ""}|${asset.storageUrl ?? ""}|${asset.durationSec ?? ""}`;
  let hash = 5381;
  for (let i = 0; i < identity.length; i++) {
    hash = ((hash << 5) + hash + identity.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * `/api/admin/archive/media/57330?v=1f3k2p` — the address plus which version of the file it is.
 *
 * `base` is the id-only path the caller already knows how to build; this only appends the token,
 * so the two admin/editor routes keep their own prefixes.
 */
export function withArchiveMediaVersion(base: string, asset: ArchiveMediaIdentity | undefined): string {
  if (!asset) return base;
  const token = archiveMediaVersion(asset);
  return `${base}${base.includes("?") ? "&" : "?"}v=${token}`;
}
