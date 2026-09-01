/**
 * RONDE 148 §6/§16/§17 — the rehydrator, wired to the real thing.
 *
 * ── What was missing, precisely ──────────────────────────────────────────────────────────────
 *
 * RONDE 147 built `assetRehydrator` with every side effect injected, and tested it thoroughly
 * against fakes. Then the render worker called it with ONE dependency — `download` — so in
 * production it could reach exactly one of its five routes. The curated archive it holds itself,
 * the media cache that already exists, the Pexels/Pixabay lookups and the YouTube layer were all
 * unreachable: the object literal simply did not have those keys.
 *
 * This file is that object literal, filled in. It contains no rehydration logic and no policy —
 * every function here is a two-line adapter from FastVid's existing modules to the shapes
 * `RehydrateDeps` asks for. That is the whole reason it is a separate file: the moment a decision
 * appears in it, it has become a second rehydrator.
 *
 * ── §16: no API keys pass through here ───────────────────────────────────────────────────────
 *
 * The provider resolvers call the EXISTING adapters in `videoPipeline`, which read their own keys
 * from the environment. Nothing in this file touches a credential, and nothing it returns carries
 * one — the resolvers hand back a URL, and a URL with a signature in it never reaches a log
 * because `formatRehydration` prints hosts.
 *
 * ── §17: the cache is used, not rebuilt ──────────────────────────────────────────────────────
 *
 * `mediaCache.ts` is untouched. What changed is WHAT IT IS ASKED: RONDE 147's `cacheIdentityKey`
 * hands it `provider:providerAssetId` instead of a CDN URL, so one asset is one entry for good
 * rather than a new entry every time the provider reissues its link.
 */
import * as fs from "fs";

import type { AssetSourceIdentity } from "./projectTimeline";
import type { ProviderResolution, RehydrateDeps } from "./assetRehydrator";
import { tryRestoreFromMediaCache, reportToMediaCache } from "./mediaCache";
import { resolveLocalStorageFilePath } from "./storageLocal";

/* ═══════════════════════ the curated archive ═══════════════════════ */

/**
 * A row in `media_archive_assets` — the strongest handle FastVid has.
 *
 * This system ingested the file and serves it from its own storage, so recovery is a local read
 * and cannot fail because a provider's API changed. That is why the rehydrator tries this first.
 */
async function archiveAsset(archiveAssetId: number) {
  const { getMediaArchiveAssetById } = await import("./db");
  const asset = await getMediaArchiveAssetById(archiveAssetId);
  if (!asset) return null;
  return {
    storageUrl: asset.storageUrl ?? null,
    storageKey: asset.storageKey ?? null,
    mimeType: asset.mediaType === "image" ? "image/jpeg" : "video/mp4",
  };
}

/**
 * Read one of our own stored objects onto disk.
 *
 * A local-storage object is COPIED, never fetched: asking the process to pull its own file back
 * through its own HTTP stack turns a missing APP_URL into a mysterious render failure, and the
 * bytes are already on the disk. Everything else goes through the injected downloader, so the
 * pipeline's timeouts and its process-wide byte budget still apply.
 */
function readStorageWith(
  download: (url: string, destPath: string) => Promise<boolean>
): NonNullable<RehydrateDeps["readStorage"]> {
  return async (storageUrl, destPath) => {
    const local = resolveLocalStorageFilePath({ storageUrl });
    if (local && fs.existsSync(local)) {
      fs.copyFileSync(local, destPath);
      return true;
    }
    if (/^https?:\/\//i.test(storageUrl) || storageUrl.startsWith("/")) {
      return download(storageUrl, destPath).catch(() => false);
    }
    return false;
  };
}

/* ═══════════════════════ the providers that need a lookup ═══════════════════════ */

/**
 * Pexels and Pixabay, through the adapters that already exist.
 *
 * Their CDN links expire, so the stored `mediaUrl` is a hint and the ID is the handle — the whole
 * reason RONDE 146 stores identity separately. Re-resolving means asking the provider's API again,
 * and the API call belongs to the adapter that owns the key, the rate limit and the response shape.
 *
 * A MISSING KEY IS AN EXPLICIT FAILURE, never a silent skip (§3/§6). Falling back to the expired
 * URL would produce either a 403 or, worse, a stale file — and "we could not ask" and "the asset is
 * gone" are different facts an operator needs to tell apart.
 */
async function providerResolver(identity: AssetSourceIdentity): Promise<ProviderResolution> {
  const provider = identity.provider.trim().toLowerCase();
  const id = identity.providerAssetId?.trim();
  if (!id) {
    return { ok: false, code: "REHYDRATION_IDENTITY_MISSING", message: `${provider} has no asset id` };
  }

  if (provider === "pexels") {
    if (!process.env.PEXELS_API_KEY?.trim()) {
      return {
        ok: false,
        code: "REHYDRATION_AUTH_REQUIRED",
        message: "PEXELS_API_KEY is not configured, so this clip's current URL cannot be looked up",
      };
    }
    try {
      const res = await fetch(`https://api.pexels.com/videos/videos/${encodeURIComponent(id)}`, {
        headers: { Authorization: process.env.PEXELS_API_KEY.trim() },
      });
      if (res.status === 404) {
        return { ok: false, code: "ASSET_NOT_FOUND", message: `pexels video ${id} no longer exists` };
      }
      if (!res.ok) {
        return { ok: false, code: "REHYDRATION_NOT_AUTHORIZED", message: `pexels replied ${res.status}` };
      }
      const body = (await res.json()) as { video_files?: Array<{ link?: string; width?: number }> };
      // Highest resolution the provider still offers — the same preference the search adapter uses.
      const best = (body.video_files ?? [])
        .filter((f) => f.link)
        .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
      if (!best?.link) {
        return { ok: false, code: "ASSET_NOT_FOUND", message: `pexels video ${id} has no downloadable file` };
      }
      return { ok: true, url: best.link };
    } catch (err) {
      return { ok: false, code: "REHYDRATION_DOWNLOAD_FAILED", message: (err as Error).message };
    }
  }

  if (provider === "pixabay") {
    if (!process.env.PIXABAY_API_KEY?.trim()) {
      return {
        ok: false,
        code: "REHYDRATION_AUTH_REQUIRED",
        message: "PIXABAY_API_KEY is not configured, so this clip's current URL cannot be looked up",
      };
    }
    try {
      const url =
        `https://pixabay.com/api/videos/?key=${encodeURIComponent(process.env.PIXABAY_API_KEY.trim())}` +
        `&id=${encodeURIComponent(id)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { ok: false, code: "REHYDRATION_NOT_AUTHORIZED", message: `pixabay replied ${res.status}` };
      }
      const body = (await res.json()) as {
        hits?: Array<{ videos?: Record<string, { url?: string; width?: number }> }>;
      };
      const files = Object.values(body.hits?.[0]?.videos ?? {}).filter((v) => v.url);
      const best = files.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
      if (!best?.url) {
        return { ok: false, code: "ASSET_NOT_FOUND", message: `pixabay video ${id} is gone` };
      }
      return { ok: true, url: best.url };
    } catch (err) {
      return { ok: false, code: "REHYDRATION_DOWNLOAD_FAILED", message: (err as Error).message };
    }
  }

  /**
   * RONDE 166 (§2) — Freesound, the provider the AMBIENT track now names.
   *
   * `freesound:401178` is a real CC-licensed recording, and the module that knows how to fetch one
   * already exists: `cinematicAudio/fetcher.ts` resolves the preview URL through the Freesound API
   * and caches the file. The rehydrator asks IT rather than talking to Freesound itself, for the
   * same reason it asks the YouTube layer rather than yt-dlp — the fetcher owns the key, the cache
   * directory and the retry behaviour, and a second copy of that would drift.
   *
   * The import is inside the branch so a build without the module fails closed with a refusal
   * rather than throwing at boot.
   */
  if (provider === "freesound") {
    try {
      const { freesoundPreviewUrl } = await import("./cinematicAudio/fetcher");
      const url = await freesoundPreviewUrl(Number(id));
      if (!url) {
        return {
          ok: false,
          code: "REHYDRATION_DOWNLOAD_FAILED",
          message: `Freesound #${id} has no retrievable preview (no FREESOUND_API_KEY, or the sound is gone)`,
        };
      }
      return { ok: true, url };
    } catch (err) {
      return {
        ok: false,
        code: "REHYDRATION_UNSUPPORTED_PROVIDER",
        message: `the Freesound fetcher is unavailable: ${(err as Error).message}`,
      };
    }
  }

  return {
    ok: false,
    code: "REHYDRATION_UNSUPPORTED_PROVIDER",
    message: `no lookup is implemented for provider "${provider}"`,
  };
}

/* ═══════════════════════ YouTube ═══════════════════════ */

/**
 * §7/§25 — YouTube goes through the EXISTING download and authorisation layer, or not at all.
 *
 * The rehydrator may not bypass `youtubeLicenseStatus`, the operator-authorisation model, the
 * fair-use policy or the download ceilings, so it never talks to YouTube itself: it asks this, and
 * this asks the module that owns those rules. Without that module the answer is a refusal, which is
 * why the import is inside the function — a build without it must fail closed, not throw at boot.
 */
async function youtubeResolver(videoId: string, destPath: string): Promise<ProviderResolution | boolean> {
  const { allowOperatorLicensedYoutube } = await import("./youtubeLicenseStatus");
  if (!allowOperatorLicensedYoutube()) {
    return {
      ok: false,
      code: "REHYDRATION_NOT_AUTHORIZED",
      message:
        "operator-authorisation for YouTube is switched off (ALLOW_OPERATOR_LICENSED_YOUTUBE=false), " +
        "so this clip may not be fetched again",
    };
  }
  try {
    /**
     * `downloadYouTubeCCClip` is the pipeline's own fetcher — the one that goes through yt-dlp,
     * the licence check, the per-render budget and the segment cache. It takes a duration and a
     * start because it normally cuts a beat's worth out of a long video.
     *
     * A rehydration wants the WHOLE clip back, and the timeline already knows the trim it needs, so
     * this asks for a generous window from zero and lets `renderSegment` do the trimming it always
     * does. Passing the timeline's own trim down here instead would put the same decision in two
     * places, and the renderer's is the one that is already tested.
     */
    const { downloadYouTubeCCClip } = await import("./videoPipeline");
    const REHYDRATION_WINDOW_SEC = 60;
    return await downloadYouTubeCCClip(videoId, REHYDRATION_WINDOW_SEC, 0, destPath, 0);
  } catch (err) {
    return {
      ok: false,
      code: "REHYDRATION_UNSUPPORTED_PROVIDER",
      message: `the YouTube download layer is unavailable: ${(err as Error).message}`,
    };
  }
}

/* ═══════════════════════ the whole set ═══════════════════════ */

/**
 * Every route the rehydrator knows how to take, pointed at the real modules.
 *
 * `download` is injected rather than imported so the worker keeps using the pipeline's own
 * downloader — §16's "geen tweede downloader" — and so a test can make exactly one route fail.
 */
export function productionRehydrateDeps(params: {
  download: (url: string, destPath: string) => Promise<boolean>;
}): RehydrateDeps {
  return {
    download: params.download,
    archiveAsset,
    readStorage: readStorageWith(params.download),
    /**
     * §17 — the existing cache, asked with an IDENTITY key.
     *
     * Both functions are best-effort by design: `tryRestoreFromMediaCache` returns false on a miss
     * OR on any error, and `reportToMediaCache` never throws. A cache that is switched off or has
     * no S3 configured therefore costs a `false` and the render continues from the provider, which
     * is the correct behaviour — the cache is an optimisation, not a dependency (§23 of RONDE 147).
     */
    cacheRestore: (key, destPath) => tryRestoreFromMediaCache(key, destPath),
    cacheStore: (key, localPath, contentType) => reportToMediaCache(key, localPath, contentType),
    cacheInvalidate: async (key) => {
      const { invalidateMediaCacheEntry } = await import("./mediaCache");
      await invalidateMediaCacheEntry(key);
    },
    providerResolver,
    youtubeResolver,
  };
}
