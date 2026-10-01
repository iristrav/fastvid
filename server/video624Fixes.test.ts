/**
 * VIDEO 624 — what the logs of the first render after the neutral rules showed.
 *
 *   1  tnBQmEqBCY0 came from the archive without a title. The clip downloaded, reached the beat,
 *      and was refused for `entity_evidence`: the person check had no text to read. YouTube's own
 *      title was in the videos.list answer the pool already asked for.
 *   2  "Uncover Musk's tales…" gave the capital-letter reader a person called "Uncover Musk", and
 *      "Uncover Musk" went to Unsplash, archive.org, Pexels and Pixabay. The render's reading of the
 *      narration had named one person, Elon Musk. Every capitalised name is now read against it.
 *   3  "Er mogen nooit shorts gedownload worden." Every download asks, before a byte moves, whether
 *      the video may be a Short; the file that arrives is refused when it stands upright.
 *   4  A 3.4 s archive shot held for 24 s was cut into pieces whose in-points ran past the end of
 *      the file: frozen frames, and picture changes inside shots at those moments. No piece runs
 *      past its source now, and a sentence that found nothing is filled from the own archive.
 *   5  The reports contradicted the film: "no clips adopted", "rendered=6 exceeds assigned=0",
 *      "never judged" for an approved clip, "adopted without judgement" for judged pictures, and
 *      a screen time of 28.8 s for a 64 s film.
 *   6  The made video carries no text (video 619): its captions and graphics are switched off for
 *      the editor. The feature matrix called that `graphics EXECUTED_WITHOUT_PLAN`.
 *   7  Retrieval was measured against 165 s while the pipeline's own picture deadline was 180 s
 *      plus up to 60 s for a scene that found nothing: "OVER +1m" on a stage inside every limit.
 *   8  Look ahead for every sentence; first look, then download; archive each download once.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { buildVideoYoutubePool, withYoutubeOwnText, type PoolDeps, type SearchItem } from "./youtubeVideoPool";
import { createLookaheadRegistry } from "./youtubeLookahead";
import { poolRowsForBeat, type VideoYoutubePool } from "./youtubeVideoPool";
import {
  YOUTUBE_LOOKAHEAD_PARALLEL,
  youtubeRowsWithoutNonFootage,
  EMPTY_SCENE_RESCUE_MIN_MS,
  extractBeatRealEntities,
  personAsRead,
  setRenderPeopleReadingForTests,
  visualDeadlineForVideoMs,
  youtubeShortAtTheDoor,
} from "./videoPipeline";
import { judgeAcquiredFile } from "./youtubeAcquisitionValidation";
import { limitLongShots } from "./longShotLimit";
import { buildRenderFeatureMatrix, featureMatrixViolations, type RenderFeatureFacts } from "./renderContract";
import { createBeatShortlistState, formatBeatShortlists, noteJudgedAtPush, noteNotAsked, beatFunnel } from "./beatShortlist";
import type { TimelineVideoClip } from "./projectTimeline";

const TITLE = "How Elon Musk shapes the news";
const input = {
  videoId: 624_001,
  prompt: TITLE,
  title: TITLE,
  sceneTexts: ["Elon Musk posts, and the papers follow.", "Uncover Musk's tales and you find a strategy."],
};

describe("1. an archive item carries YouTube's own title", () => {
  const archived = (videoId: string, title: string): SearchItem => ({ videoId, title, description: "", channel: "archive", thumb: "t" });
  const own = { durationSec: 600, embeddable: true, live: false, title: "Elon Musk at the AI meeting", description: "Full speech", channel: "News Channel" };

  it("an empty or placeholder title is filled; a real one is kept", () => {
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", ""), own).title).toBe("Elon Musk at the AI meeting");
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", "YouTube tnBQmEqBCY0"), own).title).toBe("Elon Musk at the AI meeting");
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", "Stored title"), own).title).toBe("Stored title");
    const filled = withYoutubeOwnText(archived("tnBQmEqBCY0", ""), own);
    expect(filled.description).toBe("Full speech");
    expect(filled.channel).toBe("News Channel");
    /** Without an answer from YouTube the item is what it was. */
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", ""), null).title).toBe("");
  });

  it("the pool's candidate from the archive carries the title the beat's person check reads", async () => {
    const deps: PoolDeps = {
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Elon Musk", recurringSubjects: [], query: "Elon Musk" }) } }] }),
      gate: () => ({ ok: true }),
      search: async () => ({ status: 200, items: [] }),
      details: async (ids) => new Map(ids.map((id) => [id, own])),
      triage: async () => ({ footageType: "real_footage", servesBeats: [0], depicts: "" }),
      archive: async () => [archived("tnBQmEqBCY0", "")],
      log: () => {},
    };
    const pool = await buildVideoYoutubePool(deps, input);
    const c = pool.candidates.find((x) => x.videoId === "tnBQmEqBCY0");
    expect(c?.title).toBe("Elon Musk at the AI meeting");
    expect(c?.description).toBe("Full speech");
  });

  it("the production videos.list keeps the snippet's title, description and channel", () => {
    const src = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(src).toContain('url.searchParams.set("part", "contentDetails,status,snippet")');
    expect(src).toMatch(/title: v\.snippet\?\.title/);
    expect(src).toMatch(/description: v\.snippet\?\.description/);
    expect(src).toMatch(/channel: v\.snippet\?\.channelTitle/);
  });
});

describe("2. a capitalised name is the person the reading names", () => {
  afterEach(() => setRenderPeopleReadingForTests(null));

  it("a word shared with one read person is that person; none shared is no person", () => {
    setRenderPeopleReadingForTests(["Elon Musk"]);
    expect(personAsRead("Uncover Musk")).toBe("Elon Musk");
    expect(personAsRead("Musk's")).toBe("Elon Musk");
    expect(personAsRead("elon musk")).toBe("Elon Musk");
    expect(personAsRead("Palo Alto")).toBeNull();
  });

  it("the same for any name, and two people sharing a word stay a person", () => {
    setRenderPeopleReadingForTests(["Marie Curie", "Pierre Curie"]);
    expect(personAsRead("Marie Curie")).toBe("Marie Curie");
    expect(personAsRead("Discover Curie")).toBe("Discover Curie");
    expect(personAsRead("Sorbonne")).toBeNull();
    setRenderPeopleReadingForTests(["Frida Kahlo"]);
    expect(personAsRead("Meet Kahlo")).toBe("Frida Kahlo");
  });

  it("without a reading nothing changes", () => {
    setRenderPeopleReadingForTests(null);
    expect(personAsRead("Uncover Musk")).toBeUndefined();
  });

  it("no rule for a person called 'Uncover Musk', and 'Our Musk' is not a thing called Musk", () => {
    setRenderPeopleReadingForTests(["Elon Musk"]);
    const of = (t: string) => extractBeatRealEntities(t).map((r) => `${r.kind}:${r.stockQueries[0]}`);
    expect(of("Uncover Musk's tales of war.")).toEqual([]);
    expect(of("Our Musk is a myth.")).toEqual([]);
    expect(of("Elon Musk tweets. Uncover Musk himself.")).toEqual(["person:Elon Musk"]);
    expect(of("In 1976 Steve Jobs founded a company in Palo Alto.")).not.toContain("person:Palo Alto");
  });

  it("the scene's persons are read the same way", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const body = src.slice(src.indexOf("function resolveScenePersons("), src.indexOf("function resolveScenePersons(") + 1400);
    expect(body).toContain("personAsRead(name)");
    expect(body).toMatch(/if \(read === null\) continue;/);
  });
});

describe("3. never a Short", () => {
  const KEY = process.env.YOUTUBE_API_KEY;
  afterEach(() => {
    if (KEY === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = KEY;
  });
  const long = async () => 600;

  it("a hashtag, three minutes or less, or an unknown length: not downloaded", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    expect(await youtubeShortAtTheDoor("aaaaaaaaaaa", "Crazy moment #shorts", long)).toMatch(/hashtag/);
    expect(await youtubeShortAtTheDoor("bbbbbbbbbbb", "A clip", async () => 45)).toMatch(/Short length/);
    expect(await youtubeShortAtTheDoor("ccccccccccc", "A clip", async () => 180)).toMatch(/Short length/);
    expect(await youtubeShortAtTheDoor("ddddddddddd", "A clip", async () => 0)).toMatch(/length unknown/);
    expect(await youtubeShortAtTheDoor("eeeeeeeeeee", "A clip", async () => { throw new Error("quota"); })).toMatch(/length unknown/);
    expect(await youtubeShortAtTheDoor("fffffffffff", "A full documentary", long)).toBeNull();
  });

  it("an upright file is refused whatever its title and length said", () => {
    const v = judgeAcquiredFile({ meta: { width: 1080, height: 1920, durationSec: 6 }, requestedSec: 6, frameDecoded: true });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe("VERTICAL_SHORT");
    expect(judgeAcquiredFile({ meta: { width: 1920, height: 1080, durationSec: 6 }, requestedSec: 6, frameDecoded: true }).ok).toBe(true);
  });

  it("the check stands at the one door every YouTube download passes, before the transfer", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const fn = src.indexOf("export async function downloadYouTubeCCClip(");
    const door = src.indexOf("const shortAtTheDoor = await youtubeShortAtTheDoor(videoId, title);", fn);
    const transfer = src.indexOf("const cloudVerdict =", fn);
    expect(fn).toBeGreaterThan(0);
    expect(door).toBeGreaterThan(fn);
    expect(transfer).toBeGreaterThan(door);
    /** The background fetch downloads through the same function. */
    expect(fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8")).toContain("pipeline.downloadYouTubeCCClip(");
    /** The pool's measured lengths feed the same memory, so the door costs no extra request for them. */
    expect(fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8")).toContain("rememberYoutubeVideoDurationSec(v.id");
  });
});

describe("4. no piece runs past its source; an empty sentence is filled", () => {
  const clip = (id: string, start: number, end: number, sourceIn: number, sourceOut: number): TimelineVideoClip =>
    ({
      id, kind: "video", source: { provider: "archive", archiveAssetId: 58089 },
      sourceIn, sourceOut, timelineStart: start, timelineEnd: end,
      motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", sceneIndex: 1,
    }) as TimelineVideoClip;

  it("video 624: 3.4 s of source held for 24 s — every piece lies inside those 3.4 s", () => {
    const { clips } = limitLongShots({ clips: [clip("vc_38d6214afb", 23.95, 47.99, 0, 3.4)] });
    expect(clips.length).toBeGreaterThanOrEqual(Math.ceil(24.04 / 3.4));
    for (const c of clips) {
      expect(c.sourceIn!).toBeGreaterThanOrEqual(0);
      expect(c.sourceOut!).toBeLessThanOrEqual(3.4 + 0.001);
      expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(3.4 + 0.001);
      expect(c.camera).toBeTruthy();
    }
    expect(clips[0]!.timelineStart).toBe(23.95);
    expect(clips.at(-1)!.timelineEnd).toBe(47.99);
    for (let i = 1; i < clips.length; i++) expect(clips[i]!.timelineStart).toBe(clips[i - 1]!.timelineEnd);
  });

  it("a shot under six seconds is still cut when it outlasts its source", () => {
    const { clips } = limitLongShots({ clips: [clip("vc_58470", 4.97, 11.51, 0, 4)] });
    expect(clips.length).toBe(2);
    for (const c of clips) expect(c.sourceOut!).toBeLessThanOrEqual(4 + 0.001);
  });

  it("a shot whose source covers it is untouched", () => {
    const input = [clip("fits", 0, 5, 1, 6)];
    expect(limitLongShots({ clips: input }).clips).toEqual(input);
  });

  it("the fill asks for a sentence that found nothing, on the main subject", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const body = src.slice(src.indexOf("const fillBeatWithMoreClips = async"), src.indexOf("const fillBeatWithMoreClips = async") + 2600);
    expect(body).not.toContain("if (pushed.length === 0) return;");
    expect(body).toContain("const subject = found ? null : mainSubject;");
    expect(body).toContain("ownArchiveBeatClip({ ...asked, holdSec: rest }");
  });
});

describe("5. the reports say what the film did", () => {
  it("a picture judged as it is put into the film retracts 'adopted without judgement'", () => {
    const state = createBeatShortlistState();
    noteNotAsked(state, 1, 0, "ADOPTED_WITHOUT_JUDGEMENT");
    noteJudgedAtPush(state, 1, 0);
    const f = beatFunnel(state, 1, 0);
    expect(f.notAsked).toBe(0);
    expect(f.notAskedReasons.has("ADOPTED_WITHOUT_JUDGEMENT")).toBe(false);
    expect(f.judgedAtPush).toBe(1);
    const lines = formatBeatShortlists(state);
    expect(lines.some((l) => l.includes("s1b0") && l.includes("judgedAtPush=1"))).toBe(true);
    expect(lines.join("\n")).not.toContain("ADOPTED_WITHOUT_JUDGEMENT");
  });

  it("another reason is never retracted by a look", () => {
    const state = createBeatShortlistState();
    noteNotAsked(state, 0, 2, "REJECTED_BY_EDITOR");
    noteJudgedAtPush(state, 0, 2);
    expect(beatFunnel(state, 0, 2).notAskedReasons.get("REJECTED_BY_EDITOR")).toBe(1);
  });

  it("every push records the adoption and the mix, once per clip; the timeline is measured too", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const push = src.slice(src.indexOf("const pushSceneClip = async"), src.indexOf("const pushSceneClip = async") + 2600);
    expect(push).toContain("notePushedIntoFilm(dedup, clipPath, key);");
    const helper = src.slice(src.indexOf("function notePushedIntoFilm("), src.indexOf("function notePushedIntoFilm(") + 700);
    expect(helper).toContain('lineage.hasStage(record.lineageId, "ADOPTED")');
    expect(helper).toContain("countClipInMix(dedup, clipPath, contentKey);");
    expect(src).toContain("countClipInMix(dedup, p, contentKey);");
    expect(src).not.toMatch(/else if \(isRealVideoFootageClip\(p\)\) dedup\.movingClipCount\+\+;/);
    expect(src).toContain('if (ensured.outcome === "judged") noteJudgedAtPush(dedup.beatShortlist, sceneIndex, beatIndex);');
    expect(src).toContain('.replace("[ScreenTime]", "[ScreenTime] timeline")');
  });
});

describe("6. text left to the editor is planned, not executed, and says so", () => {
  const facts = (): RenderFeatureFacts => ({
    beatsWithIntent: 11, beatsTotal: 11, retrieved: 25, eligible: 1, shortlisted: 1,
    visionEnabled: true, visionReviewPool: 1, visionAsked: 1, visionApproved: 0,
    motionBandsPlanned: 11, motionScored: 11,
    cinematicEnabled: true, cinematicPlanned: true, cinematicRendered: true,
    captionsEnabled: true, captionsPlanned: 11,
    graphicsEnabled: true, graphicsPlanned: 3,
    transitionsApplied: 3, musicCatalogueAvailable: false,
    ambiencePlanned: 3, ambienceUnavailable: 0, sfxPlanned: 0, duckingApplied: true,
    delivery: {
      fileExists: true, hasVideoStream: true, hasAudioStream: true, fromCinematicRender: true,
      assetsInFinalVideo: 6, captionsOnTimeline: 0, graphicsOnTimeline: 0, textLeftToEditor: 14,
      ambientClipsOnTimeline: 3, sfxClipsOnTimeline: 0, musicClipsOnTimeline: 0,
      graphicsBurnedInByCompose: 0, avSyncMeasured: true, spotChecked: true,
    },
  });

  it("video 624's graphics and captions: planned, not drawn, left to the editor", () => {
    const m = buildRenderFeatureMatrix(facts());
    expect(m.graphics?.planned).toBe(true);
    expect(m.graphics?.executed).toBe(false);
    expect(m.graphics?.reason).toContain("left to the editor");
    expect(m.captions?.executed).toBe(false);
    expect(m.captions?.reason).toContain("left to the editor");
    const v = featureMatrixViolations(m).join("\n");
    expect(v).not.toContain("graphics EXECUTED_WITHOUT_PLAN");
    expect(v).not.toContain("graphics UNEXPLAINED_GAP");
    expect(v).not.toContain("captions UNEXPLAINED_GAP");
  });

  it("the pipeline counts what will play, and the plan's own graphics", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("cinematicProgress.graphicsOnTimeline = graphicsTrack(t).filter((g) => !g.disabled).length;");
    expect(src).toContain("cinematicProgress.captionsOnTimeline = captionTrack(t).filter((c) => !c.disabled).length;");
    expect(src).toContain("graphicsPlanned: Math.max(visualDedup.graphicClips.size, cinematicProgress.graphicsPlanned),");
  });
});

describe("7. the retrieval yardstick is the pipeline's own clock", () => {
  it("video 624: three scenes, 64 s of film, 226 s of retrieval — inside its own limits", () => {
    const yardstick = visualDeadlineForVideoMs(55_000 * 3, 64) + EMPTY_SCENE_RESCUE_MIN_MS;
    expect(yardstick).toBeGreaterThanOrEqual(180_000 + 60_000);
    expect(226_000).toBeLessThanOrEqual(yardstick);
  });

  it("the tracker is started with it", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf('get_activeBudgetTracker()?.stageStart(\n      "retrieval",');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("visualDeadlineForVideoMs(");
    expect(src.slice(at, at + 400)).toContain("+ EMPTY_SCENE_RESCUE_MIN_MS");
  });
});

describe("8. look ahead for every sentence; first look, then download; archive once", () => {
  it("render 624's nine queued lookaheads all start — none is cancelled for waiting in line", async () => {
    expect(YOUTUBE_LOOKAHEAD_PARALLEL).toBeGreaterThanOrEqual(9);
    const registry = createLookaheadRegistry(YOUTUBE_LOOKAHEAD_PARALLEL);
    for (let b = 0; b < 9; b++) registry.start(`0:${b}`, ["q"], () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    for (let b = 0; b < 9; b++) expect(registry.take(`0:${b}`, ["q"]).kind, `beat ${b}`).toBe("use");
    expect(registry.stats().cancelled).toBe(0);
  });

  /** ONE ROUTE — the look ranks: the videos it judged to serve a sentence come first, the others after. */
  it("the pool hands a sentence the videos the look judged to serve it first", () => {
    const pool = {
      videoId: 1, sentences: ["Elon Musk speaks at the meeting.", "The factory floor at night."],
      query1: "Elon Musk", query2: null, searches: 1,
      candidates: [
        { videoId: "aaaaaaaaaaa", title: "Elon Musk speech", description: "", thumb: "t", durationSec: 600, footageType: "real_footage", serves: [0], from: 1, usable: true, why: "ok" },
        { videoId: "bbbbbbbbbbb", title: "Elon Musk factory tour", description: "", thumb: "t", durationSec: 600, footageType: "real_footage", serves: [1], from: 1, usable: true, why: "ok" },
      ],
      coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
    } as unknown as VideoYoutubePool;
    expect(poolRowsForBeat(pool, "Elon Musk speaks at the meeting.", ["musk"], "Elon Musk").map((r) => r.item.id.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(poolRowsForBeat(pool, "The factory floor at night.", ["factory"], "Elon Musk").map((r) => r.item.id.videoId)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa"]);
  });

  it("whether a picture serves a sentence is asked per sentence, not once per video", async () => {
    const row = { item: { id: { videoId: "ccccccccccc" } }, title: "a speech", desc: "", thumb: "t", rel: 1 } as never;
    const look = async (_i: unknown, _t: string, sentences: string[]) =>
      ({ footageType: "real_footage", servesBeats: sentences[0]?.includes("speech") ? [0] : [] });
    const a = { beatText: "He gave a speech.", beatIndex: 0, videoTitle: "x" } as never;
    const b = { beatText: "The rocket lifted off.", beatIndex: 1, videoTitle: "x" } as never;
    /** Asked per sentence, and (ONE ROUTE) used to rank: both sentences keep the row. */
    expect(await youtubeRowsWithoutNonFootage([row], a, 0, look)).toHaveLength(1);
    expect(await youtubeRowsWithoutNonFootage([row], b, 0, look)).toHaveLength(1);
  });

  it("the background fetch archives its segments itself; the download does not do it again", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toMatch(/if \(archiveDelivered\) \{\s*archiveYoutubeDownloadInBackground\(outPath/);
    expect(pipe).toContain("box, budgetMs, onlyRoute, archiveDelivered");
    const prefetch = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");
    const call = prefetch.slice(prefetch.indexOf("pipeline.downloadYouTubeCCClip("), prefetch.indexOf("pipeline.downloadYouTubeCCClip(") + 500);
    expect(call).toMatch(/route,\s*\/\*\*[^*]*\*\/\s*false/);
  });
});
