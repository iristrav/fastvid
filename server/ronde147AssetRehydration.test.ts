/**
 * RONDE 147 — TEST 1–12: an identity becomes the SAME file again.
 *
 * ── Real media, real ffprobe ─────────────────────────────────────────────────────────────────
 *
 * §20: no mocks for the technical validation. Every fixture below is a real MP4 produced by
 * ffmpeg, every "download" copies real bytes, and every recovered file is inspected with ffprobe.
 * The only things stood in for are the provider API calls, which need credentials this environment
 * does not have — and each of those seams is exercised for its FAILURE path too, so a missing key
 * is proved to produce an explicit code rather than a silent skip.
 *
 * ── The claim that matters most ──────────────────────────────────────────────────────────────
 *
 * TEST 12. If asset A cannot be recovered, asset B is never quietly used in its place. A
 * re-render that swapped one shot for another would be indistinguishable from a bug, and the user
 * would have no way to know their video had changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import {
  cacheIdentityKey,
  mediaIsUsable,
  probeMediaFacts,
  providerIsRehydratable,
  rehydrateAsset,
  rehydrateTimelineAssets,
  rehydrationUrlFor,
  formatRehydration,
  type RehydrateDeps,
} from "./assetRehydrator";
import {
  DEFAULT_FORMAT,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";

let ROOT = "";
let REAL_MP4 = "";
let OTHER_MP4 = "";
let CORRUPT = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r147rh-"));
  const make = async (name: string, pattern: string) => {
    const out = path.join(ROOT, `${name}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `${pattern}=size=320x180:rate=25:duration=3`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
    ]);
    return out;
  };
  REAL_MP4 = await make("real", "smptebars");
  OTHER_MP4 = await make("other", "testsrc");
  // A real file, truncated — the shape a half-written download or a bad cache entry has.
  CORRUPT = path.join(ROOT, "corrupt.mp4");
  fs.writeFileSync(CORRUPT, fs.readFileSync(REAL_MP4).subarray(0, 400));
}, 300_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

/** A "download" that copies a real file — real bytes, no network. */
const copyDownloader = (src: string) => async (_url: string, dest: string) => {
  fs.copyFileSync(src, dest);
  return true;
};

/* ═══════════════════════ TEST 1 — curated archive ═══════════════════════ */

describe("TEST 1 — a curated archive asset comes from this system's own storage", () => {
  it("identity → archive row → local file, with the media facts measured", async () => {
    let externalDownloads = 0;
    const result = await rehydrateAsset({
      identity: { provider: "archive", archiveAssetId: 57618, providerAssetId: "57618" },
      workDir: path.join(ROOT, "t1"),
      deps: {
        download: async () => {
          externalDownloads++;
          return true;
        },
        archiveAsset: async (id) => ({
          storageUrl: `/local-storage/archive/${id}.mp4`,
          storageKey: `archive/${id}.mp4`,
        }),
        readStorage: async (_url, dest) => {
          fs.copyFileSync(REAL_MP4, dest);
          return true;
        },
      },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(fs.existsSync(result.localPath)).toBe(true);
    // §7: read from the FILE, not from any metadata the row carried.
    expect(result.durationSec).toBeGreaterThan(2.5);
    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect(result.hasVideoStream).toBe(true);
    expect(result.storagePath).toBe("archive/57618.mp4");
    expect(result.provenance).toContain("own archive storage");
    // The fastest and most reliable route: no external fetch at all.
    expect(externalDownloads, "an archive asset went out to the network").toBe(0);
  }, 120_000);

  it("an archive row that no longer exists is ASSET_NOT_FOUND, not a guess", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "archive", archiveAssetId: 999 },
      workDir: path.join(ROOT, "t1b"),
      deps: { download: async () => true, archiveAsset: async () => null },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("ASSET_NOT_FOUND");
  });
});

/* ═══════════════════════ TEST 2/3/4 — the cache ═══════════════════════ */

describe("TEST 2 — a cache HIT does not call the provider", () => {
  it("the provider is never reached", async () => {
    let downloads = 0;
    const result = await rehydrateAsset({
      identity: { provider: "nasa", providerAssetId: "n1", mediaUrl: "https://nasa/x.mp4" },
      workDir: path.join(ROOT, "t2"),
      deps: {
        download: async () => {
          downloads++;
          return true;
        },
        cacheRestore: async (_key, dest) => {
          fs.copyFileSync(REAL_MP4, dest);
          return true;
        },
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.cacheHit).toBe(true);
      expect(result.downloaded).toBe(false);
    }
    expect(downloads, "the provider was called despite a cache hit").toBe(0);
  }, 120_000);
});

describe("TEST 3 — a cache MISS calls the provider and stores the result", () => {
  it("downloads, then writes the file back into the cache", async () => {
    const stored: string[] = [];
    const result = await rehydrateAsset({
      identity: { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://loc/x.mp4" },
      workDir: path.join(ROOT, "t3"),
      deps: {
        download: copyDownloader(REAL_MP4),
        cacheRestore: async () => false,
        cacheStore: async (key) => {
          stored.push(key);
        },
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.cacheHit).toBe(false);
      expect(result.downloaded).toBe(true);
    }
    expect(stored).toHaveLength(1);
    // §5: keyed on the identity, so a reissued CDN URL cannot make a second entry.
    expect(stored[0]).toBe("fastvid-identity:loc:item/1");
  }, 120_000);
});

describe("TEST 4 — a corrupt cache entry is invalidated and re-fetched", () => {
  it("detects the bad file, invalidates it, and gets a good one from the provider", async () => {
    /**
     * §4. Leaving a bad entry in place would make every future render fail identically, for a
     * reason nobody could see from the outside.
     */
    const invalidated: string[] = [];
    let downloads = 0;
    const result = await rehydrateAsset({
      identity: { provider: "nara", providerAssetId: "nara-1", mediaUrl: "https://nara/x.mp4" },
      workDir: path.join(ROOT, "t4"),
      deps: {
        cacheRestore: async (_key, dest) => {
          fs.copyFileSync(CORRUPT, dest);
          return true;
        },
        cacheInvalidate: async (key) => {
          invalidated.push(key);
        },
        download: async (_url, dest) => {
          downloads++;
          fs.copyFileSync(REAL_MP4, dest);
          return true;
        },
      },
    });
    expect(invalidated, "the corrupt entry was left in the cache").toHaveLength(1);
    expect(downloads, "the provider was not retried after the bad cache hit").toBe(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.durationSec).toBeGreaterThan(2.5);
  }, 120_000);
});

/* ═══════════════════════ TEST 5/6 — Pexels and Pixabay ═══════════════════════ */

describe("TEST 5 — Pexels keeps the video id as its identity", () => {
  it("the id is the handle; an expiring CDN URL is never the identity", () => {
    const identity = {
      provider: "pexels",
      providerAssetId: "3195394",
      mediaUrl: "https://player.vimeo.com/external/3195394.hd.mp4?s=EXPIRING&profile_id=175",
    };
    // §5: the cache key is the identity, so a reissued link cannot create a second entry.
    expect(cacheIdentityKey(identity)).toBe("fastvid-identity:pexels:3195394");
    expect(cacheIdentityKey(identity)).not.toContain("EXPIRING");
  });

  it("the id is looked up through the API — a stored CDN link is only a hint", async () => {
    let askedFor: string | null = null;
    const result = await rehydrateAsset({
      identity: {
        provider: "pexels", providerAssetId: "3195394",
        mediaUrl: "https://old.cdn/expired.mp4",
      },
      workDir: path.join(ROOT, "t5"),
      deps: {
        providerResolver: async (identity) => {
          askedFor = identity.providerAssetId ?? null;
          return { ok: true, url: "https://fresh.cdn/new.mp4" };
        },
        download: copyDownloader(REAL_MP4),
      },
    });
    expect(askedFor, "the API was asked by id").toBe("3195394");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.sourceUrl).toBe("https://fresh.cdn/new.mp4");
  }, 120_000);

  it("NO API KEY IS AN EXPLICIT FAILURE, never a silent skip", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "pexels", providerAssetId: "3195394", mediaUrl: "https://old/x.mp4" },
      workDir: path.join(ROOT, "t5b"),
      deps: { download: copyDownloader(REAL_MP4) },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorCode).toBe("REHYDRATION_AUTH_REQUIRED");
    expect(result.providerAssetId).toBe("3195394");
  });
});

describe("TEST 6 — Pixabay behaves the same way", () => {
  it("id as identity, API lookup, explicit auth failure", async () => {
    expect(cacheIdentityKey({ provider: "pixabay", providerAssetId: "128421" })).toBe(
      "fastvid-identity:pixabay:128421"
    );
    const noKey = await rehydrateAsset({
      identity: { provider: "pixabay", providerAssetId: "128421", mediaUrl: "https://cdn/x.mp4" },
      workDir: path.join(ROOT, "t6"),
      deps: { download: copyDownloader(REAL_MP4) },
    });
    expect(noKey.status).toBe("failed");
    if (noKey.status === "failed") expect(noKey.errorCode).toBe("REHYDRATION_AUTH_REQUIRED");
  });
});

/* ═══════════════════════ TEST 7/9 — YouTube ═══════════════════════ */

describe("TEST 7 — YouTube keeps the videoId as its identity", () => {
  it("the videoId is the handle and a stream URL is never treated as one", async () => {
    const identity = {
      provider: "youtube_cc",
      providerAssetId: "cS2JdEghHDo",
      mediaUrl: "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1700000000&sig=SECRET",
    };
    expect(cacheIdentityKey(identity)).toBe("fastvid-identity:youtube_cc:cS2JdEghHDo");
    expect(cacheIdentityKey(identity)).not.toContain("SECRET");

    let seen = "";
    const result = await rehydrateAsset({
      identity,
      workDir: path.join(ROOT, "t7"),
      deps: {
        download: async () => false,
        youtubeResolver: async (videoId, dest) => {
          seen = videoId;
          fs.copyFileSync(REAL_MP4, dest);
          return true;
        },
      },
    });
    expect(seen).toBe("cS2JdEghHDo");
    expect(result.status).toBe("ok");
    // And the log line never carries the signed URL.
    expect(formatRehydration("c1", result)).not.toContain("SECRET");
  }, 120_000);
});

describe("TEST 9 — an unauthorised YouTube video is refused, not substituted", () => {
  it("REHYDRATION_NOT_AUTHORIZED when the existing layer says no", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "youtube_cc", providerAssetId: "abc123" },
      workDir: path.join(ROOT, "t9"),
      deps: {
        download: async () => true,
        youtubeResolver: async () => ({
          ok: false as const,
          code: "REHYDRATION_NOT_AUTHORIZED" as const,
          message: "uploader chose -nd and the operator authorisation is off",
        }),
      },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorCode).toBe("REHYDRATION_NOT_AUTHORIZED");
    expect(result.errorMessage).toContain("-nd");
  });

  it("WITHOUT the existing layer it refuses rather than fetching directly", async () => {
    /**
     * §7/§25 — the rehydrator may not bypass youtubeLicenseStatus, OPERATOR_AUTHORIZED or the
     * download ceilings. With no resolver those cannot be consulted, so the only honest answer is
     * a refusal.
     */
    let directDownloads = 0;
    const result = await rehydrateAsset({
      identity: { provider: "youtube_cc", providerAssetId: "abc123" },
      workDir: path.join(ROOT, "t9b"),
      deps: {
        download: async () => {
          directDownloads++;
          return true;
        },
      },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("REHYDRATION_NOT_AUTHORIZED");
    expect(directDownloads, "it fetched YouTube without consulting the licence layer").toBe(0);
  });
});

/* ═══════════════════════ TEST 8 — missing identity ═══════════════════════ */

describe("TEST 8 — a missing identity is an explicit error", () => {
  it("REHYDRATION_IDENTITY_MISSING, and nothing is attempted", async () => {
    let downloads = 0;
    const result = await rehydrateAsset({
      identity: { provider: "wikimedia" },
      workDir: path.join(ROOT, "t8"),
      deps: {
        download: async () => {
          downloads++;
          return true;
        },
      },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("REHYDRATION_IDENTITY_MISSING");
      expect(result.errorMessage).toContain("wikimedia");
    }
    expect(downloads).toBe(0);
  });

  it("a provider with no rehydration route says so", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "some_new_museum", providerAssetId: "1", mediaUrl: "https://x/y.mp4" },
      workDir: path.join(ROOT, "t8b"),
      deps: { download: copyDownloader(REAL_MP4) },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("REHYDRATION_UNSUPPORTED_PROVIDER");
    expect(providerIsRehydratable("some_new_museum")).toBe(false);
  });
});

/* ═══════════════════════ TEST 10 — asset gone ═══════════════════════ */

describe("TEST 10 — an asset that cannot be found is reported with its id", () => {
  it("a failed download is REHYDRATION_DOWNLOAD_FAILED with the provider and id", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "loc", providerAssetId: "item/404", mediaUrl: "https://loc/gone.mp4" },
      workDir: path.join(ROOT, "t10"),
      deps: { download: async () => false },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorCode).toBe("REHYDRATION_DOWNLOAD_FAILED");
    expect(result.provider).toBe("loc");
    expect(result.providerAssetId).toBe("item/404");
    // §24: the host, never the full URL.
    expect(result.errorMessage).toContain("loc");
    expect(result.errorMessage).not.toContain("https://");
  });

  it("an identity with nothing fetchable is ASSET_NOT_FOUND", async () => {
    const result = await rehydrateAsset({
      // Rehydratable on paper (provider + id) and with no URL to try.
      identity: { provider: "nasa", providerAssetId: "n404" },
      workDir: path.join(ROOT, "t10b"),
      deps: { download: copyDownloader(REAL_MP4) },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("ASSET_NOT_FOUND");
    expect(rehydrationUrlFor({ provider: "nasa", providerAssetId: "n404" })).toBeNull();
  });
});

/* ═══════════════════════ TEST 11 — corrupt media ═══════════════════════ */

describe("TEST 11 — a corrupt file is refused by REAL ffprobe", () => {
  it("REHYDRATION_INVALID_MEDIA — the file is inspected, not trusted", async () => {
    const result = await rehydrateAsset({
      identity: { provider: "loc", providerAssetId: "i", mediaUrl: "https://loc/x.mp4" },
      workDir: path.join(ROOT, "t11"),
      deps: { download: copyDownloader(CORRUPT) },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("REHYDRATION_INVALID_MEDIA");
  }, 120_000);

  it("probeMediaFacts reads real numbers off a real file", async () => {
    const facts = (await probeMediaFacts(REAL_MP4))!;
    expect(facts.hasVideoStream).toBe(true);
    expect(facts.width).toBe(320);
    expect(facts.height).toBe(180);
    expect(facts.durationSec).toBeGreaterThan(2.5);
    expect(await probeMediaFacts(CORRUPT)).toBeNull();
  }, 60_000);

  it("a video with no video stream is not usable, and an image without one is", () => {
    const noVideo = { durationSec: 3, width: null, height: null, hasVideoStream: false, hasAudioStream: true };
    expect(mediaIsUsable(noVideo, true)).toBe(false);
    expect(mediaIsUsable(noVideo, false)).toBe(true);
    expect(mediaIsUsable(null, false)).toBe(false);
  });
});

/* ═══════════════════════ TEST 12 — no silent substitution ═══════════════════════ */

describe("TEST 12 — asset B is NEVER used in place of a failed asset A", () => {
  function twoClipTimeline(): ProjectTimeline {
    const t = emptyTimeline(1, { ...DEFAULT_FORMAT, widthPx: 320, heightPx: 180, fps: 25 });
    const clip = (i: number, identity: TimelineVideoClip["source"]): TimelineVideoClip => ({
      id: `vc_${i}`, kind: "video", source: identity,
      timelineStart: i * 3, timelineEnd: (i + 1) * 3,
      motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
    });
    t.tracks = [
      {
        kind: "VIDEO",
        clips: [
          clip(0, { provider: "pexels", providerAssetId: "123456", mediaUrl: "https://a/x.mp4" }),
          clip(1, { provider: "loc", providerAssetId: "item/2", mediaUrl: "https://b/y.mp4" }),
        ],
      },
      { kind: "VOICE", clips: [] }, { kind: "MUSIC", clips: [] }, { kind: "SFX", clips: [] },
      { kind: "CAPTIONS", captions: [] }, { kind: "TEXT", texts: [] }, { kind: "GRAPHICS", texts: [] },
    ];
    t.durationSec = 6;
    return t;
  }

  it("A fails: the result is a failure for A, and B is not offered for it", async () => {
    const deps: RehydrateDeps = {
      // No providerResolver → Pexels (clip 0) cannot be recovered.
      download: copyDownloader(OTHER_MP4),
    };
    const rehydration = await rehydrateTimelineAssets({
      timeline: twoClipTimeline(),
      workDir: path.join(ROOT, "t12"),
      deps,
      failFast: false,
    });
    expect(rehydration.ok).toBe(false);
    expect(rehydration.failures.map((f) => f.clipId)).toContain("vc_0");
    // THE ASSERTION: nothing at all is mapped for the failed clip.
    expect(rehydration.byClipId.has("vc_0")).toBe(false);
    // ...and B, which succeeded, is mapped only to its OWN clip.
    expect(rehydration.byClipId.get("vc_1")).toBeTruthy();
    expect(rehydration.byClipId.size).toBe(1);
  }, 180_000);

  it("failFast defaults to TRUE — a full render stops at the first unrecoverable asset", async () => {
    /**
     * §8. Running for ten minutes and producing a video with a hole is worse than stopping at the
     * moment the hole becomes certain.
     */
    let attempts = 0;
    const rehydration = await rehydrateTimelineAssets({
      timeline: twoClipTimeline(),
      workDir: path.join(ROOT, "t12b"),
      deps: {
        download: async () => {
          attempts++;
          return false;
        },
      },
    });
    expect(rehydration.ok).toBe(false);
    expect(rehydration.failures).toHaveLength(1);
    expect(rehydration.results).toHaveLength(1); // it stopped rather than trying clip 1
    expect(attempts).toBeLessThanOrEqual(1);
  }, 120_000);

  it("collect-all reports EVERY failure, for an editor showing what is missing", async () => {
    const rehydration = await rehydrateTimelineAssets({
      timeline: twoClipTimeline(),
      workDir: path.join(ROOT, "t12c"),
      deps: { download: async () => false },
      failFast: false,
    });
    expect(rehydration.failures).toHaveLength(2);
    expect(rehydration.results).toHaveLength(2);
  }, 120_000);

  it("REAL END TO END: every clip recovered, mapped to its own file", async () => {
    const bySource = new Map([["item/2", OTHER_MP4], ["3195394", REAL_MP4]]);
    const t = twoClipTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") {
      track.clips[0]!.source = { provider: "pexels", providerAssetId: "3195394" };
    }
    const rehydration = await rehydrateTimelineAssets({
      timeline: t,
      workDir: path.join(ROOT, "t12d"),
      deps: {
        providerResolver: async () => ({ ok: true, url: "https://fresh/x.mp4" }),
        download: async (url, dest) => {
          fs.copyFileSync(url.includes("fresh") ? REAL_MP4 : OTHER_MP4, dest);
          return true;
        },
      },
    });
    expect(rehydration.ok).toBe(true);
    expect(rehydration.byClipId.size).toBe(2);
    // Two different assets → two different files. Nothing was reused for the other.
    const files = [...rehydration.byClipId.values()];
    expect(new Set(files).size).toBe(2);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    expect(bySource.size).toBe(2); // fixture sanity
  }, 180_000);
});

/* ═══════════════════════ §23 — the cache is optional ═══════════════════════ */

describe("§23 — rehydration does not depend on the cache being switched on", () => {
  it("with no cache functions at all it still recovers the asset", async () => {
    /**
     * ENABLE_MEDIA_CACHE + S3 gate the cache. It is an accelerator, and a feature that only worked
     * when an obscure flag happened to be on would be a trap.
     */
    const result = await rehydrateAsset({
      identity: { provider: "europeana", providerAssetId: "rec1", mediaUrl: "https://eu/x.mp4" },
      workDir: path.join(ROOT, "nocache"),
      deps: { download: copyDownloader(REAL_MP4) },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.cacheHit).toBe(false);
  }, 120_000);
});

/* ═══════════════════════ §26 — the architecture holds ═══════════════════════ */

describe("§26 — the renderer knows no providers and the rehydrator makes no edits", () => {
  const read = (f: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, f), "utf8")
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
      .replace(/^[ \t]*\*.*$/gm, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  };

  it("timelineRenderer contains no provider API knowledge", () => {
    const src = read("timelineRenderer.ts");
    for (const forbidden of [
      "pexels", "pixabay", "youtube", "wikimedia", "api.", "RAPIDAPI", "archive.org",
    ]) {
      expect(src.toLowerCase(), `the renderer reaches for ${forbidden}`).not.toContain(
        forbidden.toLowerCase()
      );
    }
  });

  it("assetRehydrator makes no editing decisions", () => {
    // §25: no ranking, no vision, no candidate choice, no TTS, no caption generation.
    const src = read("assetRehydrator.ts");
    for (const forbidden of [
      "VisionGate", "rankCandidates", "adoptClip", "elevenlabs", "captionPlanner", "scoreCandidate",
    ]) {
      expect(src, `the rehydrator reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("there is exactly one rehydrator and it is not a second downloader", () => {
    const src = read("assetRehydrator.ts");
    // Every fetch goes through the injected `download`; no direct HTTP anywhere in this module.
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("axios");
    expect(src).not.toContain("node-fetch");
  });
});
