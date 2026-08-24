/**
 * RONDE 60 — what the pipeline can learn about a YouTube video before it downloads any of it.
 *
 * Two things, from one request: how long the video is, and where its captions live.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * The transcript is the only mechanism in the pipeline that can find the RIGHT moment in a long
 * video — the segment where the narration's subject is actually being discussed. In render 531
 * it fired zero times out of 55:
 *
 *     28 x  default  @12s
 *     27 x  metadata @8s
 *      0 x  transcript
 *
 * All 27 metadata plans landed on exactly 8, which is the `segments.length === 0` branch of that
 * ladder. Had a single caption segment come back, the start would have been `segments[0] + 5`,
 * which is almost never exactly 8. So the caption fetch returned nothing on every attempt.
 *
 * The old fetch guessed at URLs: /api/timedtext?v=ID&lang=en&fmt=json3, for three language codes
 * and two formats. That misses everything with only auto-generated captions (those need
 * &kind=asr), everything captioned in another language, and — increasingly — everything at all,
 * because YouTube no longer serves that endpoint from a bare guessed URL.
 *
 * The watch page states the answer instead of asking us to guess it: it carries the real, signed
 * caption-track URLs, their languages, and whether each is automatic. It also carries
 * lengthSeconds, which is the duration nothing else in the YouTube path had — the reason every
 * clip was cut at second 8 or 12 whether the video ran four minutes or forty.
 */

export type YoutubeCaptionTrack = {
  baseUrl: string;
  languageCode: string;
  /** "asr" for auto-generated captions. */
  kind?: string;
};

export type YoutubeVideoContext = {
  /** Source length in seconds, 0 when the page did not state it. */
  durationSec: number;
  captionTracks: YoutubeCaptionTrack[];
};

const EMPTY: YoutubeVideoContext = { durationSec: 0, captionTracks: [] };

export function youtubeVideoContextEnabled(): boolean {
  return process.env.ENABLE_YOUTUBE_VIDEO_CONTEXT !== "false";
}

/**
 * Process-level cache. Unlike the judgement budget in beatImageRelevanceGate — which is
 * deliberately per-render so two renders cannot spend each other's calls — this holds immutable
 * facts about a video: its length and its caption URLs. Sharing those across renders is free and
 * correct. Bounded in both size and age so a long-lived worker cannot grow without limit.
 */
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; ctx: YoutubeVideoContext }>();

function cacheGet(videoId: string): YoutubeVideoContext | null {
  const hit = cache.get(videoId);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(videoId);
    return null;
  }
  return hit.ctx;
}

function cacheSet(videoId: string, ctx: YoutubeVideoContext): void {
  if (cache.size >= CACHE_MAX) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(videoId, { at: Date.now(), ctx });
}

/**
 * What is already known about this video, without asking the network.
 *
 * Used where a fetch cannot be afforded — past the per-scene planning budget, for instance —
 * but a duration learned earlier in the render is still worth having. Returns null when nothing
 * is known, which callers treat as "no duration", not as a reason to reject the video.
 */
export function peekYoutubeVideoContext(videoId: string): YoutubeVideoContext | null {
  if (!youtubeVideoContextEnabled()) return null;
  return cacheGet(videoId);
}

/** Test seam: a render should never inherit another test's cached page. */
export function _resetYoutubeVideoContextCache(): void {
  cache.clear();
}

/**
 * Pulls one balanced JSON array out of a much larger document, starting at `from`.
 *
 * The watch page is megabytes of script; JSON.parse on the whole of it is not an option, and a
 * regex cannot match nested brackets. This walks the array once, tracking string state so a "]"
 * inside a caption title cannot end it early.
 */
function sliceJsonArray(html: string, from: number): string | null {
  const start = html.indexOf("[", from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(html.length, start + 200_000);
  for (let i = start; i < limit; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

export function parseYoutubeWatchPage(html: string): YoutubeVideoContext {
  if (!html) return EMPTY;

  let durationSec = 0;
  const lenMatch = /"lengthSeconds"\s*:\s*"?(\d{1,7})"?/.exec(html);
  if (lenMatch) {
    const n = Number.parseInt(lenMatch[1]!, 10);
    if (Number.isFinite(n) && n > 0) durationSec = n;
  }

  let captionTracks: YoutubeCaptionTrack[] = [];
  const at = html.indexOf('"captionTracks"');
  if (at >= 0) {
    const raw = sliceJsonArray(html, at);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        captionTracks = parsed
          .map((t) => ({
            baseUrl: typeof t.baseUrl === "string" ? t.baseUrl : "",
            languageCode: typeof t.languageCode === "string" ? t.languageCode : "",
            kind: typeof t.kind === "string" ? t.kind : undefined,
          }))
          .filter((t) => t.baseUrl.startsWith("http"));
      } catch {
        captionTracks = [];
      }
    }
  }

  return { durationSec, captionTracks };
}

/**
 * Picks the caption track to read.
 *
 * A human-written English track beats an automatic one — auto captions mishear proper nouns, and
 * proper nouns are exactly what the beat is matched on. But an automatic track still locates the
 * subject far better than a guessed offset does, so it is taken over nothing, and a track in
 * another language is taken over nothing at all.
 */
export function pickCaptionTrack(
  tracks: YoutubeCaptionTrack[],
  preferredLangs = ["en"]
): YoutubeCaptionTrack | null {
  if (!tracks.length) return null;
  const isPreferred = (t: YoutubeCaptionTrack) =>
    preferredLangs.some((l) => t.languageCode.toLowerCase().startsWith(l.toLowerCase()));
  const manual = (t: YoutubeCaptionTrack) => t.kind !== "asr";
  return (
    tracks.find((t) => isPreferred(t) && manual(t)) ??
    tracks.find((t) => isPreferred(t)) ??
    tracks.find(manual) ??
    tracks[0] ??
    null
  );
}

/**
 * Fetches the watch page and reads the two facts off it. Never throws — an unreachable or
 * changed page returns an empty context, and every caller treats that as "unknown", not as a
 * reason to reject the video.
 */
export async function fetchYoutubeVideoContext(
  videoId: string,
  timeoutMs = 6_000
): Promise<YoutubeVideoContext> {
  if (!youtubeVideoContextEnabled() || !videoId) return EMPTY;
  const cached = cacheGet(videoId);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
      headers: {
        // A desktop UA gets the full player response; the bare "Fastvid/1.0" the old transcript
        // fetch sent gets a stripped page with no caption tracks on it at all.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        // Skips the EU consent interstitial, which otherwise replaces the player response.
        Cookie: "CONSENT=YES+1",
      },
      signal: controller.signal as never,
    });
    if (!resp.ok) return EMPTY;
    const ctx = parseYoutubeWatchPage(await resp.text());
    // Only worth remembering when it actually said something.
    if (ctx.durationSec > 0 || ctx.captionTracks.length > 0) cacheSet(videoId, ctx);
    return ctx;
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
