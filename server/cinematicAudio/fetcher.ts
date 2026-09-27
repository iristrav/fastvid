
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

async function fetchFreesoundPreviewUrl(freesoundId: number): Promise<string | null> {
  if (!FREESOUND_API_KEY) return null;
  try {
    const resp = await fetchWithRetry(
      `${FREESOUND_API}/sounds/${freesoundId}/?token=${FREESOUND_API_KEY}&format=json`,
      {},
      8_000
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { previews?: { "preview-hq-mp3"?: string } };
    return data.previews?.["preview-hq-mp3"] ?? null;
  } catch {
    return null;
  }
}

