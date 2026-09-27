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
import { analyzeVideo, refuseQuery, type GateVerdict } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  poolGaveNoYoutube,
  registerVideoYoutubePool,
  releaseVideoYoutubePool,
  videoYoutubePoolGaveNoYoutube,
  type PoolDeps,
} from "./youtubeVideoPool";
import { extractPersonNamesFromText, resolvePrimaryPersonLock, narrationWithoutHeadings, buildVerifiedQueryContextForBeat } from "./videoPipeline";
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
