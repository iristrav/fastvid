import * as fs from "fs";
import * as path from "path";
import type { SoundCategoryId, SoundVariant } from "./types";
import { SOUND_CATALOG } from "./catalog";

const SOUND_CACHE_DIR = process.env.SOUND_LIBRARY_DIR ?? "/var/tmp/fastvid_sounds";
const FREESOUND_API_KEY = process.env.FREESOUND_API_KEY;
const FREESOUND_API = "https://freesound.org/apiv2";

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(SOUND_CACHE_DIR)) fs.mkdirSync(SOUND_CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }
}

function localPath(variant: SoundVariant): string {
  return path.join(SOUND_CACHE_DIR, `${variant.id}.mp3`);
}

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

async function downloadUrl(url: string, dest: string): Promise<boolean> {
  try {
    const resp = await fetchWithRetry(url, {}, 20_000, 2);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) return false;
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

async function ensureVariantCached(variant: SoundVariant): Promise<string | null> {
  const dest = localPath(variant);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return dest;

  ensureCacheDir();

  // Try Freesound API
  if (FREESOUND_API_KEY) {
    const previewUrl = await fetchFreesoundPreviewUrl(variant.freesoundId);
    if (previewUrl && await downloadUrl(previewUrl, dest)) {
      console.log(`[CinematicAudio] Downloaded: ${variant.id} (Freesound #${variant.freesoundId})`);
      return dest;
    }
  }

  return null;
}

/** Pick a random variant from a category and ensure it's cached. Returns local path or null. */
export async function resolveSoundAsset(category: SoundCategoryId): Promise<string | null> {
  const variants = SOUND_CATALOG[category];
  if (!variants?.length) return null;

  // Try variants in random order
  const shuffled = [...variants].sort(() => Math.random() - 0.5);
  for (const variant of shuffled) {
    const p = await ensureVariantCached(variant);
    if (p) return p;
  }
  return null;
}

/** Resolve multiple categories, returning a map of category → local path. */
export async function resolveSoundAssets(
  categories: SoundCategoryId[]
): Promise<Map<SoundCategoryId, string>> {
  const result = new Map<SoundCategoryId, string>();
  await Promise.all(
    categories.map(async (cat) => {
      const p = await resolveSoundAsset(cat);
      if (p) result.set(cat, p);
    })
  );
  return result;
}

/** Pre-download the full sound library. Call once during setup. */
export async function downloadFullSoundLibrary(): Promise<void> {
  if (!FREESOUND_API_KEY) {
    console.log("[CinematicAudio] FREESOUND_API_KEY not set — skipping library download");
    return;
  }
  ensureCacheDir();
  const categories = Object.keys(SOUND_CATALOG) as SoundCategoryId[];
  console.log(`[CinematicAudio] Downloading sound library (${categories.length} categories)...`);
  let downloaded = 0;
  for (const cat of categories) {
    for (const variant of SOUND_CATALOG[cat]) {
      const dest = localPath(variant);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) { downloaded++; continue; }
      const previewUrl = await fetchFreesoundPreviewUrl(variant.freesoundId);
      if (previewUrl && await downloadUrl(previewUrl, dest)) downloaded++;
      // Small delay to be kind to the API
      await new Promise(r => setTimeout(r, 200));
    }
  }
  console.log(`[CinematicAudio] Library ready: ${downloaded} sound files in ${SOUND_CACHE_DIR}`);
}

export function cinematicAudioEnabled(): boolean {
  return process.env.CINEMATIC_AUDIO !== "false";
}
