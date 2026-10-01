

export type CinematicAudioCue = {
  type: "whoosh" | "impact" | "shutter";
  timeSec: number;
  volume: number;
};

export type YearBadgeTiming = { startTime: number; endTime: number };

export type BeatYearInput = {
  text: string;
  holdSec: number;
  /** Scene-local TTS start (seconds) — montage cuts align here when set. */
  voiceStartSec?: number;
  voiceEndSec?: number;
  visualDescription?: string;
  searchQuery?: string;
};

export type BeatLabelInput = BeatYearInput & {
  powerWord?: string;
  highlightWords?: string[];
};

export type TtsMontagePlan = {
  durations: number[];
  cutStartsSec: number[];
  xfadeSec: number;
  ttsHardCut: boolean;
};

export type TimedYearLabel = {
  year: string;
  /** Short label in the yellow pill (keyword or context words). */
  caption: string;
  /** Combined string for logs. */
  displayText: string;
  startTime: number;
  endTime: number;
};

export const TYPEWRITER_CHAR_SEC = 0.042;
