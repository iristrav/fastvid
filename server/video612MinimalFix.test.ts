/**
 * Video 612 — the four causes found in its diagnosis, one regression each.
 *
 *   A. the central YouTube planner found no query → the beats still search YouTube per beat
 *   B. the script's `# title` heading is not narration → "Dominated Despite" is no person lock
 *   C. a place name no longer adds "city skyline / urban street / modern city" to a beat or an asset
 *   D. 5.7 s of footage under 70 s of voice → the final timeline is refused, not delivered
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { analyzeVideo, refuseQuery, planVideoQuery, withoutProductionWords, type GateVerdict } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  poolGaveNoYoutube,
  registerVideoYoutubePool,
  releaseVideoYoutubePool,
  videoYoutubePoolGaveNoYoutube,
  type PoolDeps,
} from "./youtubeVideoPool";
import { extractPersonNamesFromText, resolvePrimaryPersonLock, narrationWithoutHeadings, buildVerifiedQueryContextForBeat, isRejectedStockClip, buildBeatYoutubeQueries, youtubeQueriesForSentence, youtubeQueryPlanForSentence } from "./videoPipeline";
import { sentenceOnlyYoutubeQueries, neighbourSentences, namesInSentence, youtubeResultIsShort, YOUTUBE_SHORT_MAX_SEC, sentenceNameWords } from "./youtubeNonFootage";
import { youtubeSearchDurationForPass } from "./sourcingPolicy";
import { extractVisualSearchTags, extractBeatGeoPlaceTags, inferArchiveAssetTagsFromTitle } from "./visualBeatTags";
import { searchGateStrict, withSearchProvenance } from "./searchQueryContract";
import { youtubeVideoIdsForArchiveAssets } from "./youtubeFootageInFilm";
import { countVisualTagHits } from "./curatedMediaSourcing";
import { holdPictureUnderVoice } from "./edlToTimeline";
import { finalTimelineFootageRefusal, type FinalTimelineClip } from "./deliveredScreenTime";
import { deliveryGate } from "./deliveryGate";
import type { TimelineVideoClip } from "./projectTimeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * No test in this file reaches the network. The pipeline fetches through `node-fetch`; every request
 * is recorded and refused at the socket ("offline"). No provider answer is invented — what is
 * measured is only whether the request was SENT.
 */
const sent = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("node-fetch", () => ({
  default: async (url: unknown) => {
    sent.urls.push(String(url));
    throw new Error("offline in test");
  },
}));
const sentSearchFor = (q: string) =>
  sent.urls.some((u) => u.includes("googleapis.com/youtube/v3/search") && u.includes(encodeURIComponent(q).replace(/%20/g, "+")));

/** Video 612's own words. */
const TITLE = "Why the Roman Empire Dominated Despite Its Limitations";
const PROMPT = "The Roman Empire: How It Became So Powerful";
const NARRATION = [
  "Rome offered its enemies citizenship instead of chains.",
  "Rome was small, resource-strained. Yet it thrived by granting conquered peoples citizenship.",
  "Scipio Africanus led Rome against Hannibal Barca at Zama in Tunisia and sealed the fate of Carthage.",
  "Rome's strategies of integration, innovation, and governance still echo in Washington today.",
];
const SCRIPT = `# ${TITLE}\n\n${NARRATION.join("\n\n")}`;
const roman = { prompt: PROMPT, title: TITLE, sceneTexts: [NARRATION.slice(0, 2).join(" "), NARRATION[2]!, NARRATION[3]!] };

/* ═══════════ A — no central query is not "no YouTube" ═══════════ */

describe("A. the central planner finds no query → the beats search YouTube themselves", () => {
  const refuseAll = (): GateVerdict => ({ ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "x" });
  const plannerDeps = (): PoolDeps => ({
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "The Roman Empire", recurringSubjects: [], query: "Rome Carthage archival footage" }) } }],
    }),
    gate: refuseAll,
    search: async () => {
      throw new Error("the pool must not search when no query passed");
    },
    details: async () => new Map(),
    triage: async () => ({ footageType: "real_footage", servesBeats: [], depicts: "" }),
    archive: async () => [],
    notFootage: () => null,
    log: () => {},
  });

  it("the pool that got no query says it made no search, and the video is marked for per-beat search", async () => {
    const pool = buildVideoYoutubePool(plannerDeps(), { ...roman, videoId: 612_001 });
    registerVideoYoutubePool(612_001, pool);
    const built = await pool;
    await Promise.resolve();
    expect(built.query1).toBeNull();
    expect(poolGaveNoYoutube(built)).toBe(true);
    expect(videoYoutubePoolGaveNoYoutube(612_001)).toBe(true);
    releaseVideoYoutubePool(612_001);
    expect(videoYoutubePoolGaveNoYoutube(612_001)).toBe(false);
  });

  it("the per-beat search is no longer refused for such a video — and still is for a pool with usable YouTube", async () => {
    const { runWithActiveVideoId } = await import("./videoGenerationCancel");
    const { searchYoutubeVideoCandidates } = await import("./videoPipeline");
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const prev = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "test-key-not-used";
    try {
      const empty = buildVideoYoutubePool(plannerDeps(), { ...roman, videoId: 612_002 });
      registerVideoYoutubePool(612_002, empty);
      await empty;
      await Promise.resolve();
      await runWithActiveVideoId(612_002, () =>
        searchYoutubeVideoCandidates("Rome Carthage archival footage", 0, "any", [], 1, "", 50).catch(() => [])
      );
      expect(lines.join("\n")).not.toContain("[YouTubeSearchBudget] REFUSED video=612002");

      const usable = {
        videoId: "i9H_9E-IeUw", title: "Roman legion", description: "", thumb: "t", durationSec: 300,
        footageType: "real_footage" as const, serves: [0], from: 1 as const, usable: true, why: "ok",
      };
      const searched = Promise.resolve({ ...(await empty), query1: "Roman Empire archival footage", searches: 1, candidates: [usable] });
      registerVideoYoutubePool(612_003, searched);
      await searched;
      await Promise.resolve();
      await runWithActiveVideoId(612_003, () =>
        searchYoutubeVideoCandidates("Rome Carthage archival footage", 0, "any", [], 1, "", 50).catch(() => [])
      );
      expect(lines.join("\n")).toContain("[YouTubeSearchBudget] REFUSED video=612003");
    } finally {
      process.env.YOUTUBE_API_KEY = prev;
      releaseVideoYoutubePool(612_002);
      releaseVideoYoutubePool(612_003);
      logSpy.mockRestore();
    }
  }, 120_000);

  it("the fetcher leaves pool mode when the pool made no search", () => {
    expect(PIPE).toContain("} else if (poolGaveNoYoutube(pool)) {");
    expect(PIPE).toContain("the pool brought back no usable YouTube — this beat searches YouTube itself");
    expect(PIPE).toContain("!videoYoutubePoolGaveNoYoutube(renderVideoId)");
  });

  it("'Rome' now counts as the subject 'The Roman Empire'; unrelated words still do not", () => {
    const a = analyzeVideo(roman);
    const allow = (): GateVerdict => ({ ok: true });
    expect(refuseQuery("Rome Scipio Africanus archival footage", { analysis: a, mainSubject: "The Roman Empire", gate: allow }) ?? "").not.toContain("main subject");
    expect(refuseQuery("Carthage Hannibal archival footage", { analysis: a, mainSubject: "The Roman Empire", gate: allow })).toContain("main subject");
  });
});

/* ═══════════ B — a heading is not narration ═══════════ */

describe("B. the title heading does not make a person lock", () => {
  it("the heading is not read as names", () => {
    expect(extractPersonNamesFromText(SCRIPT)).toContain("Dominated Despite");
    expect(extractPersonNamesFromText(narrationWithoutHeadings(SCRIPT))).not.toContain("Dominated Despite");
  });

  it("video 612's inputs lock nobody who is not said", () => {
    const lock = resolvePrimaryPersonLock({ prompt: PROMPT, videoTitle: TITLE, topicContext: `${PROMPT} — ${TITLE}`, script: SCRIPT });
    expect(lock).not.toBe("Dominated Despite");
    expect(lock === "" || NARRATION.join(" ").includes(lock)).toBe(true);
  });

  it("a name only in the title never locks", () => {
    const lock = resolvePrimaryPersonLock({
      prompt: "",
      videoTitle: "Why Nobody Remembers Maria Lopez",
      topicContext: "Why Nobody Remembers Maria Lopez",
      script: "# Why Nobody Remembers Maria Lopez\n\nThe village forgot its founder. The records burned in a fire.",
    });
    expect(lock).toBe("");
  });

  it("a real person the narration names still locks", () => {
    const lock = resolvePrimaryPersonLock({
      prompt: "The life of Julius Caesar",
      videoTitle: "Caesar: The Man Who Ended a Republic",
      topicContext: "The life of Julius Caesar",
      script: "# Caesar: The Man Who Ended a Republic\n\nJulius Caesar crossed the Rubicon in 49 BC. Julius Caesar marched on Rome.",
    });
    expect(lock).toBe("Julius Caesar");
  });
});

describe("B2. the first person the narration names is not the video's subject", () => {
  const lockFor = (title: string, narration: string, prompt = title) =>
    resolvePrimaryPersonLock({ prompt, videoTitle: title, topicContext: `${prompt} — ${title}`, script: `# ${title}\n\n${narration}` });
  const SOURCE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("a topic video that names Scipio, Hannibal and Caesar locks nobody", () => {
    const lock = lockFor(
      "The Roman Empire: How It Became So Powerful",
      "Scipio Africanus defeated Hannibal Barca at Zama. Julius Caesar crossed the Rubicon. Rome grew into an empire."
    );
    expect(lock).toBe("");
    /** personLocked is `Boolean(primaryPerson) || isPersonCelebrityTopic(…)`; the celebrity part is untouched. */
    expect(SOURCE).toContain("const personLocked = Boolean(primaryPerson) || isPersonCelebrityTopic(topicContext);");
  });

  it("'Who Was Julius Caesar?' locks Julius Caesar", () => {
    expect(lockFor("Who Was Julius Caesar?", "Julius Caesar was born in Rome. Julius Caesar became dictator.")).toBe("Julius Caesar");
  });

  it("'The Life of Julius Caesar' locks Julius Caesar", () => {
    expect(
      lockFor("The Life of Julius Caesar", "Julius Caesar was born in 100 BC. Julius Caesar conquered Gaul. Julius Caesar was murdered.")
    ).toBe("Julius Caesar");
  });

  it("'Dominated Despite' is still no person", () => {
    const lock = lockFor(TITLE, NARRATION.join(" "), PROMPT);
    expect(lock).not.toBe("Dominated Despite");
    expect(lock).toBe("");
  });

  it("a general history video with several people locks nobody", () => {
    expect(
      lockFor(
        "How the Cold War Shaped the Modern World",
        "Harry Truman warned of Soviet power. Joseph Stalin tightened his grip. John Kennedy faced Nikita Khrushchev over Cuba."
      )
    ).toBe("");
  });
});

/* ═══════════ C — no generic city tags on a Roman beat or on an archive asset ═══════════ */

describe("C. generic city tags make no match between a Roman beat and modern footage", () => {
  const GENERIC = ["city skyline", "urban street", "modern city"];

  it("a Roman beat that names places gets none of the three tags", () => {
    for (const line of NARRATION) {
      const tags = extractVisualSearchTags(line, TITLE);
      for (const g of GENERIC) expect(tags, line).not.toContain(g);
    }
  });

  it("an archive asset tagged from its title gets none of them either", () => {
    const tags = inferArchiveAssetTagsFromTitle({ title: "Nuremberg trial judgement Berlin 1946 newsreel" });
    for (const g of GENERIC) expect(tags).not.toContain(g);
  });

  it("an asset that still carries them in the database gets no hit from a Roman beat", () => {
    const asset = { title: "California beaches 1940s", tags: ["california", "beaches", "1940s", ...GENERIC] };
    const beatTags = NARRATION.flatMap((l) => extractVisualSearchTags(l, TITLE));
    expect(countVisualTagHits(asset, beatTags)).toBe(0);
  });
});

/* ═══════════ D — one short clip does not become the film ═══════════ */

describe("D. 5.7 s of footage under 70 s of voice is not delivered", () => {
  const clip = (id: string, start: number, end: number, archiveAssetId: number): FinalTimelineClip & TimelineVideoClip =>
    ({ id, timelineStart: start, timelineEnd: end, source: { provider: "youtube", providerAssetId: String(archiveAssetId), archiveAssetId } }) as unknown as FinalTimelineClip & TimelineVideoClip;

  it("the held clip, cut into pieces of one source, is refused on the final timeline", () => {
    const clips = [clip("vc_1", 0, 5.7, 57924)];
    holdPictureUnderVoice({ clips, voiceDurationSec: 70 });
    expect(clips[0]!.timelineEnd).toBe(70);
    /** The YouTube rule's pieces: fifteen of them, every one the same asset. */
    const pieces = Array.from({ length: 15 }, (_, i) => clip(`vc_1_p${i + 1}`, (70 / 15) * i, (70 / 15) * (i + 1), 57924));
    const refusal = finalTimelineFootageRefusal(pieces);
    expect(refusal).toContain("archive:57924");
    expect(refusal).toContain("100%");
    expect(refusal).toContain("15 piece(s)");
  });

  it("the delivery gate refuses it with its own code", () => {
    const verdict = deliveryGate({
      videoId: 612,
      route: "cinematic_timeline",
      timelineExists: true,
      clips: [],
      delivered: null,
      assetsOnly: true,
      footageRefusal: finalTimelineFootageRefusal([clip("a", 0, 70, 57924)]),
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.failures.map((f) => f.code)).toContain("ONE_FOOTAGE_FILLS_FILM");
  });

  it("an ordinary edit of many sources passes", () => {
    const clips = Array.from({ length: 12 }, (_, i) => clip(`c${i}`, i * 5, i * 5 + 5, 1000 + i));
    expect(finalTimelineFootageRefusal(clips)).toBeNull();
  });

  it("the pipeline does not queue the render of such a timeline, and the worker's gate reads the same measure", () => {
    expect(PIPE).toContain("await youtubeVideoIdsForArchiveAssets(videoTrack(outcome.timeline), getMediaArchiveAssetById)");
    expect(PIPE).toContain("if (outcome.ok && cinematicProgress.enabled && !footageRefusal) {");
    const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(WORKER).toContain("await youtubeVideoIdsForArchiveAssets(videoTrack(timeline), getMediaArchiveAssetById)");
  });
});

/* ═══════════ A2 — the central route counts as "searched" only when it brought back usable YouTube ═══════════ */

describe("A2. a pool whose search failed or found nothing usable lets the beats search per beat", () => {
  const allow = (): GateVerdict => ({ ok: true });
  const item = (i: number) => ({ videoId: `vid${String(i).padStart(8, "0")}`, title: `Roman legion ${i}`, description: "", channel: "c", thumb: "t" });
  const poolDeps = (over: Partial<PoolDeps> & { searches?: string[] } = {}): PoolDeps & { searches: string[] } => {
    const searches = over.searches ?? [];
    return {
      searches,
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({
        choices: [{ message: { content: JSON.stringify({ mainSubject: "The Roman Empire", recurringSubjects: [], query: "Roman Empire Rome archival footage" }) } }],
      }),
      gate: allow,
      search: async (q) => {
        searches.push(q);
        return { status: 200, items: [item(1), item(2), item(3)] };
      },
      details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
      triage: async () => ({ footageType: "real_footage", servesBeats: [0], depicts: "" }),
      archive: async () => [],
      notFootage: () => null,
      log: () => {},
      ...over,
    };
  };
  const settle = async (videoId: number, d: PoolDeps) => {
    const p = buildVideoYoutubePool(d, { ...roman, videoId });
    registerVideoYoutubePool(videoId, p);
    const built = await p;
    await Promise.resolve();
    const fallback = videoYoutubePoolGaveNoYoutube(videoId);
    releaseVideoYoutubePool(videoId);
    return { built, fallback };
  };

  it("1. planner NO_QUERY → fallback", async () => {
    const r = await settle(612_101, poolDeps({ gate: () => ({ ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "x" }) }));
    expect(r.built.query1).toBeNull();
    expect(r.fallback).toBe(true);
  });

  it("2. pool search HTTP error → fallback", async () => {
    const r = await settle(612_102, poolDeps({ search: async () => ({ status: 403, items: [] }) }));
    expect(r.built.query1).not.toBeNull();
    expect(r.fallback).toBe(true);
  });

  it("3. pool search network error → fallback", async () => {
    const r = await settle(612_103, poolDeps({ search: async () => { throw new Error("ECONNRESET"); } }));
    expect(r.built.query1).not.toBeNull();
    expect(r.fallback).toBe(true);
  });

  it("4. pool search answered but nothing usable (triage refused or failed) → fallback", async () => {
    const refused = await settle(612_104, poolDeps({ triage: async () => ({ footageType: "talking_head", servesBeats: [], depicts: "" }) }));
    expect(refused.fallback).toBe(true);
    const failed = await settle(612_105, poolDeps({ triage: async () => { throw new Error("LLM 403"); } }));
    expect(failed.fallback).toBe(true);
  });

  it("5 + 6. a successful pool keeps the pool route, searched once, and the per-beat search stays refused", async () => {
    const searches: string[] = [];
    const d = poolDeps({ searches });
    const p = buildVideoYoutubePool(d, { ...roman, videoId: 612_106 });
    registerVideoYoutubePool(612_106, p);
    const built = await p;
    await Promise.resolve();
    expect(poolGaveNoYoutube(built)).toBe(false);
    expect(videoYoutubePoolGaveNoYoutube(612_106)).toBe(false);
    /** The pool keeps its own budget (search #2 is allowed for a gap); nothing beyond it. */
    expect(searches.length).toBeGreaterThanOrEqual(1);
    expect(searches.length).toBeLessThanOrEqual(2);

    const { runWithActiveVideoId } = await import("./videoGenerationCancel");
    const { searchYoutubeVideoCandidates } = await import("./videoPipeline");
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const prev = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "test-key-not-used";
    try {
      await runWithActiveVideoId(612_106, () => searchYoutubeVideoCandidates("Roman legion archival footage", 0, "any", [], 1, "", 50));
      expect(lines.join("\n")).toContain("[YouTubeSearchBudget] REFUSED video=612106");
      expect(sentSearchFor("Roman legion archival footage"), "a per-beat search was sent beside a working pool").toBe(false);
    } finally {
      process.env.YOUTUBE_API_KEY = prev;
      releaseVideoYoutubePool(612_106);
      logSpy.mockRestore();
    }
  }, 120_000);
});

/* ═══════════ A3 — the per-beat fallback passes SEARCH_GATE_STRICT and reaches search.list ═══════════ */

describe("A3. pool gave no YouTube + per-beat fallback + SEARCH_GATE_STRICT = the YouTube search is sent", () => {
  it("video 612's own beat query goes out to search.list", async () => {
    expect(searchGateStrict()).toBe(true);
    const failing: PoolDeps = {
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({ choices: [{ message: { content: "{}" } }] }),
      gate: () => ({ ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "x" }),
      search: async () => ({ status: 200, items: [] }),
      details: async () => new Map(),
      triage: async () => null,
      archive: async () => [],
      notFootage: () => null,
      log: () => {},
    };
    const p = buildVideoYoutubePool(failing, { ...roman, videoId: 612_201 });
    registerVideoYoutubePool(612_201, p);
    await p;
    await Promise.resolve();

    const { runWithActiveVideoId } = await import("./videoGenerationCancel");
    const { searchYoutubeVideoCandidates } = await import("./videoPipeline");
    const prev = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "test-key-not-used";
    try {
      const beat = NARRATION[0]!;
      const ctx = buildVerifiedQueryContextForBeat(beat, { scenePersons: [], sceneText: NARRATION.slice(0, 2).join(" ") });
      await runWithActiveVideoId(612_201, () =>
        withSearchProvenance(ctx, () =>
          searchYoutubeVideoCandidates("Rome citizenship instead archival footage", 0, "any", [], 1, "", 50).catch(() => [])
        )
      );
      expect(sentSearchFor("Rome citizenship instead archival footage")).toBe(true);
    } finally {
      process.env.YOUTUBE_API_KEY = prev;
      releaseVideoYoutubePool(612_201);
    }
  }, 120_000);
});

/* ═══════════ C2 — no tags from parts of words ═══════════ */

describe("C2. tags only from whole words", () => {
  const tags = (line: string) => extractVisualSearchTags(line, TITLE);
  const TRANSIT = ["public transport", "metro", "subway", "train station"];
  const USA = ["usa", "united states", "american city", "usa skyline"];

  it("resource-strained is no train, business is no bus", () => {
    for (const t of TRANSIT) {
      expect(tags("Rome was small, resource-strained."), t).not.toContain(t);
      expect(tags("Rome became a business of empire."), t).not.toContain(t);
    }
  });

  it("a real train or bus still is", () => {
    expect(tags("In Rome the train left the station.")).toContain("public transport");
    expect(tags("In Rome a bus crossed the square.")).toContain("public transport");
  });

  it("'us' is not the U.S.; 'U.S.' and 'United States' are", () => {
    for (const t of USA) expect(tags("Rome gave us roads and laws."), t).not.toContain(t);
    expect(extractBeatGeoPlaceTags("Rome gave us roads and laws.")).not.toContain("usa");
    expect(extractBeatGeoPlaceTags("The U.S. built roads like Rome.")).toContain("usa");
    expect(extractBeatGeoPlaceTags("The United States studied Rome.")).toContain("united states");
    expect(tags("The U.S. built roads like Rome.")).toContain("usa skyline");
  });
});

/* ═══════════ D2 — segments of one YouTube video are one source ═══════════ */

describe("D2. the footage check groups archive segments by their original YouTube video", () => {
  const clip = (id: string, start: number, end: number, archiveAssetId: number, provider = "youtube"): FinalTimelineClip =>
    ({ id, timelineStart: start, timelineEnd: end, source: { provider, providerAssetId: String(archiveAssetId), archiveAssetId } });
  const rows: Record<number, { sourcePlatform: string; sourceUrl: string }> = {
    58002: { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=i9H_9E-IeUw" },
    58003: { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=i9H_9E-IeUw" },
    58004: { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=i9H_9E-IeUw" },
    60001: { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" },
    70001: { sourcePlatform: "pexels", sourceUrl: "https://www.pexels.com/video/123/" },
  };
  const load = async (id: number) => rows[id];

  it("three archive assets of one YouTube video are one source → 100% → refused", async () => {
    const clips = [clip("a", 0, 20, 58002), clip("b", 20, 40, 58003), clip("c", 40, 60, 58004)];
    expect(finalTimelineFootageRefusal(clips), "without the origin they looked like three sources").toBeNull();
    const ids = await youtubeVideoIdsForArchiveAssets(clips, load);
    const refusal = finalTimelineFootageRefusal(clips, undefined, ids);
    expect(refusal).toContain("youtube:i9H_9E-IeUw");
    expect(refusal).toContain("100%");
  });

  it("two different YouTube videos stay two sources; YouTube and stock stay apart", async () => {
    const two = [clip("a", 0, 30, 58002), clip("b", 30, 60, 60001)];
    expect(finalTimelineFootageRefusal(two, undefined, await youtubeVideoIdsForArchiveAssets(two, load))).toBeNull();
    const mixed = [clip("a", 0, 30, 58002), clip("s", 30, 60, 70001, "pexels")];
    expect(finalTimelineFootageRefusal(mixed, undefined, await youtubeVideoIdsForArchiveAssets(mixed, load))).toBeNull();
  });

  it("51% of one YouTube video is refused; exactly 50% keeps the existing limit and passes", async () => {
    const over = [clip("a", 0, 25.5, 58002), clip("b", 25.5, 51, 58003), clip("s", 51, 100, 70001, "pexels")];
    expect(finalTimelineFootageRefusal(over, undefined, await youtubeVideoIdsForArchiveAssets(over, load))).toContain("51%");
    const exact = [clip("a", 0, 25, 58002), clip("b", 25, 50, 58003), clip("s", 50, 100, 70001, "pexels")];
    expect(finalTimelineFootageRefusal(exact, undefined, await youtubeVideoIdsForArchiveAssets(exact, load))).toBeNull();
  });

  it("an asset whose row cannot be read keeps the archive key", async () => {
    const clips = [clip("a", 0, 30, 99999), clip("b", 30, 60, 58002)];
    const ids = await youtubeVideoIdsForArchiveAssets(clips, async (id) => (id === 99999 ? undefined : rows[id]));
    expect(ids.has(99999)).toBe(false);
    expect(finalTimelineFootageRefusal(clips, undefined, ids)).toBeNull();
  });
});

/* ═══════════ E — video 613: our own "archival footage" is not a reason to refuse a clip ═══════════ */

describe("E. the stock filter does not refuse a clip for the words FastVid added to its own query", () => {
  const YT = "/tmp/fastvid_613/scene_1_ytfu_0__pid_youtube_cc-86c1ddee3279c7ac.mp4";

  it("a YouTube clip found with '… archival footage' reaches the picture editor", () => {
    expect(isRejectedStockClip(YT, "Kim Kardashian archival footage")).toBe(false);
    expect(isRejectedStockClip(YT, "Rome citizenship instead archival footage")).toBe(false);
    expect(isRejectedStockClip(YT, "Scipio Africanus Archival Footage")).toBe(false);
  });

  it("real stock refusals are unchanged", () => {
    expect(isRejectedStockClip(YT, "space shuttle launch archival footage")).toBe(true);
    expect(isRejectedStockClip(YT, "highway night driving")).toBe(true);
    expect(isRejectedStockClip("/tmp/old-nasa-archival-reel.mp4", "rocket")).toBe(true);
    expect(isRejectedStockClip(YT, "vintage archival reel")).toBe(true);
  });

  it("the adoption loop still asks the same filter with the clip's own query", () => {
    expect(PIPE).toContain('if (isRejectedStockClip(p, sourceQuery) && refuse("rejected_stock")) continue;');
  });
});

/* ═══════════ F — a YouTube query holds only words from its own sentence ═══════════ */

describe("F. a sentence's YouTube query never carries a word the sentence does not say", () => {
  const SENTENCES: Array<[string, string]> = [
    ["Rome offered its enemies citizenship instead of chains.", ""],
    ["Rome was small, resource-strained.", ""],
    ["Yet it thrived by granting conquered peoples citizenship.", ""],
    ["Scipio Africanus led Rome against Hannibal Barca at Zama in Tunisia in 202 BC.", "Scipio Africanus"],
    ["Rome sealed the fate of Carthage.", ""],
    ["Centuries later, Washington borrowed Rome's ideas of a republic.", ""],
    ["Kim Kardashian built a billion-dollar fortune from skincare.", "Kim Kardashian"],
    ["Kylie Jenner turned lip kits into a cosmetics empire.", "Kylie Jenner"],
    ["Kris Jenner ran the business from behind the scenes.", "Kris Jenner"],
    ["She turned reality TV fame into business.", "Kim Kardashian"],
  ];
  const queriesFor = (text: string, person: string, title = PROMPT) =>
    youtubeQueriesForSentence(
      buildBeatYoutubeQueries({ text, index: 1, searchQuery: "" } as never, { text, visualCue: "", pexelsQuery: "" } as never, title, person),
      text
    );
  const words = (t: string) =>
    t.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u).map((w) => w.replace(/['’]s$/, "")).filter(Boolean);

  it("every word of every query is a word of the sentence — nothing appended", () => {
    for (const [text, person] of SENTENCES) {
      const said = new Set(words(text));
      for (const q of queriesFor(text, person)) {
        for (const w of words(q)) expect(said.has(w), `"${w}" in "${q}" is not in "${text}"`).toBe(true);
        expect(q).not.toMatch(/\b(archival|footage|documentary|news report)\b/i);
      }
    }
  });

  it("no verb, no filler word, no pronoun", () => {
    expect(queriesFor(SENTENCES[0]![0], "")).toEqual(["Rome citizenship", "Rome"]);
    expect(queriesFor(SENTENCES[4]![0], "")).toEqual(["Carthage"]);
    expect(queriesFor(SENTENCES[5]![0], "")).toEqual(["Washington"]);
    expect(sentenceOnlyYoutubeQueries(["Kim Kardashian built", "Its", "Rome citizenship instead"], "Kim Kardashian built its Rome citizenship instead.", "built"))
      .toEqual(["Kim Kardashian", "Rome citizenship"]);
  });

  it("a sentence that names nobody, and no neighbour to borrow from, gets no YouTube question at all", () => {
    expect(queriesFor(SENTENCES[2]![0], "")).toEqual([]);
    expect(queriesFor(SENTENCES[9]![0], "Kim Kardashian", "How the Kardashians Built an Empire")).toEqual([]);
  });

  it("a one-word question is only a name the sentence capitalises", () => {
    const kylie = queriesFor(SENTENCES[7]![0], "Kylie Jenner", "How the Kardashians Built an Empire");
    expect(kylie).toEqual(["Kylie Jenner", "Kylie Jenner lip kits"]);
    expect(sentenceOnlyYoutubeQueries(["Empire", "empire documentary footage"], "They built an empire.")).toEqual([]);
    expect(sentenceOnlyYoutubeQueries(["Carthage archival footage"], "Rome sealed the fate of Carthage.")).toEqual(["Carthage"]);
  });

  it("short questions go first: the two YouTube is sent are the short ones", () => {
    const scipio = queriesFor(SENTENCES[3]![0], "Scipio Africanus");
    expect(scipio.slice(0, 2)).toEqual(["Scipio Africanus Tunisia", "Scipio Africanus"]);
    expect(scipio).toContain("Scipio Africanus Hannibal Barca Tunisia");
    expect(scipio.indexOf("Scipio Africanus Hannibal Barca Tunisia")).toBeGreaterThan(1);
  });

  it("the single YouTube door and the lookahead both cut the queries to the sentence", () => {
    expect(PIPE).toContain("const req: CentralYoutubeRequest = { ...input, queries: plan.queries };");
    expect(PIPE).toContain("youtubeQueriesForSentence(buildBeatYoutubeQueries(beat, scene, videoTitle, personName), beat.text, scene.text)");
  });

  it("the whole-video planner sends no production word, whatever the model answers", async () => {
    expect(withoutProductionWords("Rome Carthage archival footage")).toBe("Rome Carthage");
    expect(withoutProductionWords("Kim Kardashian documentary video")).toBe("Kim Kardashian");
    const lines: string[] = [];
    const planned = await planVideoQuery(
      {
        llm: async () => ({
          choices: [{ message: { content: JSON.stringify({ mainSubject: "Rome", recurringSubjects: [], query: "Rome Carthage archival footage" }) } }],
        }),
        gate: () => ({ ok: true }),
        log: (l) => lines.push(l),
      },
      roman
    );
    expect(planned?.query).toBeTruthy();
    expect(planned!.query).not.toMatch(/\b(archival|footage|documentary)\b/i);
    for (const l of lines) expect(l).not.toMatch(/query="[^"]*\b(archival|footage|documentary)\b/i);
  });
});

/* ═══════════ G — a sentence that names nobody borrows from the sentence before, then after ═══════════ */

describe("G. no who/what/where in the sentence → the previous sentence, then the next, same scene only", () => {
  const plan = (sentences: string[], i: number, person = "", title = PROMPT) => {
    const sceneText = sentences.join(" ");
    const text = sentences[i]!;
    return youtubeQueryPlanForSentence(
      buildBeatYoutubeQueries({ text, index: 1, searchQuery: "" } as never, { text: sceneText, visualCue: "", pexelsQuery: "" } as never, title, person),
      text,
      sceneText
    );
  };
  const KIM = ["Kim Kardashian built a billion-dollar fortune from skincare.", "She turned reality TV fame into business."];
  const KYLIE = ["It started with a single product.", "Kylie Jenner turned lip kits into a cosmetics empire."];
  const ROME = ["Rome offered its enemies citizenship instead of chains.", "Rome was small, resource-strained.", "Yet it thrived by granting conquered peoples citizenship."];

  it("'She …' borrows the name of the sentence before it", () => {
    expect(plan(KIM, 1, "Kim Kardashian", "How the Kardashians Built an Empire")).toEqual({ queries: ["Kim Kardashian"], from: "previous" });
    expect(plan(ROME, 2)).toEqual({ queries: ["Rome"], from: "previous" });
  });

  it("the first sentence of a scene borrows from the one after it", () => {
    expect(plan(KYLIE, 0, "Kylie Jenner", "How the Kardashians Built an Empire")).toEqual({ queries: ["Kylie Jenner"], from: "next" });
  });

  it("the previous sentence goes before the next one", () => {
    const three = ["Kris Jenner saw the chance.", "She signed the deal.", "Kylie Jenner took over later."];
    expect(plan(three, 1, "", "How the Kardashians Built an Empire")).toEqual({ queries: ["Kris Jenner"], from: "previous" });
  });

  it("a sentence that names something itself never borrows", () => {
    expect(plan(KIM, 0, "Kim Kardashian", "How the Kardashians Built an Empire").from).toBe("sentence");
    expect(plan(ROME, 1).from).toBe("sentence");
  });

  it("every borrowed word is a word of that neighbour — nothing added", () => {
    for (const [sentences, i] of [[KIM, 1], [KYLIE, 0], [ROME, 2]] as const) {
      const p = plan([...sentences], i);
      const neighbour = p.from === "previous" ? sentences[i - 1]! : sentences[i + 1]!;
      const said = new Set(neighbour.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean));
      for (const q of p.queries) for (const w of q.toLowerCase().split(/\s+/)) expect(said.has(w), `${w} / ${neighbour}`).toBe(true);
    }
  });

  it("never another scene: no neighbour when the sentence is alone in its scene or not in its text", () => {
    expect(neighbourSentences("She signed the deal.", "She signed the deal.")).toEqual({ previous: undefined, next: undefined });
    expect(neighbourSentences("Kris Jenner saw the chance.", "The decision was hers alone.")).toEqual({});
    expect(youtubeQueryPlanForSentence(["Kris Jenner archival footage"], "She signed the deal.", "She signed the deal.")).toEqual({ queries: [], from: "none" });
  });

  it("an opening capital is not a name ('Centuries later …'); a name the scene repeats is ('Rome')", () => {
    expect(namesInSentence("Centuries later, Washington borrowed the idea.")).toEqual(["Washington"]);
    expect(namesInSentence("Rome was small.", [], ROME.join(" "))).toEqual(["Rome"]);
    expect(namesInSentence("Rome was small.")).toEqual([]);
    expect(namesInSentence("Scipio won the Battle of Zama.")).toEqual(["Battle of Zama"]);
    expect(namesInSentence("Scipio won the Battle of Zama.", ["Scipio Africanus"])).toEqual(["Scipio", "Battle of Zama"]);
  });

  it("the door logs which sentence was used, and the lookahead passes the scene too", () => {
    expect(PIPE).toContain("youtubeQueryPlanForSentence(input.queries, input.beat.text, input.scene?.text)");
    expect(PIPE).toContain("sentence names nothing — ");
    expect(PIPE).toContain("youtubeQueriesForSentence(buildBeatYoutubeQueries(beat, scene, videoTitle, personName), beat.text, scene.text)");
  });
});

/* ═══════════ H — video 613: a failed render stays failed, stops its own work, keeps its provenance ═══════════ */

describe("H. video 613 — failed stays failed; a failed run stops; Openverse clips carry lineage", () => {
  const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
  const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

  it("A. a progress tick never writes over a failed or completed video", () => {
    const tick = DB.slice(DB.indexOf("export async function updateVideoProgress("), DB.indexOf("export async function advanceRunningVideoStatus("));
    expect(tick).toContain("notInArray(videos.status, ENDED_VIDEO_STATUSES)");
    expect(DB).toMatch(/ENDED_VIDEO_STATUSES: \("failed" \| "completed"\)\[\] = \["failed", "completed"\]/);
    const advance = DB.slice(DB.indexOf("export async function advanceRunningVideoStatus("));
    expect(advance.slice(0, 400)).toContain("notInArray(videos.status, ENDED_VIDEO_STATUSES)");
  });

  it("A. the render's stage badge goes through the guarded write, not the unconditional one", () => {
    const push = ROUTERS.slice(ROUTERS.indexOf("const pushStep = async"), ROUTERS.indexOf("const pipelineHeartbeat"));
    expect(push).toContain("await advanceRunningVideoStatus(videoId, statusForKey[key])");
    expect(push).not.toContain("await updateVideoStatus(videoId, statusForKey[key])");
    /** The failure itself is still the unconditional write. */
    expect(ROUTERS).toContain(`await updateVideoStatus(videoId, "failed", {
      errorMessage: normalizeStoredError(error),`);
  });

  it("B. a run that did not deliver marks its own token abandoned, so its checkpoints throw", async () => {
    expect(PIPE).toMatch(/\} catch \(err\) \{[\s\S]{0,900}renderRun\.abandoned = true;\s*throw err;\s*\} finally \{/);
    const { runWithActiveVideoId, throwIfActiveRenderCancelled, isVideoGenerationCancelRequested } = await import("./videoGenerationCancel");
    const failedRun = { abandoned: false };
    const nextRun = { abandoned: false };
    failedRun.abandoned = true;
    expect(() => runWithActiveVideoId(613, () => throwIfActiveRenderCancelled(), 1, failedRun)).toThrow("Video generation cancelled");
    /** Only that run: the next attempt for the same video is untouched, and no video-wide flag is set. */
    expect(() => runWithActiveVideoId(613, () => throwIfActiveRenderCancelled(), 1, nextRun)).not.toThrow();
    expect(isVideoGenerationCancelRequested(613)).toBe(false);
  });

  it("C. the Openverse web-wide route opens a lineage record and records the outcome", () => {
    const start = PIPE.indexOf("export async function searchWebWideVideoClips(");
    const body = PIPE.slice(start, start + 9000);
    expect(body).toContain('"openverse",');
    expect(body).toContain("tagPathWithProviderAsset(");
    expect(body).toContain('searchRoute: "searchWebWideVideoClips"');
    expect(body).toContain("recordProviderDownloadOutcome(sourcingCache, outPath, madeClip");
  });
});

/* ═══════════ I — a YouTube Short is never downloaded ═══════════ */

describe("I. a YouTube Short is never downloaded, on any route", () => {
  it("a Short is recognised by its hashtag or by a length of three minutes or less", () => {
    expect(youtubeResultIsShort("Oh No khloe even didn't Notice kim kardashian Revenge😂 #yts")).toBe("shorts hashtag");
    expect(youtubeResultIsShort("Kim Kardashian interview", "#Shorts #kim")).toBe("shorts hashtag");
    expect(youtubeResultIsShort("Kim Kardashian interview", "", 45)).toContain("Short length");
    expect(youtubeResultIsShort("Kim Kardashian interview", "", YOUTUBE_SHORT_MAX_SEC)).toContain("Short length");
    expect(youtubeResultIsShort("Kim Kardashian interview", "", YOUTUBE_SHORT_MAX_SEC + 1)).toBeNull();
    expect(youtubeResultIsShort("Rome: the rise of an empire (documentary)", "Full episode", 1500)).toBeNull();
    expect(youtubeResultIsShort("The short history of Rome")).toBeNull();
  });

  it("the per-beat search never asks YouTube for the under-4-minute slice", () => {
    for (let pass = 0; pass < 4; pass++)
      for (const count of [1, 2, 3])
        for (const q of [undefined, 0, 1, 2, 3]) expect(youtubeSearchDurationForPass(pass, count, q)).toBe("medium");
  });

  it("the per-beat result filter and the RapidAPI fallback both refuse Shorts before download", () => {
    expect(PIPE).toContain("const short = youtubeResultIsShort(item.snippet?.title, item.snippet?.description);");
    expect(PIPE).toContain("return !genre && !short;");
    expect(PIPE).toContain("const longEnough = rapidSearchRowsLongerThanAShort(all, query);");
    expect(PIPE).toContain("const kept = all.filter((r) => lengthSec(r.lengthText) > YOUTUBE_SHORT_MAX_SEC);");
    expect(PIPE).toContain(".filter((r) => !youtubeResultIsShort(r.title, r.description))");
  });

  const poolDeps = (store = memoryYoutubeSearchBudgetStore(), details?: () => Promise<Map<string, { durationSec: number; embeddable: boolean; live: boolean }>>): PoolDeps => ({
    store,
    llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Rome", recurringSubjects: [], query: "Rome Carthage" }) } }] }),
    gate: () => ({ ok: true }),
    search: async () => ({
      status: 200,
      items: [
        { videoId: "shortlen000", title: "Rome Carthage", description: "", channel: "c", thumb: "t" },
        { videoId: "hashtag0000", title: "Rome Carthage #shorts", description: "", channel: "c", thumb: "t" },
        { videoId: "documentary", title: "Rome and Carthage — the Punic Wars", description: "", channel: "c", thumb: "t" },
      ],
    }),
    details:
      details ??
      (async () =>
        new Map([
          ["shortlen000", { durationSec: 58, embeddable: true, live: false }],
          ["hashtag0000", { durationSec: 600, embeddable: true, live: false }],
          ["documentary", { durationSec: 900, embeddable: true, live: false }],
        ])),
    triage: async () => ({ footageType: "real_footage", servesBeats: [0], depicts: "" }),
    archive: async () => [],
    notFootage: () => null,
    log: () => {},
  });

  it("the whole-video pool drops a Short by its measured length and by its hashtag", async () => {
    const pool = await buildVideoYoutubePool(poolDeps(), { ...roman, videoId: 613_301 });
    const byId = new Map(pool.candidates.map((c) => [c.videoId, c]));
    expect(byId.get("shortlen000")?.usable).toBe(false);
    expect(byId.get("shortlen000")?.why).toContain("youtube short");
    expect(byId.get("hashtag0000")?.usable).toBe(false);
    expect(byId.get("hashtag0000")?.why).toContain("shorts hashtag");
    expect(byId.get("documentary")?.usable).toBe(true);
  });

  it("a search result whose length could not be read is not fetched", async () => {
    const pool = await buildVideoYoutubePool(poolDeps(undefined, async () => { throw new Error("videos.list down"); }), { ...roman, videoId: 613_302 });
    expect(pool.candidates.filter((c) => c.from !== 0).every((c) => !c.usable)).toBe(true);
    expect(pool.candidates.find((c) => c.videoId === "documentary")?.why).toContain("length unknown");
  });

  it("a pool stored by an earlier attempt is asked again: its Shorts are no longer usable", async () => {
    const store = memoryYoutubeSearchBudgetStore();
    const cand = (videoId: string, durationSec: number, title = "Rome Carthage") => ({
      videoId, title, description: "", thumb: "t", durationSec, footageType: "real_footage" as const, serves: [0], from: 1 as const, usable: true, why: "ok",
    });
    await store.record(613_303, {
      poolJson: JSON.stringify({
        videoId: 613_303, sentences: [], query1: "Rome Carthage", query2: null, searches: 1,
        candidates: [cand("oldshort000", 40), cand("oldtagged00", 700, "Rome #yts"), cand("olddocument", 1200)],
        coverage1: 1, archiveUsable: 0, search2Needed: false, search2Reason: "", finalCoverage: 1, decided: true,
      }),
    } as never);
    const pool = await buildVideoYoutubePool(poolDeps(store), { ...roman, videoId: 613_303 });
    const byId = new Map(pool.candidates.map((c) => [c.videoId, c]));
    expect(byId.get("oldshort000")?.usable).toBe(false);
    expect(byId.get("oldtagged00")?.usable).toBe(false);
    expect(byId.get("olddocument")?.usable).toBe(true);
  });

  it("the background downloader skips a Short before any download — by hashtag, length, or unknown length", async () => {
    const { prefetchOneVideo, decidePrefetchVerdict } = await import("./youtubePrefetch");
    const downloads: string[] = [];
    const deps = (sec: number) => ({
      isIdle: () => true,
      sourceDurationSec: async () => sec,
      download: async (p: { videoId: string }) => { downloads.push(p.videoId); return { ok: false, reason: "test" }; },
      videoRefusal: () => null,
      probeDurationSec: async () => 0,
      ingest: async () => ({ status: "refused", reasonCode: "UNKNOWN", reasonDetail: "test" }) as never,
      release: () => {},
      makeWorkDir: () => "/tmp/fastvid-test-prefetch-none",
      removeWorkDir: () => {},
    });
    const row = (videoId: string, title: string) => ({ videoId, title, query: "Kim Kardashian", licenseMode: null });
    for (const [r, sec] of [
      [row("k7zrnzAk9oE", "Oh No khloe even didn't Notice kim kardashian Revenge😂 #yts"), 600],
      [row("shortlength", "Kim Kardashian at the Met Gala"), 42],
      [row("nolength000", "Kim Kardashian at the Met Gala"), 0],
    ] as const) {
      const got = await prefetchOneVideo(r, deps(sec));
      expect(got.videoRefusal).toContain("youtube_short");
      expect(decidePrefetchVerdict({ attempts: 1, segments: got.segments, videoRefusal: got.videoRefusal, interrupted: false, now: 0 }).status).toBe("refused");
    }
    expect(downloads, "no Short may reach the downloader").toEqual([]);
    /** A real documentary still downloads. */
    await prefetchOneVideo(row("documentary", "Kim Kardashian: the full story"), deps(1500));
    expect(downloads.length).toBeGreaterThan(0);
    expect(new Set(downloads)).toEqual(new Set(["documentary"]));
  });

  it("the archive: a YouTube asset with a Shorts hashtag is never offered; a vertical one is refused before any look", () => {
    const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(CURATED).toContain('(a) => !(/youtube/i.test(a.sourcePlatform ?? "") && youtubeResultIsShort(a.title))');
    const vertical = CURATED.indexOf("dims.height > dims.width");
    expect(vertical).toBeGreaterThan(-1);
    /** Before the text check and the picture editor. */
    expect(vertical).toBeLessThan(CURATED.indexOf("hasBakedText = await archiveClipHasBakedEditText(rawPath, asset.mimeType);"));
  });

  it("the pool measures the archive's YouTube items too, and never triages a Short's thumbnail", async () => {
    const triaged: string[] = [];
    const deps: PoolDeps = {
      ...poolDeps(undefined, async () =>
        new Map([
          ["shortlen000", { durationSec: 58, embeddable: true, live: false }],
          ["hashtag0000", { durationSec: 600, embeddable: true, live: false }],
          ["documentary", { durationSec: 900, embeddable: true, live: false }],
          ["archShort00", { durationSec: 30, embeddable: true, live: false }],
          ["archLong000", { durationSec: 1200, embeddable: true, live: false }],
        ])),
      archive: async () => [
        { videoId: "archShort00", title: "Rome", description: "", channel: "archive", thumb: "t" },
        { videoId: "archLong000", title: "Rome", description: "", channel: "archive", thumb: "t" },
        { videoId: "archNoLen00", title: "Rome", description: "", channel: "archive", thumb: "t" },
      ],
      triage: async (it) => { triaged.push(it.videoId); return { footageType: "real_footage", servesBeats: [0], depicts: "" }; },
    };
    const pool = await buildVideoYoutubePool(deps, { ...roman, videoId: 613_304 });
    const byId = new Map(pool.candidates.map((c) => [c.videoId, c]));
    expect(byId.get("archShort00")?.usable).toBe(false);
    expect(byId.get("archNoLen00")?.usable).toBe(false);
    expect(byId.get("archLong000")?.usable).toBe(true);
    expect(triaged.sort()).toEqual(["archLong000", "documentary"]);
  });
});

/* ═══════════ J — video 614: no burnt-in subtitle, text asked before vision, every question names something ═══════════ */

describe("J. video 614 — our own subtitle no longer refuses a clip; text is asked first; no nameless questions", () => {
  const fnBody = (name: string) => {
    const at = PIPE.indexOf(name);
    const next = PIPE.slice(at + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s/);
    return PIPE.slice(at, at + 1 + next);
  };

  it("the fair-use transform burns no narration subtitle into the clip any more", () => {
    const body = fnBody("async function transformClipForFairUse(");
    expect(body).not.toContain("drawtext");
    /** The transformation itself stays: reframing, grade, vignette. */
    expect(body).toContain("vignette=angle=");
    expect(body).toContain("eq=contrast=");
  });

  it("the on-screen-text question comes before the picture editor, under the archive's own key", () => {
    const at = PIPE.indexOf('refuse("baked_edit_text_before_vision")');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(PIPE.indexOf('if ((await isMostlyBlackClip(p)) && refuse("mostly_black")) continue;'));
    const loopEnd = PIPE.indexOf("async function tryStockSources(");
    const judged = PIPE.slice(at, loopEnd).search(/judgeBeatClipRelevance|clipPassesVisionGate|beatClipPassesVisionGate/);
    expect(judged, "the picture editor is asked after the text check").toBeGreaterThan(0);
    /** Same key expression as the push gate's remoteUrl, so the verdict is read back, not paid twice. */
    const key = fnBody("function onScreenTextVerdictKey(");
    const push = fnBody("async function ensureArchiveBackedBeforePush(");
    expect(key).toContain("root?.sourceUrl ?? root?.originalUrl ?? cached?.canonicalUrl ?? null");
    expect(push).toContain("remoteUrl: root.sourceUrl ?? root.originalUrl ?? cached?.canonicalUrl ?? null");
  });

  it("render 614's nameless questions are not sent", () => {
    expect(sentenceOnlyYoutubeQueries(["examining true"], "We are examining the true story of the family.")).toEqual([]);
    expect(sentenceOnlyYoutubeQueries(["climax uncovers"], "The climax uncovers what the cameras never showed.")).toEqual([]);
    expect(sentenceOnlyYoutubeQueries(["Let"], "Let's look at how they built it.")).toEqual([]);
  });

  it("questions that name someone or something still go out", () => {
    expect(
      sentenceOnlyYoutubeQueries(["Kourtney Kardashian Los Angeles"], "The show followed Kourtney Kardashian in Los Angeles.")
    ).toEqual(["Kourtney Kardashian Los Angeles"]);
    expect(sentenceOnlyYoutubeQueries(["Instagram"], "Their fame moved to Instagram.")).toEqual(["Instagram"]);
    expect(sentenceOnlyYoutubeQueries(["Kim Kardashian"], "Kim Kardashian built a fortune.")).toEqual(["Kim Kardashian"]);
    /** A first word is a name when FastVid knows the place, or the scene writes it again. */
    expect(sentenceOnlyYoutubeQueries(["Rome citizenship"], "Rome offered citizenship.", "", "", ["rome"])).toEqual(["Rome citizenship"]);
    expect(
      sentenceOnlyYoutubeQueries(["Rome"], "Rome was small.", "", "Rome offered citizenship. Rome was small.")
    ).toEqual(["Rome"]);
  });

  it("an opening capital is grammar, an era abbreviation is no subject", () => {
    expect([...sentenceNameWords("Let's look at how they built it.")]).toEqual([]);
    expect([...sentenceNameWords("Centuries later, Washington borrowed the idea.")]).toEqual(["washington"]);
    expect([...sentenceNameWords("Carthage fell in 146 BC.")]).toEqual([]);
    expect([...sentenceNameWords("Carthage fell in 146 BC.", "Rome fought Carthage. Carthage fell in 146 BC.")]).toEqual(["carthage"]);
  });

  it("a sentence whose question named nothing borrows its neighbour's name instead", () => {
    const sentences = ["Kris Jenner saw the chance.", "Let's look at how she built it."];
    const sceneText = sentences.join(" ");
    const plan = youtubeQueryPlanForSentence(["Let", "Kris Jenner archival footage"], sentences[1], sceneText);
    expect(plan).toEqual({ queries: ["Kris Jenner"], from: "previous" });
  });
});

/* ═══════════ K — subtitles in pieces with the voice; short videos can plan a search; more time to find pictures ═══════════ */

describe("K. subtitles, the whole-video search on short videos, and the picture-finding time", () => {
  it("a long sentence becomes pieces of at most two 42-character lines, ending at a pause where one falls", async () => {
    const { planSubtitleChunks, SUBTITLE_CHARS_PER_LINE } = await import("./cinematicEditingEngine/captionPlanner");
    const text =
      "Kim Kardashian built a billion-dollar fortune from skincare, shapewear and a reality show that ran for twenty seasons on cable television.";
    const chunks = planSubtitleChunks(text, 10, 8);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const lines: string[] = [];
      for (const w of c.text.split(" ")) {
        const last = lines[lines.length - 1];
        if (last !== undefined && (last + " " + w).length <= SUBTITLE_CHARS_PER_LINE) lines[lines.length - 1] = last + " " + w;
        else lines.push(w);
      }
      expect(lines.length, c.text).toBeLessThanOrEqual(2);
    }
    expect(chunks[0]!.text.endsWith("skincare,")).toBe(true);
    /** Every word once, in order; the pieces follow each other and fill the beat exactly. */
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
    expect(chunks[0]!.startSec).toBe(10);
    expect(chunks[chunks.length - 1]!.endSec).toBe(18);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startSec).toBe(chunks[i - 1]!.endSec);
  });

  it("with the voice's word timing, each piece starts when its first word is spoken", async () => {
    const { planSubtitleChunks } = await import("./cinematicEditingEngine/captionPlanner");
    const text = "Rome offered its enemies citizenship, and they became Romans within a single generation of peace.";
    const words = text.split(" ").map((word, i) => ({ word, startSec: 20 + i * 0.5, endSec: 20 + i * 0.5 + 0.4 }));
    const chunks = planSubtitleChunks(text, 20, 8, words);
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.text.startsWith("and they")).toBe(true);
    expect(chunks[1]!.startSec).toBe(words[5]!.startSec);
  });

  it("the subtitle caption is split, and only when the video asks for subtitles", async () => {
    const { planCaptions } = await import("./cinematicEditingEngine/captionPlanner");
    const intent = {
      spokenText: "Kim Kardashian built a billion-dollar fortune from skincare, shapewear and a reality show that ran for twenty seasons.",
      events: [], people: [], visualLocation: "", visualTime: "", historicalContext: "",
    } as never;
    const on = planCaptions(intent, 0, 7, { includeSubtitle: true }).filter((c) => c.captionType === "subtitle");
    expect(on.length).toBeGreaterThan(1);
    expect(planCaptions(intent, 0, 7, { includeSubtitle: false }).filter((c) => c.captionType === "subtitle")).toEqual([]);
    const EDL = fs.readFileSync(path.join(__dirname, "cinematicEditingEngine/edlGenerator.ts"), "utf8");
    expect(EDL).toContain("wordTimings: input.wordTimings,");
  });

  it("render 614's whole-video question is no longer refused as 'built on one scene'", () => {
    const kardashians = {
      prompt: "How the Kardashians built their wealth",
      title: "Kardashian Wealth",
      sceneTexts: [
        "The Kardashians turned fame into a business. Their TV show made them household names.",
        "Kourtney Kardashian filmed in Los Angeles for years. The Kardashians sold the TV show to Hulu.",
        "Kylie Jenner and Kim Kardashian built empires on Instagram.",
      ],
    };
    const a = analyzeVideo(kardashians);
    const allow = (): GateVerdict => ({ ok: true });
    /** "Los Angeles" is one subject; TV recurs in two sentences of a three-scene video. */
    expect(refuseQuery("Kardashian TV Los Angeles", { analysis: a, mainSubject: "Kardashian", gate: allow })).toBeNull();
    expect(refuseQuery("Kardashian Los Angeles", { analysis: a, mainSubject: "Kardashian", gate: allow })).toBeNull();
    /** Two genuinely different one-scene subjects are still refused. */
    expect(refuseQuery("Kardashian Hulu Instagram", { analysis: a, mainSubject: "Kardashian", gate: allow })).toContain("built on one scene");
  });

  it("a one-minute video gets about 40% of its render time to find pictures, the total unchanged", async () => {
    const { computeRenderBudget } = await import("./renderBudget");
    const b = computeRenderBudget(3, 60, "1");
    expect(b.perSceneRetrieveMs * 3).toBeGreaterThanOrEqual(150_000);
    expect(b.perSceneRetrieveMs).toBeLessThanOrEqual(55_000);
    expect(b.totalMs).toBe(computeRenderBudget(3, 60, "1").totalMs);
  });
});

/* ═══════════ L — the picture editor's guessed identity is not an approval ═══════════ */

describe("L. an approval that rests on a guess about who is on screen is refused", () => {
  const fits = (depicts: string, reason: string) => ({ verdict: "fits" as const, depicts, reason });

  it("render 614's two guessed approvals are refused", async () => {
    const { approvalRestsOnAGuess } = await import("./beatImageRelevanceGate");
    const line = "Kim Kardashian and her sisters turned a reality show into an empire.";
    expect(
      approvalRestsOnAGuess(
        fits("Woman wearing eyeglasses seated indoors, modern setting.", "The subject appears to be one of the Kardashians mentioned in the narration, fitting the description of reality TV stars."),
        line
      )
    ).toBe(true);
    expect(
      approvalRestsOnAGuess(
        fits("A well-known person seated in a restaurant or similar setting. E! logo visible.", "The person shown is part of the Kardashian family or associated with them. The E! logo suggests a connection."),
        line
      )
    ).toBe(true);
  });

  it("an approval where the judge names the person it sees stays, hedged or not", async () => {
    const { approvalRestsOnAGuess } = await import("./beatImageRelevanceGate");
    expect(
      approvalRestsOnAGuess(
        fits("Adolf Hitler giving a speech, likely during World War II era.", "Adolf Hitler is on screen, likely during the war."),
        "Adolf Hitler chose suicide over escape in April 1945."
      )
    ).toBe(false);
    expect(
      approvalRestsOnAGuess(
        fits("An outdoor scene with a woman in a blue bikini, Kris Jenner, crew, and an elephant.", "Kris Jenner is on screen, which matches the narration."),
        "Kris Jenner steered the family business."
      )
    ).toBe(false);
  });

  it("an approval for the place or the period, or under a line that names nobody, is untouched", async () => {
    const { approvalRestsOnAGuess } = await import("./beatImageRelevanceGate");
    expect(
      approvalRestsOnAGuess(fits("Berlin in ruins, 1945.", "The place and period the line describes; likely spring 1945."), "The investigation began in Berlin in 1945.")
    ).toBe(false);
    expect(
      approvalRestsOnAGuess(fits("A crowded street market.", "It appears to be the kind of market the line describes."), "Trade made the city rich.")
    ).toBe(false);
    expect(approvalRestsOnAGuess({ verdict: "does_not_fit", depicts: "x", reason: "appears to be someone" }, "Kim Kardashian spoke.")).toBe(false);
  });

  it("the refusal is applied to fresh and to stored verdicts alike", () => {
    const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(GATE).toContain("storedRaw ? refuseGuessedIdentity(storedRaw, beatText, params.anchors?.subject) : null");
    expect(GATE).toContain("const judgement = refuseGuessedIdentity(judgementAsGiven, beatText, params.anchors?.subject);");
  });
});
