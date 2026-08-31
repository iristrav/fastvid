/**
 * RONDE 147 §6/§7 — an identity becomes a file again.
 *
 * ── What this is, and deliberately is not ────────────────────────────────────────────────────
 *
 * RONDE 146 made a render write down WHERE each picture came from. This turns that back into
 * something a renderer can open:
 *
 *     AssetSourceIdentity → cache → provider → download → technical validation → local file
 *
 * It is as small as §6 asks, and that is a design decision rather than a shortcut. It contains NO
 * search, NO ranking, NO provider API clients and NO retry policy, because FastVid already has all
 * four and a second copy would immediately disagree with the first. What this module knows is how
 * to turn an id into a URL for the providers whose URL shape is a documented function of the id,
 * and how to spend the cache that already exists.
 *
 * ── The rule that keeps it honest ────────────────────────────────────────────────────────────
 *
 * §15: AN ASSET THAT CANNOT BE REHYDRATED IS AN EXPLICIT ERROR NAMING THE ASSET.
 *
 * There is no substitution here. No "close enough" clip, no silent fall-through to stock, no
 * placeholder. A caller that asks for Wikimedia file X and cannot have it is told exactly that,
 * with the provider and the id, because the alternative — quietly rendering something else — is
 * the single worst thing a re-render could do to someone's video.
 *
 * ── Why the download is injected ─────────────────────────────────────────────────────────────
 *
 * `download` and `validate` are parameters. The pipeline owns rate limiting, provider cooldowns,
 * byte caps and the technical gate; this module must use those rather than reimplement them, and
 * a module that reached for them directly would drag videoPipeline's 39 000 lines into every test
 * that touches rehydration.
 */
import * as fs from "fs";
import * as path from "path";
import type { AssetSourceIdentity } from "./projectTimeline";
import { identityIsRehydratable } from "./assetIdentity";

export type RehydrationFailure =
  | "not_rehydratable"
  | "no_download_url"
  | "download_failed"
  | "failed_validation"
  | "provider_not_supported"
  | "authorization_refused";

export type RehydrationResult =
  | {
      ok: true;
      localPath: string;
      /** Where the bytes came from — the number that says whether the cache is earning its keep. */
      via: "already_local" | "cache" | "provider";
      identity: AssetSourceIdentity;
    }
  | {
      ok: false;
      reason: RehydrationFailure;
      detail: string;
      identity: AssetSourceIdentity;
    };

/**
 * Providers this module can turn an identity back into a URL for.
 *
 * Taken from the RONDE 145 audit, which read each adapter rather than assuming. A provider is on
 * this list only when its media URL is either stored on the identity or derivable from the id by a
 * documented rule.
 */
export const REHYDRATABLE_PROVIDERS: ReadonlyArray<string> = [
  "curated", "archive",
  "wikimedia",
  "loc",
  "internet_archive",
  "pexels", "pixabay",
  "youtube", "youtube_cc",
  "nasa", "nara", "europeana", "openverse",
];

export function providerIsRehydratable(provider: string): boolean {
  return REHYDRATABLE_PROVIDERS.includes(provider.trim().toLowerCase());
}

/**
 * The URL to fetch for this identity, or null.
 *
 * Order matters and follows §6's "gebruik geen verlopen CDN-URL als primaire identity":
 *
 *   1. `canonicalUrl`  this system's own storage. Never expires, never rate-limited.
 *   2. a URL derived from the PROVIDER ID, for providers whose shape is documented. Preferred over
 *      the stored media URL because a Pexels CDN link and a YouTube stream URL both expire, while
 *      the id does not.
 *   3. `mediaUrl`      what the provider handed us at render time. Still the best answer for
 *      Wikimedia, LOC, Internet Archive and the rest, whose media URLs are stable.
 *
 * YouTube is deliberately absent from step 2: its media URL is produced by a signed, expiring
 * request through the existing RapidAPI path, and inventing one here would be building the second
 * downloader §7 forbids. `youtubeResolver` is how a caller supplies the existing one.
 */
export function rehydrationUrlFor(
  identity: AssetSourceIdentity
): { url: string; kind: "canonical" | "derived" | "stored" } | null {
  if (identity.canonicalUrl) return { url: identity.canonicalUrl, kind: "canonical" };

  const provider = identity.provider.trim().toLowerCase();
  const id = identity.providerAssetId?.trim();
  if (id) {
    if (provider === "wikimedia") {
      // Special:FilePath resolves a File: title to the current media file, and keeps resolving
      // after a file is re-uploaded — which a stored upload.wikimedia.org URL does not.
      const title = id.startsWith("File:") ? id.slice(5) : id;
      return {
        url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`,
        kind: "derived",
      };
    }
    if (provider === "internet_archive" && identity.mediaUrl) {
      // The identifier alone does not name a FILE inside the item, so the stored URL is the handle
      // here. Kept as a separate branch to say that out loud rather than by falling through.
      return { url: identity.mediaUrl, kind: "stored" };
    }
  }
  if (identity.mediaUrl) return { url: identity.mediaUrl, kind: "stored" };
  return null;
}

export type RehydrateDeps = {
  /** Fetch `url` to `destPath`. Returns false on any failure. The pipeline's downloader. */
  download: (url: string, destPath: string) => Promise<boolean>;
  /** The existing technical gate. Returns false for a file that cannot be rendered. */
  validate?: (localPath: string) => Promise<boolean>;
  /** media_asset_cache: restore by source URL. Returns true when it filled destPath. */
  cacheRestore?: (sourceUrl: string, destPath: string) => Promise<boolean>;
  /** media_asset_cache: record a freshly downloaded file. Best-effort, never throws. */
  cacheStore?: (sourceUrl: string, localPath: string, contentType: string) => Promise<void>;
  /**
   * §7 — YouTube goes through the EXISTING download path, machtigingsmodel and all.
   *
   * Supplied by the caller precisely so this module never reimplements it: the existing route
   * already does the licence decision, the operator authorisation, the RapidAPI metadata call and
   * the render-scoped cache.
   */
  youtubeResolver?: (videoId: string, destPath: string) => Promise<boolean>;
};

/** A filename for an identity that is stable across renders and cannot collide. */
export function rehydratedFileName(identity: AssetSourceIdentity, ext = ".mp4"): string {
  const provider = identity.provider.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const raw = identity.providerAssetId ?? identity.mediaUrl ?? identity.canonicalUrl ?? "unknown";
  const { createHash } = require("crypto") as typeof import("crypto");
  const id = createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return `rehydrated_${provider}_${id}${ext}`;
}

/**
 * Turn one identity back into a local file.
 *
 * Every exit is explicit. There is no path through this function that returns a file which is not
 * the asset that was asked for.
 */
export async function rehydrateAsset(params: {
  identity: AssetSourceIdentity;
  workDir: string;
  deps: RehydrateDeps;
  /** An existing local file for this asset, if the caller already has one. */
  existingLocalPath?: string | null;
}): Promise<RehydrationResult> {
  const { identity, workDir, deps } = params;

  // A file already on disk is the cheapest possible answer, and the only one that needs no trust.
  if (params.existingLocalPath) {
    try {
      if (fs.existsSync(params.existingLocalPath) && fs.statSync(params.existingLocalPath).size > 0) {
        return { ok: true, localPath: params.existingLocalPath, via: "already_local", identity };
      }
    } catch {
      /* unreadable is the same as absent */
    }
  }

  if (!identityIsRehydratable(identity)) {
    return {
      ok: false, reason: "not_rehydratable", identity,
      detail:
        `provider=${identity.provider} providerAssetId=${identity.providerAssetId ?? "null"} — ` +
        "this clip was rendered before identity was recorded, or its provider could not be proven",
    };
  }
  if (!providerIsRehydratable(identity.provider)) {
    return {
      ok: false, reason: "provider_not_supported", identity,
      detail: `provider=${identity.provider} has no rehydration route`,
    };
  }

  fs.mkdirSync(workDir, { recursive: true });
  const isImage = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(identity.mediaUrl ?? "");
  const destPath = path.join(workDir, rehydratedFileName(identity, isImage ? ".jpg" : ".mp4"));

  const provider = identity.provider.trim().toLowerCase();
  const videoId = identity.providerAssetId?.trim();

  /**
   * §7 — YouTube is handed straight to the existing infrastructure.
   *
   * Not a special case for its own sake: YouTube is the one provider whose media URL cannot be
   * derived and whose access is governed by a licence decision this module has no business making.
   * Without a resolver the answer is an explicit refusal, never a guess.
   */
  if (provider === "youtube" || provider === "youtube_cc") {
    if (!videoId) {
      return { ok: false, reason: "no_download_url", identity, detail: "no videoId recorded" };
    }
    if (!deps.youtubeResolver) {
      return {
        ok: false, reason: "authorization_refused", identity,
        detail:
          `videoId=${videoId} — no YouTube resolver supplied, so the existing licence and ` +
          "operator-authorisation path could not be consulted; refusing rather than bypassing it",
      };
    }
    const got = await deps.youtubeResolver(videoId, destPath).catch(() => false);
    if (!got) {
      return { ok: false, reason: "download_failed", identity, detail: `videoId=${videoId}` };
    }
    return finish(destPath, identity, "provider", deps, null);
  }

  const target = rehydrationUrlFor(identity);
  if (!target) {
    return {
      ok: false, reason: "no_download_url", identity,
      detail: `provider=${provider} providerAssetId=${videoId ?? "null"} has no fetchable URL`,
    };
  }

  // The cache that already exists, keyed on the source URL — §13's "geen tweede asset cache".
  if (deps.cacheRestore) {
    const hit = await deps.cacheRestore(target.url, destPath).catch(() => false);
    if (hit) return finish(destPath, identity, "cache", deps, null);
  }

  const downloaded = await deps.download(target.url, destPath).catch(() => false);
  if (!downloaded) {
    return {
      ok: false, reason: "download_failed", identity,
      detail: `provider=${provider} url=${hostOf(target.url)} (${target.kind})`,
    };
  }
  return finish(destPath, identity, "provider", deps, target.url);
}

async function finish(
  localPath: string,
  identity: AssetSourceIdentity,
  via: "cache" | "provider",
  deps: RehydrateDeps,
  cacheUrl: string | null
): Promise<RehydrationResult> {
  try {
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
      return {
        ok: false, reason: "download_failed", identity,
        detail: "the download reported success and produced no file",
      };
    }
  } catch {
    return { ok: false, reason: "download_failed", identity, detail: "the produced file is unreadable" };
  }
  /**
   * The EXISTING technical gate, not a new one.
   *
   * §9 of the standing rules: no quality gate may be removed or duplicated. A rehydrated file goes
   * through the same check a freshly downloaded one does, because it IS a freshly downloaded one.
   */
  if (deps.validate) {
    const ok = await deps.validate(localPath).catch(() => false);
    if (!ok) {
      return {
        ok: false, reason: "failed_validation", identity,
        detail: `provider=${identity.provider} — the recovered file did not pass the technical gate`,
      };
    }
  }
  if (cacheUrl && deps.cacheStore) {
    const contentType = localPath.endsWith(".jpg") ? "image/jpeg" : "video/mp4";
    await deps.cacheStore(cacheUrl, localPath, contentType).catch(() => {});
  }
  return { ok: true, localPath, via, identity };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unparseable";
  }
}

/** One line per attempt. Hosts only, never a signed URL — the same rule the identity log follows. */
export function formatRehydration(result: RehydrationResult): string {
  const i = result.identity;
  const who = `provider=${i.provider} assetId=${i.providerAssetId ?? "null"}`;
  if (result.ok) {
    return `[Rehydrate] OK ${who} via=${result.via} file=${path.basename(result.localPath)}`;
  }
  return `[Rehydrate] FAILED ${who} reason=${result.reason} detail="${result.detail}"`;
}

/** What a whole timeline's recovery cost and how much of it succeeded. */
export function formatRehydrationSummary(results: readonly RehydrationResult[]): string {
  const ok = results.filter((r) => r.ok);
  const byVia = new Map<string, number>();
  for (const r of ok) if (r.ok) byVia.set(r.via, (byVia.get(r.via) ?? 0) + 1);
  const failed = results.length - ok.length;
  const breakdown = [...byVia.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
  return (
    `[Rehydrate] TOTAL requested=${results.length} recovered=${ok.length} failed=${failed} ` +
    (breakdown || "none")
  );
}
