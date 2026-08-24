/**
 * Script-guided clip finder — locate the right moment in a YouTube video
 * using captions (fast) and optional local CLIP thumbnail check.
 */
import { foldSearchText } from "./searchTextNormalize";
import { localVisionEnabled, scoreUrlImageAgainstBeat } from "./localClipVision";
import { pickLongVideoStartSec } from "./beatSegmentChoice";
import {
  fetchYoutubeVideoContext,
  pickCaptionTrack,
  type YoutubeCaptionTrack,
} from "./youtubeVideoContext";

export type TranscriptSegment = { startSec: number; text: string };

export type ScriptGuidedCandidate = {
  videoId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  metadataScore: number;
};

export type ScriptGuidedClipPlan = {
  videoId: string;
  startSec: number;
  method: "transcript" | "metadata" | "vision" | "default";
  confidence: number;
  skip: boolean;
  /** RONDE 60: source length, when the watch page stated it. 0 = unknown. */
  sourceDurationSec?: number;
};

export type ScriptGuidedOptions = {
  beatText: string;
  keywords: string[];
  videoTitle?: string;
  /** Wall-clock deadline (Date.now() ms). */
  deadlineMs: number;
  fastMode?: boolean;
  /** RONDE 60: how much of the video will be taken, so a fallback start can leave room for it. */
  clipDurationSec?: number;
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "was", "were", "that", "this", "it", "its", "as", "so", "if", "not", "but", "about",
]);

function tokenize(text: string): string[] {
  return foldSearchText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function keywordOverlap(text: string, keywords: string[]): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const kw of keywords) {
    if (kw.length >= 3 && hay.includes(kw.toLowerCase())) n++;
  }
  return n;
}

/** Score title + description against beat keywords (no network). */
export function scoreYoutubeMetadata(candidate: ScriptGuidedCandidate, keywords: string[]): number {
  const hay = `${candidate.title} ${candidate.description ?? ""}`;
  return keywordOverlap(hay, keywords) + Math.min(candidate.metadataScore, 5);
}

/** Find best clip start from caption segments aligned to beat keywords. */
export function findClipStartFromTranscript(
  segments: TranscriptSegment[],
  beatText: string,
  keywords: string[]
): { startSec: number; confidence: number } | null {
  if (!segments.length) return null;
  const terms = [...new Set([...tokenize(beatText), ...keywords.map((k) => k.toLowerCase())])].filter(
    (t) => t.length >= 3
  );
  if (!terms.length) return null;

  let bestStart = 0;
  let bestScore = 0;

  for (let i = 0; i < segments.length; i++) {
    const solo = keywordOverlap(segments[i].text, terms);
    if (solo < 1) continue;

    let score = solo;
    for (let j = 1; j < 3 && i + j < segments.length; j++) {
      score += keywordOverlap(segments[i + j].text, terms) * 0.35;
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = Math.max(0, segments[i].startSec - 1.5);
    }
  }

  if (bestScore < 1) return null;
  return { startSec: bestStart, confidence: Math.min(10, bestScore * 2) };
}

function parseTimedTextJson3(raw: string): TranscriptSegment[] {
  try {
    const data = JSON.parse(raw) as {
      events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
    };
    const out: TranscriptSegment[] = [];
    for (const ev of data.events ?? []) {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
      if (!text || ev.tStartMs == null) continue;
      out.push({ startSec: ev.tStartMs / 1000, text });
    }
    return out;
  } catch {
    return [];
  }
}

function parseTimedTextXml(raw: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const re = /<text[^>]*start="([^"]+)"[^>]*>([^<]*)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = parseFloat(m[1]);
    const text = m[2].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (!Number.isNaN(start) && text) out.push({ startSec: start, text });
  }
  return out;
}

/**
 * RONDE 60: fetch one caption track by its real, signed URL.
 *
 * The URL comes off the watch page, so no language or format has to be guessed — the only thing
 * appended is the format, which the endpoint accepts on an otherwise complete URL.
 */
async function fetchTranscriptFromTrack(
  track: YoutubeCaptionTrack,
  timeoutMs: number
): Promise<TranscriptSegment[]> {
  for (const fmt of ["json3", "srv3"]) {
    const url = `${track.baseUrl}${track.baseUrl.includes("?") ? "&" : "?"}fmt=${fmt}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
        signal: controller.signal as never,
      });
      if (!resp.ok) continue;
      const raw = await resp.text();
      if (!raw.trim()) continue;
      const segments = fmt === "json3" ? parseTimedTextJson3(raw) : parseTimedTextXml(raw);
      if (segments.length >= 2) return segments;
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

/**
 * Fetch YouTube captions — fast, no API key.
 *
 * RONDE 60: asks the watch page which tracks exist instead of guessing URLs. The guessing route
 * below is kept as a fallback, now including `kind=asr` — its absence alone excluded every video
 * whose only captions are auto-generated, which is most of them.
 */
export async function fetchYoutubeTranscript(
  videoId: string,
  timeoutMs = 4_000
): Promise<TranscriptSegment[]> {
  const ctx = await fetchYoutubeVideoContext(videoId, timeoutMs);
  const track = pickCaptionTrack(ctx.captionTracks);
  if (track) {
    const segments = await fetchTranscriptFromTrack(track, timeoutMs);
    if (segments.length >= 2) return segments;
  }

  const langs = ["en", "en-US", "en-GB"];
  const fmts = ["json3", "srv3"];
  const kinds = ["", "&kind=asr"];

  // Adding kind=asr doubles this loop to twelve combinations. Against a hanging endpoint that
  // would be twelve full timeouts — enough to blow the whole per-scene planning budget on one
  // candidate — so the guessing route gets an overall deadline of its own. It is a fallback:
  // when the watch page above worked, none of this runs at all.
  const guessDeadline = Date.now() + timeoutMs * 2;

  for (const lang of langs) {
    for (const fmt of fmts) {
      for (const kind of kinds) {
      if (Date.now() > guessDeadline) return [];
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=${fmt}${kind}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { headers: { "User-Agent": "Fastvid/1.0" }, signal: controller.signal as never });
        if (!resp.ok) continue;
        const raw = await resp.text();
        if (!raw.trim()) continue;
        const segments = fmt === "json3" ? parseTimedTextJson3(raw) : parseTimedTextXml(raw);
        if (segments.length >= 2) return segments;
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
      }
    }
  }
  return [];
}

/** Local CLIP thumbnail check against beat narration. */
export async function scoreThumbnailRelevance(
  thumbnailUrl: string,
  beatText: string,
  videoTitle: string | undefined,
  timeoutMs = 6_000
): Promise<{ relevance: number; showsSubject: boolean } | null> {
  if (process.env.ENABLE_SCRIPT_GUIDED_VISION === "false" || !localVisionEnabled()) return null;
  return scoreUrlImageAgainstBeat(thumbnailUrl, beatText, videoTitle, timeoutMs);
}

/**
 * The old flat default, kept for the one case where nothing is known: the deadline passed before
 * the watch page could be read, so there is no duration to scale against.
 */
const LEGACY_FALLBACK_START_SEC = 12;

export function scriptGuidedClipsEnabled(): boolean {
  return process.env.ENABLE_SCRIPT_GUIDED_CLIPS !== "false";
}

/** Per-beat time budget for script-guided planning (keeps generation fast). */
export function scriptGuidedBudgetMs(fastMode: boolean): number {
  const raw = process.env.SCRIPT_GUIDED_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fastMode ? 22_000 : 32_000;
}

/**
 * Plan clip start for one YouTube candidate: transcript → vision → metadata offset.
 * Returns skip=true when vision confidently rejects the thumbnail.
 */
export async function planScriptGuidedClip(
  candidate: ScriptGuidedCandidate,
  options: ScriptGuidedOptions
): Promise<ScriptGuidedClipPlan> {
  // How much of the source will be taken — needed so a fallback start still leaves room for it.
  const take = options.clipDurationSec && options.clipDurationSec > 0 ? options.clipDurationSec : 6;

  // Filled in from the watch page below; 0 means we never got to look, or it did not say.
  let durationSec = 0;

  /**
   * RONDE 60: what to do when nothing has located the subject.
   *
   * This used to be a flat number — 8, 10 or 12 seconds — applied to every video regardless of
   * length. In render 531 all 55 YouTube clips were cut at second 8 or second 12, which on a
   * forty-minute documentary is the channel leader and the host saying hello. Knowing the
   * duration does not tell us where the right moment is, but it does tell us where it is not.
   */
  const fallbackStart = (): number =>
    durationSec > 0 ? pickLongVideoStartSec(durationSec, take, candidate.videoId) : LEGACY_FALLBACK_START_SEC;

  const defaultPlan = (): ScriptGuidedClipPlan => ({
    videoId: candidate.videoId,
    startSec: fallbackStart(),
    method: "default",
    confidence: 1,
    skip: false,
    sourceDurationSec: durationSec,
  });

  if (Date.now() > options.deadlineMs) return defaultPlan();

  // One watch-page read gives both the caption tracks and the duration; fetchYoutubeTranscript
  // below reads the same cached context, so this costs nothing extra.
  const transcriptMs = options.fastMode ? 3_500 : 5_000;
  durationSec = (await fetchYoutubeVideoContext(candidate.videoId, transcriptMs)).durationSec;

  const segments = await fetchYoutubeTranscript(candidate.videoId, transcriptMs);
  // A caption track also states the length, for the case where the page did not.
  if (durationSec <= 0 && segments.length > 0) {
    durationSec = segments[segments.length - 1]!.startSec;
  }

  const transcriptHit = findClipStartFromTranscript(segments, options.beatText, options.keywords);
  if (transcriptHit && transcriptHit.confidence >= 2) {
    return {
      videoId: candidate.videoId,
      startSec: transcriptHit.startSec,
      method: "transcript",
      confidence: transcriptHit.confidence,
      skip: false,
      sourceDurationSec: durationSec,
    };
  }

  if (Date.now() > options.deadlineMs) return defaultPlan();

  const metaScore = scoreYoutubeMetadata(candidate, options.keywords);
  if (metaScore >= 3) {
    // A good title says the video is ABOUT the subject. It says nothing about which second of it
    // shows the subject, so the start is the duration-aware fallback, not the old flat 8.
    return {
      videoId: candidate.videoId,
      startSec: fallbackStart(),
      method: "metadata",
      confidence: metaScore,
      skip: false,
      sourceDurationSec: durationSec,
    };
  }

  if (options.fastMode && metaScore >= 2) return defaultPlan();
  if (Date.now() > options.deadlineMs || !candidate.thumbnailUrl) return defaultPlan();

  const vision = await scoreThumbnailRelevance(
    candidate.thumbnailUrl,
    options.beatText,
    options.videoTitle,
    options.fastMode ? 5_000 : 7_000
  );
  if (vision) {
    if (vision.relevance < 4 && !vision.showsSubject) {
      return { ...defaultPlan(), skip: true, method: "vision", confidence: vision.relevance };
    }
    if (vision.showsSubject || vision.relevance >= 6) {
      return {
        videoId: candidate.videoId,
        startSec: transcriptHit?.startSec ?? fallbackStart(),
        method: "vision",
        confidence: vision.relevance,
        skip: false,
        sourceDurationSec: durationSec,
      };
    }
  }

  return defaultPlan();
}

/** Rank and plan top YouTube search hits within a time budget. */
export async function planBestScriptGuidedClip(
  candidates: ScriptGuidedCandidate[],
  options: ScriptGuidedOptions
): Promise<ScriptGuidedClipPlan | null> {
  if (!scriptGuidedClipsEnabled() || !candidates.length) return null;

  const ranked = [...candidates].sort(
    (a, b) => scoreYoutubeMetadata(b, options.keywords) - scoreYoutubeMetadata(a, options.keywords)
  );
  const maxTries = options.fastMode ? 3 : 4;

  for (const c of ranked.slice(0, maxTries)) {
    if (Date.now() > options.deadlineMs) break;
    const plan = await planScriptGuidedClip(c, options);
    if (!plan.skip) return plan;
  }
  return null;
}
