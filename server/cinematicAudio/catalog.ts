import type { SoundCategoryId, SoundVariant } from "./types";

/**
 * Curated Freesound IDs per category.
 * Each category has 2–3 variants for random selection.
 * All are CC0/CC-BY licensed field recordings.
 */
export const SOUND_CATALOG: Record<SoundCategoryId, SoundVariant[]> = {
  traffic:         [{ id: "traffic_01", freesoundId: 401178, label: "City traffic loop" },
                    { id: "traffic_02", freesoundId: 264914, label: "Highway traffic" }],
  engine:          [{ id: "engine_01", freesoundId: 366073, label: "Car engine idle" }],
  tires:           [{ id: "tires_01",  freesoundId: 219244, label: "Tires on road" }],
  train:           [{ id: "train_01",  freesoundId: 443275, label: "Train interior" },
                    { id: "train_02",  freesoundId: 316920, label: "Train ambient" }],
  train_pass:      [{ id: "trainpass_01", freesoundId: 462808, label: "Train passing" }],
  birds:           [{ id: "birds_01",  freesoundId: 270402, label: "Forest birds morning" },
                    { id: "birds_02",  freesoundId: 456966, label: "Birds chirping" }],
  wind:            [{ id: "wind_01",   freesoundId: 366073, label: "Wind in trees" },
                    { id: "wind_02",   freesoundId: 459931, label: "Gentle wind" }],
  leaves:          [{ id: "leaves_01", freesoundId: 205230, label: "Leaves rustling" }],
  forest:          [{ id: "forest_01", freesoundId: 386886, label: "Forest ambience" },
                    { id: "forest_02", freesoundId: 270402, label: "Forest morning" }],
  waves:           [{ id: "waves_01",  freesoundId: 131404, label: "Ocean waves" },
                    { id: "waves_02",  freesoundId: 413578, label: "Waves on shore" }],
  ocean:           [{ id: "ocean_01",  freesoundId: 414876, label: "Ocean deep ambience" }],
  seagulls:        [{ id: "seagulls_01", freesoundId: 243642, label: "Seagulls coastal" }],
  rain:            [{ id: "rain_01",   freesoundId: 243627, label: "Rain on window" },
                    { id: "rain_02",   freesoundId: 458184, label: "Rain heavy" }],
  thunder:         [{ id: "thunder_01", freesoundId: 398908, label: "Thunder distant" }],
  storm:           [{ id: "storm_01",  freesoundId: 398907, label: "Storm ambience" }],
  city:            [{ id: "city_01",   freesoundId: 476178, label: "City daytime" },
                    { id: "city_02",   freesoundId: 391563, label: "City street" }],
  crowd:           [{ id: "crowd_01",  freesoundId: 512206, label: "Crowd murmur" },
                    { id: "crowd_02",  freesoundId: 143014, label: "Indoor crowd" }],
  sirens:          [{ id: "sirens_01", freesoundId: 192429, label: "Distant sirens" }],
  factory:         [{ id: "factory_01", freesoundId: 233127, label: "Factory machines" }],
  metal_clang:     [{ id: "metal_01",  freesoundId: 131142, label: "Metal impact" }],
  jet_engine:      [{ id: "jet_01",    freesoundId: 471645, label: "Jet engine flyover" }],
  helicopter_rotor:[{ id: "heli_01",   freesoundId: 362807, label: "Helicopter blades" }],
  ship_water:      [{ id: "ship_01",   freesoundId: 264882, label: "Ship water hull" }],
  ship_horn:       [{ id: "shiphorn_01", freesoundId: 219244, label: "Ship horn" }],
  fire:            [{ id: "fire_01",   freesoundId: 105648, label: "Fire burning" },
                    { id: "fire_02",   freesoundId: 397177, label: "Campfire crackling" }],
  crackling:       [{ id: "crackle_01", freesoundId: 397177, label: "Fire crackling" }],
  explosion:       [{ id: "expl_01",   freesoundId: 398913, label: "Distant explosion" }],
  camera_shutter:  [{ id: "shutter_01", freesoundId: 240432, label: "Camera click" },
                    { id: "shutter_02", freesoundId: 108615, label: "DSLR shutter" }],
  paper_rustle:    [{ id: "paper_01",  freesoundId: 166686, label: "Paper rustle" },
                    { id: "paper_02",  freesoundId: 411090, label: "Paper handling" }],
  paper_turn:      [{ id: "paper_turn_01", freesoundId: 240388, label: "Page turning" }],
  typewriter:      [{ id: "type_01",   freesoundId: 434572, label: "Typewriter keys" }],
  keyboard:        [{ id: "key_01",    freesoundId: 392763, label: "Keyboard typing" }],
  electronic_hum:  [{ id: "elec_01",  freesoundId: 344489, label: "Electronic hum" }],
  drone_wind:      [{ id: "drone_01", freesoundId: 459931, label: "Wind drone footage" }],
  space_ambient:   [{ id: "space_01", freesoundId: 391563, label: "Space ambience" }],
  church_bells:    [{ id: "bells_01", freesoundId: 321103, label: "Church bells distant" }],
  clock_ticking:   [{ id: "clock_01", freesoundId: 401553, label: "Clock ticking" }],
  gunshot:         [{ id: "gun_01",   freesoundId: 377357, label: "Gunshot distant" }],
  war_distant:     [{ id: "war_01",   freesoundId: 277403, label: "Distant battle" }],
  march:           [{ id: "march_01", freesoundId: 447925, label: "Military march drums" }],
  applause:        [{ id: "appl_01",  freesoundId: 237375, label: "Crowd applause" }],
  crowd_cheer:     [{ id: "cheer_01", freesoundId: 467579, label: "Crowd cheering" }],
  snow_wind:       [{ id: "snow_01",  freesoundId: 397905, label: "Wind in snow" }],
  blizzard:        [{ id: "blizzard_01", freesoundId: 398910, label: "Blizzard howl" }],
};

/**
 * Visual keyword → sound categories mapping.
 * Keywords are matched against beat text, visual cues, scene descriptions, and pexels queries.
 * Order matters: more specific keywords first.
 */
export const VISUAL_KEYWORD_MAP: Array<{ keywords: string[]; categories: SoundCategoryId[]; isObject?: boolean }> = [
  // Transport
  { keywords: ["train", "railroad", "trein", "spoorweg", "locomotive"],   categories: ["train"], isObject: false },
  { keywords: ["train pass", "trein rijdt"],                               categories: ["train_pass"], isObject: true },
  { keywords: ["airplane", "aircraft", "vliegtuig", "plane", "aviation"], categories: ["jet_engine"] },
  { keywords: ["helicopter", "helikopter"],                                categories: ["helicopter_rotor"] },
  { keywords: ["car", "auto", "vehicle", "highway", "motorway", "snelweg", "road", "traffic", "verkeer"], categories: ["traffic"] },
  { keywords: ["ship", "vessel", "schip", "tanker", "cargo ship"],        categories: ["ship_water"] },
  { keywords: ["harbor", "haven", "port", "dock"],                        categories: ["ship_water", "seagulls"] },

  // Nature
  { keywords: ["forest", "bos", "jungle", "woodland", "trees"],           categories: ["birds", "wind", "leaves"] },
  { keywords: ["bird", "vogel", "sparrow", "eagle", "owl"],               categories: ["birds"], isObject: false },
  { keywords: ["ocean", "sea", "zee", "atlantic", "pacific", "north sea"], categories: ["waves", "seagulls"] },
  { keywords: ["beach", "strand", "coast", "kust", "shore"],              categories: ["waves", "seagulls", "wind"] },
  { keywords: ["wave", "golf", "surf"],                                    categories: ["waves"] },
  { keywords: ["rain", "regen", "downpour"],                               categories: ["rain"] },
  { keywords: ["storm", "thunder", "lightning", "onweer", "bliksem"],     categories: ["thunder", "rain"] },
  { keywords: ["snow", "sneeuw", "blizzard"],                              categories: ["snow_wind"] },
  { keywords: ["mountain", "berg", "hill", "heuvel", "cliff"],            categories: ["wind"] },
  { keywords: ["wind", "breeze"],                                          categories: ["wind"] },
  { keywords: ["river", "rivier", "stream", "lake", "meer"],              categories: ["waves", "birds"] },

  // Urban
  { keywords: ["city", "stad", "urban", "downtown", "metropolis"],        categories: ["city", "crowd"] },
  { keywords: ["street", "straat", "boulevard", "avenue"],                categories: ["traffic", "crowd"] },
  { keywords: ["crowd", "menigte", "mensen", "audience", "protest"],      categories: ["crowd"] },
  { keywords: ["market", "markt", "bazaar", "shopping"],                  categories: ["crowd"] },
  { keywords: ["siren", "ambulance", "police", "politie", "firefighter"], categories: ["sirens"] },

  // War / conflict
  { keywords: ["war", "battle", "combat", "oorlog", "slag", "strijd"],    categories: ["war_distant"] },
  { keywords: ["explosion", "explosie", "bomb", "bom", "blast"],          categories: ["explosion"], isObject: true },
  { keywords: ["soldier", "soldaat", "military", "army", "leger"],        categories: ["march"] },
  { keywords: ["gun", "shoot", "schiet", "rifle", "pistol"],              categories: ["gunshot"], isObject: true },

  // Industry
  { keywords: ["factory", "fabriek", "industry", "plant", "machine"],     categories: ["factory"] },
  { keywords: ["construction", "bouw", "crane", "kraan"],                 categories: ["factory", "metal_clang"] },

  // Documents / objects
  { keywords: ["photograph", "photo", "foto", "picture", "image"],        categories: ["camera_shutter"], isObject: true },
  { keywords: ["letter", "brief", "document", "paper", "papier"],         categories: ["paper_rustle"], isObject: true },
  { keywords: ["map", "kaart", "atlas", "chart"],                         categories: ["paper_turn"], isObject: true },
  { keywords: ["typewriter", "typemachine"],                               categories: ["typewriter"], isObject: true },
  { keywords: ["computer", "keyboard", "toetsenbord", "laptop"],          categories: ["keyboard"], isObject: true },
  { keywords: ["clock", "klok", "watch", "tick"],                         categories: ["clock_ticking"] },

  // Church / ceremony
  { keywords: ["church", "kerk", "cathedral", "kathedraal", "chapel"],    categories: ["church_bells"] },
  { keywords: ["applause", "applaus", "cheer", "ceremony"],               categories: ["applause"] },

  // Tech / space
  { keywords: ["satellite", "satelliet", "drone", "aerial", "dronefootage"], categories: ["drone_wind"] },
  { keywords: ["space", "ruimte", "cosmos", "universe", "nasa", "rocket"], categories: ["space_ambient"] },

  // Fire
  { keywords: ["fire", "brand", "flame", "vlam", "burning", "blaze"],    categories: ["fire"] },
];

/**
 * Emotion detection keywords.
 */
export const EMOTION_KEYWORD_MAP: Array<{ keywords: string[]; emotion: "neutral" | "sad" | "tense" | "dramatic" | "hopeful" }> = [
  { keywords: ["war", "battle", "explosion", "attack", "oorlog", "slag", "explosie", "aanval", "death", "dood", "killed", "genocide", "massacre"], emotion: "dramatic" },
  { keywords: ["tense", "crisis", "threat", "danger", "gevaar", "nuclear", "threat", "conflict", "tension", "standoff"], emotion: "tense" },
  { keywords: ["sad", "tragedy", "loss", "grief", "mourning", "rouw", "verdriet", "died", "mourned", "suffered"], emotion: "sad" },
  { keywords: ["hope", "victory", "triumph", "freedom", "vrijheid", "peace", "vrede", "survived", "won", "liberated", "overwinning"], emotion: "hopeful" },
];
