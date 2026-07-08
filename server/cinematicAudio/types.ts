export type EmotionTag = "neutral" | "sad" | "tense" | "dramatic" | "hopeful";

export type SoundCategoryId =
  | "traffic" | "engine" | "tires"
  | "train" | "train_pass"
  | "birds" | "wind" | "leaves" | "forest"
  | "waves" | "ocean" | "seagulls"
  | "rain" | "thunder" | "storm"
  | "city" | "crowd" | "sirens"
  | "factory" | "metal_clang"
  | "jet_engine" | "helicopter_rotor"
  | "ship_water" | "ship_horn"
  | "fire" | "crackling" | "explosion"
  | "camera_shutter" | "paper_rustle" | "paper_turn"
  | "typewriter" | "keyboard"
  | "electronic_hum" | "drone_wind" | "space_ambient"
  | "church_bells" | "clock_ticking"
  | "gunshot" | "war_distant" | "march"
  | "applause" | "crowd_cheer"
  | "snow_wind" | "blizzard";

export interface SoundVariant {
  id: string;
  freesoundId: number;
  label: string;
}

export interface SoundLayer {
  localPath: string;
  volumeDb: number;
  loop: boolean;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface TimedSoundLayer extends SoundLayer {
  startSec: number;
  durationSec: number;
}

export interface SceneSoundPlan {
  sceneIndex: number;
  emotion: EmotionTag;
  ambience: SoundCategoryId[];
  objectSounds: Array<{ category: SoundCategoryId; startSec: number; durationSec: number }>;
  ambienceVolumeDb: number;
  objectVolumeDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface VideoSoundPlan {
  scenes: SceneSoundPlan[];
  totalDurationSec: number;
}
