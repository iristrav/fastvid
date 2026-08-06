/** AI Director — Director Planner (Phase 5).
 *
 *  Combines narrativeAnalysis, shotOrderPlanner, pacingAdvisor, and attentionManager into one
 *  complete DirectorDecision for a single scene. Makes no decisions of its own — every field
 *  comes from exactly one specialized function; this only sequences them, matching the same
 *  "orchestrator vs. planner" split established by Cinematic Editing Engine's edlGenerator.ts.
 */
import {
  classifyNarrative,
  classifySceneEmotion,
  classifyVisualStrategy,
  deriveSupportingVisuals,
  pickSubjectFocus,
} from "./narrativeAnalysis";
import { planShotOrder } from "./shotOrderPlanner";
import { decideEnergyTrend, decidePacing, decideTransitionStyle, suggestSoundCue, suggestTextOverlay } from "./pacingAdvisor";
import { buildAttentionRecommendations, buildHookGuidance, buildRetentionRisk } from "./attentionManager";
import type { DirectorContext, DirectorDecision, NarrativeFunction } from "./types";

const REASON_TEMPLATES: Record<NarrativeFunction, (subject: string) => string> = {
  establish: (s) => `Introduces ${s} before narrowing into detail, so the audience has context first.`,
  explain: (s) => `Builds the audience's understanding of ${s} step by step before moving on.`,
  contrast: (s) => `Alternates coverage so the audience feels the contrast around ${s}, not just hears it.`,
  reveal: (s) => `Builds anticipation before revealing new information about ${s}.`,
  climax: (s) => `Escalates shot intensity to match the significance of this moment for ${s}.`,
  resolve: (s) => `Pulls back out to close the story on ${s}.`,
  transition: (s) => `Bridges cleanly into the next part of the story around ${s}.`,
};

/** Produces one complete DirectorDecision for one scene. Pure function of its DirectorContext
 *  — no LLM call, no media lookup, fully deterministic and independently testable. */
export function planDirectorDecision(context: DirectorContext): DirectorDecision {
  const { primary, secondary } = pickSubjectFocus(context);
  const { narrativeFunction, narrativePurpose } = classifyNarrative(context, primary);
  const emotion = classifySceneEmotion(context);
  const visualStrategy = classifyVisualStrategy(context);
  const supportingVisuals = deriveSupportingVisuals(context, primary, secondary);

  const shotOrder = planShotOrder(narrativeFunction, visualStrategy, context.beatIntents.length);

  const pacing = decidePacing(context, narrativeFunction);
  const energyTrend = decideEnergyTrend(context, narrativeFunction);
  const transitionStyle = decideTransitionStyle(narrativeFunction, visualStrategy, pacing);
  const textOverlaySuggestion = suggestTextOverlay(context.scene, context.beatIntents);
  const soundCueSuggestion = suggestSoundCue(narrativeFunction, visualStrategy, emotion);

  const attentionRecommendations = buildAttentionRecommendations(context, narrativeFunction, visualStrategy, pacing);
  const hookGuidance = buildHookGuidance(context);
  const retentionRisk = buildRetentionRisk(context, narrativeFunction, visualStrategy, pacing, context.scene);

  return {
    sceneIndex: context.sceneIndex,
    primarySubject: primary,
    secondarySubject: secondary,
    narrativeFunction,
    narrativePurpose,
    emotion,
    visualStrategy,
    supportingVisuals,
    shotOrder,
    pacing,
    energyTrend,
    transitionStyle,
    textOverlaySuggestion,
    soundCueSuggestion,
    attentionRecommendations,
    hookGuidance,
    retentionRisk,
    reason: REASON_TEMPLATES[narrativeFunction](primary),
  };
}
