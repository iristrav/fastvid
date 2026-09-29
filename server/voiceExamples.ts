/**
 * VIDEO 619 — a voice's stored example has to PLAY, not merely exist as a URL.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * The voice picker plays `exampleAudioUrl` straight away whenever it is set, and the startup
 * bootstrap only generated examples for voices whose URL was EMPTY. A URL pointing at a file the
 * current storage no longer holds (an earlier storage backend, a deleted key) therefore stayed in
 * the database for good: the bootstrap logged "All voices already have example audio" on every
 * boot while the browser got a 404 on every click and showed "This preview could not be loaded".
 *
 * ── What this is ─────────────────────────────────────────────────────────────────────────────
 *
 * One question — does this example actually load? — asked at boot for every voice, and one way to
 * make an example: ElevenLabs, stored, and written back to the voice so the next click is instant.
 * The preview route uses the same maker, so a click that finds a dead example repairs it for
 * everyone rather than for one person once.
 */
import { storageGetSignedUrl, storagePut } from "./storage";

export const VOICE_PREVIEW_TEXT =
  "Hello! This is a preview of how this voice sounds. I hope you enjoy using it for your YouTube videos.";

type Fetch = typeof fetch;

/**
 * Where the bytes of a stored URL really are. `/manus-storage/<key>` is this app's own proxy path
 * and is resolved to the storage backend's signed URL; an absolute http(s) URL is itself.
 */
export async function resolvableExampleUrl(
  url: string,
  signed: (key: string) => Promise<string> = storageGetSignedUrl
): Promise<string | null> {
  if (url.startsWith("/manus-storage/")) {
    const target = await signed(url.replace(/^\/manus-storage\//, ""));
    return target.startsWith("/") ? null : target;
  }
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

/**
 * Does the example load? One byte is asked for, so checking six voices at boot costs six tiny
 * requests. Anything that is not a 200/206 with audio-ish content is "no".
 */
export async function exampleAudioLoads(
  url: string | null | undefined,
  deps: { fetch?: Fetch; signed?: (key: string) => Promise<string> } = {}
): Promise<boolean> {
  if (!url?.trim()) return false;
  try {
    const target = await resolvableExampleUrl(url, deps.signed);
    if (!target) return false;
    const res = await (deps.fetch ?? fetch)(target, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/** Make a fresh example for an ElevenLabs voice id and store it. Throws with ElevenLabs' own reason. */
export async function makeVoiceExample(
  elevenLabsVoiceId: string,
  apiKey: string,
  deps: { fetch?: Fetch; put?: typeof storagePut } = {}
): Promise<string> {
  const res = await (deps.fetch ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: VOICE_PREVIEW_TEXT,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const { url } = await (deps.put ?? storagePut)(`voice-examples/${elevenLabsVoiceId}.mp3`, buf, "audio/mpeg");
  return url;
}
