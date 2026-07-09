/**
 * Editorial Intent Engine — v1
 *
 * Answers the question: not WHAT is in this clip, but WHY would an editor choose it?
 *
 * At ingest time: computeEditorialIntent() derives EditorialCapability, NarrativeFunction,
 * and visualPurpose from the existing ClipAnnotation — pure function, no LLM, no network.
 *
 * At render time: decomposeQueryBeat() splits a beat into components, then
 * scoreEditorialCapabilityMatch() calculates a capability bonus (+0 to +8) and
 * an editorial mismatch penalty (-6 to 0) for each candidate clip.
 *
 * Feature flag: EDITORIAL_INTENT_ENGINE_ENABLED (default: "true")
 */

import path from "path";
import type {
  ClipAnnotation,
  EditorialCapability,
  NarrativeFunction,
  EditorialIntent,
} from "../drizzle/annotationTypes";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function editorialIntentEnabled(): boolean {
  return process.env.EDITORIAL_INTENT_ENGINE_ENABLED !== "false";
}

// ─── Beat decomposition ───────────────────────────────────────────────────────

/**
 * The components extracted from a beat text.
 * Used to match clip capabilities during retrieval ranking.
 */
export type BeatDecomposition = {
  /** Required capabilities — clips that have these score higher. */
  requiredCapabilities: (keyof EditorialCapability)[];
  /** Penalized capabilities — clips with these high score lower. */
  penalizedCapabilities: (keyof EditorialCapability)[];
  /** Human-readable narrative purpose detected in beat (for logs). */
  narrativePurpose?: string;
};

/**
 * Decompose a beat text into retrieval components using regex pattern matching.
 * Pure function — no LLM, no network. O(1) per beat.
 */
export function decomposeQueryBeat(beatText: string): BeatDecomposition {
  const required: (keyof EditorialCapability)[] = [];
  const penalized: (keyof EditorialCapability)[] = [];
  const purposes: string[] = [];

  // ── Opening / establishing ────────────────────────────────────────────────
  if (/\b(opening|open shot|establish|wide shot|landscape|panorama|skyline|aerial|drone|overview|first look|introduct|we begin|starting|from above)\b/i.test(beatText)) {
    required.push("canOpenDocumentary", "canIntroduceLocation");
    penalized.push("canIncreaseEmotion"); // intense emotion wrong at cold open
    purposes.push("opening/establishing");
  }

  // ── Person introduction ───────────────────────────────────────────────────
  if (/\b(introduce|portrait|biography|we see|we meet|face of|close.?up of|their face|first appears|entering|arrives)\b/i.test(beatText)) {
    required.push("canIntroducePerson");
    purposes.push("person introduction");
  }

  // ── Location introduction ─────────────────────────────────────────────────
  if (/\b(the city|the town|the country|the region|we arrive|location shot|scenery|cityscape|establishing the place)\b/i.test(beatText)) {
    required.push("canIntroduceLocation");
    purposes.push("location establishing");
  }

  // ── Historical era / archive ──────────────────────────────────────────────
  if (/\b(in \d{4}|at the time|during the|historical|archive|footage from|back in|the year|the period|the era|return to)\b/i.test(beatText)) {
    required.push("canSupportHistoricalExplanation", "canIntroduceEra");
    purposes.push("historical context");
  }

  // ── Biography ─────────────────────────────────────────────────────────────
  if (/\b(biography|life of|story of|career|born in|grew up|early years|his life|her life|their story)\b/i.test(beatText)) {
    required.push("canSupportBiography", "canIntroducePerson");
    purposes.push("biography");
  }

  // ── Voice-over / explanation ──────────────────────────────────────────────
  if (/\b(voice.?over|narrator|while we explain|as we explain|explains|background info|context|history of|tells the story|describes|narrate)\b/i.test(beatText)) {
    required.push("canSupportVoiceOver");
    penalized.push("canBuildSuspense"); // tense clips distract from VO
    purposes.push("voice-over support");
  }

  // ── Scale / mass ──────────────────────────────────────────────────────────
  if (/\b(scale|army|troops|thousands|millions|fleet|invasion|mass|crowd|huge|enormous|vast|sweeping)\b/i.test(beatText)) {
    required.push("canShowScale");
    penalized.push("canSupportVoiceOver"); // scale clips often too dynamic for VO
    purposes.push("showing scale");
  }

  // ── Victory / liberation ──────────────────────────────────────────────────
  if (/\b(victory|liberation|celebration|triumph|win|success|freedom|bevrijding|overwinning|cheering)\b/i.test(beatText)) {
    required.push("canShowVictory");
    penalized.push("canShowDefeat");
    purposes.push("victory/celebration");
  }

  // ── Defeat / aftermath ────────────────────────────────────────────────────
  if (/\b(defeat|surrender|loss|aftermath|destruction|ruin|chaos|capitulation|evacuate|retreat|refugees)\b/i.test(beatText)) {
    required.push("canShowDefeat", "canShowDestruction");
    penalized.push("canShowVictory");
    purposes.push("defeat/aftermath");
  }

  // ── Destruction / conflict ────────────────────────────────────────────────
  if (/\b(bombing|explosion|fire|burning|ruins|damaged|destroyed|attack|battle|combat|assault|blitz)\b/i.test(beatText)) {
    required.push("canShowDestruction");
    penalized.push("canSupportVoiceOver"); // chaotic clips wrong for VO
    purposes.push("conflict/destruction");
  }

  // ── Emotional moment ──────────────────────────────────────────────────────
  if (/\b(emotion|grief|sorrow|joy|relief|tears|powerful|impact|moving|touching|human moment|raw emotion)\b/i.test(beatText)) {
    required.push("canIncreaseEmotion");
    penalized.push("canServeAsBroll"); // B-roll won't carry an emotional peak
    purposes.push("emotional impact");
  }

  // ── Suspense / tension ────────────────────────────────────────────────────
  if (/\b(suspense|tension|threat|danger|approach|build.?up|countdown|imminent|crisis|on the brink|impending)\b/i.test(beatText)) {
    required.push("canBuildSuspense");
    penalized.push("canOpenDocumentary", "canServeAsBroll"); // establishing/calm clips kill tension
    purposes.push("suspense/tension");
  }

  // ── B-roll / cutaway ──────────────────────────────────────────────────────
  if (/\b(b.?roll|cutaway|illustrat|meanwhile|cut to|sfeer|background footage|intercut|scenic)\b/i.test(beatText)) {
    required.push("canServeAsBroll");
    purposes.push("B-roll");
  }

  // ── Bridge / transition ───────────────────────────────────────────────────
  if (/\b(transition|meanwhile|we move|cut to|next|later that|shortly after|following|subsequently|overgang|bridge)\b/i.test(beatText)) {
    required.push("canBridgeScenes");
    purposes.push("transition");
  }

  // ── Map / geography ───────────────────────────────────────────────────────
  if (/\b(map|geography|territory|region|advance|front line|where this|geographical|strategic position)\b/i.test(beatText)) {
    required.push("canSupportMapSequence");
    purposes.push("map/geography");
  }

  // ── Reveal / discovery ────────────────────────────────────────────────────
  if (/\b(reveal|discovery|first time|never before seen|secret|document shows|evidence|classified|uncovered)\b/i.test(beatText)) {
    required.push("canRevealInformation");
    purposes.push("information reveal");
  }

  // ── Climax / turning point ────────────────────────────────────────────────
  if (/\b(climax|turning point|decisive|key moment|pivotal|historic moment|everything changed|the moment when)\b/i.test(beatText)) {
    required.push("canIncreaseEmotion");
    penalized.push("canServeAsBroll", "canOpenDocumentary"); // wrong function for climax
    purposes.push("climax/turning point");
  }

  // ── Ending / reflection ───────────────────────────────────────────────────
  if (/\b(ending|end of|conclusion|finally|legacy|epilogue|aftermath|reflection|we close|looking back)\b/i.test(beatText)) {
    required.push("canCloseDocumentary");
    penalized.push("canBuildSuspense", "canShowDestruction"); // tension/chaos wrong for ending
    purposes.push("ending/reflection");
  }

  // ── Technical explanation ──────────────────────────────────────────────────
  if (/\b(technical|how it works|mechanism|equipment|weapon|aircraft|tank|ship|device|technology|engineering)\b/i.test(beatText)) {
    required.push("canSupportTechnicalExplanation");
    purposes.push("technical explanation");
  }

  // Deduplicate preserving order
  const unique = <T>(arr: T[]): T[] => arr.filter((v, i, a) => a.indexOf(v) === i);

  return {
    requiredCapabilities: unique(required).slice(0, 6),
    penalizedCapabilities: unique(penalized).slice(0, 4),
    narrativePurpose: purposes.length > 0 ? purposes.slice(0, 3).join(", ") : undefined,
  };
}

// ─── Capability derivation ────────────────────────────────────────────────────

function clamp(v: number): number {
  return Math.min(100, Math.max(0, Math.round(v)));
}

/**
 * Derive all 21 editorial capabilities from existing ClipAnnotation metadata.
 * Pure function — no LLM, no I/O. Called once per clip at ingest time.
 */
function deriveCapabilities(annotation: ClipAnnotation): EditorialCapability {
  const shot        = annotation.cinematography.shotType.toLowerCase();
  const movement    = annotation.cinematography.cameraMovement.toLowerCase();
  const visualStyle = annotation.cinematography.visualStyle.toLowerCase();
  const emotion     = annotation.emotion.toLowerCase();
  const motionLevel = annotation.motionLevel;
  const storyPrimary = annotation.storytellingLabels?.primary ?? "";
  const tags        = (annotation.cinematicTags ?? []).map((t) => t.toLowerCase());
  const objects     = annotation.objects.map((o) => o.toLowerCase());
  const actions     = annotation.actions.map((a) => a.toLowerCase());
  const usageHint   = (annotation.usageHints?.bestUsedAs ?? "").toLowerCase();
  const es          = annotation.editorialScore;
  const setting     = annotation.environment.setting.toLowerCase();
  const persons     = annotation.persons;
  const loc         = annotation.location;
  const hc          = annotation.historicalContext;
  const faceTracks  = annotation.faceTracks ?? [];
  const hasOcr      = (annotation.ocrTimeline?.length ?? 0) > 0 || (annotation.ocrText?.length ?? 0) > 0;
  const audioTypes  = (annotation.audioEvents ?? []).map((e) => e.type.toLowerCase());

  // Shot type helpers
  const isWide    = ["establishing", "extreme wide", "wide"].includes(shot);
  const isCloseUp = ["close-up", "extreme close-up", "medium close-up"].includes(shot);
  const isMedium  = shot === "medium" || shot.includes("medium");
  const isAerial  = tags.includes("aerial view") || movement === "drone";

  // Tag helpers
  const hasCelebration  = tags.includes("celebration") || tags.includes("ceremony") || tags.includes("procession");
  const hasDestruction  = tags.some((t) => ["destruction", "ruins", "fire", "smoke", "battle", "aftermath"].includes(t));
  const hasCrowdShot    = tags.includes("crowd shot");
  const hasArchive      = tags.some((t) => ["archive footage", "newsreel"].includes(t));
  const hasEstablishing = tags.includes("establishing shot");
  const hasSkyline      = tags.includes("skyline");
  const hasLandscape    = tags.includes("landscape");
  const hasMap          = tags.includes("map_appears") || objects.some((o) => o.includes("map"));
  const hasPortrait     = tags.includes("portrait") || tags.includes("interview");
  const hasInsert       = tags.some((t) => ["insert shot", "document_shown"].includes(t));

  // Audio helpers
  const hasLoudAudio = audioTypes.some((t) =>
    ["explosion", "gunfire", "loud event", "applause"].includes(t)
  );
  const hasLoudAudioStrong = audioTypes.some((t) =>
    ["explosion", "gunfire", "loud event"].includes(t)
  );

  // Calm = no loud audio + motion < 65
  const isCalm = !hasLoudAudioStrong && motionLevel < 65;

  return {
    canOpenDocumentary: clamp(
      (isWide || isAerial ? 35 : 0) +
      (hasSkyline || hasEstablishing || hasLandscape ? 20 : 0) +
      (["awe", "hope", "calm", "mystery"].includes(emotion) ? 15 : 0) +
      (storyPrimary === "establishing" ? 15 : 0) +
      (es.storytellingPotential > 70 ? 10 : 0) +
      (motionLevel < 60 ? 5 : 0)
    ),

    canCloseDocumentary: clamp(
      (["ending", "reflection"].includes(storyPrimary) ? 40 : 0) +
      (["calm", "grief", "triumph", "hope", "awe"].includes(emotion) ? 20 : 0) +
      (hasCelebration ? 15 : 0) +
      (tags.includes("aftermath") ? 15 : 0) +
      (motionLevel < 50 ? 10 : 0)
    ),

    canIntroducePerson: clamp(
      (persons.named.length > 0 ? 30 : 0) +
      (faceTracks.length > 0 ? 20 : 0) +
      (isCloseUp || isMedium ? 20 : 0) +
      (["context", "establishing"].includes(storyPrimary) ? 15 : 0) +
      (hasPortrait ? 15 : 0)
    ),

    canIntroduceLocation: clamp(
      (isWide || isAerial ? 30 : 0) +
      (hasEstablishing || hasSkyline || hasLandscape ? 25 : 0) +
      (loc.country || loc.city ? 20 : 0) +
      (storyPrimary === "establishing" ? 15 : 0) +
      (isCalm ? 10 : 0)
    ),

    canIntroduceEra: clamp(
      (hc.period || hc.year ? 25 : 0) +
      (hasArchive ? 25 : 0) +
      (["black and white", "sepia", "archival", "newsreel"].includes(visualStyle) ? 20 : 0) +
      (es.historicalUsability > 70 ? 20 : 0) +
      (hasOcr ? 10 : 0)
    ),

    canShowScale: clamp(
      (isWide || isAerial ? 30 : 0) +
      (hasCrowdShot ? 25 : 0) +
      (["crowd", "army", "fleet", "mass", "troops"].some((t) =>
        persons.categories.join(" ").toLowerCase().includes(t)
      ) ? 20 : 0) +
      (["battlefield", "city", "sea", "beach", "stadium"].includes(setting) ? 15 : 0) +
      (motionLevel > 30 ? 10 : 0)
    ),

    canShowDestruction: clamp(
      (hasDestruction ? 50 : 0) +
      (["chaos", "fear", "grief"].includes(emotion) ? 20 : 0) +
      (actions.some((a) =>
        ["bombing", "exploding", "destroying", "burning", "collapsing"].some((k) => a.includes(k))
      ) ? 20 : 0) +
      (objects.some((o) =>
        ["ruins", "explosion", "fire", "bomb", "debris", "wreckage"].some((k) => o.includes(k))
      ) ? 10 : 0)
    ),

    canShowVictory: clamp(
      (["triumph", "pride", "hope", "joy"].includes(emotion) ? 30 : 0) +
      (hasCelebration ? 30 : 0) +
      (["climax", "ending"].includes(storyPrimary) ? 20 : 0) +
      (actions.some((a) =>
        ["celebrating", "cheering", "saluting", "waving", "embracing"].some((k) => a.includes(k))
      ) ? 20 : 0)
    ),

    canShowDefeat: clamp(
      (["defeat", "grief", "fear"].includes(emotion) ? 35 : 0) +
      (tags.some((t) => ["aftermath", "ruins"].includes(t)) ? 25 : 0) +
      (actions.some((a) =>
        ["surrendering", "retreating", "mourning", "fleeing"].some((k) => a.includes(k))
      ) ? 25 : 0) +
      (storyPrimary === "ending" ? 15 : 0)
    ),

    canBuildSuspense: clamp(
      (["tension", "fear", "mystery"].includes(emotion) ? 30 : 0) +
      (["buildup", "tension", "conflict"].includes(storyPrimary) ? 30 : 0) +
      (["handheld", "tracking", "zoom"].includes(movement) ? 20 : 0) +
      (motionLevel > 50 ? 10 : 0) +
      (!isWide && !isAerial ? 10 : 0)
    ),

    canIncreaseEmotion: clamp(
      (es.emotionalValue > 70 ? 30 : es.emotionalValue > 50 ? 15 : 0) +
      (emotion !== "neutral" ? 20 : 0) +
      (["emotion", "reaction", "climax"].includes(storyPrimary) ? 20 : 0) +
      (faceTracks.some((f) => f.closeUpDurationSec > 2) ? 15 : 0) +
      (isCloseUp ? 15 : 0)
    ),

    canSupportVoiceOver: clamp(
      (isCalm ? 30 : 0) +
      (motionLevel < 50 ? 20 : motionLevel < 65 ? 10 : 0) +
      (["context", "establishing", "broll", "detail"].includes(storyPrimary) ? 20 : 0) +
      (["cutaway", "b-roll"].includes(usageHint) ? 15 : 0) +
      (tags.some((t) => ["cutaway", "b-roll"].includes(t)) ? 10 : 0) +
      (hasLoudAudioStrong ? -20 : 0)
    ),

    canBridgeScenes: clamp(
      (["transition", "broll"].includes(storyPrimary) ? 40 : 0) +
      (["pan", "tracking", "tilt", "dolly", "crane"].includes(movement) ? 25 : 0) +
      (motionLevel > 25 && motionLevel < 75 ? 20 : 0) +
      (usageHint === "transition" ? 15 : 0)
    ),

    canServeAsBroll: clamp(
      (["cutaway", "b-roll"].includes(usageHint) ? 30 : 0) +
      (["context", "broll", "transition", "detail"].includes(storyPrimary) ? 25 : 0) +
      (es.cinematicQuality > 60 ? 20 : 0) +
      (isCalm ? 15 : 0) +
      (isWide || isMedium ? 10 : 0)
    ),

    canRevealInformation: clamp(
      (["reveal", "detail"].includes(storyPrimary) ? 40 : 0) +
      (hasInsert ? 25 : 0) +
      (hasOcr ? 20 : 0) +
      (objects.some((o) =>
        ["document", "map", "newspaper", "letter", "sign", "poster"].some((k) => o.includes(k))
      ) ? 15 : 0)
    ),

    canVisualizeStatistics: clamp(
      (hasMap ? 50 : 0) +
      (objects.some((o) =>
        ["chart", "graph", "diagram", "statistic", "table"].some((k) => o.includes(k))
      ) ? 30 : 0) +
      (setting === "indoors" ? 10 : 0) +
      (hasOcr ? 10 : 0)
    ),

    canExplainTimeline: clamp(
      (hc.period && hc.event ? 30 : hc.period || hc.year ? 20 : 0) +
      ((annotation.ocrTimeline ?? []).some((e) => e.type === "date_overlay") ? 25 : 0) +
      (hasArchive ? 20 : 0) +
      (es.historicalUsability > 60 ? 15 : 0) +
      (isCalm ? 10 : 0)
    ),

    canSupportMapSequence: clamp(
      (hasMap ? 60 : 0) +
      (loc.country ? 20 : 0) +
      (hasEstablishing ? 10 : 0) +
      (isAerial ? 10 : 0)
    ),

    canSupportBiography: clamp(
      (persons.named.length > 0 ? 25 : 0) +
      (faceTracks.length > 0 ? 20 : 0) +
      ((annotation.personDetails?.length ?? 0) > 0 ? 15 : 0) +
      ((hc.event || hc.period) ? 15 : 0) +
      (es.historicalUsability > 60 ? 15 : 0) +
      (isCloseUp || isMedium ? 10 : 0)
    ),

    canSupportHistoricalExplanation: clamp(
      (hc.period || hc.event ? 25 : 0) +
      (es.historicalUsability > 60 ? 25 : 0) +
      (hasArchive ? 20 : 0) +
      (isCalm ? 15 : 0) +
      (es.storytellingPotential > 60 ? 15 : 0)
    ),

    canSupportTechnicalExplanation: clamp(
      (objects.some((o) =>
        ["equipment", "machine", "engine", "weapon", "aircraft", "tank", "ship", "vehicle", "gun", "device"].some((k) => o.includes(k))
      ) ? 30 : 0) +
      (["factory", "laboratory", "office", "indoors"].includes(setting) ? 20 : 0) +
      (motionLevel < 50 ? 20 : 0) +
      (["cutaway", "b-roll"].includes(usageHint) ? 15 : 0) +
      (isCloseUp ? 15 : 0)
    ),
  };
}

// ─── Narrative function derivation ────────────────────────────────────────────

function deriveNarrativeFunctions(
  annotation: ClipAnnotation,
  caps: EditorialCapability
): NarrativeFunction[] {
  const fn: NarrativeFunction[] = [];
  const c = (cap: keyof EditorialCapability) => caps[cap] ?? 0;

  if (c("canOpenDocumentary") >= 60) fn.push("opening");
  if (c("canOpenDocumentary") >= 40 || c("canIntroduceLocation") >= 60) fn.push("establishing");
  if (c("canSupportVoiceOver") >= 50 || c("canSupportHistoricalExplanation") >= 50) fn.push("context");
  if (c("canSupportHistoricalExplanation") >= 65) fn.push("historical_context");
  if (c("canIntroducePerson") >= 60) fn.push("character_introduction");
  if (c("canServeAsBroll") >= 60) fn.push("broll");
  if (c("canBridgeScenes") >= 60) fn.push("transition");
  if (c("canBuildSuspense") >= 50 && c("canBuildSuspense") < 70) fn.push("buildup");
  if (c("canBuildSuspense") >= 70) fn.push("tension");
  if (c("canShowDestruction") >= 55) fn.push("conflict");
  if (annotation.editorialScore.total >= 80 && (annotation.shotImportance?.score ?? 0) >= 70) fn.push("turning_point");
  if (c("canIncreaseEmotion") >= 70 || annotation.storytellingLabels?.primary === "climax") fn.push("climax");
  if (c("canShowDefeat") >= 50 || (annotation.cinematicTags ?? []).includes("aftermath")) fn.push("aftermath");
  if (c("canCloseDocumentary") >= 55) fn.push("ending");
  if (c("canRevealInformation") >= 55) fn.push("reflection");

  // Deduplicate, keep max 5 most specific
  return fn.filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
}

// ─── Visual purpose derivation ────────────────────────────────────────────────

function deriveVisualPurpose(
  annotation: ClipAnnotation,
  caps: EditorialCapability
): string {
  const c = (cap: keyof EditorialCapability) => caps[cap] ?? 0;

  // Find top 2 capabilities (≥ 60)
  const topCaps = (Object.keys(caps) as (keyof EditorialCapability)[])
    .filter((k) => c(k) >= 60)
    .sort((a, b) => c(b) - c(a))
    .slice(0, 2);

  const shot    = annotation.cinematography.shotType;
  const emotion = annotation.emotion;
  const subject = annotation.primarySubject
    ?? annotation.persons.named[0]
    ?? annotation.historicalContext.event
    ?? "the subject";

  const parts: string[] = [];

  if (topCaps.includes("canOpenDocumentary"))           parts.push(`Ideal as an opening establishing shot`);
  if (topCaps.includes("canIntroduceLocation"))         parts.push(`${shot} that effectively introduces the location`);
  if (topCaps.includes("canIntroducePerson"))           parts.push(`Strong ${shot} for introducing ${subject}`);
  if (topCaps.includes("canIncreaseEmotion"))           parts.push(`Powerful ${emotion} moment with high emotional impact`);
  if (topCaps.includes("canSupportVoiceOver"))          parts.push(`Calm B-roll suitable for voice-over narration`);
  if (topCaps.includes("canShowScale"))                 parts.push(`Wide shot that effectively communicates scale and mass`);
  if (topCaps.includes("canCloseDocumentary"))          parts.push(`Contemplative close with ${emotion} mood`);
  if (topCaps.includes("canBuildSuspense"))             parts.push(`Tense sequence that builds anticipation`);
  if (topCaps.includes("canRevealInformation"))         parts.push(`Reveals key information through visual detail`);
  if (topCaps.includes("canShowVictory"))               parts.push(`Celebratory moment of triumph — ideal for victory sequences`);
  if (topCaps.includes("canShowDestruction"))           parts.push(`Powerful destruction or conflict imagery`);
  if (topCaps.includes("canSupportHistoricalExplanation")) parts.push(`Archive footage suitable for historical explanation`);
  if (topCaps.includes("canSupportBiography"))          parts.push(`Strong biography clip featuring ${subject}`);
  if (topCaps.includes("canBridgeScenes"))              parts.push(`Smooth transition shot for scene bridging`);
  if (topCaps.includes("canServeAsBroll"))              parts.push(`Versatile B-roll — good for cutaway or illustration`);
  if (topCaps.includes("canSupportTechnicalExplanation")) parts.push(`Detail shot suitable for technical explanation`);

  if (parts.length === 0) {
    const fn = annotation.storytellingLabels?.primary ?? "context";
    parts.push(`${fn.charAt(0).toUpperCase() + fn.slice(1)} clip — ${shot} of ${subject}`);
  }

  return parts.slice(0, 2).join(". ").trim();
}

// ─── Main: computeEditorialIntent ────────────────────────────────────────────

/**
 * Compute the full EditorialIntent for a clip from its existing ClipAnnotation.
 * Call this at ingest time (Stage 17 of the Archive Intelligence Pipeline).
 *
 * Never throws — returns null on any error.
 */
export function computeEditorialIntent(
  annotation: ClipAnnotation
): EditorialIntent | null {
  if (!editorialIntentEnabled()) return null;

  try {
    const capabilities     = deriveCapabilities(annotation);
    const narrativeFunctions = deriveNarrativeFunctions(annotation, capabilities);
    const visualPurpose    = deriveVisualPurpose(annotation, capabilities);

    return {
      capabilities,
      narrativeFunctions,
      visualPurpose,
      computedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(
      `[EditorialIntent] compute failed:`,
      (err as Error).message?.slice(0, 80)
    );
    return null;
  }
}

// ─── Capability matching (render time) ───────────────────────────────────────

/**
 * Score how well a clip's editorial capabilities match the beat's requirements.
 *
 * Returns:
 *   bonus   — +0 to +8: clip has the right editorial capabilities
 *   penalty — -6 to 0: clip has capabilities that are wrong for this beat
 *   explanation — compact log string for retrieval explainability
 */
export function scoreEditorialCapabilityMatch(
  intent: EditorialIntent | undefined | null,
  decomposition: BeatDecomposition
): { bonus: number; penalty: number; explanation: string } {
  const none = { bonus: 0, penalty: 0, explanation: "" };
  if (!editorialIntentEnabled()) return none;
  if (!intent || decomposition.requiredCapabilities.length === 0) return none;

  const caps = intent.capabilities;
  let bonus = 0;
  let penalty = 0;
  const bonusLog: string[] = [];
  const penaltyLog: string[] = [];

  // Required capabilities → bonus when present, minor penalty when absent
  for (const cap of decomposition.requiredCapabilities) {
    const score = caps[cap] ?? 0;
    if (score >= 80)      { bonus += 3; bonusLog.push(`${cap}:${score}+3`); }
    else if (score >= 60) { bonus += 2; bonusLog.push(`${cap}:${score}+2`); }
    else if (score >= 40) { bonus += 1; bonusLog.push(`${cap}:${score}+1`); }
    else if (score < 20)  { penalty -= 1; penaltyLog.push(`${cap}:${score}-1`); } // wrong clip for this need
  }

  // Penalized capabilities → penalty when clip scores high on them
  for (const cap of decomposition.penalizedCapabilities) {
    const score = caps[cap] ?? 0;
    if (score >= 80)      { penalty -= 3; penaltyLog.push(`!${cap}:${score}-3`); }
    else if (score >= 60) { penalty -= 2; penaltyLog.push(`!${cap}:${score}-2`); }
    else if (score >= 40) { penalty -= 1; penaltyLog.push(`!${cap}:${score}-1`); }
  }

  const cappedBonus   = Math.min(8, Math.max(0, bonus));
  const cappedPenalty = Math.max(-6, Math.min(0, penalty));

  const parts: string[] = [];
  if (bonusLog.length)   parts.push(`cap[${bonusLog.join(",")}]→+${cappedBonus}`);
  if (penaltyLog.length) parts.push(`mis[${penaltyLog.join(",")}]→${cappedPenalty}`);

  return {
    bonus:   cappedBonus,
    penalty: cappedPenalty,
    explanation: parts.join(" "),
  };
}

// ─── Explainability log ────────────────────────────────────────────────────────

/**
 * Emit a per-clip explainability log line for the chosen clip's editorial intent.
 * Called from AssetDirector's logAssetDirectorChoice after the choice is made.
 */
export function logEditorialIntentChoice(
  clipPath: string,
  intent: EditorialIntent | undefined | null,
  decomposition: BeatDecomposition,
  capabilityBonus: number,
  capabilityPenalty: number,
  capabilityExplanation: string
): void {
  if (!intent) return;

  const base = path.basename(clipPath);

  const fnStr = intent.narrativeFunctions.length > 0
    ? intent.narrativeFunctions.join(", ")
    : "—";

  const topCaps = (Object.entries(intent.capabilities) as [string, number | undefined][])
    .filter(([, v]) => (v ?? 0) >= 70)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 4)
    .map(([k, v]) => `${k.replace("can", "")}:${v}`)
    .join(" ");

  console.log(
    `[EditorialIntent] ${base}\n` +
    `  Functions:   ${fnStr}\n` +
    `  Purpose:     ${intent.visualPurpose.slice(0, 120)}\n` +
    `  Capabilities:${topCaps || "(none ≥70)"}\n` +
    (decomposition.narrativePurpose ? `  Beat needs:  ${decomposition.narrativePurpose}\n` : "") +
    (capabilityBonus !== 0 || capabilityPenalty !== 0
      ? `  Cap match:   bonus:+${capabilityBonus} penalty:${capabilityPenalty}${capabilityExplanation ? ` — ${capabilityExplanation}` : ""}\n`
      : "")
  );
}
