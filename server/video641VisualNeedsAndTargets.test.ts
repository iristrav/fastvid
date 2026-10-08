import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { MAX_STOCK_VIDEOS, STOCK_FIRST_BATCH, stockOrder } from "./youtubeShotStock";
import { queryNames, type GateVerdict, type PlannerInput, type VisualNeed } from "./youtubeVideoSearchPlanner";
import {
  buildVideoYoutubePool,
  formatMultiPersonOutcome,
  type NamedSubject,
  type PoolCandidate,
  type PoolDeps,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import { formatSentencePictures, pictureIsHidden, youtubeFootageInTimeline } from "./youtubeFootageInFilm";
import type { TimelineVideoClip } from "./projectTimeline";
import { beatNamedEntitiesByKind, extractPersonNamesFromText, formatTargetedPoolEntry, youtubeRescueCandidates } from "./videoPipeline";

/**
 * VIDEO 641 — OBSERVABILITY ONLY: what happened to every targeted YouTube answer, said in the log.
 *
 * targeted search → candidate → rescue yes/no → place in the stock's order (indicative) →
 * DOWNLOAD_STARTED → DOWNLOAD_SUCCEEDED / DOWNLOAD_FAILED → DOWNLOADED / ADOPTED / FINAL_VIDEO →
 * the sentence's picture. Nothing here changes which searches, stock or pictures a render gets.
 */

const namedSubjects = (sentence: string): NamedSubject[] => {
  const e = beatNamedEntitiesByKind(sentence);
  return [
    ...extractPersonNamesFromText(sentence).map((name) => ({ name, kind: "name" as const })),
    ...e.companies.map((name) => ({ name, kind: "company" as const })),
    ...e.brands.map((name) => ({ name, kind: "brand" as const })),
  ];
};

/* ── 641's script and the planner's own needs list ── */
const SCRIPT_641: PlannerInput = {
  prompt: "Why the Kardashians are not as rich as they look",
  title: "The Kardashian Wealth Illusion",
  sceneTexts: [
    "Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think. " +
      "Their famous mansions dominate the headlines. Yet the numbers tell another story.",
    "Much of the Kardashian wealth is an illusion, with assets locked in real estate and ventures controlled by Kris Jenner. " +
      "Their wealth is a mirage shaped by media trends and unpredictable projections. Fame pays, but not forever.",
    "Finance analysts reveal that the Kardashians' income relies heavily on Kris Jenner and volatile social media monetization. " +
      "The Kardashians still spend like billionaires. " +
      "In the Calabasas corporate office, accountants lay out the stark reality: operational expenses are huge. " +
      "Kim Kardashian's hype creation keeps the public guessing.",
  ],
};
const NEEDS_641: VisualNeed[] = [
  { subject: "Kardashians", beats: [0, 3, 6, 7] },
  { subject: "Kris Jenner", beats: [3, 6] },
  { subject: "Calabasas corporate office", beats: [8] },
  { subject: "Finance analysts", beats: [6] },
  { subject: "Kim Kardashian hype creation", beats: [9] },
  { subject: "Accountants in office", beats: [8] },
];

/* ── 641 replayed through the pool: every need gets its [VISUAL_NEED] line ── */
type Video = { title: string; shows: string[] };
const ids = new Map<string, string>();
const idOf = (title: string) => {
  if (!ids.has(title)) ids.set(title, `k${String(ids.size + 1).padStart(10, "0")}`);
  return ids.get(title)!;
};
const same = (a: string, b: string) => queryNames(a, b) && queryNames(b, a);
const many = (subject: string, kinds: string[], shows = [subject]): Video[] => kinds.map((k) => ({ title: `${subject} ${k}`, shows }));
function deps641(catalogue: Record<string, Video[]>): PoolDeps & { searches: string[]; lines: string[] } {
  const searches: string[] = [];
  const lines: string[] = [];
  const byTitle = new Map(Object.values(catalogue).flat().map((v) => [v.title, v]));
  let asked = 0;
  return {
    searches,
    lines,
    store: memoryYoutubeSearchBudgetStore(),
    llm: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              ++asked === 1
                ? { mainSubject: "Kardashians", recurringSubjects: [], query: "Kim Kardashian", visualNeeds: NEEDS_641 }
                : { mainSubject: "Kardashians", recurringSubjects: [], query: "Kardashians mansions" }
            ),
          },
        },
      ],
    }),
    gate: (q: string): GateVerdict => ({ ok: true, sentAs: q }),
    search: async (query) => {
      searches.push(query);
      const found = Object.entries(catalogue).filter(([s]) => queryNames(query, s)).flatMap(([, v]) => v);
      return { status: 200, items: found.map((v): SearchItem => ({ videoId: idOf(v.title), title: v.title, description: "", channel: "c", thumb: "t" })) };
    },
    details: async (list) => new Map(list.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
    triage: async (it, _t, sentences, subjects = []): Promise<Triage> => {
      const v = byTitle.get(it.title)!;
      return {
        footageType: "real_footage",
        servesBeats: sentences.map((_, i) => i),
        depicts: "",
        shows: subjects.map((s, k) => (v.shows.some((x) => same(x, s)) ? k : -1)).filter((k) => k >= 0),
      };
    },
    archive: async () => [],
    namedSubjects,
    log: (l) => lines.push(l),
  };
}
const CATALOGUE_641: Record<string, Video[]> = {
  "Kim Kardashian": many("Kim Kardashian", ["red carpet", "interview", "Met Gala", "SNL", "Skims launch", "home tour"], ["Kim Kardashian", "Kardashians"]),
  "Kris Jenner": many("Kris Jenner", ["interview", "mansion tour"]),
  Calabasas: many("Calabasas", ["aerial view", "gated estates"]),
  "Finance analysts": many("Finance analysts", ["explain markets"]),
};

describe("VISUAL_NEED — every need of the script says whether a search was aimed at it", () => {
  it("641 replayed: one line per need, and each targeted search names its own query", async () => {
    const d = deps641(CATALOGUE_641);
    const pool = await buildVideoYoutubePool(d, { videoId: 6410, ...SCRIPT_641 });
    expect(d.searches.length).toBeLessThanOrEqual(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    const need = d.lines.filter((l) => l.startsWith("[VISUAL_NEED] video=6410 "));
    expect(need.length).toBeGreaterThan(0);
    for (const l of need) {
      expect(l).toMatch(/ subject="[^"]+" kind=\w+ sentences=\[[\d,]*\] score=\d+ covered_before=(yes|no|asked) searched=(no|#\d query="[^"]*"( \((main search|coverage gap)\))?) covered_now=(yes|no)( reason=(budget_spent|no_query))?$/);
    }
    /** every targeted search is on the line of the subject it was aimed at */
    expect(pool.entityTargets?.length).toBeGreaterThan(0);
    for (const t of pool.entityTargets ?? []) {
      expect(need.some((l) => l.includes(`subject="${t.name}"`) && l.includes(`searched=#${t.n} query="${t.query}"`))).toBe(true);
    }
    /** the planner's list, as before */
    expect(d.lines.some((l) => l.startsWith("[VISUAL_NEEDS] video=6410 planner="))).toBe(true);
  });
});

/* ── the targeted answers in the stock: logged, so "0 downloads" says why ── */
const cand = (videoId: string, from: number, serves: number[], shows?: string[]): PoolCandidate => ({
  videoId, title: `title ${videoId}`, description: "", thumb: "", durationSec: 300, footageType: "real_footage",
  serves, from, usable: true, why: "ok", ...(shows ? { shows } : {}),
});
const TARGET = { name: "Calabasas", kind: "subject" as const, beats: [8], reason: "missing_visual_subject", n: 3, query: "Calabasas footage", score: 2 };

describe("TARGETED PIPELINE — every targeted answer's place in the stock's order, marked indicative", () => {
  const main = Array.from({ length: 9 }, (_, i) => cand(`main${i}`, 1, [0, 1, 2, 3, 4, 5, 6, 7, 9], ["Kim Kardashian"]));
  const seen = cand("calab_seen", 3, [8], ["Calabasas"]);
  const unseen = cand("calab_unseen", 3, [], []);
  const pool = { entityTargets: [TARGET] };

  it("rescue=yes → slot 1 of the first batch; the look did not see it → a spare, behind the ten, with the reason", () => {
    const usable = [...main, seen, unseen];
    const rescue = youtubeRescueCandidates(pool, usable);
    expect([...rescue]).toEqual(["calab_seen"]);
    const lines = formatTargetedPoolEntry(641, pool, usable, rescue);
    expect(lines[0]).toBe(
      `[TARGETED_VISUAL] film=641 subject="Calabasas" search=#3 videoId=calab_seen stage=POOL slot=1/${STOCK_FIRST_BATCH} order=indicative rescue=yes serves=1 title="title calab_seen"`
    );
    expect(lines[1]).toBe(
      '[TARGETED_VISUAL] film=641 subject="Calabasas" search=#3 videoId=calab_unseen stage=SPARE position=1 (asked only if a pool video fails) order=indicative ' +
        'rescue=no reason=the_look_did_not_see_the_subject_and_assigned_none_of_its_sentences serves=0 title="title calab_unseen"'
    );
  });

  it("serving its sentence but over the rescue cap → rescue=no reason=over_the_rescue_cap; VIDEO 642 — the only video for its sentence enters the first batch", () => {
    /** three subjects' worth of rescue answers fill the cap of three; the fourth serves its sentence and waits */
    const others = ["A", "B", "C"].map((s, i) => ({ name: s, kind: "subject" as const, beats: [i], reason: "missing_visual_subject", n: 2, query: `${s} footage`, score: 2 }));
    const targets = [...others, TARGET];
    const rescued = [cand("a1", 2, [0], ["A"]), cand("b1", 2, [1], ["B"]), cand("c1", 2, [2], ["C"])];
    const capped = cand("calab_capped", 3, [8], ["Calabasas"]);
    const fill = Array.from({ length: 4 }, (_, i) => cand(`m${i}`, 1, [0, 1, 2, 3, 4, 5]));
    const usable = [...rescued, ...fill, capped];
    const rescue = new Set(["a1", "b1", "c1"]);
    const lines = formatTargetedPoolEntry(641, { entityTargets: targets }, usable, rescue);
    expect(lines.find((l) => l.includes("videoId=calab_capped"))).toBe(
      '[TARGETED_VISUAL] film=641 subject="Calabasas" search=#3 videoId=calab_capped stage=POOL slot=5/6 order=indicative ' +
        'rescue=no reason=over_the_rescue_cap serves=1 title="title calab_capped"'
    );
  });

  it("W6: the order is the stock's own — a video shown recently moves behind the fresh ones, as in the stock", () => {
    const usable = [seen, ...main.slice(0, 6)];
    const shown = (id: string) => id === "calab_seen";
    /** not rescued, shown recently: the stock fetches the six fresh videos first */
    const lines = formatTargetedPoolEntry(641, pool, usable, new Set(), shown);
    expect(lines[0]).toContain("videoId=calab_seen stage=MORE position=1 ");
    const real = stockOrder(usable.map((c) => ({ videoId: c.videoId, title: c.title, durationSec: 300, serves: c.serves.length, beats: c.serves, shownRecently: shown(c.videoId) })), usable.length);
    expect(real.findIndex((c) => c.videoId === "calab_seen")).toBe(6);
  });

  it("a targeted search with no usable answer says so", () => {
    expect(formatTargetedPoolEntry(641, pool, main, new Set())).toEqual([
      '[TARGETED_VISUAL] film=641 subject="Calabasas" search=#3 stage=NO_USABLE_RESULT — nothing to stock',
    ]);
  });

  it("the pipeline logs the stock entry with W6 and labels each targeted answer for the stock's own lines", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("for (const line of formatTargetedPoolEntry(filmId, pool, usable, rescue, shownRecently)) console.log(line);");
    expect(PIPE).toContain('...(targetOf(c) ? { targetLabel: `subject="${targetOf(c)!.name}" search=#${targetOf(c)!.n}` } : {}),');
  });
});

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-641-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const video = (file: string, seconds: number): string => {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=gray:s=64x36:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
};

describe("TARGETED PIPELINE — the stock's own lines for a targeted answer: started, succeeded, failed", () => {
  it("one targeted answer downloads, one fails: both are named with their subject and search", async () => {
    const { startYoutubeShotStock, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
    const lines: string[] = [];
    startYoutubeShotStock(
      6_411,
      [
        { videoId: "calab_ok", title: "Calabasas aerial", durationSec: 60, serves: 1, rescue: true, targetLabel: 'subject="Calabasas" search=#3' },
        { videoId: "calab_bad", title: "Calabasas estates", durationSec: 60, serves: 1, rescue: true, targetLabel: 'subject="Calabasas" search=#3' },
        { videoId: "kim_main", title: "Kim Kardashian interview", durationSec: 60, serves: 5 },
      ],
      {
        workDir: dir,
        download: async (id, _s, _d, out) => (id === "calab_bad" ? false : fs.existsSync(video(out, 8))),
        cut: async (file) => [{ path: file, startSec: 0, endSec: 8 }],
        startFor: () => 0,
        log: (l) => lines.push(l),
      }
    );
    await youtubeStockSettled(6_411);
    releaseYoutubeShotStock(6_411);
    const targeted = lines.filter((l) => l.startsWith("[TARGETED_VISUAL]"));
    expect(targeted).toContain('[TARGETED_VISUAL] subject="Calabasas" search=#3 videoId=calab_ok stage=DOWNLOAD_STARTED film=6411');
    expect(targeted).toContain('[TARGETED_VISUAL] subject="Calabasas" search=#3 videoId=calab_ok stage=DOWNLOAD_SUCCEEDED shots=1');
    expect(targeted).toContain('[TARGETED_VISUAL] subject="Calabasas" search=#3 videoId=calab_bad stage=DOWNLOAD_FAILED reason="the download delivered nothing"');
    /** the main subject's video is stocked as before, unlabelled */
    expect(lines.some((l) => l.includes("video=kim_main ready"))).toBe(true);
    expect(targeted.some((l) => l.includes("kim_main"))).toBe(false);
  });

  it("a targeted spare that replaces a failed download: the stock's 'replaces' line, then its own STARTED/SUCCEEDED", async () => {
    const { startYoutubeShotStock, youtubeStockSettled, releaseYoutubeShotStock } = await import("./youtubeShotStock");
    const lines: string[] = [];
    const planned = Array.from({ length: MAX_STOCK_VIDEOS }, (_, i) => ({ videoId: `plan${i}`, title: `plan ${i}`, durationSec: 60, serves: 20 - i }));
    startYoutubeShotStock(
      6_412,
      [...planned, { videoId: "calab_spare", title: "Calabasas aerial", durationSec: 60, serves: 1, targetLabel: 'subject="Calabasas" search=#3' }],
      {
        workDir: dir,
        download: async (id, _s, _d, out) => (id === "plan0" ? false : fs.existsSync(video(out, 8))),
        cut: async (file) => [{ path: file, startSec: 0, endSec: 8 }],
        startFor: () => 0,
        log: (l) => lines.push(l),
      }
    );
    await youtubeStockSettled(6_412);
    /** VIDEO 642 — the wait covers the first batch; the spare runs once the rest of the ten are done. */
    for (let i = 0; i < 300 && !lines.some((l) => l.includes("calab_spare stage=DOWNLOAD_SUCCEEDED")); i++) await new Promise((r) => setTimeout(r, 50));
    releaseYoutubeShotStock(6_412);
    const replaces = lines.findIndex((l) => l.startsWith("[YouTubeStock] film=6412 video=calab_spare replaces a failed download ("));
    const started = lines.indexOf('[TARGETED_VISUAL] subject="Calabasas" search=#3 videoId=calab_spare stage=DOWNLOAD_STARTED film=6412');
    expect(replaces).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(replaces);
    expect(lines).toContain('[TARGETED_VISUAL] subject="Calabasas" search=#3 videoId=calab_spare stage=DOWNLOAD_SUCCEEDED shots=1');
  });
});

describe("TARGETED PIPELINE — how far each answer came, at the end of the render", () => {
  const pool: Pick<VideoYoutubePool, "entityTargets" | "candidates" | "searches"> = {
    searches: 3,
    entityTargets: [TARGET],
    candidates: [cand("calab_fit", 3, [8], ["Calabasas"]), cand("calab_refused", 3, [8], ["Calabasas"]), cand("main0", 1, [0])],
  };

  it("refused by the picture editor → DOWNLOADED; adopted → ADOPTED; placed via the archive → FINAL_VIDEO with its film seconds", () => {
    const rows = [
      { providerAssetId: "calab_refused", sceneIndex: 2, beatIndex: 2, downloaded: true, adopted: false, finalVideo: false },
      { providerAssetId: "calab_fit", sceneIndex: 2, beatIndex: 2, downloaded: true, adopted: true, finalVideo: false },
      { providerAssetId: "main0", sceneIndex: 0, beatIndex: 0, downloaded: true, adopted: true, finalVideo: true },
    ];
    expect(formatMultiPersonOutcome(641, pool, rows)).toContain(
      '[TARGETED_VISUAL] video=641 subject="Calabasas" search=#3 videoId=calab_fit stage=ADOPTED sentences=[s2b2]'
    );
    const lines = formatMultiPersonOutcome(641, pool, rows, [
      /** the adopted answer reached the film as an archive clip cut from it */
      { videoId: "calab_fit", origin: "youtube_via_archive", seconds: 4.4 },
      { videoId: "main0", origin: "youtube_direct", seconds: 4.56 },
    ]);
    expect(lines).toContain('[TARGETED_VISUAL] video=641 subject="Calabasas" search=#3 videoId=calab_refused stage=DOWNLOADED sentences=[s2b2]');
    expect(lines).toContain('[TARGETED_VISUAL] video=641 subject="Calabasas" search=#3 videoId=calab_fit stage=FINAL_VIDEO sentences=[s2b2] filmSec=4.4 via=youtube_via_archive');
    expect(lines).toContain('[MULTI_PERSON_OUTCOME] video=641 entity="Calabasas" search=#3 downloaded=2 adopted=1 final=0 entityBeats=[8] filmSec=4.4');
    expect(lines.at(-1)).toBe("[MULTI_PERSON_SUMMARY] video=641 searches=3 targeted_searches=1 targeted_downloaded=2 targeted_adopted=1 targeted_final=0 targeted_film_sec=4.4");
    /** the main subject's video is never counted as targeted */
    expect(lines.some((l) => l.includes("main0"))).toBe(false);
  });
});

/* ── ATTRIBUTION: what each sentence shows in the rendered film ── */
const clip = (over: Partial<TimelineVideoClip> & { id: string; timelineStart: number; timelineEnd: number }): TimelineVideoClip =>
  ({ source: { provider: "youtube_cc", providerAssetId: "UJT6QkAriVQ" }, previewSource: { kind: "none" }, ...over }) as unknown as TimelineVideoClip;
/** 641's rendered timeline, simplified: two real shots, the rest chapter cards on a hidden ground. */
const TIMELINE_641: TimelineVideoClip[] = [
  clip({ id: "vc_29be997a9c", timelineStart: 0, timelineEnd: 4.56, sceneIndex: 0, beatIndex: 0 }),
  clip({ id: "vc_29be997a9c_graphic1", timelineStart: 4.56, timelineEnd: 9.12, sceneIndex: 0, beatIndex: 0, transform: { opacity: 0 } }),
  clip({ id: "vc_29be997a9c_graphic2", timelineStart: 9.12, timelineEnd: 18.24, sceneIndex: 0, beatIndex: 0, transform: { opacity: 0 } }),
  clip({ id: "vc_abdab95dd4", timelineStart: 18.24, timelineEnd: 26.84, sceneIndex: 1, beatIndex: 0, source: { provider: "youtube", archiveAssetId: 60416 } as never }),
  clip({ id: "vc_abdab95dd4_graphic4_p1", timelineStart: 26.84, timelineEnd: 57.27, sceneIndex: 1, beatIndex: 0, source: { provider: "youtube", archiveAssetId: 60416 } as never, transform: { opacity: 0 } }),
];
const ORIGINS = new Map([[60416, { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=UJT6QkAriVQ&t=135s" }]]);

describe("ATTRIBUTION — each sentence's picture, and the film's YouTube seconds the viewer sees", () => {
  it("B3: the [YouTubeInFilm] metric counts only visible clips — 641's 57.27 s was 13.16 s on screen", () => {
    const f = youtubeFootageInTimeline(TIMELINE_641, ORIGINS, "rendered_timeline");
    expect(f.youtubeSec).toBe(13.16);
    expect(f.clips.length).toBe(2);
    /** the film's own length is unchanged: the card is on screen for those seconds */
    expect(f.filmSec).toBe(57.27);
    /** the hidden grounds filtered first or not: the same YouTube clips */
    const visible = youtubeFootageInTimeline(TIMELINE_641.filter((c) => !pictureIsHidden(c)), ORIGINS, "rendered_timeline");
    expect(visible.clips).toEqual(f.clips);
    expect(pictureIsHidden(TIMELINE_641[4]!)).toBe(true);
    expect(pictureIsHidden(TIMELINE_641[0]!)).toBe(false);
  });

  it("sentence → clip → source: a YouTube clip that came through the archive keeps its YouTube video and its sentence", () => {
    const lines = formatSentencePictures(
      641,
      TIMELINE_641,
      ORIGINS,
      [
        { sceneIndex: 0, beatIndex: 0, text: "Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think." },
        { sceneIndex: 0, beatIndex: 1 },
        { sceneIndex: 1, beatIndex: 0 },
        { sceneIndex: 2, beatIndex: 0 },
      ],
      new Map([["s0b1", "chapter_card"]])
    );
    expect(lines).toEqual([
      '[SENTENCE_PICTURE] video=641 s0b0 footage=4.56s clips=1 [youtube:UJT6QkAriVQ 4.56s] "Despite their billion-dollar empire, the Kardashians may not be as cas"',
      "[SENTENCE_PICTURE] video=641 s0b1 footage=none picture=graphic:chapter_card",
      "[SENTENCE_PICTURE] video=641 s1b0 footage=8.60s clips=1 [youtube_via_archive:UJT6QkAriVQ (asset 60416) 8.60s]",
      "[SENTENCE_PICTURE] video=641 s2b0 footage=none picture=none",
      "[SENTENCE_PICTURE] video=641 TOTAL sentences=4 withFootage=2 withoutFootage=2",
    ]);
  });

  it("the pipeline prints it for the delivered film, and gives the outcome lines the same visible clips", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toContain("for (const line of formatSentencePictures(videoId, measured.clips, origins, sentences)) {");
    expect(PIPE).toContain("footage = youtubeFootageInTimeline(measured.clips, origins, measured.basis);");
    expect(PIPE).toContain("visibleFilm = footage.clips;");
    expect(PIPE).toContain("for (const l of formatMultiPersonOutcome(videoId, searchedPool, youtubeLifecycle, visibleFilm, (id) => stockVideoState(videoId, id)))");
  });
});
