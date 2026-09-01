/**
 * RONDE 96 — the last five providers join the ledger.
 *
 * Eleven providers opened a lineage record at the moment they downloaded: provider name, the
 * provider's own asset id and the destination path all in hand, straight from the API response.
 * Five did not — Pexels, Unsplash, SerpAPI, Openverse and YouTube thumbnails wrote their file to
 * workDir and handed the path on. Those clips only ever reached the ledger later, through
 * clipAdoptAudit's "adoption of a clip the ledger has never seen" branch, which deliberately
 * records NO provider because guessing one from a filename is what RONDE 86 removed.
 *
 * The result was honest and useless: every asset from those five counted as UNVERIFIED however
 * normally it had arrived, so "which visuals came from Pexels" had no answer at all.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { VisualSourceLedger, UNVERIFIED_PROVIDER } from "./visualSourceLineage";
import { tagPathWithProviderAsset, recordProviderDownloadOutcome } from "./videoPipeline";

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The five fetchers this round is about, and the id each one keeps. */
const NEW_PROVIDERS = [
  { fn: "fetchPexelsClips", provider: "pexels", idExpr: "String(video.id)" },
  { fn: "fetchOpenverseImages", provider: "openverse", idExpr: 'images[i]?.id?.trim() || imgUrl' },
  { fn: "fetchUnsplashImages", provider: "unsplash", idExpr: "images[i].id?.trim() || urlKey" },
  { fn: "fetchSerpAPIImages", provider: "serpapi", idExpr: "urlKey" },
] as const;

/**
 * RONDE 97 removed fetchYouTubeThumbnails entirely.
 *
 * RONDE 96 had wired it into the ledger like the other four, which was the right thing to do while
 * the route existed — it downloaded a YouTube search-result still, ran ffmpeg with `-loop 1 …
 * zoompan` over it, and handed the resulting .mp4 to adoptClip as footage. Giving it provenance
 * made that visible; RONDE 97 acted on what it showed and deleted the route. FastVid uses YouTube
 * for video it can cut a fragment out of, and a still has no fragment.
 *
 * Its lineage tests move to ronde97YouTubeVideoOnly, which asserts the opposite property: that no
 * such asset can be created at all.
 */

/** Every provider that downloads its own assets and must therefore open a record. */
const ALL_DOWNLOADING_FETCHERS = [
  "fetchWikimediaVideos", "fetchYouTubeCCClips", "fetchInternetArchiveClips",
  "fetchEuropeanaVideos", "fetchNaraClips", "fetchNasaVideoClips", "fetchGdeltTvNewsClips",
  "fetchSepiaSearchVideos", "fetchVimeoCCVideos", "fetchMediaCccVideos", "fetchFlickrCCVideos",
  "fetchPexelsClips", "fetchOpenverseImages", "fetchUnsplashImages", "fetchSerpAPIImages",
  "downloadAndTrimPoolCandidate",
  // RONDE 96's own re-scan found four more the brief had not listed: Pixabay (which §8 does name),
  // Wikimedia IMAGES — a sibling of fetchWikimediaVideos that never opened a record — and the
  // Pexels b-roll path. Leaving them out would have made "every provider is covered" false.
  "fetchPixabayClips", "fetchWikimediaImages", "fetchBrollClips",
] as const;

function bodyOf(fn: string, span = 16000): string {
  const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
  expect(idx, `${fn} not found`).toBeGreaterThan(-1);
  return PIPELINE_SRC.slice(idx, idx + span);
}

/** A cache shaped like the one the pipeline passes, with a real ledger inside it. */
function cacheWithLedger() {
  const ledger = new VisualSourceLedger({ renderId: "r96", videoId: 42 });
  return { cache: { lineage: ledger } as never, ledger };
}

function silence<T>(fn: () => T): T {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/* ═══════════ §1/§2 — the five now open a record ═══════════ */

describe("RONDE 96 §1 — every one of the five reaches the ledger", () => {
  it.each(NEW_PROVIDERS)("TEST — $fn tags its output with $provider", ({ fn, provider }) => {
    const body = bodyOf(fn);
    expect(body, `${fn} still writes its file outside the ledger`).toContain(
      "tagPathWithProviderAsset("
    );
    expect(body, `${fn} does not name its provider`).toContain(`"${provider}"`);
  });

  it.each(NEW_PROVIDERS)("TEST — $fn keeps the provider's own id ($idExpr)", ({ fn, idExpr }) => {
    expect(bodyOf(fn), `${fn} does not pass a real provider id`).toContain(idExpr);
  });

  it.each(NEW_PROVIDERS)("TEST — $fn passes its own searchRoute", ({ fn }) => {
    expect(bodyOf(fn)).toContain(`searchRoute: "${fn}"`);
  });

  it.each(NEW_PROVIDERS)("TEST — $fn records the download outcome", ({ fn }) => {
    expect(bodyOf(fn)).toContain("recordProviderDownloadOutcome(");
  });
});

/* ═══════════ §2 — the record that comes out ═══════════ */

describe("RONDE 96 §2 — provider, id and route land on the record", () => {
  it("TEST 21 — tagging opens a record with all three, and files DOWNLOAD_STARTED", () => {
    const { cache, ledger } = cacheWithLedger();
    const tagged = silence(() =>
      tagPathWithProviderAsset("/tmp/scene_1_pexels_vid8899.mp4", "pexels", "8899", cache, {
        sceneIndex: 1,
        beatIndex: 2,
        sourceUrl: "https://player.pexels.com/8899.mp4",
        mediaType: "video",
        query: "Berlin Wall",
        searchRoute: "fetchPexelsClips",
      })
    );
    const record = ledger.resolve(tagged)!;
    expect(record.provider).toBe("pexels");
    expect(record.providerStatus).toBe("VERIFIED");
    expect(record.providerAssetId).toBe("8899");
    expect(record.searchRoute).toBe("fetchPexelsClips");
    expect(record.query).toBe("Berlin Wall");
    expect(record.sourceUrl).toBe("https://player.pexels.com/8899.mp4");
    expect(ledger.allEvents().some((e) => e.stage === "DOWNLOAD_STARTED")).toBe(true);
  });

  it("TEST 22 — the download outcome flips it to DOWNLOAD_SUCCEEDED", () => {
    const { cache, ledger } = cacheWithLedger();
    const tagged = silence(() => {
      const p = tagPathWithProviderAsset("/tmp/u.mp4", "unsplash", "abc123", cache, {
        searchRoute: "fetchUnsplashImages",
      });
      recordProviderDownloadOutcome(cache, p, true);
      return p;
    });
    const stages = ledger.allEvents().filter((e) => e.lineageId === ledger.resolve(tagged)!.lineageId);
    expect(stages.map((e) => e.stage)).toContain("DOWNLOAD_SUCCEEDED");
    expect(ledger.summary().byProvider.unsplash!.downloadSucceeded).toBe(1);
  });

  it("TEST 23 — a failed download is recorded as failed, not quietly as success", () => {
    const { cache, ledger } = cacheWithLedger();
    silence(() => {
      const p = tagPathWithProviderAsset("/tmp/s.mp4", "serpapi", "https://x.test/a.jpg", cache, {
        searchRoute: "fetchSerpAPIImages",
      });
      recordProviderDownloadOutcome(cache, p, false, "http_404");
    });
    expect(ledger.summary().byProvider.serpapi!.downloadSucceeded).toBe(0);
    expect(ledger.summary().byProvider.serpapi!.downloadFailed).toBe(1);
  });

  it("TEST 24 — no provider means no record is invented", () => {
    const { cache, ledger } = cacheWithLedger();
    // tagPathWithProviderAsset returns the path untouched when there is no id to key on.
    const tagged = silence(() => tagPathWithProviderAsset("/tmp/x.mp4", "pexels", undefined, cache));
    expect(tagged).toBe("/tmp/x.mp4");
    expect(ledger.allRecords()).toHaveLength(0);
  });
});

/* ═══════════ §5 — the lineage survives every derived path ═══════════ */

describe("RONDE 96 §5 — a trimmed, padded, copied clip keeps its identity", () => {
  it("TEST 25 — the whole lifecycle stays on one lineageId", () => {
    const { cache, ledger } = cacheWithLedger();
    const tagged = silence(() =>
      tagPathWithProviderAsset("/tmp/ov.mp4", "openverse", "ov-77", cache, {
        sceneIndex: 3, beatIndex: 1, mediaType: "image", query: "canal",
        searchRoute: "fetchOpenverseImages",
      })
    );
    const id = ledger.resolve(tagged)!.lineageId;
    silence(() => {
      recordProviderDownloadOutcome(cache, tagged, true);
      ledger.recordEvent(id, "ELIGIBLE", { status: "OK" });
      ledger.recordEvent(id, "SELECTED", { status: "OK" });
      ledger.recordEvent(id, "ADOPTED", { status: "OK" });
      // trimmed into a new file, then padded into another
      ledger.linkDerivedPath("/tmp/ov_trim.mp4", tagged, "TRIMMED");
      ledger.linkDerivedPath("/tmp/ov_trim_pad.mp4", "/tmp/ov_trim.mp4", "PADDED");
      ledger.recordEventForPath("/tmp/ov_trim_pad.mp4", "COMPOSED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/ov_trim_pad.mp4"]);
    });
    // Two hops later, the clip still resolves to an openverse asset with its route intact.
    const finalRecord = ledger.resolve("/tmp/ov_trim_pad.mp4")!;
    expect(finalRecord.provider).toBe("openverse");
    expect(finalRecord.providerAssetId).toBe("ov-77");
    expect(finalRecord.searchRoute).toBe("fetchOpenverseImages");
    expect(ledger.summary().byProvider.openverse!.finalVideo).toBe(1);
  });

  it("TEST 26 — a replacement of a derived clip does not fabricate a FINAL_VIDEO", () => {
    const { cache, ledger } = cacheWithLedger();
    const a = silence(() =>
      tagPathWithProviderAsset("/tmp/a.mp4", "pexels", "1", cache, { searchRoute: "fetchPexelsClips" })
    );
    const b = silence(() =>
      tagPathWithProviderAsset("/tmp/b.mp4", "unsplash", "2", cache, { searchRoute: "fetchUnsplashImages" })
    );
    silence(() => {
      ledger.recordEventForPath(a, "SELECTED", { status: "OK" });
      ledger.recordReplacement(a, b, "compose_gate_failed");
      ledger.markFinalVideo([b]);
    });
    expect(ledger.summary().byProvider.pexels!.finalVideo).toBe(0);
    expect(ledger.summary().byProvider.unsplash!.finalVideo).toBe(1);
  });
});

/* ═══════════ §6 — UNVERIFIED means unknown, not "one of the five" ═══════════ */

describe("RONDE 96 §6 — UNVERIFIED is reserved for genuinely unknown assets", () => {
  it("TEST 27 — a tagged asset never lands in the UNVERIFIED bucket", () => {
    const { cache, ledger } = cacheWithLedger();
    for (const [provider, id, route] of [
      ["pexels", "1", "fetchPexelsClips"],
      ["openverse", "2", "fetchOpenverseImages"],
      ["unsplash", "3", "fetchUnsplashImages"],
      ["serpapi", "https://x.test/4.jpg", "fetchSerpAPIImages"],
      ["youtube", "5", "fetchYouTubeThumbnails"],
    ] as const) {
      silence(() =>
        tagPathWithProviderAsset(`/tmp/${provider}.mp4`, provider, id, cache, { searchRoute: route })
      );
    }
    const providers = Object.keys(ledger.summary().byProvider);
    expect(providers).not.toContain(UNVERIFIED_PROVIDER);
    for (const p of ["pexels", "openverse", "unsplash", "serpapi", "youtube"]) {
      expect(providers, p).toContain(p);
    }
  });

  it("TEST 28 — clipAdoptAudit still refuses to guess a provider for a clip it never saw", () => {
    const src = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
    const idx = src.indexOf("const created = ledger.createLineage({");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, src.indexOf("});", idx));
    // No provider, no searchRoute — the record exists so reconcile() can find the hole, and says
    // nothing it cannot prove.
    expect(body).not.toContain("provider:");
    expect(body).not.toContain("searchRoute:");
    expect(body).toContain("sourceLabel: source");
  });

  it("TEST 29 — an unknown clip is still recorded, still UNVERIFIED", () => {
    const { ledger } = cacheWithLedger();
    const record = silence(() =>
      ledger.createLineage({
        sceneIndex: 0, beatIndex: 0, candidateId: "mystery.mp4", contentKey: "",
        localPath: "/tmp/mystery.mp4", sourceLabel: "unknown",
      })
    );
    expect(record.provider).toBeNull();
    expect(record.providerStatus).toBe("UNVERIFIED");
    expect(record.searchRoute).toBeUndefined();
    expect(Object.keys(ledger.summary().byProvider)).toContain(UNVERIFIED_PROVIDER);
  });
});

/* ═══════════ §8 — provider coverage ═══════════ */

describe("RONDE 96 §8 — every downloading provider is lineage-capable", () => {
  it("TEST 30 — every downloader opens a record", () => {
    const missing: string[] = [];
    for (const fn of ALL_DOWNLOADING_FETCHERS) {
      if (!bodyOf(fn).includes("tagPathWithProviderAsset(")) missing.push(fn);
    }
    expect(missing, `these still write outside the ledger:\n${missing.join("\n")}`).toEqual([]);
  });

  it("TEST 31 — every downloader passes a real searchRoute, never a generic default", () => {
    const missing: string[] = [];
    for (const fn of ALL_DOWNLOADING_FETCHERS) {
      if (!/searchRoute: ("[a-zA-Z]+"|`scenePool:)/.test(bodyOf(fn))) missing.push(fn);
    }
    expect(missing, `no route:\n${missing.join("\n")}`).toEqual([]);
    expect(PIPELINE_SRC).not.toMatch(/searchRoute: "provider_search"/);
  });

  it("TEST 31b — AI-generated clips are the one documented exemption", () => {
    // fetchBeatAIClip does not search a provider; it asks an image model for a picture that has
    // never existed. There is no provider asset id to keep and no search route to record, so it
    // writes its file plainly and arrives through clipAdoptAudit as UNVERIFIED — which is the
    // correct answer for an asset with no external origin, not a gap.
    const body = bodyOf("fetchBeatAIClip");
    expect(body).not.toContain("tagPathWithProviderAsset(");
    expect(body).toMatch(/generateAI|leonardo|Leonardo|aiImage|imagePrompt/i);
  });

  it("TEST 32 — the curated archive is exempt, and says why", () => {
    // Curated assets come from the database, not from a search, so there is no route to record.
    // RONDE 170 split the body out so the funnel, which holds only a ledger, can call it too.
    const idx = PIPELINE_SRC.indexOf("export function ensureCuratedAssetLineageOn(");
    expect(idx).toBeGreaterThan(-1);
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
    expect(body).toContain("createLineage({");
    expect(body).not.toContain("searchRoute:");
  });
});

/* ═══════════ §10 — no remaining bypasses ═══════════ */

describe("RONDE 96 §10 — nothing writes a provider asset outside the ledger", () => {
  it("TEST 33 — none of the five builds its output path bare any more", () => {
    for (const bare of [
      "const outPath = path.join(workDir, `scene_${sceneIndex}_${fileTag}_vid${video.id}.mp4`)",
      "const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}openverse_${assetTag}.mp4`)",
      "const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}unsplash_${i}.mp4`)",
      "const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}serp_${i}.mp4`)",
      "const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}yt_${i}.mp4`)",
    ]) {
      expect(PIPELINE_SRC, `still bare: ${bare}`).not.toContain(bare);
    }
  });

  it("TEST 34 — there is still exactly one place a provider lineage is opened", () => {
    // Two openers in this file and no more: tagPathWithProviderAsset for everything a provider
    // downloads, ensureCuratedAssetLineage for the database archive. A third would be a second
    // entry point, and two entry points drift — which is how the five got left behind in the
    // first place.
    expect((PIPELINE_SRC.match(/createLineage\(\{/g) ?? []).length).toBe(2);
    const idx = PIPELINE_SRC.indexOf("export function tagPathWithProviderAsset(");
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
    expect(body).toContain("provider,");
    expect(body).toContain("providerAssetId: id,");
  });
});
