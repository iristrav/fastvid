/**
 * Script-guided clip finder — locate the right moment in a YouTube video
 * using captions (fast) and optional local CLIP thumbnail check.
 */
import { localVisionEnabled, scoreUrlImageAgainstBeat } from "./localClipVision";

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
};

export type ScriptGuidedOptions = {
  beatText: string;
  keywords: string[];
  videoTitle?: string;
  /** Wall-clock deadline (Date.now() ms). */
  deadlineMs: number;
  fastMode?: boolean;
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "was", "were", "that", "this", "it", "its", "as", "so", "if", "not", "but", "about",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
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

/** Fetch YouTube captions (CC videos) — fast, no API key. */
export async function fetchYoutubeTranscript(
  videoId: string,
  timeoutMs = 4_000
): Promise<TranscriptSegment[]> {
  const langs = ["en", "en-US", "en-GB"];
  const fmts = ["json3", "srv3"];

  for (const lang of langs) {
    for (const fmt of fmts) {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=${fmt}`;
      try {
        const resp = await Promise.race([
          fetch(url, { headers: { "User-Agent": "Fastvid/1.0" } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ]);
        if (!resp.ok) continue;
        const raw = await resp.text();
        if (!raw.trim()) continue;
        const segments = fmt === "json3" ? parseTimedTextJson3(raw) : parseTimedTextXml(raw);
        if (segments.length >= 2) return segments;
      } catch {
        continue;
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
  const defaultPlan: ScriptGuidedClipPlan = {
    videoId: candidate.videoId,
    startSec: 12,
    method: "default",
    confidence: 1,
    skip: false,
  };

  if (Date.now() > options.deadlineMs) return defaultPlan;

  const transcriptMs = options.fastMode ? 3_500 : 5_000;
  const segments = await fetchYoutubeTranscript(candidate.videoId, transcriptMs);
  const transcriptHit = findClipStartFromTranscript(segments, options.beatText, options.keywords);
  if (transcriptHit && transcriptHit.confidence >= 2) {
    return {
      videoId: candidate.videoId,
      startSec: transcriptHit.startSec,
      method: "transcript",
      confidence: transcriptHit.confidence,
      skip: false,
    };
  }

  if (Date.now() > options.deadlineMs) return defaultPlan;

  const metaScore = scoreYoutubeMetadata(candidate, options.keywords);
  if (metaScore >= 3) {
    return {
      videoId: candidate.videoId,
      startSec: segments.length > 0 ? Math.min(30, segments[0].startSec + 5) : 8,
      method: "metadata",
      confidence: metaScore,
      skip: false,
    };
  }

  if (options.fastMode && metaScore >= 2) return defaultPlan;
  if (Date.now() > options.deadlineMs || !candidate.thumbnailUrl) return defaultPlan;

  const vision = await scoreThumbnailRelevance(
    candidate.thumbnailUrl,
    options.beatText,
    options.videoTitle,
    options.fastMode ? 5_000 : 7_000
  );
  if (vision) {
    if (vision.relevance < 4 && !vision.showsSubject) {
      return { ...defaultPlan, skip: true, method: "vision", confidence: vision.relevance };
    }
    if (vision.showsSubject || vision.relevance >= 6) {
      return {
        videoId: candidate.videoId,
        startSec: transcriptHit?.startSec ?? 10,
        method: "vision",
        confidence: vision.relevance,
        skip: false,
      };
    }
  }

  return defaultPlan;
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
