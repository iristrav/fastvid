/** AI Director — Narrative Analysis (Phase 5).
 *
 *  Answers the VISUAL STORYTELLING questions ("why is this scene shown, what does the viewer
 *  need to understand") and applies DOCUMENTARY THINKING (cause/effect, conflict/contrast,
 *  scale/importance) to classify a scene's narrative role, subject focus, target emotion, and
 *  the kind of visual coverage it calls for. Pure text/entity heuristics over the scene's
 *  already-extracted VisualIntent[] — no LLM call, no media search, consistent with the
 *  Director's "only makes decisions" scope.
 */
import type { DirectorContext, DirectorEmotion, NarrativeFunction, VisualStrategy } from "./types";
import type { EmotionalTone } from "../cinematicEditingEngine/types";

function clean(s: string | undefined | null): string {
  return (s ?? "").trim();
}

function combinedText(context: DirectorContext): string {
  return context.beatIntents.map((i) => i.spokenText).join(" ");
}

function matchSignal(text: string, signals: string[]): string | null {
  const lower = text.toLowerCase();
  return signals.find((s) => lower.includes(s)) ?? null;
}

// ─── Subject focus ──────────────────────────────────────────────────────────────

/** Aggregates named-entity frequency across every beat in the scene and picks the two most
 *  prominent — "which subject should receive emphasis" is a scene-wide judgment, not a
 *  per-beat one (a subject mentioned across 4 of 5 beats is clearly primary even if a single
 *  beat's own VisualIntent.visualSubject briefly names someone else). */
export function pickSubjectFocus(context: DirectorContext): { primary: string; secondary: string | null } {
  const counts = new Map<string, { count: number; display: string }>();
  const bump = (name: string) => {
    const trimmed = clean(name);
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, display: trimmed });
  };

  for (const intent of context.beatIntents) {
    for (const p of intent.people) bump(p);
    for (const c of intent.companies) bump(c);
    for (const b of intent.brands) bump(b);
  }

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  if (ranked.length > 0) {
    return { primary: ranked[0]!.display, secondary: ranked[1]?.display ?? null };
  }

  const fallback = context.beatIntents.find((i) => clean(i.visualSubject))?.visualSubject;
  return { primary: clean(fallback) || "the topic", secondary: null };
}

// ─── Narrative function / purpose ────────────────────────────────────────────────

const SCALE_SIGNALS = ["biggest", "first ever", "record", "unprecedented", "historic", "largest", "never before", "most significant"];
const CONTRAST_SIGNALS = ["however", "but ", "unlike", "compared to", "versus", "despite", "instead of", "on the other hand"];
const REVEAL_SIGNALS = ["revealed", "turns out", "surprisingly", "unexpectedly", "it turned out", "behind the scenes"];

/** Classifies this scene's role in the overall story and produces a human-readable purpose
 *  string. Structural position (opening/closing scene, chapter card) takes priority over
 *  content signals — a scene marked as a chapter break IS a transition regardless of what its
 *  narration happens to say. */
export function classifyNarrative(
  context: DirectorContext,
  primarySubject: string
): { narrativeFunction: NarrativeFunction; narrativePurpose: string } {
  const text = combinedText(context);

  if (context.scene.isChapterCard) {
    return {
      narrativeFunction: "transition",
      narrativePurpose: `Bridge into the next part of the story around ${primarySubject}.`,
    };
  }
  if (context.sceneIndex === 0) {
    return {
      narrativeFunction: "establish",
      narrativePurpose: `Establish who/what ${primarySubject} is and set the scene.`,
    };
  }
  if (context.sceneIndex === context.totalScenes - 1) {
    return {
      narrativeFunction: "resolve",
      narrativePurpose: `Resolve the story and leave the audience with a final thought about ${primarySubject}.`,
    };
  }

  if (matchSignal(text, SCALE_SIGNALS)) {
    return {
      narrativeFunction: "climax",
      narrativePurpose: `Emphasize the scale and significance of ${primarySubject}.`,
    };
  }
  if (matchSignal(text, CONTRAST_SIGNALS)) {
    return {
      narrativeFunction: "contrast",
      narrativePurpose: `Contrast ${primarySubject} against what came before.`,
    };
  }
  if (matchSignal(text, REVEAL_SIGNALS)) {
    return {
      narrativeFunction: "reveal",
      narrativePurpose: `Reveal new information about ${primarySubject}.`,
    };
  }

  return {
    narrativeFunction: "explain",
    narrativePurpose: `Explain ${primarySubject}'s role in the story so the viewer understands before moving on.`,
  };
}

// ─── Emotion ─────────────────────────────────────────────────────────────────────

const EMOTION_SIGNALS: Array<{ emotion: DirectorEmotion; signals: string[] }> = [
  { emotion: "triumph", signals: ["victory", "triumph", "success", "achieved", "overcame", "won the"] },
  { emotion: "tension", signals: ["tension", "danger", "threat", "conflict", "confrontation", "fight"] },
  { emotion: "urgency", signals: ["urgent", "immediately", "deadline", "critical", "race against", "must act"] },
  { emotion: "unease", signals: ["unease", "uncertain", "troubling", "ominous", "worrying sign"] },
  { emotion: "empathy", signals: ["struggle", "hardship", "grief", "loss of", "personal story", "heartbreak"] },
  { emotion: "awe", signals: ["astonishing", "majestic", "breathtaking", "monumental", "awe-inspiring"] },
  { emotion: "excitement", signals: ["exciting", "thrilling", "breakthrough", "incredible", "amazing"] },
  { emotion: "nostalgia", signals: ["remember", "used to", "back then", "the old days", "years ago", "reminisce"] },
  { emotion: "hope", signals: ["hope", "optimistic", "promise of", "brighter future", "potential to"] },
  { emotion: "concern", signals: ["concern", "worry", "controversy", "criticized", "backlash"] },
  { emotion: "curiosity", signals: ["wonder", "curious", "mystery", "unknown", "why did", "how did"] },
];

/** Scans the scene's combined narration AND every beat's already-extracted emotion field
 *  (Phase 3's VisualIntent.emotion) — reusing that signal rather than re-deriving it from
 *  scratch, same principle as Cinematic Editing Engine's emotionalPacing.ts, just aggregated
 *  across a whole scene instead of one beat and mapped onto the Director's richer vocabulary. */
export function classifySceneEmotion(context: DirectorContext): DirectorEmotion {
  const text = [combinedText(context), ...context.beatIntents.map((i) => i.emotion)].join(" ");
  for (const { emotion, signals } of EMOTION_SIGNALS) {
    if (matchSignal(text, signals)) return emotion;
  }
  return "neutral";
}

/** Maps the Director's richer per-scene emotion onto Cinematic Editing Engine's coarser
 *  4-bucket pacing tone — the integration point between the two modules (see
 *  cinematicEditingEngine/emotionalPacing.ts's optional directorGuidance parameter). */
const EMOTION_TO_PACING_TONE: Record<DirectorEmotion, EmotionalTone> = {
  tension: "dramatic",
  unease: "dramatic",
  empathy: "dramatic",
  concern: "dramatic",
  excitement: "exciting",
  triumph: "exciting",
  urgency: "exciting",
  awe: "exciting",
  curiosity: "educational",
  hope: "educational",
  nostalgia: "educational",
  neutral: "neutral",
};

export function directorEmotionToPacingTone(emotion: DirectorEmotion): EmotionalTone {
  return EMOTION_TO_PACING_TONE[emotion];
}

// ─── Visual strategy ────────────────────────────────────────────────────────────

const STAGE_ACTION_SIGNALS = ["speak", "announce", "keynote", "present", "on stage", "conference"];
const DETAIL_ACTION_SIGNALS = ["unveil", "hold", "reveal the", "show the", "display", "operate"];
const QUOTE_RE = /["“”](.+?)["“”]/;

/** Classifies the kind of footage/graphic this scene is fundamentally built around. Purely
 *  from VisualIntent/Scene signals — the Director never sees a CandidateAsset, so this is a
 *  content-driven prediction of what coverage the scene needs, not a judgment about what
 *  footage was actually found (that's the Visual Intelligence Engine's job, upstream). */
export function classifyVisualStrategy(context: DirectorContext): VisualStrategy {
  const { beatIntents, scene } = context;
  // Includes each beat's visualAction alongside spokenText — narration often doesn't say "on
  // stage" or "unveiled the product" literally even when the extracted visualAction does, and
  // that field is exactly what the strategy signals below (stage/detail actions) are matching
  // against.
  const text = [combinedText(context), ...beatIntents.map((i) => i.visualAction)].join(" ");

  const historicalCount = beatIntents.filter((i) => clean(i.historicalContext)).length;
  if (beatIntents.length > 0 && historicalCount / beatIntents.length >= 0.5) return "archive_footage";

  const hasPeople = beatIntents.some((i) => i.people.length > 0);
  const hasQuote = QUOTE_RE.test(text);
  if (hasPeople && hasQuote) return "interview";
  if (hasPeople && matchSignal(text, STAGE_ACTION_SIGNALS)) return "keynote_or_stage_footage";

  const hasEvents = beatIntents.some((i) => i.events.length > 0);
  if (hasEvents && historicalCount > 0) return "timeline";

  const distinctCountries = new Set(beatIntents.flatMap((i) => i.countries.map((c) => c.toLowerCase())));
  if (distinctCountries.size >= 1) return "map";

  if (scene.statCallout || /\b\d+(\.\d+)?\s*(%|percent|million|billion)\b/i.test(text)) return "chart";

  const hasObjects = beatIntents.some((i) => i.objects.length > 0);
  if (hasObjects && matchSignal(text, DETAIL_ACTION_SIGNALS)) return "close_up_product";

  const distinctEntities = new Set(
    beatIntents.flatMap((i) => [...i.people, ...i.companies, ...i.brands, ...i.objects, ...i.countries, ...i.events].map((s) => s.toLowerCase()))
  );
  if (distinctEntities.size > 5) return "montage";

  return "b_roll";
}

// ─── Supporting visuals ──────────────────────────────────────────────────────────

/** Short, human-readable secondary-coverage suggestions — the "supporting visuals" list in
 *  the Phase 5 output example ("Audience reactions.", "Factory B-roll.", "Close-up of
 *  product."). Deliberately capped at 3: a scene-level suggestion list, not an exhaustive
 *  shot list (that's shotOrderPlanner.ts's job). */
export function deriveSupportingVisuals(context: DirectorContext, primary: string, secondary: string | null): string[] {
  const { beatIntents } = context;
  const out: string[] = [];
  const text = combinedText(context);

  if (secondary) out.push(`${secondary} B-roll.`);

  if (beatIntents.some((i) => i.people.length > 0) && matchSignal(text, STAGE_ACTION_SIGNALS)) {
    out.push("Audience reactions.");
  }

  const firstObject = beatIntents.find((i) => i.objects.length > 0)?.objects[0];
  if (firstObject) out.push(`Close-up of ${firstObject}.`);

  const firstCompany = beatIntents.find((i) => i.companies.length > 0)?.companies[0];
  if (firstCompany && firstCompany.toLowerCase() !== primary.toLowerCase() && !out.some((s) => s.startsWith(firstCompany))) {
    out.push(`${firstCompany} facility B-roll.`);
  }

  return out.slice(0, 3);
}
