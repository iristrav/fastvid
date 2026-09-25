/**
 * RONDE 656 — THE SOUND OF THE KEYS UNDER TEXT THAT TYPES.
 *
 * "Ook met een typend geluid." Every element the text director marked as typing gets the
 * catalogue's typewriter recording on the SFX track, from its first key to its last, at the pace
 * `typewriter.ts` defines — the same numbers the renderer types with. One clip per element rather
 * than one per key: a render with a hundred one-frame audio inputs is a render ffmpeg struggles
 * with, and a real typewriter recording already has the rhythm of keys in it.
 *
 * The recording is `freesound:434572`, "Typewriter keys", from the sound catalogue that already
 * supplies the ambience — not a new id written down here. Quiet (-22 dB), ducked under the voice,
 * and cut with a short fade so it stops when the typing does.
 */
import type { TimelineAudioClip } from "./projectTimeline";
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import { TYPE_DELAY_SEC, typedLength, TYPE_CHAR_SEC } from "./remotion/components/typewriter";

export const TYPEWRITER_GAIN_DB = -22;

export function typewriterSoundId(): string | null {
  const v = SOUND_CATALOG.typewriter?.[0];
  return v ? String(v.freesoundId) : null;
}

export function typewriterSfxClips(
  entries: ReadonlyArray<{ id: string; start: number; text: string }>
): TimelineAudioClip[] {
  const id = typewriterSoundId();
  if (!id) return [];
  const gain = Number((10 ** (TYPEWRITER_GAIN_DB / 20)).toFixed(4));
  return entries
    .filter((e) => typedLength(e.text.trim()) > 0)
    .map((e) => {
      const start = Number((e.start + TYPE_DELAY_SEC).toFixed(3));
      const end = Number((start + typedLength(e.text) * TYPE_CHAR_SEC + 0.08).toFixed(3));
      return {
        id: `sfx_type_${e.id}`,
        source: { provider: "freesound", providerAssetId: id, title: "Typewriter keys" },
        start,
        end,
        gain,
        fadeOutSec: 0.08,
        duckUnderVoice: true,
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
