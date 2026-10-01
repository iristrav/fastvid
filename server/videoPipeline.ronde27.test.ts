import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { youtubeDownloadTimeoutMs, youtubeMinFormatHeight } from "./sourcingPolicy";
import { looksLikeSentenceFragment } from "./mediaResearchEngine";

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
