/**
 * YOUTUBE SEARCH DRY RUN — "1 search per video, 2 at most": measured before it is built.
 *
 * Lives on the test branch `claude/youtube-search-dry-run` only. It is never merged and changes
 * nothing the product runs. Per topic:
 *
 *   FastVid's own script engine → scenes → beats (one per sentence, as buildSceneBeats does)
 *   → ONE planned query for the whole video → search.list (maxResults 50) → videos.list (1 unit)
 *   → local scoring: title genre filter, duration, CLIP thumbnail similarity per beat, and the
 *     vision model on each thumbnail (footage type + which beats it could serve)
 *   → the operator's archive, YouTube-origin assets only, counted SEPARATELY
 *   → coverage and the search-#2 rules, exactly as agreed → search #2 only when they say so,
 *     aimed at the biggest gap.
 *
 * No download, no render, no database write, no prefetch enqueue. Reads: the archive tables.
 * Hard cap: MAX_SEARCH_CALLS search.list calls for the whole run, counted before each request.
 * The API key is read from the environment and never printed: every logged string is scrubbed.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** Pass 1 spent 9 search.list calls; pass 2 may spend at most this many, so the run stays under 18. */
const MAX_SEARCH_CALLS = Number(process.env.DRY_RUN_MAX_SEARCHES ?? 6);
const VIDEO_LENGTH = "1";
const VIDEO_TYPE = "documentary";

const ALL_TOPICS: Array<{ category: string; prompt: string }> = [
  { category: "geschiedenis", prompt: "The fall of the Berlin Wall in 1989" },
  { category: "technologie", prompt: "How the smartphone changed the world" },
  { category: "gezondheid", prompt: "How artificial intelligence is changing healthcare" },
  { category: "business", prompt: "How Tesla became the world's most valuable car company" },
  { category: "reizen", prompt: "Exploring Japan: from Tokyo to Kyoto" },
  { category: "wetenschap", prompt: "How the James Webb Space Telescope sees the early universe" },
  { category: "bekende personen", prompt: "The life of Muhammad Ali" },
  { category: "actuele gebeurtenissen", prompt: "The 2026 FIFA World Cup in North America" },
  { category: "abstract", prompt: "Why do we procrastinate?" },
];
/** PASS 2 — only the topics named here (comma-separated categories); all of them when unset. */
const ONLY = (process.env.DRY_RUN_TOPICS ?? "gezondheid,business,abstract").split(",").map((t) => t.trim()).filter(Boolean);
const TOPICS = ONLY.length ? ALL_TOPICS.filter((t) => ONLY.includes(t.category)) : ALL_TOPICS;

/* ═══════════════════════ safety: the key never leaves this process ═══════════════════════ */

const KEY = (process.env.YOUTUBE_API_KEY ?? "").trim();
function scrub(s: string): string {
  return KEY ? s.split(KEY).join("[key]") : s;
}
function log(line: string): void {
  console.log(scrub(line));
}

let searchCalls = 0;
let videosListCalls = 0;

/* ═══════════════════════ types ═══════════════════════ */

type Beat = { index: number; sceneIndex: number; text: string };
type SearchItem = { videoId: string; title: string; description: string; channel: string; thumb: string };
type Details = { durationSec: number; embeddable: boolean; live: boolean; definition: string; license: string };
type Vision = {
  footageType: "real_footage" | "archival_footage" | "talking_head" | "text_or_graphic" | "animation_or_game" | "other";
  period: "historical" | "modern" | "unclear";
  servesBeats: number[];
  depicts: string;
};
type Candidate = SearchItem & {
  details: Details | null;
  genre: string | null;
  vision: Vision | null;
  clipBeats: number[];
  usable: boolean;
  why: string;
  beats: number[];
};
type SearchReport = {
  n: 1 | 2;
  query: string;
  gate: string;
  results: number;
  unique: number;
  notFootageByTitle: number;
  relevantText: number;
  footageTypes: Record<string, number>;
  usableVideos: number;
  multiBeatVideos: number;
  coveredBeats: number[];
  candidates: Candidate[];
};

/* ═══════════════════════ helpers ═══════════════════════ */

const STOP = new Set(
  "a an the of in on at to for from by with and or but is are was were be been this that these those how why what who when where which its it their his her our your as into over under about after before between during".split(" ")
);
const PRODUCTION_WORDS = new Set(["footage", "archival", "archive", "documentary", "newsreel", "film", "video", "b-roll", "broll", "stock", "clips", "clip"]);

function words(s: string): string[] {
  return s.toLowerCase().replace(/[|"()]/g, " ").split(/[^a-z0-9'-]+/).filter(Boolean);
}
function meaningfulWords(q: string): string[] {
  return words(q).filter((w) => !STOP.has(w) && !PRODUCTION_WORDS.has(w) && w !== "-");
}
function provable(word: string, evidence: string): boolean {
  const w = word.toLowerCase();
  if (/^\d{4}s?$/.test(w)) return evidence.includes(w.replace(/s$/, ""));
  const stem = w.length > 5 ? w.slice(0, 5) : w;
  return evidence.includes(stem);
}
function isoDurationSec(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}
function llmText(resp: unknown): string {
  const c = (resp as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? "").join("");
  return "";
}
function parseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

/* ═══════════════════════ the YouTube Data API, counted ═══════════════════════ */

async function searchList(q: string): Promise<{ status: number; items: SearchItem[] }> {
  if (searchCalls >= MAX_SEARCH_CALLS) throw new Error(`HARD CAP: ${MAX_SEARCH_CALLS} search.list calls reached`);
  searchCalls++;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", KEY);
  url.searchParams.set("q", q);
  url.searchParams.set("type", "video");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("videoEmbeddable", "true");
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  log(`[DryRunSearchCall] call=${searchCalls}/${MAX_SEARCH_CALLS} status=${resp.status} q="${q}"`);
  if (!resp.ok) return { status: resp.status, items: [] };
  const data = (await resp.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: { title?: string; description?: string; channelTitle?: string; thumbnails?: { high?: { url?: string }; medium?: { url?: string } } };
    }>;
  };
  return {
    status: resp.status,
    items: (data.items ?? [])
      .filter((i) => i.id?.videoId)
      .map((i) => ({
        videoId: i.id!.videoId!,
        title: i.snippet?.title ?? "",
        description: i.snippet?.description ?? "",
        channel: i.snippet?.channelTitle ?? "",
        thumb: i.snippet?.thumbnails?.high?.url ?? i.snippet?.thumbnails?.medium?.url ?? "",
      })),
  };
}

async function videosList(ids: string[]): Promise<Map<string, Details>> {
  const out = new Map<string, Details>();
  if (!ids.length) return out;
  videosListCalls++;
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("key", KEY);
  url.searchParams.set("id", ids.slice(0, 50).join(","));
  url.searchParams.set("part", "contentDetails,status,snippet");
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  log(`[DryRunVideosList] call=${videosListCalls} ids=${ids.length} status=${resp.status}`);
  if (!resp.ok) return out;
  const data = (await resp.json()) as {
    items?: Array<{
      id: string;
      contentDetails?: { duration?: string; definition?: string };
      status?: { embeddable?: boolean; license?: string };
      snippet?: { liveBroadcastContent?: string };
    }>;
  };
  for (const v of data.items ?? []) {
    out.set(v.id, {
      durationSec: isoDurationSec(v.contentDetails?.duration),
      embeddable: v.status?.embeddable !== false,
      live: (v.snippet?.liveBroadcastContent ?? "none") !== "none",
      definition: v.contentDetails?.definition ?? "?",
      license: v.status?.license ?? "?",
    });
  }
  return out;
}

/* ═══════════════════════ the planner under test ═══════════════════════ */

type Plan = { query: string; mainSubject: string; entities: string[]; why: string };
const PLAN_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "youtube_search_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mainSubject: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        why: { type: "string" },
      },
      required: ["query", "mainSubject", "entities", "why"],
      additionalProperties: false,
    },
  },
};

function validatePlanQuery(q: string, evidence: string, avoid?: string): string | null {
  const mw = meaningfulWords(q);
  if (mw.length < 2) return "fewer than 2 meaningful words";
  if (mw.length > 8) return `${mw.length} meaningful words (max 8)`;
  const unproven = mw.filter((w) => !provable(w, evidence));
  if (unproven.length) return `words not in the script or its visual plan: ${unproven.join(", ")}`;
  if (avoid && meaningfulWords(avoid).join(" ") === mw.join(" ")) return "same as search #1";
  return null;
}

async function planQuery(
  invokeLLM: (p: unknown) => Promise<unknown>,
  ctx: { prompt: string; title: string; sceneLines: string[]; beats: Beat[]; evidence: string },
  gap?: { query1: string; uncovered: Beat[]; covered: Beat[] }
): Promise<{ plan: Plan; attempts: number; rejected: string[] }> {
  const rejected: string[] = [];
  const baseRules =
    "Rules for the query: 3 to 8 meaningful words; only concrete things a camera can film — named people, " +
    "places, events, objects, years; no metaphors, no abstract nouns, no words that only appear as a figure of " +
    "speech in the narration; every word must come from the script or its visual plan; add ONE production word " +
    "at the end: 'archival footage' for historical subjects, 'footage' otherwise. You may join two subjects with " +
    "'|' ONLY when the video clearly covers two distinct filmable subjects. Return JSON only.";
  const task = gap
    ? `Search #1 was: "${gap.query1}". It left these beats WITHOUT usable footage:\n` +
      gap.uncovered.map((b) => `  [${b.index}] ${b.text}`).join("\n") +
      `\nPlan search #2: ONE query aimed at the biggest filmable subject these uncovered beats share. It must differ from search #1.`
    : "Plan ONE YouTube search that must supply real footage for the WHOLE video below — not for one sentence. " +
      "Pick the main filmable subject and the 2–3 concrete subjects that most beats need.";
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await invokeLLM({
      messages: [
        { role: "system", content: "You plan YouTube searches for a documentary video editor." },
        {
          role: "user",
          content:
            `${task}\n\n${baseRules}${feedback}\n\nVideo prompt: ${ctx.prompt}\nTitle: ${ctx.title}\n` +
            `Scenes (narration | visual plan):\n${ctx.sceneLines.join("\n")}\n\nBeats:\n` +
            ctx.beats.map((b) => `  [${b.index}] ${b.text}`).join("\n"),
        },
      ],
      response_format: PLAN_SCHEMA,
      maxTokens: 300,
    });
    const plan = parseJson<Plan>(llmText(resp));
    if (!plan?.query) {
      rejected.push("no JSON");
      feedback = "\nYour previous answer was not valid JSON.";
      continue;
    }
    const bad = validatePlanQuery(plan.query, ctx.evidence, gap?.query1);
    if (!bad) return { plan, attempts: attempt, rejected };
    rejected.push(`"${plan.query}" — ${bad}`);
    feedback = `\nYour previous query "${plan.query}" was refused: ${bad}. Fix exactly that.`;
  }
  /** Deterministic fallback: the video's most frequent provable capitalised terms. */
  const caps = (ctx.evidence.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*|\b(1[0-9]|20)\d{2}\b/g) ?? []);
  const freq = new Map<string, number>();
  for (const c of caps) if (!STOP.has(c.toLowerCase())) freq.set(c, (freq.get(c) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3);
  const query = `${top.join(" ")} footage`.trim();
  return { plan: { query, mainSubject: top[0] ?? "", entities: top, why: "deterministic fallback" }, attempts: 3, rejected };
}

/* ═══════════════════════ judging the candidates ═══════════════════════ */

const VISION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "youtube_thumbnail_triage",
    strict: true,
    schema: {
      type: "object",
      properties: {
        footageType: {
          type: "string",
          enum: ["real_footage", "archival_footage", "talking_head", "text_or_graphic", "animation_or_game", "other"],
        },
        period: { type: "string", enum: ["historical", "modern", "unclear"] },
        servesBeats: { type: "array", items: { type: "integer" } },
        depicts: { type: "string" },
      },
      required: ["footageType", "period", "servesBeats", "depicts"],
      additionalProperties: false,
    },
  },
};

async function judgeThumbnail(
  deps: { invokeLLM: (p: unknown) => Promise<unknown>; prepare: (b: Buffer, m: string) => Promise<{ buffer: Buffer; mimeType: string } | null>; toDataUrl: (b: Buffer, m: string) => string },
  c: SearchItem,
  title: string,
  beats: Beat[]
): Promise<Vision | null> {
  if (!c.thumb) return null;
  try {
    const r = await fetch(c.thumb, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const prepared = await deps.prepare(Buffer.from(await r.arrayBuffer()), "image/jpeg");
    if (!prepared) return null;
    const resp = await Promise.race([
      deps.invokeLLM({
        messages: [
          { role: "system", content: "You triage YouTube search results for a documentary editor. Return only JSON." },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Video being made: "${title}".\nYouTube result title: "${c.title}" (channel: ${c.channel}).\n` +
                  `This is the result's THUMBNAIL. Thumbnails often carry added headline text or a presenter's face; ` +
                  `judge the underlying footage the video most likely contains.\n` +
                  `footageType: real_footage (filmed real-world scenes), archival_footage (historical film/photo), ` +
                  `talking_head (presenter/interview/podcast/reaction), text_or_graphic (slides, infographics, text), ` +
                  `animation_or_game, other.\n` +
                  `servesBeats: the numbers of the beats below that real footage from this video could honestly be shown under ` +
                  `(empty if none). Be strict: the subject must match, not just the theme.\n\nBeats:\n` +
                  beats.map((b) => `[${b.index}] ${b.text}`).join("\n"),
              },
              { type: "image_url", image_url: { url: deps.toDataUrl(prepared.buffer, prepared.mimeType), detail: "low" } },
            ],
          },
        ],
        response_format: VISION_SCHEMA,
        maxTokens: 250,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("vision timeout")), 25_000)),
    ]);
    const v = parseJson<Vision>(llmText(resp));
    if (!v) return null;
    const valid = new Set(beats.map((b) => b.index));
    v.servesBeats = [...new Set((v.servesBeats ?? []).filter((n) => valid.has(n)))];
    return v;
  } catch {
    return null;
  }
}

async function clipBeatsFor(
  clip: {
    embedText: (q: string) => Promise<number[] | null>;
    embedImage: (p: string) => Promise<number[] | null>;
    sim: (a: number[], b: number[]) => number;
    threshold: number;
    queryText: (beat: string) => string;
  },
  c: SearchItem,
  beatEmb: Map<number, number[]>
): Promise<number[]> {
  if (!c.thumb || beatEmb.size === 0) return [];
  const tmp = path.join(os.tmpdir(), `dry_${c.videoId}.jpg`);
  try {
    const r = await fetch(c.thumb, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return [];
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    const e = await clip.embedImage(tmp);
    if (!e) return [];
    return [...beatEmb.entries()].filter(([, q]) => clip.sim(q, e) >= clip.threshold).map(([i]) => i);
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Greedy set cover: how many different source videos the covered beats need, at most 3 beats (shots) per video. */
function sourcesNeeded(cands: Array<{ id: string; beats: number[] }>): { sources: number; perVideo: Record<string, number[]> } {
  const left = new Set(cands.flatMap((c) => c.beats));
  const perVideo: Record<string, number[]> = {};
  const pool = cands.map((c) => ({ id: c.id, beats: new Set(c.beats) }));
  while (left.size) {
    let best: { id: string; take: number[] } | null = null;
    for (const c of pool) {
      if (perVideo[c.id]) continue;
      const take = [...c.beats].filter((b) => left.has(b)).slice(0, 3);
      if (take.length && (!best || take.length > best.take.length)) best = { id: c.id, take };
    }
    if (!best) break;
    perVideo[best.id] = best.take;
    for (const b of best.take) left.delete(b);
  }
  return { sources: Object.keys(perVideo).length, perVideo };
}

/* ═══════════════════════ the run ═══════════════════════ */

async function main() {
  const { invokeLLM } = await import("../server/_core/llm");
  const { runScriptEngineV2 } = await import("../server/scriptEngine");
  const { getScriptLengthBudget } = await import("../server/scriptWriter");
  const pipeline = await import("../server/videoPipeline");
  const { withSearchProvenance, validateSearchQuery } = await import("../server/searchQueryContract");
  const { youtubeTitleIsNotFootage } = await import("../server/youtubeNonFootage");
  const { prepareImageForVision, imageMimeToDataUrl } = await import("../server/archiveClipFilter");
  const vision = await import("../server/localClipVision");
  const { listCuratedArchiveCandidates } = await import("../server/curatedMediaSourcing");
  const { normalizeMediaTags } = await import("../server/db");
  const llm = invokeLLM as unknown as (p: unknown) => Promise<unknown>;
  log(`[DryRun] modules loaded; key=${KEY ? "SET" : "MISSING"} db=${process.env.DATABASE_URL ? "SET" : "MISSING"}`);
  if (!KEY) throw new Error("YOUTUBE_API_KEY is MISSING in this service");
  log(`[DryRun] start topics=${TOPICS.length} maxSearchCalls=${MAX_SEARCH_CALLS}`);

  const clipReady = vision.localVisionEnabled() && (await vision.warmUpLocalClipVision().catch(() => false));
  log(`[DryRun] CLIP thumbnail scoring ${clipReady ? "READY" : "UNAVAILABLE — vision model only"}`);
  const clipThreshold = vision.minLocalClipSimilarity(6) - 0.04;

  const summary: Array<Record<string, unknown>> = [];

  for (const topic of TOPICS) {
    const t0 = Date.now();
    log(`\n[DryRunTopic] ===== ${topic.category}: "${topic.prompt}" =====`);
    try {
      /* 1. FastVid's own script → scenes → beats */
      const engine = await runScriptEngineV2(topic.prompt, VIDEO_TYPE, getScriptLengthBudget(VIDEO_LENGTH));
      const scenes = await pipeline.parseScriptIntoScenes(engine.markdownScript, 6, topic.prompt);
      const beats: Beat[] = [];
      for (const s of scenes) {
        if (s.isChapterCard) continue;
        const sentences = s.text.match(/[^.!?]+[.!?]+/g)?.map((x) => x.trim()).filter((x) => x.length > 5) ?? [s.text.trim()];
        for (const text of sentences) beats.push({ index: beats.length, sceneIndex: s.index, text });
      }
      const sceneLines = engine.scenes.map(
        (s) => `  scene ${s.index}: ${s.narration.slice(0, 220)} | ${[s.visualIntent, ...s.searchKeywords].join("; ").slice(0, 220)}`
      );
      const evidence = [topic.prompt, engine.title, engine.markdownScript, ...engine.scenes.flatMap((s) => [s.visualIntent, ...s.searchKeywords, s.archiveIntent])]
        .join(" ")
        .toLowerCase();
      log(`[DryRunScript] title="${engine.title}" scenes=${scenes.length} beats=${beats.length}`);
      for (const b of beats) log(`[DryRunBeat] [${b.index}] s${b.sceneIndex} ${b.text.slice(0, 160)}`);

      /* CLIP: one text embedding per beat, compared with every thumbnail */
      const beatEmb = new Map<number, number[]>();
      if (clipReady) {
        for (const b of beats) {
          const e = await vision.embedTextQuery(vision.buildBeatVisionQueryText({ beatText: b.text, videoTitle: engine.title }));
          if (e) beatEmb.set(b.index, e);
        }
      }
      const videoKeywords = [...new Set(meaningfulWords(`${topic.prompt} ${engine.title}`).filter((w) => w.length >= 4))];

      /* the archive, YouTube-origin only — counted apart from the search, and judged like it */
      /**
       * PASS 2 — pass 1 counted every pick the archive returned, and it returned the same ~140 assets
       * for Tesla, procrastination and the Berlin Wall alike: its coverage said nothing. Now a pick must
       * clear the curated route's own floor (score >= 22), and then its source video's YouTube thumbnail
       * goes through the SAME triage as a search result. Only what that triage calls usable counts.
       */
      const archiveCache = new Map();
      const topicAnchors = normalizeMediaTags(videoKeywords);
      const archiveSeen = new Map<string, { id: number; score: number; title: string }>();
      for (const b of beats) {
        const tags = normalizeMediaTags(meaningfulWords(b.text).filter((w) => w.length >= 4));
        const picks = await listCuratedArchiveCandidates(
          tags, new Set(), new Set(), topicAnchors, undefined, b.text, new Set(), archiveCache, true, true
        ).catch(() => []);
        for (const p of picks) {
          const ytId =
            /youtube/i.test(p.asset.sourcePlatform ?? "") && /^[\w-]{11}$/.test(p.asset.providerAssetId ?? "")
              ? p.asset.providerAssetId!
              : /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(p.asset.sourceUrl ?? "")?.slice(1).find(Boolean);
          if (!ytId || p.score < 22) continue;
          const prev = archiveSeen.get(ytId);
          if (!prev || p.score > prev.score) archiveSeen.set(ytId, { id: p.asset.id, score: p.score, title: p.asset.title ?? "" });
        }
      }
      const archiveTop = [...archiveSeen.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 30);
      const archiveJudged = await pool(archiveTop, 5, async ([ytId, a]) => {
        const item: SearchItem = { videoId: ytId, title: a.title, description: "", channel: "archive", thumb: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` };
        const v = await judgeThumbnail({ invokeLLM: llm, prepare: prepareImageForVision, toDataUrl: imageMimeToDataUrl }, item, engine.title, beats);
        const usable = !!v && (v.footageType === "real_footage" || v.footageType === "archival_footage") && v.servesBeats.length > 0;
        log(
          `[DryRunArchive] ${ytId} score=${Math.round(a.score)} ${usable ? "USABLE" : "no    "} beats=[${usable ? v!.servesBeats.join(",") : ""}] ` +
            `${v?.footageType ?? "no_verdict"} "${a.title.slice(0, 70)}" — ${(v?.depicts ?? "").slice(0, 80)}`
        );
        return { ytId, beats: usable ? v!.servesBeats : [], usable };
      });
      const archiveUsable = archiveJudged.filter((a) => a.usable);
      const archiveByBeat = new Map<number, Array<{ id: number; source: string; score: number }>>();
      for (const a of archiveUsable) for (const b of a.beats) {
        const list = archiveByBeat.get(b) ?? [];
        list.push({ id: 0, source: a.ytId, score: 0 });
        archiveByBeat.set(b, list);
      }
      const archiveCovered = [...archiveByBeat.keys()];
      const archiveAssets = new Set(archiveUsable.map((a) => a.ytId));
      const archiveSources = new Set(archiveUsable.map((a) => a.ytId));
      log(
        `[DryRunArchiveSummary] picksAboveFloor=${archiveSeen.size} judged=${archiveTop.length} usable=${archiveUsable.length} ` +
          `coverage=${archiveCovered.length}/${beats.length}`
      );

      /* 2. one search, judged */
      const runSearch = async (n: 1 | 2, plan: Plan): Promise<SearchReport> => {
        const ctx = pipeline.buildVerifiedQueryContextForBeat(engine.markdownScript.slice(0, 4000), { sceneText: engine.markdownScript.slice(0, 4000), topic: topic.prompt });
        const admitted = withSearchProvenance(ctx, () => pipeline.admitProviderQuery("youtube", plan.query, "dry_run_planner"));
        const verdict = validateSearchQuery(plan.query, ctx) as { ok: boolean; reason?: string };
        const gate =
          (admitted === null ? "BLOCKED" : admitted === plan.query ? "ADMITTED" : `ADMITTED_AS "${admitted}"`) +
          (verdict.ok ? "" : ` reason=${verdict.reason ?? "?"}`);
        const { status, items } = await searchList(plan.query);
        const unique = [...new Map(items.map((i) => [i.videoId, i])).values()];
        const details = await videosList(unique.map((u) => u.videoId));
        const candidates: Candidate[] = await pool(unique, 5, async (it) => {
          const genre = youtubeTitleIsNotFootage(it.title);
          const d = details.get(it.videoId) ?? null;
          const [v, clipBeats] = await Promise.all([
            genre ? Promise.resolve(null) : judgeThumbnail({ invokeLLM: llm, prepare: prepareImageForVision, toDataUrl: imageMimeToDataUrl }, it, engine.title, beats),
            genre || !clipReady
              ? Promise.resolve([] as number[])
              : clipBeatsFor(
                  {
                    embedText: vision.embedTextQuery,
                    embedImage: vision.embedImageFromPath,
                    sim: vision.scoreEmbeddingSimilarity,
                    threshold: clipThreshold,
                    queryText: (t) => t,
                  },
                  it,
                  beatEmb
                ),
          ]);
          let why = "ok";
          if (genre) why = `title genre ${genre}`;
          else if (!d) why = "no details";
          else if (d.live) why = "live";
          else if (d.durationSec < 10) why = `too short ${d.durationSec}s`;
          else if (d.durationSec > 20 * 60) why = `too long ${Math.round(d.durationSec / 60)}min (download ceiling)`;
          else if (!v) why = "vision gave no verdict";
          else if (v.footageType !== "real_footage" && v.footageType !== "archival_footage") why = `footage type ${v.footageType}`;
          else if (!v.servesBeats.length) why = "serves no beat";
          const usable = why === "ok";
          return { ...it, details: d, genre, vision: v, clipBeats, usable, why, beats: usable ? v!.servesBeats : [] };
        });
        const usableC = candidates.filter((c) => c.usable);
        const footageTypes: Record<string, number> = {};
        for (const c of candidates) {
          const k = c.genre ? "title_rejected" : c.vision?.footageType ?? "no_verdict";
          footageTypes[k] = (footageTypes[k] ?? 0) + 1;
        }
        const hay = (c: SearchItem) => `${c.title} ${c.description}`.toLowerCase();
        const report: SearchReport = {
          n,
          query: plan.query,
          gate,
          results: items.length,
          unique: unique.length,
          notFootageByTitle: candidates.filter((c) => c.genre).length,
          relevantText: candidates.filter((c) => !c.genre && videoKeywords.some((k) => hay(c).includes(k))).length,
          footageTypes,
          usableVideos: usableC.length,
          multiBeatVideos: usableC.filter((c) => c.beats.length >= 2).length,
          coveredBeats: [...new Set(usableC.flatMap((c) => c.beats))].sort((a, b) => a - b),
          candidates,
        };
        log(
          `[DryRunSearch] #${n} status=${status} gate=${gate} query="${plan.query}" results=${report.results} unique=${report.unique} ` +
            `titleRejected=${report.notFootageByTitle} relevantText=${report.relevantText} usable=${report.usableVideos} ` +
            `multiBeat=${report.multiBeatVideos} covered=${report.coveredBeats.length}/${beats.length} types=${JSON.stringify(footageTypes)}`
        );
        for (const c of candidates.slice(0, 50)) {
          log(
            `[DryRunCand] #${n} ${c.videoId} ${c.usable ? "USABLE" : "no    "} beats=[${c.beats.join(",")}] clip=[${c.clipBeats.join(",")}] ` +
              `dur=${c.details?.durationSec ?? "?"}s ${c.vision?.footageType ?? "-"} why=${c.why} "${c.title.slice(0, 70)}" — ${(c.vision?.depicts ?? "").slice(0, 80)}`
          );
        }
        return report;
      };

      const p1 = await planQuery(llm, { prompt: topic.prompt, title: engine.title, sceneLines, beats, evidence });
      log(`[DryRunPlan] #1 query="${p1.plan.query}" attempts=${p1.attempts} rejected=${JSON.stringify(p1.rejected)} why="${p1.plan.why.slice(0, 200)}"`);
      const s1 = await runSearch(1, p1.plan);

      /* 3. the pool: search #1 + archive, and the search-#2 rules exactly as agreed */
      const evaluate = (reports: SearchReport[]) => {
        const searchUsable = reports.flatMap((r) => r.candidates.filter((c) => c.usable));
        const searchIds = new Set(searchUsable.map((c) => c.videoId));
        const searchCovered = new Set(searchUsable.flatMap((c) => c.beats));
        const combined = new Set([...searchCovered, ...archiveCovered]);
        const usableCandidates = searchIds.size + archiveAssets.size;
        const distinctVideos = new Set([...searchIds, ...archiveSources]).size;
        const cover = sourcesNeeded([
          ...searchUsable.map((c) => ({ id: c.videoId, beats: c.beats })),
          ...archiveUsable.map((a) => ({ id: `archive:${a.ytId}`, beats: a.beats })),
        ]);
        const needCand = Math.max(6, Math.ceil(beats.length / 2));
        const reasons: string[] = [];
        if (usableCandidates < needCand) reasons.push(`usable candidates ${usableCandidates} < max(6, beats/2)=${needCand}`);
        if (distinctVideos < 4) reasons.push(`distinct usable videos ${distinctVideos} < 4`);
        if (combined.size < beats.length / 2) reasons.push(`coverage ${combined.size}/${beats.length} < 50%`);
        return {
          searchCoverage: searchCovered.size,
          archiveOnlyExtra: [...combined].filter((b) => !searchCovered.has(b)).length,
          combinedCoverage: combined.size,
          usableCandidates,
          distinctVideos,
          sourcesNeeded: cover.sources,
          reasons,
          uncovered: beats.filter((b) => !combined.has(b.index)),
        };
      };
      const e1 = evaluate([s1]);
      log(
        `[DryRunPool] after #1: searchCoverage=${e1.searchCoverage}/${beats.length} archiveCoverage=${archiveCovered.length}/${beats.length} ` +
          `archiveExtra=${e1.archiveOnlyExtra} combined=${e1.combinedCoverage}/${beats.length} usableCandidates=${e1.usableCandidates} ` +
          `(search ${s1.usableVideos} + archive assets ${archiveAssets.size}) distinctVideos=${e1.distinctVideos} sourcesNeeded=${e1.sourcesNeeded} ` +
          `search2=${e1.reasons.length ? "YES" : "NO"}${e1.reasons.length ? ` reason="${e1.reasons.join("; ")}"` : ""}`
      );

      let s2: SearchReport | null = null;
      let e2: ReturnType<typeof evaluate> | null = null;
      let p2: Awaited<ReturnType<typeof planQuery>> | null = null;
      if (e1.reasons.length) {
        const covered = beats.filter((b) => !e1.uncovered.includes(b));
        p2 = await planQuery(llm, { prompt: topic.prompt, title: engine.title, sceneLines, beats, evidence }, { query1: p1.plan.query, uncovered: e1.uncovered, covered });
        log(`[DryRunPlan] #2 query="${p2.plan.query}" attempts=${p2.attempts} rejected=${JSON.stringify(p2.rejected)} why="${p2.plan.why.slice(0, 200)}"`);
        s2 = await runSearch(2, p2.plan);
        e2 = evaluate([s1, s2]);
        log(
          `[DryRunPool] after #2: combined=${e2.combinedCoverage}/${beats.length} usableCandidates=${e2.usableCandidates} distinctVideos=${e2.distinctVideos} ` +
            `sourcesNeeded=${e2.sourcesNeeded} stillFailing="${e2.reasons.join("; ") || "none"}" — YouTube STOPS here`
        );
      }

      const row = {
        category: topic.category,
        prompt: topic.prompt,
        title: engine.title,
        beats: beats.length,
        query1: p1.plan.query,
        query1Gate: s1.gate,
        plannerRejected1: p1.rejected.length,
        s1: {
          results: s1.results,
          unique: s1.unique,
          titleRejected: s1.notFootageByTitle,
          relevantText: s1.relevantText,
          usable: s1.usableVideos,
          multiBeat: s1.multiBeatVideos,
          coverage: s1.coveredBeats.length,
          types: s1.footageTypes,
        },
        archive: { assets: archiveAssets.size, sources: archiveSources.size, coverage: archiveCovered.length },
        after1: { ...e1, uncovered: e1.uncovered.map((b) => b.index) },
        search2: e1.reasons.length ? "JA" : "NEE",
        search2Reason: e1.reasons.join("; "),
        query2: p2?.plan.query ?? null,
        s2: s2 ? { results: s2.results, usable: s2.usableVideos, coverage: s2.coveredBeats.length, types: s2.footageTypes } : null,
        after2: e2 ? { ...e2, uncovered: e2.uncovered.map((b) => b.index) } : null,
        seconds: Math.round((Date.now() - t0) / 1000),
      };
      summary.push(row);
      log(`[DryRunResult] ${JSON.stringify(row)}`);
    } catch (err) {
      log(`[DryRunTopic] ${topic.category} FAILED: ${(err as Error).message}`);
      summary.push({ category: topic.category, prompt: topic.prompt, error: (err as Error).message });
      if (/HARD CAP/.test((err as Error).message)) break;
    }
  }

  log(`\n[DryRunSummary] searchCalls=${searchCalls} videosListCalls=${videosListCalls} quotaUnits=${searchCalls * 100 + videosListCalls}`);
  for (const r of summary) log(`[DryRunSummaryRow] ${JSON.stringify(r)}`);
  log("[DryRun] DONE");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`[DryRun] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
