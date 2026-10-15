
const FREESOUND_API_KEY = process.env.FREESOUND_API_KEY;
const FREESOUND_API = "https://freesound.org/apiv2";

async function fetchWithRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  timeoutMs: number,
  maxAttempts = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok || resp.status < 500) return resp; // don't retry 4xx
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

/**
 * RONDE 166 (§2) — exported so the asset rehydrator can reuse it.
 *
 * The rehydrator resolves a `freesound:<id>` identity from the AMBIENT track and needs the same
 * preview URL this module already looks up. Exporting it is what stops a second Freesound client
 * (with a second copy of the key handling and the retry rules) from being written next to it.
 */
export async function freesoundPreviewUrl(freesoundId: number): Promise<string | null> {
  return fetchFreesoundPreviewUrl(freesoundId);
}

/**
 * VIDEO 659 (fix F) — a sound Freesound says is GONE (404/410) is not asked for again.
 *
 * 459931 ("Wind drone footage" / "Gentle wind") answered 404 in job 27, 63 and 66, every render
 * asking afresh. The answer is final: the sound was removed. Remembered for the life of the process,
 * so the next clip, scene or render that names it moves straight on to its alternative. A 5xx, a
 * timeout or a 429 is NOT remembered — those pass, and the sound is asked for again next time.
 */
const goneSounds = new Set<number>();
export function freesoundSoundIsGone(freesoundId: number): boolean {
  return goneSounds.has(freesoundId);
}
export function __resetFreesoundGoneForTests(): void {
  goneSounds.clear();
}

async function fetchFreesoundPreviewUrl(freesoundId: number): Promise<string | null> {
  if (!FREESOUND_API_KEY) return null;
  if (goneSounds.has(freesoundId)) return null;
  try {
    const resp = await fetchWithRetry(
      `${FREESOUND_API}/sounds/${freesoundId}/?token=${FREESOUND_API_KEY}&format=json`,
      {},
      8_000
    );
    if (!resp.ok) {
      /** VIDEO 650 — the status, so a 401 (key), a 404 (sound gone) and a 429 (quota) read differently. */
      const gone = resp.status === 404 || resp.status === 410;
      if (gone) goneSounds.add(freesoundId);
      console.warn(
        `[Freesound] sound=${freesoundId} preview lookup answered HTTP ${resp.status}` +
          (gone ? " — the sound is gone; remembered, not asked again" : "")
      );
      return null;
    }
    const data = await resp.json() as { previews?: { "preview-hq-mp3"?: string } };
    if (!data.previews?.["preview-hq-mp3"]) console.warn(`[Freesound] sound=${freesoundId} answered without a preview-hq-mp3 field`);
    return data.previews?.["preview-hq-mp3"] ?? null;
  } catch (err) {
    console.warn(`[Freesound] sound=${freesoundId} preview lookup failed: ${(err as Error)?.message?.slice(0, 100)}`);
    return null;
  }
}

