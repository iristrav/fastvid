import type { SceneSoundPlan, SoundCategoryId, EmotionTag, VideoSoundPlan } from "./types";
import { VISUAL_KEYWORD_MAP, EMOTION_KEYWORD_MAP } from "./catalog";

interface SceneMetadata {
  index: number;
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
  duration: number;
  beats?: Array<{
    text: string;
    voiceStartSec?: number;
    voiceEndSec?: number;
    holdSec: number;
  }>;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function matchesKeywords(haystack: string, keywords: string[]): boolean {
  return keywords.some(kw => haystack.includes(kw.toLowerCase()));
}

function detectEmotion(text: string): EmotionTag {
  const hay = normalizeText(text);
  for (const { keywords, emotion } of EMOTION_KEYWORD_MAP) {
    if (matchesKeywords(hay, keywords)) return emotion;
  }
  return "neutral";
}

function detectCategories(
  text: string,
  isObjectContext = false
): Array<{ category: SoundCategoryId; isObject: boolean }> {
  const hay = normalizeText(text);
  const found: Array<{ category: SoundCategoryId; isObject: boolean }> = [];
  const seen = new Set<SoundCategoryId>();

  for (const entry of VISUAL_KEYWORD_MAP) {
    if (matchesKeywords(hay, entry.keywords)) {
      for (const cat of entry.categories) {
        if (!seen.has(cat)) {
          seen.add(cat);
          found.push({ category: cat, isObject: entry.isObject ?? false });
        }
      }
    }
  }
  return found;
}

function ambientVolumeDb(emotion: EmotionTag): number {
  switch (emotion) {
    case "dramatic": return -28;
    case "tense":    return -30;
    case "sad":      return -32;
    case "hopeful":  return -30;
    default:         return -34;
  }
}

function objectVolumeDb(cat: SoundCategoryId): number {
  // Object sounds are slightly louder than ambient but never dominant
  const louder: SoundCategoryId[] = ["explosion", "train_pass", "camera_shutter", "gunshot", "thunder"];
  return louder.includes(cat) ? -20 : -26;
}

export function planSceneAudio(scene: SceneMetadata, videoTitle = ""): SceneSoundPlan {
  const fullText = [videoTitle, scene.text, scene.visualCue ?? "", scene.pexelsQuery ?? ""]
    .filter(Boolean)
    .join(" ");

  const emotion = detectEmotion(fullText);
  const allCategories = detectCategories(fullText);

  const ambience: SoundCategoryId[] = allCategories
    .filter(c => !c.isObject)
    .map(c => c.category)
    .slice(0, 2); // max 2 ambient layers

  const objectSounds: SceneSoundPlan["objectSounds"] = [];

  // Map object sounds to beat timestamps when word-timed beats are available
  if (scene.beats?.length) {
    for (const beat of scene.beats) {
      const beatText = [beat.text, scene.visualCue ?? ""].join(" ");
      const beatCats = detectCategories(beatText, true);
      for (const { category, isObject } of beatCats) {
        if (!isObject) continue;
        const startSec = beat.voiceStartSec ?? 0;
        const durationSec = beat.voiceEndSec != null
          ? beat.voiceEndSec - startSec
          : beat.holdSec;
        // Avoid duplicate object sounds within same scene
        const alreadyScheduled = objectSounds.some(o => o.category === category && Math.abs(o.startSec - startSec) < 2);
        if (!alreadyScheduled) {
          objectSounds.push({ category, startSec, durationSec });
        }
      }
    }
  }

  // If no ambient detected, fall back to generic neutral ambience based on emotion
  if (ambience.length === 0) {
    if (emotion === "dramatic" || emotion === "tense") {
      ambience.push("wind");
    } else {
      ambience.push("city");
    }
  }

  return {
    sceneIndex: scene.index,
    emotion,
    ambience,
    objectSounds,
    ambienceVolumeDb: ambientVolumeDb(emotion),
    objectVolumeDb: objectSounds.length > 0 ? objectVolumeDb(objectSounds[0].category) : -26,
    fadeInMs: 600,
    fadeOutMs: 800,
  };
}

export function planVideoAudio(
  scenes: SceneMetadata[],
  videoTitle = ""
): VideoSoundPlan {
  const scenePlans = scenes.map(s => planSceneAudio(s, videoTitle));
  const totalDurationSec = scenes.reduce((sum, s) => sum + s.duration, 0);
  return { scenes: scenePlans, totalDurationSec };
}
