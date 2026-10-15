/**
 * RONDE 656 — THE SOUND OF THE KEYS UNDER TEXT THAT TYPES.
 *
 * "Ook met een typend geluid." Every element the text director marked as typing gets the
 * catalogue's typewriter recording on the SFX track, from its first key to its last, at the pace
 * `typewriter.ts` defines — the same numbers the renderer types with. One clip per element rather
 * than one per key: a render with a hundred one-frame audio inputs is a render ffmpeg struggles
 * with, and a real typewriter recording already has the rhythm of keys in it.
 *
 * VIDEO 660 — the sound is DRAWN, not downloaded. It used to be `freesound:434572`, and Freesound
 * removed that recording: every render from job 55 to 61 logged "preview lookup answered HTTP 404"
 * and played the typing in silence. A sound made by the render's own ffmpeg (`makeSyntheticSfx`,
 * short filtered clicks about ten a second) cannot disappear from someone else's site, needs no API
 * key and no download. Its identity is `synthetic_sfx:typewriter`. Quiet (-22 dB) and cut with a short fade
 * so it stops when the typing does. Not ducked: the renderer never ducks an SFX-track clip unless
 * asked (§154, an accent is meant to be heard), and a typing sound pushed under the voice would be
 * gone exactly when the text types during narration. -22 dB is what keeps it under the voice.
 */
import { execFile } from "child_process";
import type { AssetSourceIdentity, ProjectTimeline, TimelineAudioClip, TimelineGraphic } from "./projectTimeline";
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import { TYPE_DELAY_SEC, typedLength, TYPE_CHAR_SEC } from "./remotion/components/typewriter";

export const TYPEWRITER_GAIN_DB = -22;

/** VIDEO 660 — a sound the render makes itself; its id names which one. */
export const SYNTHETIC_SFX_PROVIDER = "synthetic_sfx";
export const TYPEWRITER_SYNTHETIC_ID = "typewriter";

export function typewriterSoundIdentity(): AssetSourceIdentity {
  return { provider: SYNTHETIC_SFX_PROVIDER, providerAssetId: TYPEWRITER_SYNTHETIC_ID, title: "Typewriter keys" };
}

/**
 * The ffmpeg arguments that draw a sound, or null for an id this module does not know.
 *
 * Typewriter: a noise burst that dies away in about 10 ms with a short 1.8 kHz ring, repeating
 * every ~95 ms with a slow wobble so the keys do not tick like a clock; band-passed to the range
 * a key strike lives in. Eight seconds is longer than any typed line (`TYPE_CHAR_SEC` × 20 chars).
 */
export function syntheticSfxArgs(id: string, destPath: string): string[] | null {
  if (id !== TYPEWRITER_SYNTHETIC_ID) return null;
  const phase = "mod(t+0.021*sin(13*t),0.095)";
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", `aevalsrc='(random(0)*2-1)*0.7*exp(-90*${phase})+0.25*sin(2*PI*1800*t)*exp(-400*${phase})':s=44100:d=8`,
    "-af", "highpass=f=700,lowpass=f=7000",
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k",
    destPath,
  ];
}

/** Draws the sound to `destPath`. False when the id is unknown or ffmpeg failed; never throws. */
export async function makeSyntheticSfx(id: string, destPath: string, ffmpegBin?: string): Promise<boolean> {
  const args = syntheticSfxArgs(id, destPath);
  if (!args) return false;
  const bin = ffmpegBin ?? (await import("./ffmpegBinary")).resolveFFmpegBin();
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000 }, (err) => resolve(!err));
  });
}

export function typewriterSfxClips(
  entries: ReadonlyArray<{ id: string; start: number; text: string }>
): TimelineAudioClip[] {
  const gain = Number((10 ** (TYPEWRITER_GAIN_DB / 20)).toFixed(4));
  return entries
    .filter((e) => typedLength(e.text.trim()) > 0)
    .map((e) => {
      const start = Number((e.start + TYPE_DELAY_SEC).toFixed(3));
      const end = Number((start + typedLength(e.text) * TYPE_CHAR_SEC + 0.08).toFixed(3));
      return {
        id: `sfx_type_${e.id}`,
        source: typewriterSoundIdentity(),
        start,
        end,
        gain,
        fadeOutSec: 0.08,
      };
    });
}

/**
 * The film's intensity at a moment, from the planning engine's curve and the shot that is on screen:
 * that shot's own beat when the curve has it, else the loudest point of its scene. Null when the
 * moment is not covered or the curve says nothing about it.
 */
export function intensityAtFrom(
  clips: ReadonlyArray<{ timelineStart: number; timelineEnd: number; sceneIndex?: number; beatIndex?: number }>,
  curve: ReadonlyArray<{ sceneIndex: number; beatIndex: number; intensity: number }>
): (sec: number) => number | null {
  return (sec) => {
    const clip = clips.find((c) => sec >= c.timelineStart && sec < c.timelineEnd);
    if (!clip || clip.sceneIndex == null) return null;
    const exact = curve.find((p) => p.sceneIndex === clip.sceneIndex && p.beatIndex === clip.beatIndex);
    if (exact) return exact.intensity;
    const scene = curve.filter((p) => p.sceneIndex === clip.sceneIndex).map((p) => p.intensity);
    return scene.length ? Math.max(...scene) : null;
  };
}

/** Every recording that sounds like keys: the drawn typewriter, and the catalogue's typewriter and keyboard. */
function isTypingSound(source: AssetSourceIdentity): boolean {
  if (source.provider === SYNTHETIC_SFX_PROVIDER && source.providerAssetId === TYPEWRITER_SYNTHETIC_ID) return true;
  if (source.provider !== "freesound") return false;
  const keys = [...(SOUND_CATALOG.typewriter ?? []), ...(SOUND_CATALOG.keyboard ?? [])].map((v) => String(v.freesoundId));
  return keys.includes(String(source.providerAssetId ?? ""));
}

/**
 * VIDEO 660 — "als er typgeluid gebruikt wordt, dan moet dat wel met tekst". The last word on the
 * SFX track: a key sound stays only while a text or card that TYPES is on screen (a text animated
 * `typewriter`, a card with `data.typewriter`). Anything else — a sound left behind by a text that
 * was switched off, an older plan, an edit — is taken off the track. Returns the ids removed.
 */
export function typingSoundsOnlyUnderTypingText(
  timeline: ProjectTimeline,
  /**
   * Where a card is REALLY on screen. A year card waits for the voice to say the year
   * (`graphicOnScreenWindow`) and can appear after its planned window, with its keys; without this
   * those keys would be judged against the plan and wrongly taken off.
   */
  onScreen?: (g: TimelineGraphic) => { startSec: number; endSec: number }
): string[] {
  const typing = timeline.tracks.flatMap((t): Array<{ start: number; end: number }> =>
    t.kind === "TEXT"
      ? t.texts.filter((x) => !x.disabled && x.animation === "typewriter")
      : t.kind === "GRAPHICS"
        ? t.graphics
            .filter((g) => !g.disabled && g.data?.typewriter === true)
            .flatMap((g) => {
              const w = onScreen?.(g);
              return w ? [g, { start: w.startSec, end: w.endSec }] : [g];
            })
        : []
  );
  const removed: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "SFX") continue;
    const keep = track.clips.filter((c) => {
      if (!isTypingSound(c.source)) return true;
      const withText = typing.some((x) => c.start < x.end && x.start < c.end);
      if (!withText) removed.push(c.id);
      return withText;
    });
    track.clips.splice(0, track.clips.length, ...keep);
  }
  return removed;
}
