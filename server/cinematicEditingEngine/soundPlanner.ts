/** Cinematic Editing Engine — Sound Effects Planner (Phase 4).
 *
 *  Decides which sound effect(s), if any, apply to a beat — which sound, when, volume, fade.
 *  Never synthesizes or mixes audio.
 *
 *  Extends cinematicEffectsEngine.ts's CinematicAudioCue concept (that module already places
 *  SFX cues into scenes — `{ type: "whoosh" | "impact" | "shutter"; timeSec; volume }`, mixed
 *  by buildCinematicSfxAudioFilter, live in production) from 3 hardcoded types to the full
 *  17-type vocabulary, and — unlike that module's mechanical year/clip-count triggers — reasons
 *  each cue from the beat's actual content. `camera_click` here is the same event
 *  cinematicEffectsEngine.ts calls `shutter`; kept as its own name in this vocabulary to match
 *  the Phase 4 spec's naming, one-to-one with that existing cue at the renderer boundary.
 */
import type { PacingProfile, SoundEffectType, SoundInstruction } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";

type SoundRule = {
  soundType: SoundEffectType;
  signals: string[];
  /** "cue" = short punctuation sound at a specific moment; "ambient" = sustained background
   *  layer for the whole beat, quieter and with longer fades. */
  category: "cue" | "ambient";
  volume: number;
};

const RULES: SoundRule[] = [
  { soundType: "camera_click", signals: ["photograph", "photo of", "press photographers", "camera flash", "snapshot"], category: "cue", volume: 0.55 },
  { soundType: "applause", signals: ["applause", "clapping", "cheered", "cheering", "applauded"], category: "cue", volume: 0.6 },
  { soundType: "crowd", signals: ["crowd", "spectators", "gathering of people", "packed audience"], category: "ambient", volume: 0.35 },
  { soundType: "cash_register", signals: ["purchase", "sale", "sold out", "revenue", "bought", "price tag"], category: "cue", volume: 0.5 },
  { soundType: "notification", signals: ["notification", "phone buzzes", "message alert", "ping"], category: "cue", volume: 0.5 },
  { soundType: "wind", signals: ["wind", "breeze", "gust"], category: "ambient", volume: 0.3 },
  { soundType: "rain", signals: ["rain", "rainstorm", "downpour"], category: "ambient", volume: 0.3 },
  { soundType: "fire", signals: ["fire", "flames", "burning building"], category: "ambient", volume: 0.35 },
  { soundType: "explosion", signals: ["explosion", "exploded", "blast", "bomb"], category: "cue", volume: 0.7 },
  { soundType: "page_turn", signals: ["page", "book", "reading a document", "flipping through"], category: "cue", volume: 0.4 },
  { soundType: "keyboard", signals: ["coding", "programming", "writing software", "at the keyboard"], category: "ambient", volume: 0.3 },
  { soundType: "typing", signals: ["typing", "types out", "typed a message"], category: "ambient", volume: 0.3 },
  { soundType: "ui_click", signals: ["clicks the button", "taps the screen", "opens the app", "user interface"], category: "cue", volume: 0.45 },
  { soundType: "hit", signals: ["struck", "punch", "slammed"], category: "cue", volume: 0.6 },
  { soundType: "impact", signals: ["collision", "crashed into", "impact of"], category: "cue", volume: 0.65 },
];

const HEARTBEAT_SIGNALS = ["tension", "suspense", "danger", "anxious", "terrifying", "on edge"];
const WHOOSH_TRANSITIONS = ["whip", "slide", "push", "motion_blur"];

function matchSignal(text: string, signals: string[]): string | null {
  const lower = text.toLowerCase();
  return signals.find((s) => lower.includes(s)) ?? null;
}

function cue(
  soundType: SoundEffectType,
  timeSec: number,
  volume: number,
  fadeInSec: number,
  fadeOutSec: number,
  reason: string
): SoundInstruction {
  return { soundType, timeSec, volume, fadeInSec, fadeOutSec, reason };
}

/**
 * Builds every sound-effect instruction that applies to this beat. `transitionType` (optional)
 * lets a whoosh get planned for beats entering on a fast transition (whip/slide/push/motion
 * blur) — a sound cue matching a visual movement the TransitionPlanner already decided on,
 * not a second independent guess.
 */
export function planSoundEffects(
  intent: VisualIntent,
  pacing: PacingProfile,
  beatVoiceStartSec: number,
  beatVoiceDurationSec: number,
  transitionType?: string
): SoundInstruction[] {
  const out: SoundInstruction[] = [];
  const text = [intent.spokenText, intent.visualAction, intent.visualDescription].join(" ");

  if (transitionType && WHOOSH_TRANSITIONS.includes(transitionType)) {
    out.push(cue("whoosh", beatVoiceStartSec, 0.4, 0.05, 0.15, `Beat opens on a ${transitionType} transition — a whoosh matches the visual motion.`));
  }

  for (const rule of RULES) {
    const hit = matchSignal(text, rule.signals);
    if (!hit) continue;
    if (rule.category === "cue") {
      out.push(cue(rule.soundType, beatVoiceStartSec, rule.volume, 0.05, 0.2, `Beat's content matches "${hit}" — a ${rule.soundType.replace(/_/g, " ")} cue punctuates the moment.`));
    } else {
      out.push(
        cue(
          rule.soundType,
          beatVoiceStartSec,
          rule.volume,
          0.6,
          0.6,
          `Beat's content matches "${hit}" — a low ${rule.soundType.replace(/_/g, " ")} ambience plays under the whole beat.`
        )
      );
    }
  }

  if (pacing.tone === "dramatic") {
    const heartbeatSignal = matchSignal(text, HEARTBEAT_SIGNALS);
    if (heartbeatSignal) {
      out.push(
        cue(
          "heartbeat",
          beatVoiceStartSec,
          0.3,
          0.4,
          0.4,
          `Dramatic pacing and beat content matches "${heartbeatSignal}" — a subtle heartbeat underscores the tension.`
        )
      );
    }
  }

  return out;
}
