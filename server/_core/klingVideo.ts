

/**
 * RONDE 30: read the credentials at call time instead of at import time.
 *
 * The three constants above were captured once when the module loaded, so a value set later —
 * which is exactly what a test does, and what any code that configures env after boot would do —
 * was invisible to the availability checks. maxKlingClipsPerVideo() in this same file already
 * reads process.env on every call, so the file disagreed with itself.
 *
 * No production behaviour changes: Railway sets these before the process starts, so the snapshot
 * and the live read return the same thing. What changes is that the check is now honest about
 * where it gets its answer, and can be exercised.
 */
function klingApiKey(): string {
  return process.env.KLING_API_KEY?.trim() || "";
}
function klingApiSecret(): string {
  return process.env.KLING_API_SECRET?.trim() || "";
}
function falKey(): string {
  return process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim() || "";
}

export function isKlingDirectAvailable(): boolean {
  return Boolean(klingApiKey() && klingApiSecret());
}

export function isKlingFalAvailable(): boolean {
  return Boolean(falKey());
}

export function isKlingAvailable(): boolean {
  return isKlingDirectAvailable() || isKlingFalAvailable();
}

/** On when API keys set; set ENABLE_KLING_BEAT_FALLBACK=false to disable. */
export function klingBeatFallbackEnabled(): boolean {
  if (process.env.ENABLE_KLING_BEAT_FALLBACK === "false") return false;
  return isKlingAvailable();
}

export function maxKlingClipsPerVideo(): number {
  const n = parseInt(process.env.KLING_MAX_CLIPS_PER_VIDEO || "6", 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(20, n) : 6;
}
