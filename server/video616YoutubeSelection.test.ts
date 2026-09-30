/**
 * Video 616, round two — the four remaining YouTube repairs, and the three from 76697f4 beside them.
 *
 *   1  the thumbnail triage asks what the video SHOWS: commentary and caption-dressed edits are not
 *      footage, a real interview or archival film still is — same categories, same `judge`
 *   2  a black fragment gets ONE other window of the same video; on-screen text gets none
 *   3  the length the pool measured is used first; RapidAPI and YTContext only when it is unknown
 *   4  an archive clip of YouTube origin is reported as YouTube, also on a timeline that was refused
 *
 * No test reaches the network: `node-fetch` and the global `fetch` answer from this file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

vi.hoisted(() => {
  /** Module-level in videoPipeline.ts, so it is set before the import — as the f341 test does. */
  process.env.RAPIDAPI_KEY = "v616b-test-rapidapi-key";
});
const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import {
  fetchYouTubeCCClips,
  resetYoutubeFragmentsFetched,
  alternativeYoutubeStartSec,
  youtubeFragmentKeyFor,
  capYoutubeClipDurationForTest,
  YOUTUBE_ALT_START_MIN_GAP_SEC,
  setYoutubeLengthLookupForTests,
} from "./videoPipeline";
import { pickLongVideoStartSec } from "./beatSegmentChoice";
import { noteYoutubeFragmentRefusal, youtubeFragmentRefusal, resetPermanentDownloadRefusals } from "./providerFailureClass";
import {
  buildVideoYoutubePool,
  poolRowsForBeat,
  registerVideoYoutubePool,
  releaseVideoYoutubePool,
  search2Reasons,
  type PoolDeps,
  type PoolCandidate,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import { youtubeTriagePrompt } from "./youtubeVideoPoolProduction";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import type { GateVerdict } from "./youtubeVideoSearchPlanner";
import { runWithActiveVideoId } from "./videoGenerationCancel";
import { formatYoutubeFootage, youtubeFootageInTimeline } from "./youtubeFootageInFilm";
import { finalTimelineFootageRefusal, type FinalTimelineClip } from "./deliveredScreenTime";
import { deliveryGate } from "./deliveryGate";
import type { TimelineVideoClip } from "./projectTimeline";

process.env.SEARCH_GATE_STRICT = "false";
const ORIGINAL_ENV = { ...process.env };
const silent = () => {};
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ FIX 1 — the triage asks what the video shows ═══════════════════════ */

describe("Fix 1. the thumbnail triage separates footage OF the subject from videos ABOUT it", () => {
  const beats = ["Kris Jenner turned her family into a media empire.", "Kim Kardashian built a skincare fortune."];
  const prompt = youtubeTriagePrompt(
    { title: "How the Kardashians Made Their BILLIONS: The UNTOLD story!", channel: "Explained", description: "the untold story" },
    "The Kardashian Empire",
    beats
  );

  it("a thumbnail with the right face is no longer taken as real footage", () => {
    expect(prompt).not.toContain("judge the underlying footage");
    expect(prompt).toContain("Judge what the VIDEO ITSELF shows on screen for most of its running time");
    expect(prompt).toContain("A thumbnail with the right face proves nothing");
  });

  it("commentary and explainer are talking_head; captions, logos and listicles are text_or_graphic", () => {
    expect(prompt).toMatch(/talking_head: someone ELSE talking ABOUT the subject — a presenter, commentator, YouTuber, podcast, reaction, explainer/);
    expect(prompt).toMatch(/text_or_graphic: listicles and top-10s, compilations dressed in large captions or burnt-in subtitles/);
    expect(prompt).toContain("logos or channel branding over the picture");
    expect(prompt).toContain("clickbait titles");
  });

  it("a real interview WITH the subject, events and archival film stay footage", () => {
    expect(prompt).toContain("An interview WITH the subject is real_footage, not talking_head.");
    expect(prompt).toMatch(/real_footage: filmed real-world scenes OF the subject — events, appearances, red carpets, press conferences, paparazzi, TV or press interviews/);
    expect(prompt).toContain("archival_footage: historical film or photographs of the subject.");
  });

  it("the prompt carries the result's own words and every beat; the production triage uses it", () => {
    expect(prompt).toContain('"How the Kardashians Made Their BILLIONS: The UNTOLD story!" (channel: Explained)');
    expect(prompt).toContain("Description: the untold story");
    expect(prompt).toContain("[1] Kim Kardashian built a skincare fortune.");
    const PROD = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(PROD).toContain("text: youtubeTriagePrompt(item, title, sentences),");
    /** Same six categories, same schema. */
    expect(PROD).toContain('enum: ["real_footage", "archival_footage", "talking_head", "text_or_graphic", "animation_or_game", "other"]');
  });
});

/* A pool whose triage answers per video, as the model would for these five kinds of result. */
const input = {
  videoId: 9616,
  prompt: "How Kris Jenner built the Kardashian empire",
  title: "The Kardashian Empire",
  sceneTexts: [
    "Kris Jenner turned her family into a media empire in Los Angeles.",
    "Kim Kardashian and Kris Jenner built the Kardashian brand in Calabasas.",
  ],
};
const allow = (): GateVerdict => ({ ok: true });
function poolDeps(results: Array<{ id: string; type: Triage["footageType"] }>): PoolDeps & { searches: string[] } {
  const searches: string[] = [];
  let q = 0;
  return {
    searches,
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Kris Jenner", recurringSubjects: [], query: ++q === 1 ? "Kris Jenner Kardashian Los Angeles" : "Kim Kardashian Calabasas" }) } }],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      const list = searches.length === 1 ? results : results.map((r, i) => ({ id: `Z${String(i).padStart(10, "0")}`, type: "real_footage" as const }));
      return { status: 200, items: list.map((r) => ({ videoId: r.id, title: r.id, description: "", channel: "c", thumb: "t" })) };
    },
    details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 480, embeddable: true, live: false }])),
    triage: async (it: SearchItem): Promise<Triage> => {
      const type = results.find((r) => r.id === it.videoId)?.type ?? "real_footage";
      return { footageType: type, servesBeats: [0, 1], depicts: "" };
    },
    archive: async () => [],
    notFootage: () => null,
    log: silent,
  };
}
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(10, "0")}`.slice(0, 11));

describe("Fix 1. the same `judge` and the same thresholds decide", () => {
  it("commentary and caption-heavy results are not usable; a real interview and archival film are", async () => {
    const d = poolDeps([
      { id: "commentary1", type: "talking_head" },
      { id: "listicle001", type: "text_or_graphic" },
      { id: "interview01", type: "real_footage" },
      { id: "archival001", type: "archival_footage" },
      ...ids("R", 6).map((id) => ({ id, type: "real_footage" as const })),
    ]);
    const pool = await buildVideoYoutubePool(d, input);
    const by = (id: string) => pool.candidates.find((c) => c.videoId === id)!;
    expect(by("commentary1").usable).toBe(false);
    expect(by("commentary1").why).toBe("footage type talking_head");
    expect(by("listicle001").usable).toBe(false);
    expect(by("listicle001").why).toBe("footage type text_or_graphic");
    expect(by("interview01").usable).toBe(true);
    expect(by("archival001").usable).toBe(true);
    /** 8 usable ≥ max(6, beats/2): the triage change alone asks for no second search. */
    expect(pool.search2Needed).toBe(false);
    expect(d.searches).toHaveLength(1);
  });

  it("when the triage leaves too little usable, the EXISTING threshold asks for search #2 — once", async () => {
    const d = poolDeps([
      ...ids("C", 8).map((id) => ({ id, type: "talking_head" as const })),
      ...ids("R", 3).map((id) => ({ id, type: "real_footage" as const })),
    ]);
    const pool = await buildVideoYoutubePool(d, input);
    expect(pool.search2Reason).toContain("usable candidates");
    expect(d.searches).toHaveLength(2);
    expect(pool.searches).toBe(2);
  });

  it("the existing thresholds are unchanged", () => {
    const c = (id: string, serves: number[]): PoolCandidate =>
      ({ videoId: id, title: "", description: "", thumb: "", durationSec: 60, footageType: "real_footage", serves, from: 1, usable: true, why: "ok" });
    const sentences = Array.from({ length: 12 }, (_, i) => `s${i}`);
    expect(search2Reasons({ sentences, candidates: Array.from({ length: 6 }, (_, i) => c(`v${i}`, [i])) })).toEqual([]);
    expect(search2Reasons({ sentences, candidates: Array.from({ length: 5 }, (_, i) => c(`v${i}`, [i, i + 5])) })[0]).toContain("usable candidates 5 < max(6, beats/2)=6");
  });
});

/* ═══════════════════════ FIX 2 + FIX 3 — driven through the real fetch loop, in pool mode ═══════════════════════ */

describe("Fix 2/3. one other window after a black fragment; the pool's length first", () => {
  let workDir: string;
  let source: string;
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v616b-"));
    source = path.join(workDir, "source.mp4");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "8",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", source,
    ], { stdio: "ignore" });
  });
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const RENDER = 96161;
  const A = "AAAAAAAAAAA";
  const B = "BBBBBBBBBBB";
  const LENGTH = 600;
  const pool = (withLength: boolean): VideoYoutubePool => ({
    videoId: RENDER,
    sentences: ["steam locomotive crossing a bridge"],
    query1: "steam locomotive",
    query2: null,
    searches: 1,
    candidates: [A, B].map((id, i) => ({
      videoId: id, title: `Steam locomotive film ${i}`, description: "steam locomotive", thumb: "",
      durationSec: withLength ? LENGTH : 0, footageType: "real_footage" as const, serves: [0], from: 1 as const, usable: true, why: "ok",
    })),
    coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "v616b-test-key";
    /** VIDEO 624 — the download's Shorts check reads a length; these are long films. */
    setYoutubeLengthLookupForTests(async () => LENGTH);
    process.env.YOUTUBE_CC_DL_SERVICE = "https://v616b-cloud.example.com";
    process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
    delete process.env.YOUTUBE_SEARCH_MODE;
    resetPermanentDownloadRefusals();
    /** VIDEO 622 — a new render starts with no seconds fetched, as the pipeline does. */
    resetYoutubeFragmentsFetched();
    nodeFetchMock.mockReset();
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://v616b-cloud.example.com/download")) {
        return Promise.resolve({ ok: true, status: 200, body: fs.createReadStream(source) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    setYoutubeLengthLookupForTests(null);
    releaseVideoYoutubePool(RENDER);
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  const downloads = () =>
    nodeFetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.startsWith("https://v616b-cloud.example.com/download"))
      .map((u) => ({ id: new URL(u).searchParams.get("id"), start: Number(new URL(u).searchParams.get("start")) }));
  const rapidApiMetaCalls = () => nodeFetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/dl?id="));
  const fetchInPool = async (withLength: boolean, count = 1) => {
    registerVideoYoutubePool(RENDER, Promise.resolve(pool(withLength)));
    return runWithActiveVideoId(RENDER, () => fetchYouTubeCCClips("steam locomotive", 6, workDir, 0, count, [], 1, ""));
  };
  /** The key of a video's first window, for every duration a licence pass can ask for. */
  const refuseFirstWindow = (id: string, reason: string) => {
    for (const tag of ["ytfu", "ytcc", "ytstd"]) {
      const take = capYoutubeClipDurationForTest(6, tag);
      noteYoutubeFragmentRefusal(youtubeFragmentKeyFor(id, pickLongVideoStartSec(LENGTH, take, id), take), reason);
    }
  };

  it("Fix 3 — the pool's length is used: no RapidAPI metadata request, the start scales with it", async () => {
    await fetchInPool(true);
    expect(rapidApiMetaCalls()).toEqual([]);
    const first = downloads()[0]!;
    expect(first.id).toBe(A);
    /** 15 s is the no-length start; with the pool's 600 s it is the long-video start. */
    expect(first.start).not.toBe(15);
    expect(first.start).toBeGreaterThan(15);
  });

  /** VIDEO 619 — RapidAPI is switched off: without a pool length nothing is asked, and 15s is the start. */
  it("Fix 3 — without a pool length RapidAPI is not asked any more; the start falls back to 15s", async () => {
    await fetchInPool(false);
    expect(rapidApiMetaCalls()).toHaveLength(0);
    expect(downloads()[0]!.start).toBe(15);
  });

  it("Fix 2 — a black first window: the same video's other window is downloaded instead", async () => {
    refuseFirstWindow(A, "mostly_black");
    await fetchInPool(true);
    const got = downloads();
    expect(got[0]!.id).toBe(A);
    const firsts = ["ytfu", "ytcc", "ytstd"].map((t) => pickLongVideoStartSec(LENGTH, capYoutubeClipDurationForTest(6, t), A));
    expect(firsts.every((f) => Math.abs(got[0]!.start - f) >= YOUTUBE_ALT_START_MIN_GAP_SEC)).toBe(true);
  });

  it("Fix 2 — on-screen text: no other window; the next candidate is tried", async () => {
    refuseFirstWindow(A, "baked_edit_text_before_vision");
    await fetchInPool(true);
    expect(downloads().map((d) => d.id)).toEqual([B]);
  });

  it("Fix 2 — never a third window: both windows black → the next candidate", async () => {
    refuseFirstWindow(A, "mostly_black");
    for (const tag of ["ytfu", "ytcc", "ytstd"]) {
      const take = capYoutubeClipDurationForTest(6, tag);
      const firstStart = pickLongVideoStartSec(LENGTH, take, A);
      noteYoutubeFragmentRefusal(youtubeFragmentKeyFor(A, alternativeYoutubeStartSec(A, LENGTH, take, firstStart)!, take), "mostly_black");
    }
    await fetchInPool(true);
    expect(downloads().map((d) => d.id)).toEqual([B]);
  });

  it("Fix 2 — the other window is a normal attempt: a turn still starts at most `count` downloads", async () => {
    refuseFirstWindow(A, "mostly_black");
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("https://v616b-cloud.example.com/download")) {
        return Promise.resolve({ ok: false, status: 502, text: async () => "ERROR: Video unavailable" });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
    });
    await fetchInPool(true, 1);
    expect(downloads()).toHaveLength(1);
  });
});

describe("Fix 2. the other window, as a rule", () => {
  it("differs from the refused start by at least 30 s, from the same start rule", () => {
    for (const id of ["c_d8DhDgPwg", "FehVtsAqSoI", "8-A-im-zfaU", "vobKopmCMAc"]) {
      const first = pickLongVideoStartSec(537, 5, id);
      const alt = alternativeYoutubeStartSec(id, 537, 5, first)!;
      expect(alt).not.toBeNull();
      expect(Math.abs(alt - first)).toBeGreaterThanOrEqual(YOUTUBE_ALT_START_MIN_GAP_SEC);
      expect(alt).toBeGreaterThanOrEqual(0);
      expect(alt).toBeLessThanOrEqual(537 - 5);
    }
  });

  it("no length, or no room for a second window: none", () => {
    expect(alternativeYoutubeStartSec("x", 0, 5, 10)).toBeNull();
    expect(alternativeYoutubeStartSec("x", 5, 5, 0)).toBeNull();
    /** 40 s of video, 5 s taken: a window 30 s away from 5 s still fits. */
    expect(alternativeYoutubeStartSec("x", 40, 5, 5)).not.toBeNull();
    /** 20 s of video: nothing is 30 s away. */
    expect(alternativeYoutubeStartSec("x", 20, 5, 7)).toBeNull();
  });

  it("the refusal memory stays per fragment: the other window's key is its own", () => {
    resetPermanentDownloadRefusals();
    /** VIDEO 622 — a new render starts with no seconds fetched, as the pipeline does. */
    resetYoutubeFragmentsFetched();
    const first = pickLongVideoStartSec(537, 5, "c_d8DhDgPwg");
    const alt = alternativeYoutubeStartSec("c_d8DhDgPwg", 537, 5, first)!;
    noteYoutubeFragmentRefusal(youtubeFragmentKeyFor("c_d8DhDgPwg", first, 5), "mostly_black");
    expect(youtubeFragmentRefusal(youtubeFragmentKeyFor("c_d8DhDgPwg", first, 5))).toBe("mostly_black");
    expect(youtubeFragmentRefusal(youtubeFragmentKeyFor("c_d8DhDgPwg", alt, 5))).toBeNull();
  });

  it("only a black refusal opens the other window, in the loop itself", () => {
    expect(PIPE).toMatch(/if \(fragmentRefused === "mostly_black"\) \{\s*const altStart = alternativeYoutubeStartSec\(videoId, sourceDurationSec, clipDur, clipStart\);/);
  });
});

/* ═══════════════════════ FIX 4 — YouTube origin is reported as YouTube ═══════════════════════ */

describe("Fix 4. an archive clip of YouTube origin is reported as YouTube, delivered or refused", () => {
  const clip = (id: string, start: number, end: number, source: TimelineVideoClip["source"]): TimelineVideoClip =>
    ({ id, timelineStart: start, timelineEnd: end, source }) as unknown as TimelineVideoClip;
  const origins = new Map([
    [58019, { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=gx1T7-L8kns&t=50s" }],
    [70001, { sourcePlatform: "wikimedia", sourceUrl: "https://commons.wikimedia.org/x" }],
  ]);

  it("a fresh YouTube clip is direct, an archive clip of YouTube origin is via archive, an archive-only clip is neither", () => {
    const f = youtubeFootageInTimeline(
      [
        clip("fresh", 0, 5, { provider: "youtube_cc", providerAssetId: "abcdefghijk" } as TimelineVideoClip["source"]),
        clip("arch", 5, 10, { provider: "youtube", providerAssetId: "58019", archiveAssetId: 58019 } as TimelineVideoClip["source"]),
        clip("wiki", 10, 15, { provider: "archive", providerAssetId: "70001", archiveAssetId: 70001 } as TimelineVideoClip["source"]),
      ],
      origins,
      "rendered_timeline"
    );
    expect(f.clips.map((c) => [c.clipId, c.origin])).toEqual([["fresh", "youtube_direct"], ["arch", "youtube_via_archive"]]);
    expect(f.youtubeSec).toBe(10);
    expect(f.videoIds.sort()).toEqual(["abcdefghijk", "gx1T7-L8kns"]);
  });

  it("video 616's refused timeline: 21 pieces of the archive clip read as 100% YouTube, marked NOT DELIVERED", () => {
    const pieces = Array.from({ length: 21 }, (_, i) =>
      clip(`vc_p${i}`, (75.78 / 21) * i, (75.78 / 21) * (i + 1), { provider: "youtube", providerAssetId: "58019", archiveAssetId: 58019 } as TimelineVideoClip["source"])
    );
    const f = youtubeFootageInTimeline(pieces, origins, "planned_timeline");
    const line = formatYoutubeFootage(616, f, { found: 7, downloaded: 4, adopted: 0 }, { delivered: false });
    expect(line).toContain("basis=planned_timeline");
    expect(line).toContain("share=100%");
    expect(line).toContain("viaArchive=75.78s");
    expect(line).toContain("videos=gx1T7-L8kns");
    expect(line).toContain("adopted=0 adoptedViaArchive=1");
    expect(line).toContain("NOT DELIVERED (measured on the refused timeline)");
  });

  it("a delivered film's line is unchanged apart from the via-archive count", () => {
    const f = youtubeFootageInTimeline(
      [clip("fresh", 0, 5, { provider: "youtube_cc", providerAssetId: "abcdefghijk" } as TimelineVideoClip["source"])],
      origins,
      "rendered_timeline"
    );
    const line = formatYoutubeFootage(1, f, { found: 1, downloaded: 1, adopted: 1 }, { delivered: true });
    expect(line).toBe("[YouTubeInFilm] video=1 basis=rendered_timeline youtubeSec=5 filmSec=5 share=100% direct=5s viaArchive=0s videos=abcdefghijk found=1 downloaded=1 adopted=1");
  });

  it("reporting only: the requirement and timelineClips still describe the delivered film", () => {
    expect(PIPE).toContain("youtubeFootageVerdict = judgeYoutubeRequirement(delivered ? footage : unmeasuredFootage(), requiredYoutubeSeconds());");
    expect(PIPE).toContain("timelineClips: delivered ? footage.clips.length : 0,");
    expect(PIPE).toContain("if (outcome.ok) refusedTimelineClips = videoTrack(outcome.timeline);");
  });

  it("ONE_FOOTAGE_FILLS_FILM still refuses that timeline", () => {
    const pieces: FinalTimelineClip[] = Array.from({ length: 21 }, (_, i) => ({
      id: `vc_p${i}`, timelineStart: (75.78 / 21) * i, timelineEnd: (75.78 / 21) * (i + 1),
      source: { provider: "youtube", providerAssetId: "58019", archiveAssetId: 58019 },
    }));
    const refusal = finalTimelineFootageRefusal(pieces, undefined, new Map([[58019, "gx1T7-L8kns"]]));
    expect(refusal).toContain("youtube:gx1T7-L8kns");
    const verdict = deliveryGate({ videoId: 616, route: "cinematic_timeline", timelineExists: true, clips: [], delivered: null, assetsOnly: true, footageRefusal: refusal });
    expect(verdict.allow === false && verdict.failures.map((x) => x.code)).toContain("ONE_FOOTAGE_FILLS_FILM");
  });
});

/* ═══════════════════════ the pool row carries the length (Fix 3, unit) ═══════════════════════ */

describe("Fix 3. the pool row carries the length the pool measured", () => {
  it("poolRowsForBeat hands on durationSec; an unmeasured candidate hands on 0", () => {
    const p: VideoYoutubePool = {
      videoId: 1, sentences: ["steam locomotive"], query1: "q", query2: null, searches: 1,
      candidates: [
        { videoId: "AAAAAAAAAAA", title: "steam locomotive", description: "", thumb: "", durationSec: 537, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" },
        { videoId: "BBBBBBBBBBB", title: "steam locomotive", description: "", thumb: "", durationSec: 0, footageType: "real_footage", serves: [0], from: 0, usable: true, why: "ok" },
      ],
      coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
    };
    const rows = poolRowsForBeat(p, "steam locomotive", []);
    expect(rows.map((r) => [r.item.id.videoId, r.durationSec])).toEqual([["AAAAAAAAAAA", 537], ["BBBBBBBBBBB", 0]]);
  });
});

/* ═══════════════════════ the combined scenario: A black, B text, C commentary, D footage, E interview ═══════════════════════ */

describe("Scenario. A black · B baked text · C commentary · D real footage · E real interview", () => {
  let workDir: string;
  let source: string;
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v616c-"));
    source = path.join(workDir, "source.mp4");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "8",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", source,
    ], { stdio: "ignore" });
  });
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));
  afterEach(() => {
    releaseVideoYoutubePool(input.videoId);
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  const A = "videoAblack", B = "videoBtext0", C = "videoCcomm0", D = "videoDreal0", E = "videoEintvw";

  it("C never enters the pool; A gets its other window; B is not retried; D and E are what the beats download", async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "v616c-test-key";
    process.env.YOUTUBE_CC_DL_SERVICE = "https://v616c-cloud.example.com";
    process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
    delete process.env.YOUTUBE_SEARCH_MODE;
    resetPermanentDownloadRefusals();
    /** VIDEO 622 — a new render starts with no seconds fetched, as the pipeline does. */
    resetYoutubeFragmentsFetched();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    nodeFetchMock.mockReset();
    nodeFetchMock.mockImplementation((url: string) =>
      String(url).startsWith("https://v616c-cloud.example.com/download")
        ? Promise.resolve({ ok: true, status: 200, body: fs.createReadStream(source) })
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" })
    );

    /** The triage as the sharpened prompt asks it to answer: C is commentary; D and E are footage. */
    const d = poolDeps([
      { id: A, type: "real_footage" },
      { id: B, type: "real_footage" },
      { id: C, type: "talking_head" },
      { id: D, type: "real_footage" },
      { id: E, type: "real_footage" },
      ...ids("R", 4).map((id) => ({ id, type: "real_footage" as const })),
    ]);
    const pool = await buildVideoYoutubePool(d, input);
    expect(pool.candidates.find((c) => c.videoId === C)!.usable).toBe(false);
    expect(poolRowsForBeat(pool, input.sceneTexts[0]!, []).map((r) => r.item.id.videoId)).not.toContain(C);

    /** Earlier this render: A's first window was black, B's first window carried burnt-in text. */
    for (const tag of ["ytfu", "ytcc", "ytstd"]) {
      const take = capYoutubeClipDurationForTest(6, tag);
      noteYoutubeFragmentRefusal(youtubeFragmentKeyFor(A, pickLongVideoStartSec(480, take, A), take), "mostly_black");
      noteYoutubeFragmentRefusal(youtubeFragmentKeyFor(B, pickLongVideoStartSec(480, take, B), take), "baked_edit_text_before_vision");
    }

    registerVideoYoutubePool(input.videoId, Promise.resolve(pool));
    await runWithActiveVideoId(input.videoId, () => fetchYouTubeCCClips("Kris Jenner", 6, workDir, 0, 2, [], 1, ""));
    const got = nodeFetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.startsWith("https://v616c-cloud.example.com/download"))
      .map((u) => ({ id: new URL(u).searchParams.get("id")!, start: Number(new URL(u).searchParams.get("start")) }));
    /** Two downloads — the turn's limit — and neither is B's refused window or C. */
    expect(got).toHaveLength(2);
    expect(got.map((g) => g.id)).not.toContain(B);
    expect(got.map((g) => g.id)).not.toContain(C);
    /** A, if it is reached, is fetched at its OTHER window, never at the black one. */
    for (const g of got.filter((x) => x.id === A)) {
      for (const tag of ["ytfu", "ytcc", "ytstd"]) {
        expect(g.start).not.toBe(pickLongVideoStartSec(480, capYoutubeClipDurationForTest(6, tag), A));
      }
    }
    /** No length was asked of RapidAPI: the pool had it. */
    expect(nodeFetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/dl?id="))).toEqual([]);
  });
});
