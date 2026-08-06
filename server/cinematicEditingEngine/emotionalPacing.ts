/** Cinematic Editing Engine — Emotional Pacing Planner (Phase 4).
 *
 *  Derives one EmotionalTone per beat and turns it into concrete pacing numbers (cut speed,
 *  movement intensity) that every other planner in this directory reads, so "dramatic scenes
 *  get slower/longer/subtler, exciting scenes get faster/busier, educational scenes stay
 *  clean/readable/focused" is decided once, consistently, rather than re-derived per planner.
 *
 *  Prefers VisualIntent.emotion (Phase 3's already-extracted, free-text emotional signal) —
 *  reusing it here is the entire reason that field exists on VisualIntent per its own doc
 *  comment ("consumed by ranking/selection AND downstream editing decisions"). Falls back to a
 *  lightweight keyword scan over the beat's own text only when VisualIntent.emotion is empty —
 *  never a new LLM call; this stays a pure, fast, fully-deterministic function so it's testable
 *  without any network/LLM dependency, matching "EDL should be testable without rendering a
 *  video."
 *
 *  When a DirectorGuidance (Phase 5's AI Director) is supplied and carries a pacingTone, that
 *  scene-wide judgment takes precedence over this beat's own local signal — the Director sees
 *  the whole scene's narration, this function only sees one beat's. Omitting directorGuidance
 *  entirely (every pre-Phase-5 call site) leaves this function's behavior byte-identical to
 *  before.
 */
import type { DirectorGuidance, EmotionalTone, PacingProfile } from "./types";
import type { VisualIntent } from "../visualMatchingV2/types";

const DRAMATIC_KEYWORDS = [
  "grim", "somber", "solemn", "tragic", "tragedy", "sad", "sorrow", "grief", "loss", "mourning",
  "fear", "afraid", "terror", "dread", "dark", "bleak", "devastating", "crisis", "war", "death",
  "suffering", "despair", "melancholy", "haunting", "tense", "ominous",
];

const EXCITING_KEYWORDS = [
  "excited", "excitement", "thrilling", "thrill", "triumphant", "triumph", "victorious",
  "victory", "celebratory", "celebration", "joyful", "joy", "energetic", "energy", "urgent",
  "urgency", "action", "fast-paced", "explosive", "breakthrough", "record-breaking", "epic",
  "electrifying", "dazzling", "spectacular",
];

const EDUCATIONAL_KEYWORDS = [
  "explains", "explained", "explanation", "informative", "factual", "data", "statistic",
  "research", "study", "analysis", "breakdown", "overview", "how it works", "in other words",
  "for example", "specifically", "according to",
];

function matchesAny(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase();
  return keywords.find((kw) => lower.includes(kw)) ?? null;
}

function classifyText(text: string): { tone: EmotionalTone; matchedKeyword: string } | null {
  const dramatic = matchesAny(text, DRAMATIC_KEYWORDS);
  if (dramatic) return { tone: "dramatic", matchedKeyword: dramatic };
  const exciting = matchesAny(text, EXCITING_KEYWORDS);
  if (exciting) return { tone: "exciting", matchedKeyword: exciting };
  const educational = matchesAny(text, EDUCATIONAL_KEYWORDS);
  if (educational) return { tone: "educational", matchedKeyword: educational };
  return null;
}

/** Tone -> pacing numbers. Deliberately centralized here (not per-planner) so "what dramatic
 *  pacing means" has exactly one definition in the codebase. */
const PACING_BY_TONE: Record<EmotionalTone, { cutSpeedMultiplier: number; movementIntensity: number }> = {
  dramatic: { cutSpeedMultiplier: 0.7, movementIntensity: 0.3 },
  exciting: { cutSpeedMultiplier: 1.4, movementIntensity: 0.8 },
  educational: { cutSpeedMultiplier: 1.0, movementIntensity: 0.35 },
  neutral: { cutSpeedMultiplier: 1.0, movementIntensity: 0.5 },
};

/** Derives this beat's emotional tone and pacing. Checks, in order: AI Director's scene-wide
 *  pacingTone (when supplied) -> VisualIntent.emotion (Phase 3's extracted signal) -> keyword
 *  scan of intent.spokenText -> neutral default. */
export function deriveEmotionalTone(intent: VisualIntent, directorGuidance?: DirectorGuidance): PacingProfile {
  if (directorGuidance?.pacingTone) {
    const tone = directorGuidance.pacingTone;
    return {
      tone,
      ...PACING_BY_TONE[tone],
      reason: `AI Director set this scene's emotional tone to "${tone}" — takes precedence over this beat's own local signal.`,
    };
  }

  const emotionField = (intent.emotion ?? "").trim();
  if (emotionField) {
    const classified = classifyText(emotionField);
    if (classified) {
      const { tone } = classified;
      return {
        tone,
        ...PACING_BY_TONE[tone],
        reason: `Visual Intent's emotion field ("${emotionField}") matches "${classified.matchedKeyword}" -> ${tone} pacing.`,
      };
    }
  }

  const spoken = (intent.spokenText ?? "").trim();
  if (spoken) {
    const classified = classifyText(spoken);
    if (classified) {
      const { tone } = classified;
      return {
        tone,
        ...PACING_BY_TONE[tone],
        reason: `No usable Visual Intent emotion field; beat text matches "${classified.matchedKeyword}" -> ${tone} pacing.`,
      };
    }
  }

  return {
    tone: "neutral",
    ...PACING_BY_TONE.neutral,
    reason: "No strong emotional signal in Visual Intent's emotion field or beat text; defaulting to neutral pacing.",
  };
}
