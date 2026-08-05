/** Cinematic Editing Engine — EDL Generator (Phase 4).
 *
 *  The single entrypoint that chains every planner in this directory into one Edit Decision
 *  List for a scene: EmotionalPacing -> ShotPlanner -> CameraPlanner -> TransitionPlanner
 *  -> TimelinePlanner -> CaptionPlanner -> MotionGraphicsPlanner -> EffectsPlanner ->
 *  SoundPlanner, one beat at a time, threading continuity state (recent shot types,
 *  recent transitions, established subjects) between beats so later decisions can see what
 *  came before — same "accumulate as you go" pattern Phase 3's v2Pipeline.ts uses for
 *  diversity tracking. Makes no editorial decisions itself — every decision is made by
 *  exactly one specialized planner; this only sequences them and carries state between calls.
 *
 *  Nothing renders. The output is data only, ready for a future renderer (Phase 5) to consume.
 */
import { deriveEmotionalTone } from "./emotionalPacing";
import { planShot } from "./shotPlanner";
import { planCameraMovement } from "./cameraPlanner";
import { planTransition, type TransitionContext } from "./transitionPlanner";
import { planClipTiming } from "./timelinePlanner";
import { planCaptions } from "./captionPlanner";
import { planMotionGraphics } from "./motionGraphicsPlanner";
import { planVisualEffects } from "./effectsPlanner";
import { planSoundEffects } from "./soundPlanner";
import type { CinematicEditingInput, EDL, EditDecision, VisualContinuityState } from "./types";

function emptyContinuity(): VisualContinuityState {
  return { recentShotTypes: [], recentTransitions: [], establishedSubjects: [] };
}

const MAX_RECENT = 5;

function pushRecent(list: string[], value: string): void {
  list.push(value);
  if (list.length > MAX_RECENT) list.shift();
}

/**
 * Generates a complete EDL for one scene from its beats, in order. Each element of `inputs`
 * is one beat's already-resolved Scene/Visual Intent/Best Candidate/Word Timestamps/Video
 * Context — the literal Phase 4 INPUT list — for that beat. Continuity state is threaded
 * automatically between beats unless a caller supplies its own per-input `continuity`
 * (useful for tests, or for resuming a scene's continuity from an earlier point).
 */
export function generateEDL(inputs: CinematicEditingInput[]): EDL {
  const decisions: EditDecision[] = [];
  let prevTransitionCtx: TransitionContext | null = null;
  const runningContinuity = emptyContinuity();

  inputs.forEach((input, i) => {
    const continuity = input.continuity ?? runningContinuity;

    const pacing = deriveEmotionalTone(input.intent);
    const shot = planShot(input.intent, input.bestCandidate, continuity);
    const camera = planCameraMovement(shot, input.bestCandidate, pacing);

    const nextTransitionCtx: TransitionContext = { shotType: shot.shotType, subject: input.intent.visualSubject };
    const transitionIn = planTransition(prevTransitionCtx, nextTransitionCtx, pacing, continuity);

    const clips = planClipTiming(
      input.intent.spokenText,
      [input.bestCandidate],
      input.beatVoiceStartSec,
      input.beatVoiceDurationSec,
      input.wordTimings
    );
    const clip = clips[0]!;

    const captions = planCaptions(input.intent, input.beatVoiceStartSec, input.beatVoiceDurationSec, {
      scene: input.scene,
      isFirstBeatOfScene: i === 0,
      continuity,
    });
    const motionGraphics = planMotionGraphics(input.intent, input.scene, input.beatVoiceStartSec, input.beatVoiceDurationSec);
    const effects = planVisualEffects(shot, input.bestCandidate, pacing);
    const sounds = planSoundEffects(input.intent, pacing, input.beatVoiceStartSec, input.beatVoiceDurationSec, transitionIn.type);

    decisions.push({
      beatId: input.intent.beatId,
      sceneIndex: input.scene.index,
      clip,
      shot,
      camera,
      transitionIn,
      captions,
      motionGraphics,
      effects,
      sounds,
      pacing,
    });

    if (!input.continuity) {
      pushRecent(runningContinuity.recentShotTypes, shot.shotType);
      pushRecent(runningContinuity.recentTransitions, transitionIn.type);
      if (input.intent.visualLocation.trim()) runningContinuity.establishedSubjects.push(input.intent.visualLocation.trim());
      for (const person of input.intent.people) runningContinuity.establishedSubjects.push(person);
    }
    prevTransitionCtx = nextTransitionCtx;
  });

  const totalDurationSec = decisions.reduce((max, d) => Math.max(max, d.clip.endSec), 0);

  return {
    sceneIndex: inputs[0]?.scene.index ?? 0,
    decisions,
    totalDurationSec,
  };
}
