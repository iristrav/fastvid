import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  HUMAN_RATING_CRITERIA,
  averageHumanRating,
  clipIdentityCounts,
  percent,
  sourceDistribution,
  validSeconds,
  validateHumanRating,
  validateTestPrompts,
  type HumanRatingCriterion,
} from "./videoQualityMetrics";
import { analyseLogLines, durationToSeconds, parseLogLine, renderIdOfLine } from "./railwayLogAnalyser";

/**
 * MEASUREMENT BASE — the report arithmetic, the log analyser and the fixed test set.
 *
 * Everything here runs on local fixtures: the real summary lines of render 645 (an excerpt of the worker's
 * Railway log) and small synthetic logs for the edge cases. No network, no provider, no credits.
 */
const FIX = path.join(__dirname, "..", "tests", "fixtures", "video-quality");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const lines645 = () => read("render-645.worker.log").split("\n");
const report645 = () => {
  const a = analyseLogLines(lines645());
  const r = a.reports.find((x) => x.identification.videoId === 645);
  if (!r) throw new Error("no report for 645");
  return { a, r };
};

/* ═══════════════════ arithmetic ═══════════════════ */

describe("percentages, durations, sources and clips", () => {
  it("percent: one decimal, null when either side is unknown or the whole is not positive", () => {
    expect(percent(29.31, 52.41)).toBe(55.9);
    expect(percent(6, 11)).toBe(54.5);
    expect(percent(0, 10)).toBe(0);
    expect(percent(null, 10)).toBeNull();
    expect(percent(5, null)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, Number.NaN)).toBeNull();
    expect(percent(-1, 10)).toBeNull();
  });

  it("a duration must be a finite number above zero; zero, negative, NaN and text are unknown", () => {
    expect(validSeconds(52.41)).toBe(52.41);
    expect(validSeconds("52.41")).toBe(52.41);
    expect(validSeconds(0)).toBeNull();
    expect(validSeconds(-3)).toBeNull();
    expect(validSeconds("abc")).toBeNull();
    expect(validSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(durationToSeconds("143ms")).toBe(0.143);
    expect(durationToSeconds("105.9s")).toBe(105.9);
    expect(durationToSeconds("none")).toBeNull();
    expect(durationToSeconds(null)).toBeNull();
  });

  it("largest source and distribution: seconds per source, largest first, zero-length clips ignored", () => {
    const d = sourceDistribution([
      { sourceId: "A", provider: "youtube_cc", durationSec: 2.21 },
      { sourceId: "A", provider: "youtube_cc", durationSec: 2.21 },
      { sourceId: "B", provider: "youtube_cc", durationSec: 3.04 },
      { sourceId: "C", provider: "archive", durationSec: 0 },
      { sourceId: "D", provider: "archive", durationSec: Number.NaN },
    ]);
    expect(d).toEqual([
      { sourceId: "A", provider: "youtube_cc", seconds: 4.42 },
      { sourceId: "B", provider: "youtube_cc", seconds: 3.04 },
    ]);
    expect(percent(d[0]!.seconds, 7.46)).toBe(59.2);
  });

  it("unique clips vs pieces vs repeats: pieces of one shot are not repeats; repeats need a source in-point", () => {
    const noIn = clipIdentityCounts([
      { clipId: "vc_1_p1", sourceId: "A", provider: "yt" },
      { clipId: "vc_1_p2", sourceId: "A", provider: "yt" },
      { clipId: "vc_2", sourceId: "B", provider: "yt" },
    ]);
    expect(noIn).toEqual({ clips: 3, shotDecisions: 2, pieces: 2, repeated: null });
    const withIn = clipIdentityCounts([
      { clipId: "vc_1", sourceId: "A", provider: "yt", sourceInSec: 10 },
      { clipId: "vc_2", sourceId: "A", provider: "yt", sourceInSec: 10 },
      { clipId: "vc_3", sourceId: "A", provider: "yt", sourceInSec: 50 },
    ]);
    expect(withIn.repeated).toBe(1);
    expect(clipIdentityCounts([]).repeated).toBeNull();
  });
});

/* ═══════════════════ reading lines ═══════════════════ */

describe("reading Railway log lines", () => {
  it("the worker's time-only prefix, Railway's ISO prefix, and a line without a tag", () => {
    const a = parseLogLine("15:22:48.689 i [RenderLock] video=645 render=rmv3z2lb7 ACQUIRED");
    expect(a).toMatchObject({ level: "i", tag: "RenderLock", absolute: false });
    expect(a!.atMs).toBe(((15 * 60 + 22) * 60 + 48) * 1000 + 689);
    const b = parseLogLine("2026-10-11T15:22:48.689Z 15:22:48.689 i [RenderLock] video=645 ACQUIRED");
    expect(b!.absolute).toBe(true);
    expect(b!.atMs).toBe(Date.parse("2026-10-11T15:22:48.689Z"));
    expect(parseLogLine("just some text without a tag")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });

  it("the render id: numeric video=/film=/render=/videoId=; a YouTube id after video= is not one", () => {
    const at = "15:00:00.000 i ";
    expect(renderIdOfLine(parseLogLine(`${at}[A] video=645 b`)!)).toBe(645);
    expect(renderIdOfLine(parseLogLine(`${at}[A] film=645`)!)).toBe(645);
    expect(renderIdOfLine(parseLogLine(`${at}[FinalRenderAsset] render=645 job=48`)!)).toBe(645);
    expect(renderIdOfLine(parseLogLine(`${at}[YouTubeTunelio] video=mr9kK0_7x08 step=create`)!)).toBeNull();
    expect(renderIdOfLine(parseLogLine(`${at}[RenderLock] render=rmv3z2lb7 ACQUIRED`)!)).toBeNull();
  });

  it("invalid lines are counted and reported, the analysis goes on; identical lines are counted once", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=7 render=rA ACQUIRED",
      "garbage line",
      "another garbage line",
      "15:00:01.000 i [Timeline] stored video=7 version=1 schema=1 durationSec=30",
      "15:00:01.000 i [Timeline] stored video=7 version=1 schema=1 durationSec=30",
      "15:00:02.000 i [RenderLock] video=7 render=rA RELEASED",
    ]);
    expect(a.invalidLines).toBe(2);
    expect(a.invalidSamples).toEqual(["garbage line", "another garbage line"]);
    expect(a.duplicateLinesDropped).toBe(1);
    expect(a.reports).toHaveLength(1);
    expect(a.reports[0]!.visual.totalVideoSeconds).toBe(30);
    expect(a.reports[0]!.input.partial).toBe(false);
  });

  it("duplicate [FinalRenderAsset] lines (a re-sent log chunk) do not double the seconds", () => {
    const clip = "15:00:01.000 i [FinalRenderAsset] render=7 job=1 asset=youtube_cc:A provider=youtube_cc sourceId=A clip=vc_1 start=0.00 duration=4.00 origin=REAL_ASSET local=true";
    const a = analyseLogLines(["15:00:00.000 i [RenderLock] video=7 render=rA ACQUIRED", clip, clip, clip, "15:00:02.000 i [RenderLock] video=7 render=rA RELEASED"]);
    expect(a.reports[0]!.visual.uniqueClipCount).toBe(1);
    expect(a.reports[0]!.visual.largestSourceSeconds).toBe(4);
  });
});

/* ═══════════════════ missing, partial, aborted ═══════════════════ */

describe("missing values, partial logs and aborted renders", () => {
  it("a render with nothing but its lock: every metric is null (never 0), status unknown, no partial flag", () => {
    const a = analyseLogLines(["15:00:00.000 i [RenderLock] video=9 render=rB ACQUIRED", "15:00:05.000 i [RenderLock] video=9 render=rB RELEASED"]);
    const r = a.reports[0]!;
    expect(r.identification.status).toBe("unknown");
    expect(r.identification.durationSeconds).toBe(5);
    expect(r.visual.totalVideoSeconds).toBeNull();
    expect(r.visual.movingFootageSeconds).toBeNull();
    expect(r.visual.movingFootagePercent).toBeNull();
    expect(r.visual.sentenceCount).toBeNull();
    expect(r.visual.largestSource).toBeNull();
    expect(r.visual.uniqueClipCount).toBeNull();
    expect(r.visual.stretchedBeyondSourceCount).toBeNull();
    expect(r.funnel.downloadsAttempted).toBeNull();
    expect(r.funnel.rejectionReasons).toBeNull();
    expect(r.timing.judgeSeconds).toBeNull();
    expect(r.providers).toEqual({});
    expect(r.assembly.finalOutputValidated).toBeNull();
    expect(r.assembly.movementStatus).toBe("unknown");
    expect(Object.values(r.provenance).filter((p) => p === "unknown").length).toBeGreaterThan(10);
    expect(r.input.partial).toBe(false);
  });

  it("zero and invalid durations are unknown, and percentages built on them are null", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=9 render=rB ACQUIRED",
      "15:00:01.000 i [Timeline] stored video=9 version=1 schema=1 durationSec=0",
      "15:00:02.000 i [RenderJob] video=9 job=3 DELIVERED_BY=cinematic_timeline duration=NaNs",
      "15:00:03.000 i [FinalRenderAsset] render=9 job=3 asset=youtube_cc:A provider=youtube_cc sourceId=A clip=vc_1 start=0.00 duration=0 origin=REAL_ASSET local=true",
      "15:00:05.000 i [RenderLock] video=9 render=rB RELEASED",
    ]);
    const r = a.reports[0]!;
    expect(r.visual.totalVideoSeconds).toBeNull();
    expect(r.visual.totalVideoSecondsBasis).toBe("unknown");
    expect(r.visual.uniqueClipCount).toBeNull();
    expect(r.visual.largestSourcePercent).toBeNull();
    expect(r.visual.movingFootagePercent).toBeNull();
  });

  it("a partial log: the lock is never released and the log ends inside the render — flagged, status incomplete_log, finishedAt null", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=9 render=rB ACQUIRED",
      "15:00:01.000 i [RenderJob] video=9 job=3 attempt=1 timelineVersion=1 route=cinematic_timeline queued",
      "15:00:02.000 i [Timeline] stored video=9 version=1 schema=1 durationSec=40",
    ]);
    const r = a.reports[0]!;
    expect(r.input.partial).toBe(true);
    expect(r.input.partialReasons).toEqual(["render lock never released in this log", "render job queued but no end status in this log", "the log ends inside this render"]);
    expect(r.identification.status).toBe("incomplete_log");
    expect(r.identification.finishedAt).toBeNull();
    expect(r.identification.durationSeconds).toBeNull();
    /** what IS there is still reported */
    expect(r.visual.totalVideoSeconds).toBe(40);
    expect(r.visual.totalVideoSecondsBasis).toBe("stored_timeline");
  });

  it("an aborted render: the job ends in failed, the lock is released, nothing delivered — status failed, not incomplete", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=9 render=rB ACQUIRED",
      "15:00:01.000 i [RenderJob] video=9 job=3 attempt=1 timelineVersion=1 route=cinematic_timeline queued",
      "15:00:30.000 e [RenderJob] job=3 video=9 timelineVersion=1 attempt=1 status=failed phase=render output=none",
      "15:00:31.000 i [RenderLock] video=9 render=rB RELEASED",
    ]);
    const r = a.reports[0]!;
    expect(r.identification.status).toBe("failed");
    expect(r.input.partial).toBe(false);
    expect(r.timing.renderSeconds).toBe(29);
    expect(r.assembly.finalOutputValidated).toBeNull();
  });

  it("two renders in one log keep their own lines; a line without an id goes to the render whose lock is held, and none after the release", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=1 render=rA ACQUIRED",
      "15:00:01.000 i [YouTubeDownload] video=ytAAAAAAAAA scene=-1 status=DOWNLOAD_SUCCESS attempts=cloud:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=cloud_service",
      "15:00:02.000 i [RenderLock] video=1 render=rA RELEASED",
      "15:00:03.000 i [YouTubeDownload] video=ytBBBBBBBBB scene=-1 status=DOWNLOAD_SUCCESS attempts=cloud:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=cloud_service",
      "15:00:04.000 i [RenderLock] video=2 render=rC ACQUIRED",
      "15:00:05.000 i [YouTubeDownload] video=ytCCCCCCCCC scene=-1 status=DOWNLOAD_FAILED attempts=cloud:DOWNLOAD_FAILED(http_502) cloudService=SET reason=cloud=http_502",
      "15:00:06.000 i [RenderLock] video=2 render=rC RELEASED",
    ]);
    expect(a.reports.map((r) => r.identification.videoId)).toEqual([1, 2]);
    expect(a.reports[0]!.funnel.downloadsAttempted).toBe(1);
    expect(a.reports[0]!.funnel.downloadsSucceeded).toBe(1);
    expect(a.reports[1]!.funnel.downloadsAttempted).toBe(1);
    expect(a.reports[1]!.funnel.downloadsSucceeded).toBe(0);
    expect(a.unattributedLines).toBe(1);
  });
});

/* ═══════════════════ providers ═══════════════════ */

describe("providers: several at once, unknown costs, one video with several attempts", () => {
  const base = ["15:00:00.000 i [RenderLock] video=5 render=rD ACQUIRED"];
  const end = ["15:09:00.000 i [RenderLock] video=5 render=rD RELEASED"];

  it("Tunelio, the yt-dlp service and the YouTube Data API are told apart; money is null everywhere; credits are not invented from a count", () => {
    const a = analyseLogLines([
      ...base,
      '15:00:01.000 i [YouTubeSearchCall] video=5 render=none scene=-1 cacheHit=false quotaCall=true status=200 processCallsToday=1 query="x"',
      "15:00:02.000 i [YouTubeVideosList] video=5 ids=50 status=200 quotaUnits=1",
      "15:00:03.000 i [YouTubeTunelio] video=ytAAAAAAAAA step=create http=200 ms=800 declared_bytes=100 quality=720p",
      "15:00:04.000 i [YouTubeTunelio] video=ytAAAAAAAAA step=ready bytes=100 duration=200.0s size=1280x720 transfer_ms=500 total_ms=1300 credits_left=90",
      "15:00:05.000 i [YouTubeTunelio] video=ytBBBBBBBBB step=create http=200 ms=800 declared_bytes=100 quality=720p",
      "15:00:06.000 i [YouTubeTunelio] video=ytBBBBBBBBB step=download_failed ms=6305 — paid answer unusable: download request to <url>",
      "15:00:07.000 i [YouTubeDownload] video=ytAAAAAAAAA scene=-1 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=tunelio",
      "15:00:08.000 i [YouTubeDownload] video=ytBBBBBBBBB scene=2 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_FAILED(download_failed:download request to <url>),cloud:DOWNLOAD_SUCCESS(5204363_bytes) cloudService=SET reason=cloud_service",
      "15:00:09.000 i [YouTubeDownload] video=ytCCCCCCCCC scene=-1 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_FAILED(insufficient_credits:balance 0 < 10),cloud:DOWNLOAD_SUCCESS(3525557_bytes) cloudService=SET reason=cloud_service",
      ...end,
    ]);
    const r = a.reports[0]!;
    expect(r.providers.tunelio).toMatchObject({ requests: 2, failures: 1, fallbacks: 2, costs: null, credits: null });
    expect(r.providers.tunelio!.creditsBasis).toContain("credits_left observed 90→90");
    expect(r.providers.ytdlp_cloud).toMatchObject({ requests: 2, failures: 0, costs: null });
    expect(r.providers.youtube_data_api).toMatchObject({ requests: 2, credits: 101, costs: null });
    /** three unique videos were attempted; the one with two attempts counts once */
    expect(r.funnel.downloadsAttempted).toBe(3);
    expect(r.funnel.downloadsSucceeded).toBe(3);
  });

  it("the same video reported twice (a retry line) is still one attempted video, with its last status", () => {
    const a = analyseLogLines([
      ...base,
      "15:00:07.000 e [YouTubeDownload] video=ytAAAAAAAAA scene=-1 status=DOWNLOAD_FAILED attempts=cloud:DOWNLOAD_FAILED(http_502) cloudService=SET reason=cloud=http_502",
      "15:00:08.000 i [YouTubeDownload] video=ytAAAAAAAAA scene=-1 status=DOWNLOAD_SUCCESS attempts=cloud:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=cloud_service",
      ...end,
    ]);
    expect(a.reports[0]!.funnel.downloadsAttempted).toBe(1);
    expect(a.reports[0]!.funnel.downloadsSucceeded).toBe(1);
  });
});

/* ═══════════════════ render 645 — the reference ═══════════════════ */

describe("render 645 (Tesla) against the audit report's reference figures", () => {
  it("identification: video 645, lock rmv3z2lb7, delivered, 900.4 s between lock acquired and released (≈ 15 min reference: matches)", () => {
    const { r } = report645();
    expect(r.identification).toMatchObject({ videoId: 645, renderId: "rmv3z2lb7", status: "delivered", promptId: null, gitSha: null });
    expect(r.identification.durationSeconds).toBe(900.39);
    expect(r.input.partial).toBe(false);
    expect(r.input.invalidLines).toBe(0);
    expect(r.input.duplicateLinesDropped).toBe(0);
  });

  it("seconds: delivered 52.41 s (timeline 52.46 s; reference ≈ 52.5: matches), real moving 29.31 s = 55.9% (reference 29.31 s / ≈ 56%: matches)", () => {
    const { r } = report645();
    expect(r.visual.totalVideoSeconds).toBe(52.41);
    expect(r.visual.totalVideoSecondsBasis).toBe("delivered_file");
    expect(r.visual.movingFootageSeconds).toBe(29.31);
    expect(r.visual.movingFootagePercent).toBe(55.9);
    expect(r.provenance["visual.movingFootageSeconds"]).toBe("measured");
    expect(r.notes.some((n) => n.includes("52.41s vs stored timeline 52.46s"))).toBe(true);
  });

  it("sentences: 11, of which 5 without a picture of their own (reference 5 of 11: matches); coverage 54.5%", () => {
    const { r } = report645();
    expect(r.visual.sentenceCount).toBe(11);
    expect(r.visual.sentencesWithoutSuitableVisualCount).toBe(5);
    expect(r.visual.sentenceVisualCoveragePercent).toBe(54.5);
  });

  it("source share: the reference '≈ 86%' is the youtube_cc PROVIDER share of all 17 timeline clips (85.9%, cards included); the largest single footage source is mr9kK0_7x08 at 11.38 s = 21.7% of the film, 38.8% of the footage", () => {
    const { r } = report645();
    expect(r.visual.largestProvider).toEqual({ provider: "youtube_cc", seconds: 45.02, percentOfFilm: 85.9 });
    expect(r.visual.largestSource).toEqual({ sourceId: "mr9kK0_7x08", provider: "youtube_cc" });
    expect(r.visual.largestSourceSeconds).toBe(11.38);
    expect(r.visual.largestSourcePercent).toBe(21.7);
    expect(r.visual.largestSourceShareOfFootagePercent).toBe(38.8);
    expect(r.visual.uniqueSourceCount).toBe(5);
    expect(r.visual.uniqueClipCount).toBe(17);
    expect(r.visual.clipPiecesCount).toBe(13);
    expect(r.visual.repeatedClipCount).toBeNull();
    expect(r.visual.stretchedBeyondSourceCount).toBe(2);
    expect(r.visual.titleCardSeconds).toBe(23.15);
    expect(r.visual.genericBackgroundSeconds).toBe(0);
    expect(r.visual.photoSeconds).toBeNull();
    /** the footage and the cards add up to the stored timeline */
    expect(Math.round((r.visual.movingFootageSeconds! + r.visual.titleCardSeconds!) * 100) / 100).toBe(52.46);
  });

  it("funnel: 3 searches, 103 raw results of which 66 Shorts, 11 videos downloaded (11 ok), 34 looks, 5 approved, 4 placed, 1 approved-not-placed", () => {
    const { r } = report645();
    expect(r.funnel).toMatchObject({ searchQueries: 3, resultsFound: 103, shortsFound: 66, downloadsAttempted: 11, downloadsSucceeded: 11, candidatesJudged: 34, candidatesApproved: 5, approvedClipsPlaced: 4, approvedNotPlaced: 1, candidatesOffered: null });
    expect(r.funnel.rejectionReasons).toMatchObject({ REJECTED_BY_EDITOR: 33, "pre_judge:entity_evidence": 4 });
  });

  it("Tunelio: 10 accepted paid calls, 1 paid answer unusable, 2 fallbacks to the yt-dlp service; the 100 credits are NOT confirmable from raw lines (credits null; credits_left observed 70→0)", () => {
    const { r } = report645();
    expect(r.providers.tunelio).toMatchObject({ requests: 10, failures: 1, fallbacks: 2, costs: null, credits: null });
    expect(r.providers.tunelio!.creditsBasis).toContain("10 accepted /create call(s)");
    expect(r.providers.tunelio!.creditsBasis).toContain("credits_left observed 70→0");
    expect(r.providers.youtube_data_api).toMatchObject({ requests: 7, credits: 304 });
    expect(r.providers.ytdlp_cloud).toMatchObject({ requests: 2, failures: 0 });
  });

  it("time: judge 62.09 s (final stage), render job 416.19 s, wall-clock 898.6 s; search/download/assembly seconds are not in the lines (null)", () => {
    const { r } = report645();
    expect(r.timing).toMatchObject({ judgeSeconds: 62.09, renderSeconds: 416.19, wallClockSeconds: 898.6, searchSeconds: null, downloadSeconds: null, assemblySeconds: null });
    expect(r.timing.stageSeconds).toMatchObject({ retrieval: 105.9, tts: 15.3, image_search: 757.8 });
  });

  it("assembly: 4 transitions planned, none verified (null); movement planned but not executed; captions off; delivery gate passed", () => {
    const { r } = report645();
    expect(r.assembly).toEqual({
      transitionPlannedCount: 4,
      transitionSucceededCount: null,
      movementPlannedCount: null,
      movementSucceededCount: null,
      movementStatus: "planned_not_executed",
      subtitlesEnabled: false,
      subtitleTimingStatus: "disabled",
      voiceoverTimingStatus: "unknown",
      finalOutputValidated: true,
    });
  });

  it("the lines without a render id (Tunelio, downloads, EDL, judge) were attributed by the lock window, and the three post-render prefetch downloads were not", () => {
    const { a, r } = report645();
    expect(r.notes.some((n) => /\d+ line\(s\) carried no render id and were attributed by the render lock's time window/.test(n))).toBe(true);
    expect(a.unattributedLines).toBeGreaterThanOrEqual(3);
    expect(r.funnel.downloadsAttempted).toBe(11);
  });
});

/* ═══════════════════ the fixed test set and the human rating ═══════════════════ */

describe("the twelve fixed prompts", () => {
  it("parse, are twelve, have unique ids vq-01…vq-12, a genre, a prompt, scriptVersion null and a known visual strategy", () => {
    const prompts = JSON.parse(read("prompts.json")) as Array<{ id: string; genre: string; scriptVersion: unknown; expectedVisualStrategy: string[] }>;
    expect(validateTestPrompts(prompts)).toEqual([]);
    expect(prompts).toHaveLength(12);
    expect(prompts.map((p) => p.id.slice(0, 5))).toEqual(Array.from({ length: 12 }, (_, i) => `vq-${String(i + 1).padStart(2, "0")}`));
    /** the brief names "Bedrijf" twice (Tesla, and the rise of a car brand): eleven distinct genres */
    expect(prompts.filter((p) => p.genre === "Bedrijf")).toHaveLength(2);
    expect(new Set(prompts.map((p) => p.genre)).size).toBe(11);
    expect(prompts.every((p) => p.scriptVersion === null)).toBe(true);
    expect(prompts[0]!.id).toBe("vq-01-tesla-growth-competition");
    expect(prompts[0]!.expectedVisualStrategy).toContain("real_footage");
  });

  it("the validator refuses a duplicate id, a bad id, a missing strategy and an unknown strategy", () => {
    const ok = { id: "vq-01-a", genre: "g", title: "t", prompt: "p", scriptVersion: null, expectedVisualStrategy: ["real_footage"] };
    expect(validateTestPrompts([ok, { ...ok }])).toEqual(["prompt[1]: duplicate id vq-01-a"]);
    expect(validateTestPrompts([{ ...ok, id: "bad" }])).toEqual(["prompt[0]: id must look like vq-01-slug"]);
    expect(validateTestPrompts([{ ...ok, expectedVisualStrategy: [] }])).toEqual(["prompt[0]: expectedVisualStrategy missing"]);
    expect(validateTestPrompts([{ ...ok, expectedVisualStrategy: ["hologram"] }])).toEqual(["prompt[0]: unknown strategy hologram"]);
    expect(validateTestPrompts("nope")).toEqual(["not an array"]);
  });
});

describe("the human rating", () => {
  const scores: Record<HumanRatingCriterion, number> = { pictureMatchesSpeech: 3, visualVariety: 2, editingAndPace: 3, voiceoverAndSubtitles: 4, chartsAndExplanation: 2, overallViewingQuality: 3 };

  it("six criteria, the mean to two decimals", () => {
    expect(HUMAN_RATING_CRITERIA).toHaveLength(6);
    expect(averageHumanRating(scores)).toBe(2.83);
    expect(averageHumanRating({ ...scores, overallViewingQuality: 5 })).toBe(3.17);
    expect(averageHumanRating({ pictureMatchesSpeech: 5, visualVariety: 5, editingAndPace: 5, voiceoverAndSubtitles: 5, chartsAndExplanation: 5, overallViewingQuality: 5 })).toBe(5);
  });

  it("a complete record validates; a wrong average, a 0 or 6, a decimal, a missing criterion, an unknown key and a missing field do not", () => {
    const rec = { renderId: "645", testId: "vq-01-tesla-growth-competition", gitSha: "87651b6", ratedAt: "2026-10-12T09:00:00Z", scores, averageScore: 2.83, note: "x" };
    expect(validateHumanRating(rec)).toEqual([]);
    expect(validateHumanRating({ ...rec, averageScore: 3 })).toEqual(["averageScore must be 2.83"]);
    expect(validateHumanRating({ ...rec, scores: { ...scores, visualVariety: 0 } })).toEqual(["score visualVariety must be a whole number 1–5"]);
    expect(validateHumanRating({ ...rec, scores: { ...scores, visualVariety: 6 } })).toEqual(["score visualVariety must be a whole number 1–5"]);
    expect(validateHumanRating({ ...rec, scores: { ...scores, visualVariety: 2.5 } })).toEqual(["score visualVariety must be a whole number 1–5"]);
    const { overallViewingQuality: _o, ...five } = scores;
    void _o;
    expect(validateHumanRating({ ...rec, scores: five })).toEqual(["score overallViewingQuality must be a whole number 1–5"]);
    expect(validateHumanRating({ ...rec, scores: { ...scores, humour: 3 } })).toEqual(["unknown score humour"]);
    expect(validateHumanRating({ ...rec, gitSha: "" })).toEqual(["gitSha missing"]);
    expect(validateHumanRating({ ...rec, ratedAt: "yesterday" })).toEqual(["ratedAt is not a date"]);
    expect(validateHumanRating(null)).toEqual(["not an object"]);
  });

  it("the stored ratings file holds no generated scores: it is empty until a person fills it, and whatever is in it validates", () => {
    const stored = JSON.parse(read("human-ratings.json")) as unknown[];
    expect(Array.isArray(stored)).toBe(true);
    for (const rec of stored) expect(validateHumanRating(rec)).toEqual([]);
    const schema = JSON.parse(read("human-rating.schema.json")) as { required: string[]; properties: { scores: { required: string[] } } };
    expect(schema.properties.scores.required).toEqual([...HUMAN_RATING_CRITERIA]);
    expect(schema.required).toEqual(["renderId", "testId", "gitSha", "ratedAt", "scores", "averageScore"]);
  });
});

/* ═══════════════════ the hard rule: coverage and the blue-grey card ground ═══════════════════ */

describe("visual coverage and the blue-grey placeholder", () => {
  it("645: 11 sentences, 5 uncovered (footage=none picture=none), 54.5% covered; the chapter-card ground is on screen 23.15 s (timeline measure, not the MP4); the file's own check saw no black/freeze", () => {
    const { r } = report645();
    expect(r.coverage.sentenceVisualCoverage).toBe(54.5);
    expect(r.coverage.uncoveredSentenceCount).toBe(5);
    expect(r.coverage.blueGrayPlaceholderSeconds).toBe(23.15);
    expect(r.coverage.blueGrayBasis).toBe("timeline_card_clips");
    expect(r.coverage.placeholderDetected).toBe(true);
    expect(r.coverage.deliveredFileCheck).toEqual({ ok: true, black: 0, freeze: 0, silent: 0, frames: 4 });
    expect(r.provenance["coverage.blueGrayPlaceholderSeconds"]).toBe("derived");
    expect(r.notes.some((n) => n.includes("not a frame measure of the MP4"))).toBe(true);
  });

  it("645: every uncovered sentence is named with its text and the reasons its looks gave", () => {
    const { r } = report645();
    const f = Object.fromEntries(r.coverage.visualCoverageFailures.map((x) => [x.sentence, x]));
    expect(Object.keys(f).sort()).toEqual(["s0b0", "s0b3", "s1b0", "s1b1", "s2b0"]);
    expect(f.s0b0!.text).toContain("In 2008, Tesla built their first Roadster");
    expect(f.s0b0!.reasons).toEqual(expect.arrayContaining(["REJECTED_BY_EDITOR×9", "VISION_BUDGET_EXHAUSTED×2"]));
    expect(f.s1b1!.reasons).toEqual(expect.arrayContaining(["pre_judge:entity_evidence×4", "JUDGE_BUDGET_EXHAUSTED"]));
    expect(f.s2b0!.reasons).toEqual(expect.arrayContaining(["JUDGE_BUDGET_EXHAUSTED", "APPROVED_NOT_PLACED"]));
    for (const x of r.coverage.visualCoverageFailures) expect(x.reasons.length).toBeGreaterThan(0);
  });

  it("a content graphic as the sentence's picture counts as covered; a card does not; no card lines → placeholder unknown, not 0", () => {
    const a = analyseLogLines([
      "15:00:00.000 i [RenderLock] video=3 render=rE ACQUIRED",
      '15:00:01.000 i [SENTENCE_PICTURE] video=3 s0b0 footage=none picture=graphic:bar_chart "Revenue tripled."',
      '15:00:01.000 i [SENTENCE_PICTURE] video=3 s0b1 footage=none picture=none "A sentence nobody pictured."',
      "15:00:01.000 i [SENTENCE_PICTURE] video=3 s0b2 footage=4.00s clips=1 [youtube:ytAAAAAAAAA 4.00s] \"A factory.\"",
      "15:00:01.001 i [SENTENCE_PICTURE] video=3 TOTAL sentences=3 withFootage=1 withoutFootage=2",
      "15:00:02.000 i [RenderLock] video=3 render=rE RELEASED",
    ]);
    const r = a.reports[0]!;
    expect(r.coverage.sentenceVisualCoverage).toBe(66.7);
    expect(r.coverage.uncoveredSentenceCount).toBe(1);
    expect(r.coverage.visualCoverageFailures).toEqual([{ sentence: "s0b1", text: "A sentence nobody pictured.", reasons: ["no reason line found for this sentence"] }]);
    expect(r.coverage.blueGrayPlaceholderSeconds).toBeNull();
    expect(r.coverage.blueGrayBasis).toBe("unknown");
    expect(r.coverage.placeholderDetected).toBeNull();
    expect(r.coverage.deliveredFileCheck).toBeNull();
  });
});

/* ═══════════════════ the second-section route, counted from its own lines ═══════════════════ */

describe("second-section counters", () => {
  const lines = [
    "15:00:00.000 i [RenderLock] video=8 render=rF ACQUIRED",
    "15:00:01.000 i [YouTubeTunelio] video=vidA0000001 step=create http=200 ms=800 declared_bytes=100 quality=720p",
    "15:00:02.000 i [YouTubeDownload] video=vidA0000001 scene=-1 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=tunelio",
    "15:00:03.000 i [YouTubeDownload] video=vidB0000002 scene=-1 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=tunelio",
    "15:05:00.000 i [SecondSection] s1b1 video=vidA0000001 — another section of a video already downloaded (3_shots @150s; cuts this render 1/3; cut_ms=4200; no download)",
    "15:05:06.000 i [SecondSection] s1b1 video=vidA0000001 result=FIT moments=2 look_ms=5100 clip=scene_1_ytfu_late1m7_t512d40__pid_youtube_cc-abcdef.mp4",
    "15:05:10.000 i [SecondSection] s2b0 video=vidB0000002 — another section of a video already downloaded (no_room_in_source; cuts this render 2/3; cut_ms=3; no download)",
    "15:05:11.000 i [SecondSection] s2b0 video=vidA0000001 — another section of a video already downloaded (2_shots @190s; cuts this render 3/3; cut_ms=3900; no download)",
    "15:05:16.000 i [SecondSection] s2b0 video=vidA0000001 result=NO_FIT moments=2 look_ms=4800",
    "15:06:00.000 e [APPROVED_NOT_PLACED] s2b2 reason=approved after scene closed — not placed",
    '15:07:00.000 i [SENTENCE_PICTURE] video=8 s1b1 footage=4.00s clips=1 [youtube:vidA0000001 4.00s] "Inside the factory."',
    '15:07:00.000 i [SENTENCE_PICTURE] video=8 s2b0 footage=none picture=none "The market cap."',
    "15:07:00.001 i [SENTENCE_PICTURE] video=8 TOTAL sentences=2 withFootage=1 withoutFootage=1",
    "15:08:00.000 i [RenderLock] video=8 render=rF RELEASED",
  ];

  it("requested ≠ cut ≠ offered ≠ FIT ≠ placed: 3 attempts, 2 cuts ok, 1 failed (no room), 4 moments offered, 1 FIT, 1 no-fit round, 1 placed, 0 approved-not-placed, 0 extra downloads, 0 paid calls, 18.0 s", () => {
    const r = analyseLogLines(lines).reports[0]!;
    expect(r.secondSection).toEqual({
      active: true,
      secondSectionAttempts: 3,
      secondSectionCutsSucceeded: 2,
      secondSectionCutsFailed: 1,
      secondSectionCandidatesOffered: 4,
      secondSectionJudgeFitCount: 1,
      secondSectionJudgeMismatchCount: 1,
      secondSectionPlacedCount: 1,
      secondSectionApprovedNotPlacedCount: 0,
      secondSectionExtraDownloads: 0,
      secondSectionPaidTunelioRequests: 0,
      secondSectionProcessingSeconds: 18,
    });
  });

  it("the same lines re-sent (a duplicated log chunk) count once", () => {
    const r = analyseLogLines([...lines, ...lines.slice(4, 9)]).reports[0]!;
    expect(r.secondSection.secondSectionAttempts).toBe(3);
    expect(r.secondSection.secondSectionJudgeFitCount).toBe(1);
    expect(r.secondSection.secondSectionCandidatesOffered).toBe(4);
    expect(r.input.duplicateLinesDropped).toBe(5);
  });

  it("a FIT whose sentence ends without that video in its picture, and an APPROVED_NOT_PLACED for that sentence, is counted as approved-not-placed; a download or paid call for the video AFTER the attempt is counted as extra", () => {
    const r = analyseLogLines([
      ...lines.slice(0, 5),
      "15:05:06.000 i [SecondSection] s1b1 video=vidA0000001 result=FIT moments=1 look_ms=100",
      "15:05:30.000 e [APPROVED_NOT_PLACED] s1b1 reason=approved after scene closed — not placed",
      "15:05:40.000 i [YouTubeTunelio] video=vidA0000001 step=create http=200 ms=800 declared_bytes=100 quality=720p",
      "15:05:41.000 i [YouTubeDownload] video=vidA0000001 scene=1 status=DOWNLOAD_SUCCESS attempts=tunelio:DOWNLOAD_SUCCESS(100_bytes) cloudService=SET reason=tunelio",
      '15:07:00.000 i [SENTENCE_PICTURE] video=8 s1b1 footage=none picture=none "Inside the factory."',
      "15:08:00.000 i [RenderLock] video=8 render=rF RELEASED",
    ]).reports[0]!;
    expect(r.secondSection.secondSectionJudgeFitCount).toBe(1);
    expect(r.secondSection.secondSectionPlacedCount).toBe(0);
    expect(r.secondSection.secondSectionApprovedNotPlacedCount).toBe(1);
    expect(r.secondSection.secondSectionExtraDownloads).toBe(1);
    expect(r.secondSection.secondSectionPaidTunelioRequests).toBe(1);
  });

  it("645 is the baseline: the route was not in the deployed code (no [SecondSection] line) — active=false, every counter 0 with the note; a render with no lines at all stays null", () => {
    const { r } = report645();
    expect(r.secondSection.active).toBe(false);
    expect(r.secondSection.secondSectionAttempts).toBe(0);
    expect(r.secondSection.secondSectionJudgeFitCount).toBe(0);
    expect(r.secondSection.secondSectionPaidTunelioRequests).toBe(0);
    expect(r.notes.some((n) => n.includes("no [SecondSection] line in this render"))).toBe(true);
    const empty = analyseLogLines(["15:00:00.000 i [RenderLock] video=9 render=rB ACQUIRED", "15:00:05.000 i [RenderLock] video=9 render=rB RELEASED"]).reports[0]!;
    expect(empty.secondSection.active).toBeNull();
    expect(empty.secondSection.secondSectionAttempts).toBeNull();
  });

  it("the pipeline prints exactly these two lines per attempt, as measurement only, after the cut and after the look", () => {
    const vp = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const round = vp.slice(vp.indexOf("const secondSectionRound = async"), vp.indexOf("/** STEP 0 — every sentence queued"));
    expect(round).toContain("cut_ms=${Date.now() - cutStartedAt}; no download)");
    expect(round).toContain('result=${clip ? "FIT" : "NO_FIT"} moments=${moments.length} look_ms=${Date.now() - lookStartedAt}');
    expect(round).toContain("result=NO_MOMENT moments=0 look_ms=0");
    /** the guards and the single look are untouched */
    expect(round).toContain("if (tried >= lateVideosPerSentence || secondSectionsCut >= SECOND_SECTIONS_PER_RENDER) break;");
    expect((round.match(/await finalReadyYoutubeLook\(/g) ?? []).length).toBe(1);
    expect((round.match(/await second\.cut\(id\)/g) ?? []).length).toBe(1);
  });
});
