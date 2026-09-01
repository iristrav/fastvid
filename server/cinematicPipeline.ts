/**
 * RONDE 150 §2/§3 — the cinematic route, finally connected.
 *
 * ── What was actually wrong ──────────────────────────────────────────────────────────────────
 *
 * Nothing. Every part worked and nothing called them.
 *
 * `cinematicEditingEngine/featureFlags.ts` says so in its own words: "Nothing in this directory is
 * called from the live render pipeline — it only produces an Edit Decision List (EDL), never
 * renders". `aiDirector/featureFlags.ts` says the same. Both flags gated code that was already
 * unreachable, so turning them on changed nothing.
 *
 * This module is the call that was missing. It is short on purpose: every decision below is made
 * by a planner that already existed and was already tested, and the only thing here is the order
 * they run in and the shape of what is handed between them.
 *
 *     scenes + beats + adopted clips
 *         → runAIDirector          scene-level narrative judgement          (§3)
 *         → toDirectorGuidance     one scene's judgement, as engine input
 *         → generateEDL            per-beat shot/camera/transition/caption/ (§2)
 *                                  graphics/effects/sound decisions
 *         → translateEdl           the EDL becomes a ProjectTimeline
 *
 * ── §4: ONE timeline ─────────────────────────────────────────────────────────────────────────
 *
 * The output is a `ProjectTimeline` and nothing else. No parallel document, no engine-specific
 * state that outlives this function. Everything downstream — validator, rehydrator, renderer,
 * editor — reads that one timeline, exactly as it does for a video edited by hand.
 *
 * ── §26: this must not be blocked by graphics ────────────────────────────────────────────────
 *
 * "Cinematic Engine live > perfecte Remotion graphics." So this module knows nothing about
 * Remotion. It produces a timeline; how that timeline is drawn is somebody else's decision, made
 * later, and a graphic that cannot be drawn is reported by the renderer rather than blocking the
 * plan from being made.
 */
import {
  cinematicEditingEngineEnabled,
  generateEDL,
  type CinematicEditingInput,
} from "./cinematicEditingEngine";
import type { EDL, EditDecision } from "./cinematicEditingEngine/types";
import { aiDirectorEnabled, runAIDirector, toDirectorGuidance, type SceneInput } from "./aiDirector";
import type { DirectorOutput } from "./aiDirector/types";
import { translateEdl, type EdlTranslationInput } from "./edlToTimeline";
import { ambientClips, planCinematicAudio, type CinematicAudioPlan } from "./cinematicAmbient";
import { ATTENTION_EFFECTS, classifyAttentionMoment, type AttentionMoment } from "./shotVocabulary";
import { newRenderId } from "./renderCorrelation";
import type { AssetSourceIdentity, ProjectTimeline } from "./projectTimeline";
import type { TtsWordTiming } from "./voiceTtsAlignment";

/* ═══════════════════════ what a caller must supply ═══════════════════════ */

/**
 * One beat, with everything the planners need and nothing they do not.
 *
 * `identity` is the beat's ADOPTED clip from the lineage ledger — the same identity the rehydrator
 * will later use to fetch the file again. It is required rather than optional because a beat with
 * no proven source cannot be rendered from, and discovering that after the plan is made would mean
 * planning around a shot that does not exist.
 */
export type CinematicBeatInput = {
  input: CinematicEditingInput;
  identity: AssetSourceIdentity;
  /**
   * RONDE 151 §7 — the cut this render already made into the provider's original, when it did.
   * Carried through untouched so the timeline's sourceIn is relative to what the rehydrator
   * returns rather than to a temp file that will not exist tomorrow.
   */
  sourceTrim?: { inSec: number; outSec?: number };
};

export type CinematicSceneInput = {
  director: SceneInput;
  beats: CinematicBeatInput[];
  /**
   * Where this scene starts on the WHOLE video's clock, in seconds.
   *
   * It lives on the SCENE and not on the beat, because that is the unit the engine's own times are
   * measured against: `CinematicEditingInput.beatVoiceStartSec` is documented as "within the
   * scene", and every number an `EditDecision` produces is built from it. A per-beat offset would
   * be added on top of a beat offset that is already there — see the note on
   * `EdlTranslationInput.sceneOffsetSec`, which is the fault this shape makes unrepresentable.
   */
  sceneOffsetSec: number;
};

export type CinematicPipelineParams = {
  videoId: number;
  scenes: CinematicSceneInput[];
  /** The persisted narration, when there is one. Never regenerated — RONDE 146 stores it. */
  voice?: { url: string; durationSec: number } | null;
  /** The measured TTS alignment, carried so captions land on real word boundaries. */
  words?: TtsWordTiming[];
  format?: ProjectTimeline["format"];
  /**
   * R160 — the video's colour treatment.
   *
   * Defaults to the documentary grade, because that is FastVid's look and because an ungraded
   * cinematic video loses the whole point of documentaryStyle's source-aware calibration: making
   * archive, stock and generated footage belong in one film. Pass `{ grade: "none" }` for no grade.
   */
  look?: ProjectTimeline["look"];
  /** Emit a narration subtitle per beat. On by default — see the note at the generateEDL call. */
  includeSubtitles?: boolean;
  /**
   * RONDE 172 — the render's correlation id.
   *
   * Passed in rather than minted here whenever the caller already has one: the sourcing ledger
   * mints a `renderId` for every render and `[SourceLineage]`/`[SearchQuery]` already print it, so
   * generating a second id here would split one render's log into two stories. One is minted only
   * when the caller has none to give.
   */
  renderId?: string;
};

/* ═══════════════════════ what it produces ═══════════════════════ */

/**
 * RONDE 166 (§3) — one beat's attention moment, with the evidence that produced it.
 *
 * The evidence travels with the verdict on purpose. "This beat is a statistic" is a claim; "this
 * beat states a figure (\"3 billion\")" is that claim with its receipt, and a Director decision
 * nobody can check is a Director decision nobody should trust.
 */
export type PlannedAttention = {
  beatId: string;
  moment: AttentionMoment;
  evidence: string;
  effects: (typeof ATTENTION_EFFECTS)[AttentionMoment];
};

export type CinematicPipelineResult = {
  timeline: ProjectTimeline;
  edl: EDL;
  /** The Director's own output, kept so a caller can log or store WHY the edit looks like it does. */
  director: DirectorOutput | null;
  /**
   * Everything a planner asked for that this renderer cannot execute, with the planner's own
   * reason. §2: "NIETS mag stil verdwijnen."
   */
  unsupported: string[];
  /**
   * RONDE 166 (§1/§2) — the ambience that was laid down, and the music verdict.
   *
   * `music` is always present and always states whether a track was available, so a caller can
   * report `musicSourceUnavailable` rather than leaving a silent gap where music was expected.
   */
  /** RONDE 172 — the id that joins this plan to the retrieval, render and upload logs. */
  renderId: string;
  audio: CinematicAudioPlan;
  /**
   * RONDE 166 (§3) — one entry per beat, in beat order; null where the beat carries no evidence.
   *
   * Exposed rather than applied silently: it is available for shot, graphic and pacing decisions,
   * and a caller can log exactly which beats the Director thought were moments and why.
   */
  attention: Array<PlannedAttention | null>;
  /** How the route was configured for this run, for the render log. */
  used: { cinematicEngine: boolean; aiDirector: boolean };
};

/* ═══════════════════════ the route ═══════════════════════ */

/**
 * Should a video be planned by the cinematic engine?
 *
 * A single named question rather than an inline `process.env` check, so the answer is findable and
 * so the pipeline can log which route it took. The flag stays OFF by default: §2 asks for the
 * switch-over to be safe, and safe means an operator turns it on deliberately.
 */
export function cinematicRouteEnabled(): boolean {
  return cinematicEditingEngineEnabled();
}

/**
 * Plan a video the cinematic way.
 *
 * ── The AI Director's part, and why it is per-scene ──────────────────────────────────────────
 *
 * `runAIDirector` reads ALL the scenes at once, because its judgements are about the video as a
 * whole: where the hook is, how energy should rise and fall, which moments deserve attention. Its
 * per-scene decision is then narrowed to `DirectorGuidance` and handed to the engine for that
 * scene's beats.
 *
 * That is the existing contract — `toDirectorGuidance` already exists and `CinematicEditingInput`
 * already has a `directorGuidance` field marked "entirely additive". This function does not invent
 * a way to combine them; it uses the one that was designed for it.
 *
 * ── With AI_DIRECTOR off ─────────────────────────────────────────────────────────────────────
 *
 * `directorGuidance` is simply absent and every planner behaves exactly as it does today. That is
 * the flag's own promise ("every existing caller that omits it keeps its exact current behavior"),
 * so both settings produce a valid video and only one of them is advised.
 */
export function runCinematicPipeline(params: CinematicPipelineParams): CinematicPipelineResult {
  const useDirector = aiDirectorEnabled();

  /**
   * The Director runs FIRST and over everything, because pacing is a property of the whole video.
   * A per-scene call would make each scene decide its own energy in isolation, which is precisely
   * the flat rhythm the Director exists to fix.
   */
  const director: DirectorOutput | null = useDirector
    ? runAIDirector(params.scenes.map((s) => s.director))
    : null;

  const renderId = params.renderId?.trim() || newRenderId();
  const inputs: CinematicEditingInput[] = [];
  const identities: AssetSourceIdentity[] = [];
  const trims: Array<{ inSec: number; outSec?: number } | undefined> = [];
  const offsets: number[] = [];
  /** RONDE 166 (§3) — index-aligned with `inputs`; null for a beat with no evidence. */
  const attention: Array<PlannedAttention | null> = [];
  /** The whole video's planned length, needed to place a beat in it. From the scenes, not guessed. */
  const totalPlannedSec = params.scenes.reduce(
    (max, s) => Math.max(max, s.sceneOffsetSec + Math.max(0, s.director.durationSec)),
    0
  );

  params.scenes.forEach((scene, sceneIndex) => {
    const decision = director?.decisions[sceneIndex];
    const guidance = decision ? toDirectorGuidance(decision) : undefined;
    scene.beats.forEach((beat, beatIndex) => {
      inputs.push({
        ...beat.input,
        /**
         * Both are set HERE rather than trusted from the caller, because they are facts about
         * position that this function knows and a caller could get wrong. `beatIndexInScene` is
         * what lets the engine look up the matching entry in the Director's shot order.
         */
        beatIndexInScene: beatIndex,
        ...(guidance ? { directorGuidance: guidance } : {}),
      });
      identities.push(beat.identity);
      trims.push(beat.sourceTrim);
      /**
       * RONDE 166 (§3) — the beat's attention moment, classified from the beat's OWN TEXT.
       *
       * `classifyAttentionMoment` was written in RONDE 157 and called by nothing but its own test.
       * This is where it runs on the live route. It is asked once per beat, here, so every consumer
       * downstream reads the same answer rather than each re-deriving one.
       *
       * Position is passed in but is never sufficient on its own: a `hook` requires an early beat
       * that ALSO carries a number, a name or a question. Most beats classify as null, which is the
       * correct answer — a Director that marked every beat as a moment would be marking none.
       */
      const moment = classifyAttentionMoment({
        text: beat.input.intent.spokenText,
        beatIndexInVideo: inputs.length - 1,
        videoDurationSec: totalPlannedSec,
        beatStartSec: scene.sceneOffsetSec + beat.input.beatVoiceStartSec,
        hasLocation: Boolean(beat.input.intent.visualLocation.trim()),
      });
      attention.push(
        moment
          ? { beatId: beat.input.intent.beatId, ...moment, effects: ATTENTION_EFFECTS[moment.moment] }
          : null
      );
      /** One offset per scene, repeated per beat, because the adapter works decision by decision. */
      offsets.push(scene.sceneOffsetSec);
    });
  });

  /**
   * The engine's own chain: pacing → shot → camera → transition → timing → captions → …
   *
   * R160 — `includeSubtitles` is ON here, and that is the fix for a bug the audit found: nothing
   * ever passed it, so a cinematically-planned video had an EMPTY captions track and the whole
   * caption engine was unreachable from the live route. A documentary with narration wants
   * subtitles; the flag stays off by default for every other caller.
   */
  const edl = generateEDL(inputs, { includeSubtitles: params.includeSubtitles !== false });

  /**
   * The EDL becomes the timeline through the adapter that already exists, which makes no editorial
   * decisions of its own and REPORTS whatever it cannot carry across.
   */
  const translationInputs: EdlTranslationInput[] = edl.decisions.map(
    (decision: EditDecision, i: number) => ({
      decision,
      sceneOffsetSec: offsets[i] ?? 0,
      identity: identities[i]!,
      ...(trims[i] ? { sourceTrim: trims[i]! } : {}),
    })
  );
  const { timeline, unsupported } = translateEdl({
    videoId: params.videoId,
    inputs: translationInputs,
    format: params.format,
    voice: params.voice ?? null,
    /** R160 — without this the cinematic route produced an UNGRADED video. See translateEdl. */
    look: params.look ?? { grade: "documentary" },
  });

  /**
   * RONDE 166 (§1/§2) — the AMBIENT track, filled from the catalogue that was already there.
   *
   * `translateEdl` builds AMBIENT and MUSIC as literal empty arrays, because an EDL is a picture
   * plan and says nothing about room tone. So the ambience is planned here, from the SCENES, by
   * the classifier that has been reading them for the legacy route all along — and laid onto the
   * track the renderer already mixes and ducks.
   *
   * Music stays empty on purpose: this build has no music catalogue, and `audioPlan.music` carries
   * the reason so the caller can report it rather than leaving a silent gap.
   */
  const sceneWindows = params.scenes.map((scene) => ({
    startSec: scene.sceneOffsetSec,
    endSec: scene.sceneOffsetSec + Math.max(0, scene.director.durationSec),
  }));
  const audioPlan = planCinematicAudio({
    scenes: params.scenes.map((s) => s.director.scene),
    sceneWindows,
  });
  const ambientTrack = timeline.tracks.find((t) => t.kind === "AMBIENT");
  if (ambientTrack?.kind === "AMBIENT") ambientTrack.clips.push(...ambientClips(audioPlan));
  for (const line of audioPlan.unavailable) unsupported.push(line);

  return {
    timeline,
    edl,
    director,
    unsupported,
    renderId,
    audio: audioPlan,
    attention,
    used: { cinematicEngine: true, aiDirector: useDirector },
  };
}

/* ═══════════════════════ §2 — proving nothing was lost ═══════════════════════ */

/**
 * Compare the EDL with the timeline built from it, and name every editorial decision that did not
 * survive the crossing.
 *
 * ── Why this is production code, not only a test ─────────────────────────────────────────────
 *
 * §2 asks for an integration test, and there is one. But a test proves the translation was lossless
 * for the decisions someone wrote down; this runs on the REAL edit, so a combination no test
 * covered still gets an answer, and the answer appears in the render log rather than in a silence.
 *
 * It deliberately compares COUNTS and INTENT rather than deep equality: the two documents have
 * different shapes on purpose (beat-relative vs absolute time), so a deep comparison would be all
 * noise. What must hold is that every decision that was made is still represented.
 */
export function lostEditorialIntent(edl: EDL, timeline: ProjectTimeline): string[] {
  const lost: string[] = [];
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  const clips = track && track.kind === "VIDEO" ? track.clips : [];

  if (clips.length !== edl.decisions.length) {
    lost.push(
      `the EDL made ${edl.decisions.length} shot decision(s) and the timeline has ${clips.length} clip(s)`
    );
  }

  const captionCount = timeline.tracks
    .filter((t) => t.kind === "CAPTIONS" || t.kind === "TEXT")
    .reduce((n, t) => n + (t.kind === "CAPTIONS" ? t.captions.length : t.kind === "TEXT" ? t.texts.length : 0), 0);
  const plannedCaptions = edl.decisions.reduce((n, d) => n + d.captions.length, 0);
  if (captionCount < plannedCaptions) {
    lost.push(`${plannedCaptions - captionCount} planned caption(s) are not on the timeline`);
  }

  const graphicsTrackRef = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  const graphicCount =
    graphicsTrackRef && graphicsTrackRef.kind === "GRAPHICS" ? graphicsTrackRef.graphics.length : 0;
  const plannedGraphics = edl.decisions.reduce((n, d) => n + d.motionGraphics.length, 0);
  if (graphicCount < plannedGraphics) {
    lost.push(`${plannedGraphics - graphicCount} planned motion graphic(s) are not on the timeline`);
  }

  const sfxTrack = timeline.tracks.find((t) => t.kind === "SFX");
  const sfxCount = sfxTrack && sfxTrack.kind === "SFX" ? sfxTrack.clips.length : 0;
  const plannedSounds = edl.decisions.reduce((n, d) => n + d.sounds.length, 0);
  if (sfxCount < plannedSounds) {
    lost.push(`${plannedSounds - sfxCount} planned sound effect(s) are not on the timeline`);
  }

  /**
   * Per-clip intent. A count cannot catch these, and losing one produces a video that renders
   * perfectly and is not the video the planners designed.
   */
  edl.decisions.forEach((decision, i) => {
    const clip = clips[i];
    if (!clip) return;
    if (decision.camera.movement !== "camera_hold" && !clip.camera) {
      lost.push(`beat ${decision.beatId}: camera "${decision.camera.movement}" did not reach the clip`);
    }
    if (decision.effects.length !== (clip.effects?.length ?? 0)) {
      lost.push(`beat ${decision.beatId}: ${decision.effects.length} effect(s) planned, ${clip.effects?.length ?? 0} carried`);
    }
    if (clip.sourceIn !== decision.clip.trimStartSec) {
      lost.push(`beat ${decision.beatId}: the planner's trim was not carried across`);
    }
  });

  return lost;
}

/** One line per planned video, for the render log. Never a payload, never a URL. */
export function formatCinematicPlan(result: CinematicPipelineResult): string {
  const track = result.timeline.tracks.find((t) => t.kind === "VIDEO");
  const clips = track && track.kind === "VIDEO" ? track.clips.length : 0;
  const withCamera = track && track.kind === "VIDEO" ? track.clips.filter((c) => c.camera).length : 0;
  const transitions =
    track && track.kind === "VIDEO" ? track.clips.filter((c) => c.transitionIn !== "hard_cut").length : 0;
  return (
    `[CinematicPipeline] video=${result.timeline.videoId} ` +
    `engine=${result.used.cinematicEngine} director=${result.used.aiDirector} ` +
    `decisions=${result.edl.decisions.length} clips=${clips} cameras=${withCamera} ` +
    `transitions=${transitions} duration=${result.timeline.durationSec.toFixed(2)}s ` +
    `unsupported=${result.unsupported.length}`
  );
}
