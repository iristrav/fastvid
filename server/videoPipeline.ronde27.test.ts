import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { youtubeDownloadTimeoutMs, youtubeMinFormatHeight } from "./sourcingPolicy";
import { locPoolBudgetMs } from "./scenePool";
import { looksLikeSentenceFragment } from "./mediaResearchEngine";
import { mergeCandidates } from "./retrievalFunnel";
import type { PoolCandidate } from "./scenePool";

// RONDE 27 — render 528 looked better but the montage was carried by Ken Burns stills and generic
// stock. The log says why, in four places:
//
//   YouTube CC found N relevant videos for "hitler bunker archival footage"      (found it)
//   RapidAPI YouTube download scene 1 exceeded 90s                               (lost it)
//   calls: ... loc=28 | ms: loc=60905, wikimedia=887, pexels=132                 (pool starved)
//   "Over Surrender archival footage" / "Chose Death archival footage"           (junk queries)
//
// plus the same Internet Archive item cut into two different scenes, and a "gray pad" reported in
// a render whose ffmpeg commands contain no tpad at all.

describe("RONDE 27a — YouTube downloads get room and stay small", () => {
  afterEach(() => {
    delete process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS;
    delete process.env.YOUTUBE_MIN_FORMAT_HEIGHT;
  });

  it("gives a download more than the 90s that lost every clip in render 528", () => {
    expect(youtubeDownloadTimeoutMs()).toBeGreaterThan(90_000);
  });

  it("is tunable within sane bounds", () => {
    process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS = "240000";
    expect(youtubeDownloadTimeoutMs()).toBe(240_000);
    process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS = "5";
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS = "nonsense";
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
  });

  it("keeps a resolution floor rather than accepting anything", () => {
    expect(youtubeMinFormatHeight()).toBe(480);
    process.env.YOUTUBE_MIN_FORMAT_HEIGHT = "360";
    expect(youtubeMinFormatHeight()).toBe(360);
    process.env.YOUTUBE_MIN_FORMAT_HEIGHT = "4000";
    expect(youtubeMinFormatHeight()).toBe(480);
  });
});

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 27a — the format picker optimises for download time", () => {
  const picker = pipelineSrc.slice(
    pipelineSrc.indexOf("const pickFormat = ("),
    pipelineSrc.indexOf("const format = pickFormat("),
  );

  it("no longer sorts by distance to 720p", () => {
    // That rule happily chose a huge 720p file over a small 480p one of the same video.
    expect(picker).not.toContain("Math.abs(heightA - 720)");
  });

  it("takes the smallest file that clears the floor", () => {
    expect(picker).toContain("youtubeMinFormatHeight()");
    expect(picker).toContain("sizeOf(a) - sizeOf(b)");
  });

  it("still returns something when nothing clears the floor", () => {
    // Falling through to "no clip" would trade one problem for a worse one.
    expect(picker).toContain("(b.height ?? 0) - (a.height ?? 0)");
  });

  it("treats a missing contentLength as worst, not best", () => {
    // Sorting ascending with a missing size parsed as 0 or NaN would pick the unknown every time.
    expect(picker).toContain("Number.MAX_SAFE_INTEGER");
  });

  it("is applied to both download routes", () => {
    const uses = pipelineSrc.split("youtubeDownloadTimeoutMs()").length - 1;
    expect(uses).toBe(2); // cloud/yt-dlp service and RapidAPI
  });
});

describe("RONDE 27b — Library of Congress cannot run out the pool clock", () => {
  afterEach(() => {
    delete process.env.LOC_POOL_BUDGET_MS;
  });

  it("has a budget well under the 60s pool window it used to consume whole", () => {
    expect(locPoolBudgetMs()).toBeLessThan(60_000);
    expect(locPoolBudgetMs()).toBeGreaterThanOrEqual(10_000);
  });

  it("is tunable within sane bounds", () => {
    process.env.LOC_POOL_BUDGET_MS = "30000";
    expect(locPoolBudgetMs()).toBe(30_000);
    process.env.LOC_POOL_BUDGET_MS = "999999";
    expect(locPoolBudgetMs()).toBe(20_000);
  });
});

const poolSrc = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");

describe("RONDE 27b — the budget is enforced where the time is spent", () => {
  const fn = poolSrc.slice(
    poolSrc.indexOf("export async function searchLibraryOfCongressCandidates("),
    poolSrc.indexOf("export async function searchLibraryOfCongressCandidates(") + 4000,
  );

  it("stops starting new queries once spent", () => {
    expect(fn).toContain("outOfTime()");
    expect(fn).toContain("skipping remaining queries");
  });

  it("also stops between detail-fetch batches — that is what burns the clock", () => {
    // One item request per search hit, five at a time, 8s each: the search calls are cheap and
    // the detail calls are not, so a query-level check alone would not have bounded anything.
    const batchLoop = fn.slice(fn.indexOf("for (let i = 0; i < results.length"));
    expect(batchLoop).toContain("if (outOfTime()) break;");
  });

  it("returns what it found rather than throwing it away", () => {
    expect(fn).toContain("keeping ${candidates.length} candidate(s)");
  });
});

const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");

describe("RONDE 27c — moving footage gets a nudge, not a veto", () => {
  // RONDE 29 gave movingFootageBonus a second argument (the render's shortfall against its
  // moving-footage target), so the two cases below no longer match the old source text
  // verbatim. They assert the same two properties through mergeCandidates instead, which is
  // what actually has to hold — and does not have to be rewritten again the next time the
  // bonus is reshaped.
  const poolItem = (mediaType: "video" | "image"): PoolCandidate =>
    ({ id: `x:${mediaType}`, source: "pexels", title: "t", thumbnailUrl: null, mediaType }) as PoolCandidate;

  it("bonuses video on both archive and external candidates", () => {
    const external = mergeCandidates([], [], [poolItem("video"), poolItem("image")], 1, 1, 10);
    const video = external.find((c) => c.mediaType === "video")!;
    const image = external.find((c) => c.mediaType === "image")!;
    expect(video.rankingScore).toBeGreaterThan(image.rankingScore);
    // Archive path: same call, same bonus — asserted at the source level because building a
    // real CuratedCandidatePick here would pull in the whole archive schema for one number.
    expect(funnelSrc).toContain("movingFootageBonus(archiveMediaType");
    expect(funnelSrc).toContain("movingFootageBonus(c.mediaType");
  });

  it("gives stills nothing rather than penalising them", () => {
    // An image candidate must score exactly the flat internetWeight * (0.7 + tier) — Pexels'
    // tier bonus is 0 — i.e. the bonus adds nothing rather than subtracting.
    const [image] = mergeCandidates([], [], [poolItem("image")], 1, 1, 10);
    expect(image.rankingScore).toBeCloseTo(0.7, 10);
  });

  it("stays smaller than a full source-tier step", () => {
    // The tier bonuses span 0–0.15. Anything larger would let a Pexels clip outrank a genuine
    // Internet Archive still on media type alone — trading "everything matches" for "more video".
    const match = funnelSrc.match(/const MOVING_FOOTAGE_BONUS = ([0-9.]+);/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1]!)).toBeGreaterThan(0);
    expect(parseFloat(match![1]!)).toBeLessThan(0.15);
  });

  it("only moves the shortlist — the winner is still decided on vision scores", () => {
    // rankingScore governs which candidates get downloaded and CLIP-scored at all.
    expect(funnelSrc).toContain("pickBestFunnelCandidate");
    const doc = funnelSrc.slice(
      funnelSrc.indexOf("RONDE 27: nudge toward footage"),
      funnelSrc.indexOf("const MOVING_FOOTAGE_BONUS"),
    );
    expect(doc).toContain("not a veto");
  });
});

describe("RONDE 27d — clause fragments are not search anchors", () => {
  it("rejects the exact anchors render 528 sent to nine providers", () => {
    expect(looksLikeSentenceFragment("Over Surrender")).toBe(true);
    expect(looksLikeSentenceFragment("Chose Death")).toBe(true);
    expect(looksLikeSentenceFragment("As Soviet")).toBe(true);
    expect(looksLikeSentenceFragment("did nazism")).toBe(true);
  });

  it("keeps real subjects", () => {
    expect(looksLikeSentenceFragment("Adolf Hitler")).toBe(false);
    expect(looksLikeSentenceFragment("Eva Braun")).toBe(false);
    expect(looksLikeSentenceFragment("Berlin bunker")).toBe(false);
    expect(looksLikeSentenceFragment("Soviet troops")).toBe(false);
  });

  it("judges only the first word, so a stopword later in the phrase is harmless", () => {
    expect(looksLikeSentenceFragment("Battle of Berlin")).toBe(false);
    expect(looksLikeSentenceFragment("Hitler in the bunker")).toBe(false);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(looksLikeSentenceFragment("OVER Surrender")).toBe(true);
    expect(looksLikeSentenceFragment('"As Soviet')).toBe(true);
  });

  it("says nothing about empty input", () => {
    expect(looksLikeSentenceFragment("")).toBe(false);
    expect(looksLikeSentenceFragment("   ")).toBe(false);
  });
});

const researchSrc = readFileSync(path.join(__dirname, "mediaResearchEngine.ts"), "utf8");

describe("RONDE 27d — the filter is applied to both anchor sources", () => {
  it("guards the generic anchor set", () => {
    expect(researchSrc).toContain("if (anchor && !looksLikeSentenceFragment(anchor))");
  });

  it("guards the per-target variants, which is where the junk came from", () => {
    const loop = researchSrc.slice(
      researchSrc.indexOf("for (const target of targets) {"),
      researchSrc.indexOf("out.push(...intent.searchQueries);"),
    );
    expect(loop).toContain("if (looksLikeSentenceFragment(target.text)) continue;");
  });
});

describe("RONDE 27d — one source item, one appearance", () => {
  it("stamps the provider-asset id into pool downloads like every other route", () => {
    const fn = pipelineSrc.slice(
      pipelineSrc.indexOf("export async function downloadAndTrimPoolCandidate("),
      pipelineSrc.indexOf("const _dtT0 = Date.now();"),
    );
    expect(fn).toContain("tagPathWithProviderAsset(");
    expect(fn).toContain("candidate.assetId");
  });
});

describe("RONDE 27d — the quality report describes what actually happened", () => {
  it("no longer claims a grey filler was rendered", () => {
    // Two problems at once: the list is built from a pre-compose ESTIMATE (render 528 reported it
    // with no tpad anywhere in the run), and since RONDE 26 the filler holds the last frame.
    expect(pipelineSrc).not.toContain("rendered with a gray filler");
  });

  it("reports the shortfall itself, which is true either way", () => {
    // The sentence moved into videoQualityReport with RONDE 132 §10, which added the seconds and
    // the clip counts to it. The claim — the render reports its own shortfall — is unchanged.
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const report = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("had less footage than voice");
    expect(pipelineSrc).toContain("visual coverage incomplete");
  });
});
