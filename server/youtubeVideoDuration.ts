/**
 * VIDEO 619 — how long a YouTube video is, asked of YouTube itself.
 *
 * The background fetch asked RapidAPI's metadata endpoint for this, and RapidAPI is switched off
 * (`RAPIDAPI_SWITCHED_OFF`): with no key every answer was "unknown", and "length unknown" refuses a
 * video as a possible Short — so the background fetch would have refused every video it was given.
 *
 * The YouTube Data API answers the same question for one quota unit per call (videos.list,
 * part=contentDetails). Answers are remembered for the life of the process, so a video asked about
 * twice costs one unit.
 */
export function isoDurationSec(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

const known = new Map<string, number>();

/** The video's length in seconds; 0 when it cannot be known (no key, not found, request failed). */
export async function youtubeVideoDurationSec(
  videoId: string,
  deps: { fetch?: typeof fetch; apiKey?: string } = {}
): Promise<number> {
  const id = videoId.trim();
  if (!id) return 0;
  const hit = known.get(id);
  if (hit != null) return hit;
  const apiKey = (deps.apiKey ?? process.env.YOUTUBE_API_KEY ?? "").trim();
  if (!apiKey) return 0;
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("id", id);
    url.searchParams.set("part", "contentDetails");
    const resp = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return 0;
    const data = (await resp.json()) as { items?: Array<{ contentDetails?: { duration?: string } }> };
    const sec = isoDurationSec(data.items?.[0]?.contentDetails?.duration);
    if (sec > 0) known.set(id, sec);
    return sec;
  } catch {
    return 0;
  }
}

export function forgetYoutubeVideoDurationsForTests(): void {
  known.clear();
}
