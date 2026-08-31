/**
 * RONDE 147 — an identity becomes the SAME file again.
 *
 * ── The one sentence this module is ──────────────────────────────────────────────────────────
 *
 *     stored identity → cache → provider → download → technical validation → local file
 *
 * and nothing else. §25 lists what it may never do, and the list is the design: no new visual
 * choices, no searching because something is missing, no ranking, no VisionGate, no substitute
 * candidate, no invented trim times, no adjusted timeline times, no regenerated captions, no TTS.
 *
 * ── The rule that everything here serves ─────────────────────────────────────────────────────
 *
 * IF ASSET X IS ASKED FOR, ONLY ASSET X MAY COME BACK.
 *
 * §8: if the timeline says `pexels 123456` and that cannot be fetched, the answer is a failure
 * naming it — never `pexels 123457`, never a similar clip, never a shorter timeline. A re-render
 * that quietly swapped one shot for another would be indistinguishable from a bug, and the user
 * would have no way to know their video had changed.
 *
 * ── Why it duplicates no downloader ──────────────────────────────────────────────────────────
 *
 * Every provider call, rate limiter, cooldown and technical gate already exists in the pipeline.
 * This module reaches them through injected dependencies (`RehydrateDeps`) rather than importing
 * videoPipeline, for two reasons: a 39 000-line import in every test that touches rehydration is
 * unusable, and a module that could reach for a provider directly is a module that will eventually
 * grow a second downloader. `rehydrationDeps.ts` does the wiring.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { AssetSourceIdentity, ProjectTimeline, TimelineVideoClip } from "./projectTimeline";
import { videoTrack } from "./projectTimeline";
import { identityIsRehydratable } from "./assetIdentity";

const execFileAsync = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/* ═══════════════════════ result shapes ═══════════════════════ */

/**
 * §9 — machine-readable codes, so a caller can BRANCH on the failure instead of matching prose.
 *
 * An auth problem and a missing asset need different responses (supply a key versus accept the
 * loss), and a string message makes that distinction unusable in code.
 */
export type RehydrationErrorCode =
  | "REHYDRATION_IDENTITY_MISSING"
  | "REHYDRATION_UNSUPPORTED_PROVIDER"
  | "REHYDRATION_AUTH_REQUIRED"
  | "REHYDRATION_NOT_AUTHORIZED"
  | "ASSET_NOT_FOUND"
  | "REHYDRATION_DOWNLOAD_FAILED"
  | "REHYDRATION_INVALID_MEDIA";

/** What was actually recovered, measured from the file rather than taken from metadata. */
export type RehydratedAsset = {
  status: "ok";
  localPath: string;
  provider: string;
  providerAssetId: string | null;
  /** §7 — read with ffprobe from the file itself. A provider's claim is not evidence. */
  durationSec: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  sizeBytes: number;
  /** The URL the bytes came from, or null when they came from local storage or the cache. */
  sourceUrl: string | null;
  cacheHit: boolean;
  downloaded: boolean;
  storagePath: string | null;
  /** How this asset was recovered, in words, for the report. */
  provenance: string;
};

export type RehydrationFailure = {
  status: "failed";
  provider: string;
  providerAssetId: string | null;
  errorCode: RehydrationErrorCode;
  errorMessage: string;
  cacheHit: false;
  downloaded: false;
};

export type RehydrationResult = RehydratedAsset | RehydrationFailure;

export function rehydrationSucceeded(r: RehydrationResult): r is RehydratedAsset {
  return r.status === "ok";
}

/* ═══════════════════════ providers ═══════════════════════ */

/**
 * Providers the RONDE 145 audit proved rehydratable by reading each adapter.
 *
 * A provider is here only when its media is reachable from the stored identity — either because
 * this system holds the file, or because the provider's URL is a documented function of the id, or
 * because the stored media URL is stable for that provider.
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
 * Is there a route to this asset — by provider OR because we hold the file ourselves?
 *
 * RONDE 148 found the gap the provider list alone leaves. An archive clip carries the archive's
 * SLUG as its provider ("wwii_archive", "nara_films", whatever an operator named it), which is
 * never in `REHYDRATABLE_PROVIDERS` and never can be: the list is fixed and the slugs are data.
 * Judging those clips on the name refused the one kind of asset that is guaranteed recoverable —
 * `archiveAssetId` means this system ingested the file and serves it from its own storage, which
 * is the strongest handle there is.
 *
 * So the question is asked about the IDENTITY, not the name: an archive id is a route on its own,
 * and the provider list decides the rest. Caught by RONDE 148's own replacement test, which put a
 * real archive slug in and watched the render refuse a file sitting on our own disk.
 */
export function identityHasRehydrationRoute(identity: AssetSourceIdentity): boolean {
  if (identity.archiveAssetId != null) return true;
  return providerIsRehydratable(identity.provider);
}

/** Providers whose re-fetch needs a credential this process may not have. */
const PROVIDERS_NEEDING_AUTH: ReadonlyArray<string> = ["pexels", "pixabay"];

/**
 * §5 — THE CACHE KEY IS THE IDENTITY, not the URL.
 *
 * `mediaCache` hashes whatever string it is handed. Handing it a Pexels CDN link or a YouTube
 * stream URL means a new cache entry every time that URL is reissued — the same asset stored
 * repeatedly and never hit. Handing it `provider:providerAssetId` gives one entry per asset, for
 * good. mediaCache.ts itself is untouched: this is a change of what we ask it, not of what it does.
 *
 * The URL is used as the key only when there is no durable id to use instead.
 */
export function cacheIdentityKey(identity: AssetSourceIdentity): string {
  const provider = identity.provider.trim().toLowerCase();
  if (identity.archiveAssetId != null) return `fastvid-identity:archive:${identity.archiveAssetId}`;
  if (identity.providerAssetId?.trim()) {
    return `fastvid-identity:${provider}:${identity.providerAssetId.trim()}`;
  }
  return identity.mediaUrl ?? identity.canonicalUrl ?? `fastvid-identity:${provider}:unknown`;
}

/**
 * The URL to fetch, or null.
 *
 * §3's per-provider rules, in one place:
 *
 *   curated/archive    the archive's own storage URL. Fastest and most reliable; never external.
 *   wikimedia          Special:FilePath on the File: TITLE — resolves to the current media and
 *                      keeps resolving after a re-upload, which a stored upload URL does not.
 *   loc / internet_archive / nasa / nara / europeana / openverse
 *                      the stored media URL, which is stable for these providers.
 *   pexels / pixabay   handled by the caller's provider resolver: the id must be looked up through
 *                      the provider's API, because the CDN link expires. Never derived here.
 *   youtube            handled by the existing download layer. Never derived here.
 */
export function rehydrationUrlFor(
  identity: AssetSourceIdentity
): { url: string; kind: "canonical" | "derived" | "stored" } | null {
  if (identity.canonicalUrl) return { url: identity.canonicalUrl, kind: "canonical" };
  const provider = identity.provider.trim().toLowerCase();
  const id = identity.providerAssetId?.trim();

  if (provider === "wikimedia" && id) {
    const title = id.startsWith("File:") ? id.slice(5) : id;
    return {
      url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`,
      kind: "derived",
    };
  }
  if (identity.mediaUrl) return { url: identity.mediaUrl, kind: "stored" };
  return null;
}

/* ═══════════════════════ dependencies ═══════════════════════ */

export type ProviderResolution =
  | { ok: true; url: string }
  | { ok: false; code: RehydrationErrorCode; message: string };

export type RehydrateDeps = {
  /** The pipeline's downloader, so its byte caps and timeouts apply. */
  download: (url: string, destPath: string) => Promise<boolean>;
  /** media_archive_assets lookup, for the curated route. */
  archiveAsset?: (
    archiveAssetId: number
  ) => Promise<{ storageUrl: string | null; storageKey: string | null; mimeType?: string } | null>;
  /** Read a local/S3 storage object into a file, for archive assets we hold ourselves. */
  readStorage?: (storageUrl: string, destPath: string) => Promise<boolean>;
  /** media_asset_cache. Optional by design — see §23; rehydration works without it. */
  cacheRestore?: (key: string, destPath: string) => Promise<boolean>;
  cacheStore?: (key: string, localPath: string, contentType: string) => Promise<void>;
  cacheInvalidate?: (key: string) => Promise<void>;
  /**
   * The provider's own API, for ids whose media URL must be looked up (Pexels, Pixabay).
   *
   * Returns a code rather than null so an absent API key reports REHYDRATION_AUTH_REQUIRED and is
   * never silently skipped — §3.
   */
  providerResolver?: (identity: AssetSourceIdentity) => Promise<ProviderResolution>;
  /**
   * §7/§25 — YouTube goes through the EXISTING download and authorisation layer.
   *
   * The rehydrator may not bypass youtubeLicenseStatus, OPERATOR_AUTHORIZED, the fair-use policy
   * or the download ceilings, so it does not talk to YouTube at all: it asks this.
   */
  youtubeResolver?: (videoId: string, destPath: string) => Promise<ProviderResolution | boolean>;
};

/* ═══════════════════════ technical validation ═══════════════════════ */

export type MediaFacts = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
};

/**
 * §7 — what the FILE says, not what the provider said.
 *
 * "A provider that says something is 30 seconds long is not enough." Everything here comes from
 * ffprobe reading the bytes that arrived.
 */
export async function probeMediaFacts(localPath: string): Promise<MediaFacts | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json", localPath,
    ], { maxBuffer: 1024 * 1024 * 8 });
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const duration = Number(parsed.format?.duration);
    return {
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasVideoStream: Boolean(video),
      hasAudioStream: streams.some((s) => s.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

/** Is this file usable as render input at all? */
export function mediaIsUsable(facts: MediaFacts | null, expectVideo: boolean): boolean {
  if (!facts) return false;
  if (expectVideo && !facts.hasVideoStream) return false;
  // A still has no duration in the container; a video without one cannot be trimmed or placed.
  if (expectVideo && (facts.durationSec == null || facts.durationSec <= 0)) return false;
  if (facts.width != null && facts.width <= 0) return false;
  return true;
}

/* ═══════════════════════ the rehydration ═══════════════════════ */

export function rehydratedFileName(identity: AssetSourceIdentity, ext = ".mp4"): string {
  const provider = identity.provider.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const raw = identity.providerAssetId ?? identity.mediaUrl ?? identity.canonicalUrl ?? "unknown";
  const id = createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return `rehydrated_${provider}_${id}${ext}`;
}

const fail = (
  identity: AssetSourceIdentity,
  errorCode: RehydrationErrorCode,
  errorMessage: string
): RehydrationFailure => ({
  status: "failed",
  provider: identity.provider,
  providerAssetId: identity.providerAssetId ?? null,
  errorCode,
  errorMessage,
  cacheHit: false,
  downloaded: false,
});

export async function rehydrateAsset(params: {
  identity: AssetSourceIdentity;
  workDir: string;
  deps: RehydrateDeps;
  /** A local file the caller already has for this asset. */
  existingLocalPath?: string | null;
  /** Whether the asset must carry a video stream. Images legitimately do not. */
  expectVideo?: boolean;
}): Promise<RehydrationResult> {
  const { identity, workDir, deps } = params;
  const provider = identity.provider.trim().toLowerCase();
  const assetId = identity.providerAssetId?.trim() || null;
  const expectVideo = params.expectVideo ?? true;
  const cacheKey = cacheIdentityKey(identity);

  if (!identityIsRehydratable(identity)) {
    return fail(
      identity, "REHYDRATION_IDENTITY_MISSING",
      `provider=${provider} providerAssetId=${assetId ?? "null"} — no durable handle was recorded`
    );
  }
  if (!identityHasRehydrationRoute(identity)) {
    return fail(identity, "REHYDRATION_UNSUPPORTED_PROVIDER", `provider=${provider}`);
  }

  fs.mkdirSync(workDir, { recursive: true });
  const isImage = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(identity.mediaUrl ?? "");
  const destPath = path.join(workDir, rehydratedFileName(identity, isImage ? ".jpg" : ".mp4"));

  const done = async (
    localPath: string,
    opts: { cacheHit: boolean; downloaded: boolean; sourceUrl: string | null; provenance: string; storagePath?: string | null }
  ): Promise<RehydrationResult> => {
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(localPath).size;
    } catch {
      return fail(identity, "REHYDRATION_DOWNLOAD_FAILED", "the produced file is unreadable");
    }
    if (sizeBytes <= 0) {
      return fail(identity, "REHYDRATION_DOWNLOAD_FAILED", "the produced file is empty");
    }
    const facts = await probeMediaFacts(localPath);
    if (!mediaIsUsable(facts, expectVideo && !isImage)) {
      /**
       * §4 — a corrupt CACHED file invalidates its entry and is not simply refused.
       *
       * Leaving a bad entry in place would make every future render fail the same way, for a
       * reason nobody could see. Invalidating it means the next attempt goes to the provider.
       */
      if (opts.cacheHit && deps.cacheInvalidate) {
        await deps.cacheInvalidate(cacheKey).catch(() => {});
      }
      return fail(
        identity, "REHYDRATION_INVALID_MEDIA",
        `${path.basename(localPath)} did not survive ffprobe` +
          (facts ? ` (video=${facts.hasVideoStream} duration=${facts.durationSec ?? "null"})` : " (unreadable)")
      );
    }
    if (opts.downloaded && deps.cacheStore) {
      await deps
        .cacheStore(cacheKey, localPath, isImage ? "image/jpeg" : "video/mp4")
        .catch(() => {});
    }
    return {
      status: "ok",
      localPath,
      provider,
      providerAssetId: assetId,
      durationSec: facts!.durationSec,
      width: facts!.width,
      height: facts!.height,
      mimeType: isImage ? "image/jpeg" : "video/mp4",
      hasVideoStream: facts!.hasVideoStream,
      hasAudioStream: facts!.hasAudioStream,
      sizeBytes,
      sourceUrl: opts.sourceUrl,
      cacheHit: opts.cacheHit,
      downloaded: opts.downloaded,
      storagePath: opts.storagePath ?? null,
      provenance: opts.provenance,
    };
  };

  // A file already on disk needs no network and no trust.
  if (params.existingLocalPath) {
    try {
      if (fs.existsSync(params.existingLocalPath) && fs.statSync(params.existingLocalPath).size > 0) {
        return done(params.existingLocalPath, {
          cacheHit: false, downloaded: false, sourceUrl: null,
          provenance: "already present in the work directory",
        });
      }
    } catch {
      /* unreadable is the same as absent */
    }
  }

  /**
   * §3 — CURATED ARCHIVE FIRST, and never through an external download.
   *
   * This system holds the file. Reading it from our own storage is the fastest and the only route
   * that cannot fail because someone else's API is down or has changed.
   *
   * RONDE 148 — the condition is `archiveAssetId != null` ALONE, not the provider name.
   *
   * It used to also require provider "curated" or "archive", which silently excluded every real
   * archive clip: `videoEditorEdits` and the editor both record the ARCHIVE'S SLUG as the provider
   * ("wwii_archive", "nara_films"), because that is the proven origin and the lineage ledger wants
   * the truth there. So a clip whose bytes were sitting on our own disk fell through to the
   * external routes, found no fetchable URL, and failed. The id is the route; the name is not.
   */
  if (identity.archiveAssetId != null) {
    const row = await deps.archiveAsset?.(identity.archiveAssetId).catch(() => null);
    const storageUrl = row?.storageUrl ?? identity.canonicalUrl ?? null;
    if (!row && !identity.canonicalUrl) {
      return fail(
        identity, "ASSET_NOT_FOUND",
        `archiveAssetId=${identity.archiveAssetId} is not in media_archive_assets any more`
      );
    }
    if (storageUrl && deps.readStorage) {
      const got = await deps.readStorage(storageUrl, destPath).catch(() => false);
      if (got) {
        return done(destPath, {
          cacheHit: false, downloaded: false, sourceUrl: storageUrl,
          storagePath: row?.storageKey ?? null,
          provenance: `read from this system's own archive storage (asset ${identity.archiveAssetId})`,
        });
      }
    }
    if (storageUrl) {
      const got = await deps.download(storageUrl, destPath).catch(() => false);
      if (got) {
        return done(destPath, {
          cacheHit: false, downloaded: true, sourceUrl: storageUrl,
          storagePath: row?.storageKey ?? null,
          provenance: `fetched from archive storage URL (asset ${identity.archiveAssetId})`,
        });
      }
    }
    return fail(
      identity, "REHYDRATION_DOWNLOAD_FAILED",
      `archiveAssetId=${identity.archiveAssetId} could not be read from storage`
    );
  }

  // The cache, before any provider. Optional: rehydration works with it switched off (§23).
  if (deps.cacheRestore) {
    const hit = await deps.cacheRestore(cacheKey, destPath).catch(() => false);
    if (hit) {
      const result = await done(destPath, {
        cacheHit: true, downloaded: false, sourceUrl: null,
        provenance: `media_asset_cache hit on ${cacheKey}`,
      });
      // A cache hit that failed validation invalidated itself above; fall through to the provider.
      if (result.status === "ok") return result;
      if (result.errorCode !== "REHYDRATION_INVALID_MEDIA") return result;
    }
  }

  /**
   * §7/§25 — YouTube is asked of the existing layer, or refused.
   *
   * Without that layer there is no licence decision and no operator authorisation, and fetching
   * anyway would bypass exactly the protections the round is forbidden to touch.
   */
  if (provider === "youtube" || provider === "youtube_cc") {
    if (!assetId) {
      return fail(identity, "REHYDRATION_IDENTITY_MISSING", "no videoId recorded");
    }
    if (!deps.youtubeResolver) {
      return fail(
        identity, "REHYDRATION_NOT_AUTHORIZED",
        `videoId=${assetId} — no YouTube resolver supplied, so the existing licence and ` +
          "operator-authorisation path could not be consulted; refusing rather than bypassing it"
      );
    }
    const answer = await deps.youtubeResolver(assetId, destPath).catch(() => false);
    if (answer === true) {
      return done(destPath, {
        cacheHit: false, downloaded: true, sourceUrl: null,
        provenance: `fetched through the existing YouTube layer (videoId=${assetId})`,
      });
    }
    if (answer === false) {
      return fail(identity, "REHYDRATION_DOWNLOAD_FAILED", `videoId=${assetId}`);
    }
    if (!answer.ok) return fail(identity, answer.code, answer.message);
    const got = await deps.download(answer.url, destPath).catch(() => false);
    if (!got) return fail(identity, "REHYDRATION_DOWNLOAD_FAILED", `videoId=${assetId}`);
    return done(destPath, {
      cacheHit: false, downloaded: true, sourceUrl: answer.url,
      provenance: `fetched through the existing YouTube layer (videoId=${assetId})`,
    });
  }

  /**
   * §3 — Pexels and Pixabay must be looked up by ID through their API.
   *
   * Their CDN links expire, so a stored `mediaUrl` is a hint and not a handle. Without a resolver
   * the answer is REHYDRATION_AUTH_REQUIRED — an explicit, actionable failure rather than a
   * silent skip or an attempt on a link that will 403.
   */
  let target = rehydrationUrlFor(identity);
  if (PROVIDERS_NEEDING_AUTH.includes(provider)) {
    if (!deps.providerResolver) {
      return fail(
        identity, "REHYDRATION_AUTH_REQUIRED",
        `provider=${provider} providerAssetId=${assetId ?? "null"} — the API key needed to look ` +
          "this id up again is not configured"
      );
    }
    const resolved = await deps
      .providerResolver(identity)
      .catch((err) => ({ ok: false as const, code: "REHYDRATION_DOWNLOAD_FAILED" as const, message: String(err) }));
    if (!resolved.ok) return fail(identity, resolved.code, resolved.message);
    target = { url: resolved.url, kind: "derived" };
  }

  if (!target) {
    return fail(
      identity, "ASSET_NOT_FOUND",
      `provider=${provider} providerAssetId=${assetId ?? "null"} has no fetchable URL`
    );
  }

  const downloaded = await deps.download(target.url, destPath).catch(() => false);
  if (!downloaded) {
    return fail(
      identity, "REHYDRATION_DOWNLOAD_FAILED",
      `provider=${provider} host=${hostOf(target.url)} (${target.kind})`
    );
  }
  return done(destPath, {
    cacheHit: false, downloaded: true, sourceUrl: target.url,
    provenance: `downloaded from ${hostOf(target.url)} (${target.kind} URL)`,
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unparseable";
  }
}

/* ═══════════════════════ whole timelines ═══════════════════════ */

export type TimelineRehydration = {
  ok: boolean;
  /** clip id → local file, for the renderer's `resolveMedia`. */
  byClipId: Map<string, string>;
  results: Array<{ clipId: string; result: RehydrationResult }>;
  failures: Array<{ clipId: string; result: RehydrationFailure }>;
};

/**
 * Recover every clip a timeline needs.
 *
 * `failFast` defaults to TRUE, per §8: for a full render, the first unrecoverable asset should
 * stop the attempt rather than let it run for ten minutes and produce a video with a hole. A
 * caller that wants the complete picture — the editor, showing a user what is missing — passes
 * false and gets every failure at once.
 */
export async function rehydrateTimelineAssets(params: {
  timeline: ProjectTimeline;
  workDir: string;
  deps: RehydrateDeps;
  failFast?: boolean;
  existingByClipId?: Map<string, string>;
}): Promise<TimelineRehydration> {
  const failFast = params.failFast ?? true;
  const byClipId = new Map<string, string>();
  const results: TimelineRehydration["results"] = [];
  const failures: TimelineRehydration["failures"] = [];

  for (const clip of videoTrack(params.timeline).filter((c: TimelineVideoClip) => !c.disabled)) {
    const result = await rehydrateAsset({
      identity: clip.source,
      workDir: params.workDir,
      deps: params.deps,
      existingLocalPath: params.existingByClipId?.get(clip.id) ?? null,
      expectVideo: clip.kind === "video",
    });
    results.push({ clipId: clip.id, result });
    console.log(formatRehydration(clip.id, result));
    if (result.status === "ok") {
      byClipId.set(clip.id, result.localPath);
    } else {
      failures.push({ clipId: clip.id, result });
      if (failFast) break;
    }
  }
  return { ok: failures.length === 0, byClipId, results, failures };
}

/* ═══════════════════════ observability ═══════════════════════ */

/**
 * §24 — compact, and never a full URL.
 *
 * A provider URL routinely carries a signed token or an API key in its query string, and this line
 * goes to a log that people read and paste. The host is enough to know where a picture came from.
 */
export function formatRehydration(clipId: string, result: RehydrationResult): string {
  const head = `[AssetRehydrator] clip=${clipId} provider=${result.provider} id=${result.providerAssetId ?? "null"}`;
  if (result.status === "ok") {
    return (
      `${head} cache=${result.cacheHit ? "HIT" : "MISS"} downloaded=${result.downloaded} ` +
      `duration=${result.durationSec?.toFixed(2) ?? "null"}s ` +
      `${result.width ?? "?"}x${result.height ?? "?"} bytes=${result.sizeBytes}`
    );
  }
  return `${head} status=${result.errorCode} reason="${result.errorMessage}"`;
}

export function formatRehydrationSummary(rehydration: TimelineRehydration): string[] {
  const ok = rehydration.results.filter((r) => r.result.status === "ok");
  const cacheHits = ok.filter((r) => r.result.status === "ok" && r.result.cacheHit).length;
  const lines = [
    `[AssetRehydrator] TOTAL requested=${rehydration.results.length} recovered=${ok.length} ` +
      `failed=${rehydration.failures.length} cacheHits=${cacheHits}`,
  ];
  for (const f of rehydration.failures) {
    lines.push(
      `   UNRECOVERABLE clip=${f.clipId} provider=${f.result.provider} ` +
        `id=${f.result.providerAssetId ?? "null"} code=${f.result.errorCode}`
    );
  }
  return lines;
}
