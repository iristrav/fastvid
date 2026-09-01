/**
 * RONDE 166 (§1/§2) — the AMBIENT track, connected to the catalogue that was already there.
 *
 * ── What the R160–165 audit found ────────────────────────────────────────────────────────────
 *
 * `edlToTimeline` built its AMBIENT and MUSIC tracks as literal `clips: []`, and
 * `audioAssetSource.ts` — the module RONDE 154 wrote to resolve exactly these — had zero
 * production callers. So a cinematically planned video had no room tone and no music, ever, and
 * nothing said so.
 *
 * Everything needed was already in the repository, in three separate pieces that had never been
 * introduced to each other:
 *
 *   cinematicAudio/planner.ts   `planSceneAudio` reads a scene and returns the catalogue
 *                               CATEGORIES its text supports — an evidence-based classifier that
 *                               has been running for the legacy route all along.
 *   audioAssetSource.ts         `resolveCatalogSound` turns a category into a real
 *                               `freesound:401178` IDENTITY, deterministically by index rather
 *                               than at random.
 *   cinematicAudio/fetcher.ts   turns that Freesound id into a cached local file.
 *
 * This module is the sentence between them. It classifies nothing and invents nothing: it asks the
 * existing planner what the scene supports, asks the existing resolver for an identity, and lays
 * the result on the timeline as ordinary audio clips.
 *
 * ── Why the timeline stores an identity and not a path ───────────────────────────────────────
 *
 * §1: "De timeline moet niet zeggen music: 'something cinematic' maar een concrete,
 * reproduceerbare asset identity bevatten." `freesound:401178` names one specific CC-licensed
 * recording that the rehydrator can fetch again next month. A local path in a temp directory names
 * a file that will not exist tomorrow.
 *
 * ── Music ────────────────────────────────────────────────────────────────────────────────────
 *
 * There is no music catalogue in this repository. The audio catalogue is 45 categories of
 * Freesound FIELD RECORDINGS — traffic, rain, crowds — and the only thing that answers "give me
 * something tense" is `ProceduralMusicSource`, a synthesised sine bed that says itself that it
 * ignores the mood it was asked for.
 *
 * §1 is explicit about this case: do not pretend. So `planCinematicAudio` reports
 * `musicSourceUnavailable` with the reason, the MUSIC track stays empty, and no sine bed is
 * quietly laid under a documentary and called music.
 */
import { planSceneAudio } from "./cinematicAudio/planner";
import type { SoundCategoryId } from "./cinematicAudio/types";
import { resolveCatalogSound } from "./audioAssetSource";
import type { AssetSourceIdentity, TimelineAudioClip } from "./projectTimeline";
import type { Scene } from "./pipeline/types";

/** One scene's ambience, resolved to something the renderer can actually fetch. */
export type PlannedAmbient = {
  sceneIndex: number;
  category: SoundCategoryId;
  identity: AssetSourceIdentity;
  label: string;
  startSec: number;
  endSec: number;
};

export type CinematicAudioPlan = {
  ambient: PlannedAmbient[];
  /**
   * Every ambience the planner asked for that the catalogue could not supply, and why.
   *
   * §17 — a fallback is never silent. A scene whose room tone is missing is a scene that sounds
   * different from the one that was planned, and the render log says which.
   */
  unavailable: string[];
  /** §1 — the music verdict, always stated. */
  music: { available: false; reason: string };
};

/**
 * How loud room tone sits under narration.
 *
 * The catalogue's own `ambienceVolumeDb` is a dB figure for the legacy ffmpeg mixer;
 * `TimelineAudioClip.gain` is linear. This converts rather than inventing a second calibration —
 * −26 dBFS is what `planSceneAudio` already returns for a neutral scene.
 */
function gainFromDb(db: number): number {
  return Number(Math.pow(10, db / 20).toFixed(4));
}

/**
 * Plan the ambience for a whole video.
 *
 * `sceneWindows` gives each scene its absolute start and end on the finished timeline — the same
 * offsets the video clips were laid out with. They are supplied rather than recomputed here, so
 * this cannot disagree with the picture about where a scene is.
 */
export function planCinematicAudio(params: {
  scenes: readonly Scene[];
  sceneWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  videoTitle?: string;
  /**
   * Only the FIRST ambience layer per scene reaches the timeline by default. The planner may
   * return two, and two beds under one narration is a muddier mix than one — an editor can add the
   * second by hand, which is a different decision from the renderer stacking them unasked.
   */
  layersPerScene?: number;
}): CinematicAudioPlan {
  const ambient: PlannedAmbient[] = [];
  const unavailable: string[] = [];
  const layers = Math.max(1, params.layersPerScene ?? 1);

  params.scenes.forEach((scene, i) => {
    const window = params.sceneWindows[i];
    if (!window || window.endSec <= window.startSec) return;

    const plan = planSceneAudio(
      { index: scene.index, text: scene.text, visualCue: scene.visualCue, pexelsQuery: scene.pexelsQuery } as never,
      params.videoTitle ?? ""
    );

    for (const category of plan.ambience.slice(0, layers)) {
      /**
       * The variant is chosen by SCENE INDEX, not at random.
       *
       * The catalogue holds two or three recordings per category so a long video does not use the
       * same one throughout. Choosing randomly would make the same timeline render a different mix
       * every time, which breaks determinism; choosing by scene index varies the sound AND keeps
       * the render reproducible.
       */
      const found = resolveCatalogSound(category, scene.index);
      if (!found.ok) {
        unavailable.push(`ambient scene ${scene.index} "${category}": ${found.reason}`);
        continue;
      }
      ambient.push({
        sceneIndex: scene.index,
        category,
        identity: found.identity,
        label: found.label,
        startSec: Number(window.startSec.toFixed(3)),
        endSec: Number(window.endSec.toFixed(3)),
      });
    }
  });

  return {
    ambient,
    unavailable,
    music: {
      available: false,
      /**
       * Stated as a fact about the repository rather than as an error. There is no music library
       * to connect; the interface for one exists and is unimplemented.
       */
      reason:
        "musicSourceUnavailable — this build has no music catalogue. The audio catalogue is " +
        "Freesound field recordings (ambience and effects); the only music source is a " +
        "synthesised bed that does not honour a requested mood, so no music is laid down.",
    },
  };
}

/** The planned ambience as timeline clips, ready for the AMBIENT track. */
export function ambientClips(plan: CinematicAudioPlan, ambienceGainDb = -26): TimelineAudioClip[] {
  return plan.ambient.map((a) => ({
    id: `amb_s${a.sceneIndex}_${a.identity.providerAssetId}`,
    source: a.identity,
    start: a.startSec,
    end: a.endSec,
    gain: gainFromDb(ambienceGainDb),
    /**
     * §2 — ambience ducks under the voice, and more gently than music does. `duckUnderVoice` is
     * the flag `buildAudioGraph` already reads, and it applies `DUCK_AMBIENT` rather than
     * `DUCK_MUSIC` because the track is on the AMBIENT track. No second ducking decision.
     */
    duckUnderVoice: true,
    fadeInSec: 0.6,
    fadeOutSec: 0.8,
    role: a.category,
  }));
}

/** One line for the render log. Categories and counts only — no URLs, no keys. */
export function formatCinematicAudio(plan: CinematicAudioPlan): string {
  const cats = plan.ambient.map((a) => a.category).join(",");
  return (
    `[Audio] ambient=${plan.ambient.length}${cats ? ` categories=${cats}` : ""} ` +
    `unavailable=${plan.unavailable.length} music=unavailable`
  );
}
