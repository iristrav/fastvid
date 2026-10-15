/**
 * VIDEO 659 — ONE LOOK PER YOUTUBE VIDEO, BEFORE ANYTHING IS DOWNLOADED.
 *
 * ── The owner's rule ─────────────────────────────────────────────────────────────────────────
 *
 * "Kunnen we er niet voor zorgen dat voor een beeld wordt gedownload, hij echt gecheckt is of het
 * past? En dat op een goedkope manier." — and: "Je mag ook uit 1 beeldcontrole. Dus 1 youtube
 * heeeeel veel beelden knippen."
 *
 * Until now the stock downloaded 40 seconds of every pool video somewhere in its middle, cut it into
 * shots, and the picture editor judged each shot under each sentence afterwards — a download for
 * every video and a paid look for every shot, and the right seconds of a long video were only found
 * when the guessed 40 happened to hold them.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 *   1. YouTube's storyboard — the small frames the player shows when the timeline is hovered — is
 *      read for the WHOLE video (the download service returns the sprite list; no video bytes).
 *   2. Where the caption track names a sentence's subject, those seconds are taken first; the rest
 *      of the sheet is spread evenly over the video.
 *   3. Up to `SHEET_MAX_FRAMES` frames are laid on ONE numbered sheet, and the picture editor is
 *      asked ONCE, with every sentence of the film, which frame fits which sentence — by the same
 *      rules it judges a downloaded clip by.
 *   4. Only the approved seconds are downloaded (`windowsAroundApprovals`), cut into shots, and each
 *      shot that holds an approved frame carries that approval to its sentence
 *      (`sheetApprovalFor`), so the sentence does not pay for a second look.
 *
 * A video with no storyboard, a service that does not answer or a sheet the model cannot read falls
 * back to the old way (`no_sheet`). A sheet on which nothing fits is not downloaded at all.
 *
 * What a storyboard frame cannot show is small text. The separate on-screen-text check still runs
 * on every downloaded shot, exactly as before.
 */
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { beatSentences } from "./youtubeVideoPool";

const execFileAsync = promisify(execFile);

/** Frames on one sheet: a 6 × 6 grid. */
export const SHEET_COLUMNS = 6;
export const SHEET_MAX_FRAMES = 36;
/** At most this many caption hits per sentence are put on the sheet. */
export const HITS_PER_SENTENCE = 2;
/** The first and last bit of a video are its intro and outro cards: not sampled. */
const EDGE_FRACTION = 0.04;
/** Two frames closer than this are the same moment. */
const MIN_FRAME_GAP_SEC = 3;

export type Storyboard = {
  durationSec: number;
  width: number;
  height: number;
  rows: number;
  columns: number;
  fragments: Array<{ url: string; durationSec: number }>;
  captionUrl?: string | null;
};

export type TranscriptSegment = { startSec: number; text: string };

/** Where on which sprite the frame for `sec` sits. Null when the storyboard does not reach it. */
export function storyboardFrameAt(
  sb: Storyboard,
  sec: number
): { fragment: number; x: number; y: number } | null {
  const perSprite = sb.rows * sb.columns;
  const first = sb.fragments[0];
  if (!first || perSprite <= 0 || first.durationSec <= 0 || !Number.isFinite(sec) || sec < 0) return null;
  const interval = first.durationSec / perSprite;
  const index = Math.floor(sec / interval);
  const fragment = Math.floor(index / perSprite);
  if (fragment >= sb.fragments.length) return null;
  const k = index % perSprite;
  return { fragment, x: (k % sb.columns) * sb.width, y: Math.floor(k / sb.columns) * sb.height };
}

/** YouTube's json3 caption format → timed text. Never throws. */
export function transcriptSegmentsFromJson3(json: unknown): TranscriptSegment[] {
  const events = (json as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> })?.events;
  if (!Array.isArray(events)) return [];
  const out: TranscriptSegment[] = [];
  for (const e of events) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text && typeof e.tStartMs === "number") out.push({ startSec: e.tStartMs / 1000, text });
  }
  return out;
}

const STOP = new Set(
  "the and that this with from were was are for his her their they them then than there which what when where while into onto over under about after before would could should have has had been being also just only more most very some such will shall its it's not but yet one two".split(
    " "
  )
);
function contentWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w))
    ),
  ];
}

/**
 * Per sentence, the seconds where the transcript says the most of its words — at most
 * `HITS_PER_SENTENCE`, and only where at least two of them (one for a sentence with fewer than
 * three content words) are spoken within the segment and its neighbour.
 */
export function transcriptHits(segments: readonly TranscriptSegment[], sentences: readonly string[]): number[][] {
  const ownWords = segments.map((s) => new Set(contentWords(s.text)));
  const segWords = segments.map((s, i) => new Set(contentWords(`${s.text} ${segments[i + 1]?.text ?? ""}`)));
  return sentences.map((sentence) => {
    const words = contentWords(sentence);
    const need = words.length < 3 ? 1 : 2;
    /** A sentence split over two caption lines still counts — but the hit is where it STARTS being said. */
    const scored = segments
      .map((s, i) => ({ sec: s.startSec, own: words.filter((w) => ownWords[i]!.has(w)).length, score: words.filter((w) => segWords[i]!.has(w)).length }))
      .filter((x) => x.own >= 1 && x.score >= need)
      .sort((a, b) => b.score - a.score || a.sec - b.sec);
    const picked: number[] = [];
    for (const x of scored) {
      if (picked.length >= HITS_PER_SENTENCE) break;
      if (picked.every((p) => Math.abs(p - x.sec) >= MIN_FRAME_GAP_SEC * 3)) picked.push(x.sec);
    }
    return picked;
  });
}

/** The seconds put on the sheet: the caption hits first, then an even spread over the video. */
export function chooseSheetSeconds(durationSec: number, hits: readonly number[], max = SHEET_MAX_FRAMES): number[] {
  if (!(durationSec > 0)) return [];
  const lo = durationSec * EDGE_FRACTION;
  const hi = durationSec * (1 - EDGE_FRACTION);
  const out: number[] = [];
  const add = (sec: number) => {
    const s = Math.min(hi, Math.max(lo, sec));
    if (out.length < max && out.every((p) => Math.abs(p - s) >= MIN_FRAME_GAP_SEC)) out.push(Number(s.toFixed(1)));
  };
  /** A sentence's subject is usually on screen a moment after it is said. */
  for (const h of hits) add(h + 1.5);
  /** The even spread, offset again where a hit already took a spot, until the sheet is full. */
  for (const offset of [0.5, 0.25, 0.75, 0.125, 0.875]) {
    const room = max - out.length;
    if (room <= 0) break;
    for (let i = 0; i < room; i++) add(lo + ((hi - lo) * (i + offset)) / room);
  }
  return out.sort((a, b) => a - b);
}

/** Sharp frames sit four to a row on the service's sheet (`/frames`). */
export const SHARP_COLUMNS = 4;
/** At most this many sharp frames per video: the candidates the quick look found, one or two per sentence. */
export const SHARP_MAX_FRAMES = 12;

export function sheetPrompt(
  videoTitle: string,
  sentences: readonly string[],
  frames: ReadonlyArray<{ n: number; sec: number }>,
  kind: "storyboard" | "sharp" = "storyboard"
): string {
  const sharp = kind === "sharp";
  return [
    "You are the picture editor on a documentary. The image is a contact sheet of ONE YouTube video:",
    sharp
      ? `${frames.length} full-quality frames from it, ${SHARP_COLUMNS} per row. Frame 1 is top-left;`
      : `${frames.length} small frames in order through the video, ${SHEET_COLUMNS} per row. Frame 1 is top-left;`,
    "they are numbered left to right, then row by row (a number may also be printed in each corner).",
    sharp
      ? "This is the final check before these seconds are downloaded and cut into the film: judge exactly as you would the clip itself."
      : "",
    `Video title, for background only: "${videoTitle.slice(0, 120)}"`,
    "",
    "The film's narration, one sentence per line:",
    ...sentences.map((s, i) => `[${i}] ${s.slice(0, 220)}`),
    "",
    "For EVERY frame, decide which sentences it could be cut under — the viewer hears that sentence",
    "while looking at this picture. A frame belongs under a sentence only when BOTH are true:",
    "  · WHO or WHAT the sentence is about is visibly on screen (never because the title names it);",
    "  · the frame shows the SITUATION the sentence describes — its action, place, objects or period.",
    "    A person the sentence names, somewhere unrelated to what it says about them, is not enough.",
    "  · For a sentence about something no camera can film (money, a decision, a rumour, a deal), the",
    "    people, company, products or places that story is about, in its period, do belong.",
    "Never under any sentence: a presenter or someone talking to camera, a studio, a title card,",
    "a logo, a screenshot, a frame mostly covered by text or graphics, a black or blurred frame.",
    ...(sharp ? ["Also never: burned-in subtitles, a channel watermark or caption text across the picture."] : []),
    "The era on its own is never enough. When you cannot tell, it does NOT belong.",
    "",
    'Return JSON: {"frames":[{"frame":<number>,"depicts":"<what is on screen, a few words>","sentences":[<sentence numbers>]}]}',
    "List every frame once; use an empty list when a frame belongs under no sentence.",
  ].join("\n");
}

export const SHEET_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "youtube_contact_sheet",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["frames"],
      properties: {
        frames: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["frame", "depicts", "sentences"],
            properties: {
              frame: { type: "integer" },
              depicts: { type: "string" },
              sentences: { type: "array", items: { type: "integer" } },
            },
          },
        },
      },
    },
  },
} as const;

export type SheetPick = { frame: number; depicts: string; sentences: number[] };

/** The model's answer, held to the sheet it was shown: unknown frames and sentences are dropped. */
export function parseSheetAnswer(raw: string, frameCount: number, sentenceCount: number): SheetPick[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const frames = (parsed as { frames?: unknown })?.frames;
  if (!Array.isArray(frames)) return null;
  const out: SheetPick[] = [];
  const seen = new Set<number>();
  for (const f of frames as Array<{ frame?: unknown; depicts?: unknown; sentences?: unknown }>) {
    const n = typeof f.frame === "number" ? Math.round(f.frame) : NaN;
    if (!(n >= 1 && n <= frameCount) || seen.has(n)) continue;
    seen.add(n);
    const sentences = Array.isArray(f.sentences)
      ? [...new Set((f.sentences as unknown[]).filter((s): s is number => Number.isInteger(s) && (s as number) >= 0 && (s as number) < sentenceCount))]
      : [];
    out.push({ frame: n, depicts: typeof f.depicts === "string" ? f.depicts.slice(0, 200) : "", sentences });
  }
  return out;
}

/**
 * The sections to download: one around each approved second, merged where they touch, inside the
 * video, longest-first within the caps. Each section starts a little before the approved frame so
 * the cut has a clean shot boundary to find.
 */
export const SECTION_BEFORE_SEC = 3;
export const SECTION_AFTER_SEC = 7;
export const MAX_SECTIONS = 6;
export const MAX_SECTION_TOTAL_SEC = 60;
export function windowsAroundApprovals(
  seconds: readonly number[],
  durationSec: number
): Array<{ startSec: number; durationSec: number }> {
  const raw = [...new Set(seconds)]
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b)
    .map((s) => {
      const startSec = Math.max(0, s - SECTION_BEFORE_SEC);
      const end = durationSec > 0 ? Math.min(durationSec, s + SECTION_AFTER_SEC) : s + SECTION_AFTER_SEC;
      return { startSec, end };
    });
  const merged: Array<{ startSec: number; end: number; approvals: number }> = [];
  for (const w of raw) {
    const last = merged[merged.length - 1];
    if (last && w.startSec <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.approvals++;
    } else merged.push({ ...w, approvals: 1 });
  }
  /** The sections with the most approved frames first, then in order through the video. */
  const chosen: typeof merged = [];
  let total = 0;
  for (const w of [...merged].sort((a, b) => b.approvals - a.approvals || a.startSec - b.startSec)) {
    if (chosen.length >= MAX_SECTIONS) break;
    const len = w.end - w.startSec;
    if (total + len > MAX_SECTION_TOTAL_SEC) continue;
    chosen.push(w);
    total += len;
  }
  return chosen
    .sort((a, b) => a.startSec - b.startSec)
    .map((w) => ({ startSec: Number(w.startSec.toFixed(2)), durationSec: Number((w.end - w.startSec).toFixed(2)) }));
}

/* ═══════════ what the sheet approved, for the sentence that later takes the shot ═══════════ */

type Approval = { sec: number; sentence: string; depicts: string };
const approvalsByFilm = new Map<number, Map<string, Approval[]>>();

export function normSentence(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** `assetKey` is the video's provider key (`youtube_cc:<hash>`), the one a moment's content key starts with. */
export function rememberSheetApprovals(filmId: number, assetKey: string, approvals: readonly Approval[]): void {
  const film = approvalsByFilm.get(filmId) ?? new Map<string, Approval[]>();
  approvalsByFilm.set(filmId, film);
  film.set(assetKey, [...(film.get(assetKey) ?? []), ...approvals]);
}

/**
 * The sheet's approval of a frame inside `[startSec, endSec]` of this video for THIS sentence, or
 * null. A shot that does not hold an approved frame, or a frame approved for another sentence, is
 * judged as before.
 */
export function sheetApprovalFor(
  filmId: number,
  assetKey: string,
  startSec: number,
  endSec: number,
  sentence: string
): Approval | null {
  const list = approvalsByFilm.get(filmId)?.get(assetKey);
  if (!list?.length) return null;
  /** The pool's own sentence match (`beatSentences`): a beat and its pool sentence are the same line. */
  const same = (a: Approval) => normSentence(a.sentence) === normSentence(sentence) || beatSentences({ sentences: [a.sentence] }, sentence).length > 0;
  return list.find((a) => a.sec >= startSec - 0.25 && a.sec <= endSec + 0.25 && same(a)) ?? null;
}

/** A moment's content key (`youtube_cc:<hash>@t<tenths>d<tenths>`) → its video key and seconds. */
export function parseYoutubeMomentKey(contentKey: string | null | undefined): { assetKey: string; startSec: number; endSec: number } | null {
  const m = /^(youtube_cc:[0-9a-f]{16})@t(\d+)d(\d+)$/.exec(contentKey?.trim() ?? "");
  if (!m) return null;
  const startSec = Number(m[2]) / 10;
  return { assetKey: m[1]!, startSec, endSec: startSec + Number(m[3]) / 10 };
}

export function sheetApprovalCount(filmId: number): number {
  let n = 0;
  for (const list of approvalsByFilm.get(filmId)?.values() ?? []) n += list.length;
  return n;
}

export function clearSheetApprovals(filmId: number): void {
  approvalsByFilm.delete(filmId);
}

/* ═══════════ the look ═══════════ */

export type SheetDeps = {
  workDir: string;
  fetchStoryboard: (videoId: string) => Promise<Storyboard | null>;
  fetchBytes: (url: string) => Promise<Buffer | null>;
  fetchTranscript: (captionUrl: string) => Promise<TranscriptSegment[]>;
  /** Lay `frames` (crops of sprite files) on one numbered sheet at `outPath`. */
  compose: (frames: ReadonlyArray<{ sprite: string; x: number; y: number; w: number; h: number; n: number }>, outPath: string) => Promise<boolean>;
  /** One vision call: the prompt and the sheet. Returns the model's text. */
  ask: (prompt: string, sheetPath: string) => Promise<string | null>;
  /**
   * Step 3 — one sharp frame per second, read from the stream (the service's `/frames`), tiled
   * `SHARP_COLUMNS` wide; `seconds` are the ones actually on the sheet, in order. Null: no sharp look.
   */
  fetchSharpFrames?: (videoId: string, seconds: readonly number[], outPath: string) => Promise<{ seconds: number[] } | null>;
  log?: (line: string) => void;
};

export type SheetOutcome =
  /**
   * `confirmed`: the picks were approved on SHARP frames — they stand as the picture editor's verdict.
   * Not confirmed (no sharp frames could be read): only the candidates' seconds are downloaded, and
   * every shot is judged after the download as before.
   */
  | { kind: "approved"; picks: Array<{ sec: number; sentences: number[]; depicts: string }>; windows: Array<{ startSec: number; durationSec: number }>; frames: number; confirmed: boolean }
  | { kind: "nothing_fits"; frames: number }
  | { kind: "no_sheet"; reason: string };

export async function lookBeforeDownload(params: {
  videoId: string;
  title: string;
  sentences: readonly string[];
  durationSec: number;
  deps: SheetDeps;
}): Promise<SheetOutcome> {
  const { videoId, deps } = params;
  const say = deps.log ?? ((l: string) => console.log(l));
  if (!params.sentences.length) return { kind: "no_sheet", reason: "no sentences" };
  const sb = await deps.fetchStoryboard(videoId).catch(() => null);
  if (!sb) return { kind: "no_sheet", reason: "no storyboard" };
  const durationSec = params.durationSec > 0 ? params.durationSec : sb.durationSec;
  let hits: number[] = [];
  if (sb.captionUrl) {
    const segments = await deps.fetchTranscript(sb.captionUrl).catch(() => []);
    hits = transcriptHits(segments, params.sentences).flat();
  }
  const seconds = chooseSheetSeconds(durationSec, hits).filter((s) => storyboardFrameAt(sb, s) != null);
  if (seconds.length < 4) return { kind: "no_sheet", reason: `the storyboard holds ${seconds.length} usable frame(s)` };

  fs.mkdirSync(deps.workDir, { recursive: true });
  const sprites = new Map<number, string>();
  const frames: Array<{ sprite: string; x: number; y: number; w: number; h: number; n: number; sec: number }> = [];
  for (const sec of seconds) {
    const at = storyboardFrameAt(sb, sec)!;
    let sprite = sprites.get(at.fragment);
    if (sprite === undefined) {
      const bytes = await deps.fetchBytes(sb.fragments[at.fragment]!.url).catch(() => null);
      sprite = bytes && bytes.length > 0 ? path.join(deps.workDir, `sb_${videoId}_${at.fragment}.jpg`) : "";
      if (sprite) fs.writeFileSync(sprite, bytes!);
      sprites.set(at.fragment, sprite);
    }
    if (sprite) frames.push({ sprite, x: at.x, y: at.y, w: sb.width, h: sb.height, n: frames.length + 1, sec });
  }
  if (frames.length < 4) return { kind: "no_sheet", reason: "the storyboard images could not be fetched" };
  const sheetPath = path.join(deps.workDir, `sheet_${videoId}.jpg`);
  if (!(await deps.compose(frames, sheetPath).catch(() => false))) return { kind: "no_sheet", reason: "the sheet could not be made" };

  const answer = await deps
    .ask(sheetPrompt(params.title, params.sentences, frames.map((f) => ({ n: f.n, sec: f.sec }))), sheetPath)
    .catch(() => null);
  const picks = answer ? parseSheetAnswer(answer, frames.length, params.sentences.length) : null;
  if (!picks) return { kind: "no_sheet", reason: "the picture editor's answer could not be read" };
  const approved = picks
    .filter((p) => p.sentences.length > 0)
    .map((p) => ({ sec: frames[p.frame - 1]!.sec, sentences: p.sentences, depicts: p.depicts }));
  say(
    `[YouTubeSheet] ${videoId} quick look (storyboard): ${frames.length} frame(s) of ${Math.round(durationSec)}s ` +
      `(${hits.length} from the transcript) — ${approved.length} candidate(s) for ` +
      `${new Set(approved.flatMap((a) => a.sentences)).size} sentence(s)`
  );
  if (!approved.length) return { kind: "nothing_fits", frames: frames.length };

  /* Step 3 — the candidates' seconds as SHARP frames, and the picture editor decides on those. */
  const sharpSeconds = sharpCandidateSeconds(approved);
  const sharpPath = path.join(deps.workDir, `sharp_${videoId}.jpg`);
  const sharp = deps.fetchSharpFrames ? await deps.fetchSharpFrames(videoId, sharpSeconds, sharpPath).catch(() => null) : null;
  if (!sharp || !sharp.seconds.length || !fs.existsSync(sharpPath)) {
    say(`[YouTubeSheet] ${videoId} no sharp frames — only the candidates' seconds are downloaded, and each shot is judged after the download`);
    return { kind: "approved", picks: approved, windows: windowsAroundApprovals(approved.map((a) => a.sec), durationSec), frames: frames.length, confirmed: false };
  }
  const sharpFrames = sharp.seconds.map((sec, i) => ({ n: i + 1, sec }));
  const sharpAnswer = await deps.ask(sheetPrompt(params.title, params.sentences, sharpFrames, "sharp"), sharpPath).catch(() => null);
  const sharpPicks = sharpAnswer ? parseSheetAnswer(sharpAnswer, sharpFrames.length, params.sentences.length) : null;
  if (!sharpPicks) {
    say(`[YouTubeSheet] ${videoId} the sharp look's answer could not be read — candidates downloaded, judged after the download`);
    return { kind: "approved", picks: approved, windows: windowsAroundApprovals(approved.map((a) => a.sec), durationSec), frames: frames.length, confirmed: false };
  }
  const confirmed = sharpPicks
    .filter((p) => p.sentences.length > 0)
    .map((p) => ({ sec: sharpFrames[p.frame - 1]!.sec, sentences: p.sentences, depicts: p.depicts }));
  say(
    `[YouTubeSheet] ${videoId} sharp look: ${sharpFrames.length} frame(s) — ${confirmed.length} approved for ` +
      `${new Set(confirmed.flatMap((a) => a.sentences)).size} sentence(s); only those seconds are downloaded`
  );
  if (!confirmed.length) return { kind: "nothing_fits", frames: frames.length };
  return { kind: "approved", picks: confirmed, windows: windowsAroundApprovals(confirmed.map((a) => a.sec), durationSec), frames: frames.length, confirmed: true };
}

/**
 * Which candidate seconds go to the sharp look: first one per sentence (so every sentence the quick
 * look served gets its chance), then a second per sentence, then the rest — at most `SHARP_MAX_FRAMES`,
 * in order through the video.
 */
export function sharpCandidateSeconds(candidates: ReadonlyArray<{ sec: number; sentences: readonly number[] }>, max = SHARP_MAX_FRAMES): number[] {
  const picked = new Set<number>();
  const perSentence = new Map<number, number>();
  for (const round of [1, 2, Infinity]) {
    for (const c of candidates) {
      if (picked.size >= max) break;
      if (picked.has(c.sec)) continue;
      if (c.sentences.some((s) => (perSentence.get(s) ?? 0) < round)) {
        picked.add(c.sec);
        for (const s of c.sentences) perSentence.set(s, (perSentence.get(s) ?? 0) + 1);
      }
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/* ═══════════ production pieces ═══════════ */

/** The download service's `/storyboard`. Null on any failure — the caller falls back. */
export async function fetchStoryboardFromService(videoId: string, timeoutMs = 25_000): Promise<Storyboard | null> {
  const base = process.env.YOUTUBE_CC_DL_SERVICE?.trim().replace(/\/$/, "");
  if (!base) return null;
  const token = process.env.YOUTUBE_CC_DL_TOKEN?.trim();
  try {
    const res = await fetch(`${base}/storyboard?id=${encodeURIComponent(videoId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as {
      duration?: number; width?: number; height?: number; rows?: number; columns?: number;
      fragments?: Array<{ url?: string; duration?: number }>; captionUrl?: string | null;
    };
    const fragments = (b.fragments ?? [])
      .filter((f) => typeof f.url === "string" && f.url.startsWith("https://"))
      .map((f) => ({ url: f.url!, durationSec: Number(f.duration) || 0 }));
    if (!fragments.length || !b.width || !b.height || !b.rows || !b.columns) return null;
    return {
      durationSec: Number(b.duration) || 0,
      width: b.width, height: b.height, rows: b.rows, columns: b.columns,
      fragments,
      captionUrl: typeof b.captionUrl === "string" && b.captionUrl.startsWith("https://") ? b.captionUrl : null,
    };
  } catch {
    return null;
  }
}

/** Step 3 — the service's `/frames`: the sheet is written to `outPath`; null on any failure. */
export async function fetchSharpFramesFromService(
  videoId: string,
  seconds: readonly number[],
  outPath: string,
  timeoutMs = 90_000
): Promise<{ seconds: number[] } | null> {
  const base = process.env.YOUTUBE_CC_DL_SERVICE?.trim().replace(/\/$/, "");
  if (!base || !seconds.length) return null;
  const token = process.env.YOUTUBE_CC_DL_TOKEN?.trim();
  try {
    const res = await fetch(`${base}/frames?id=${encodeURIComponent(videoId)}&at=${seconds.map((s) => s.toFixed(2)).join(",")}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
    const kept = (res.headers.get("x-frame-seconds") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    if (!kept.length) return null;
    fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
    return { seconds: kept };
  } catch {
    return null;
  }
}

/** Crops each frame from its sprite, numbers it, and tiles them `SHEET_COLUMNS` wide. */
export async function composeSheetWithFfmpeg(
  ffmpegBin: string,
  fontFile: string | null,
  frames: ReadonlyArray<{ sprite: string; x: number; y: number; w: number; h: number; n: number }>,
  outPath: string
): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(path.dirname(outPath), "sheetframes-"));
  try {
    const W = 320;
    /** A build without `drawtext` (the bundled ffmpeg-static has none) still makes the sheet: the prompt numbers by position. */
    let numbered = Boolean(fontFile);
    for (const f of frames) {
      const crop = `crop=${f.w}:${f.h}:${f.x}:${f.y},scale=${W}:-2`;
      const label = `,drawtext=fontfile='${(fontFile ?? "").replace(/'/g, "")}':text='${f.n}':x=6:y=6:fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4`;
      const run = (vf: string) =>
        execFileAsync(ffmpegBin, [
          "-y", "-loglevel", "error", "-i", f.sprite, "-vf", vf,
          "-frames:v", "1", path.join(dir, `f${String(f.n).padStart(3, "0")}.jpg`),
        ], { timeout: 15_000 });
      if (numbered) {
        try {
          await run(crop + label);
          continue;
        } catch {
          numbered = false;
        }
      }
      await run(crop);
    }
    const rows = Math.ceil(frames.length / SHEET_COLUMNS);
    await execFileAsync(ffmpegBin, [
      "-y", "-loglevel", "error", "-start_number", "1", "-i", path.join(dir, "f%03d.jpg"),
      "-vf", `tile=${SHEET_COLUMNS}x${rows}:padding=4:color=black`,
      "-frames:v", "1", "-q:v", "4", outPath,
    ], { timeout: 30_000 });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
