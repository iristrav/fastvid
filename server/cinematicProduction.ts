/**
 * RONDE 151 §2/§19/§20 — the cinematic route, called from the production pipeline.
 *
 * ── Why this is a separate file from videoPipeline.ts ────────────────────────────────────────
 *
 * videoPipeline.ts is 39,442 lines. Every line added there is a line in the middle of the function
 * that produces every FastVid video, and the round's own §28 forbids removing working behaviour
 * without a migration path. So the whole of the cinematic route lives here, videoPipeline calls one
 * function, and a failure in any part of this file cannot take a finished render down with it.
 *
 * ── What this does, and what it deliberately does not ───────────────────────────────────────
 *
 *     production facts (scenes, beats, adopted clips, lineage, voice)
 *         → buildCinematicSceneInputs      the §1 vocabulary bridge
 *         → runCinematicPipeline           Director → EDL → ProjectTimeline
 *         → validateTimeline               §5, before anything is stored
 *         → saveVideoTimeline              the editor and the render job read this
 *
 * It produces and persists ONE ProjectTimeline. It does not render. §19's cutover — the timeline
 * producing the delivered MP4 instead of `composeSceneVideo` — is a separate switch
 * (`cinematicRenderPathEnabled`), because the two questions are genuinely separate: "is the plan
 * good enough to store and edit" can be answered on every render starting now, while "does the
 * plan render the same video the old path did" needs a real render to compare against.
 */
import {
  buildCinematicSceneInputs,
  formatCinematicInputs,
  type EntityExtractors,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import {
  cinematicRouteEnabled,
  formatCinematicGraphics,
  formatCinematicPlan,
  lostEditorialIntent,
  runCinematicPipeline,
} from "./cinematicPipeline";
import { validateTimeline, NON_BLOCKING_ISSUES, formatTimelineIssue } from "./timelineValidator";
import { formatCinematicAudio } from "./cinematicAmbient";
import { formatCueSheet, type CurvePoint } from "./musicDirector";
import {
  judgeTimeline,
  formatQualityFindings,
  formatQualitySummary,
  type QualityFinding,
} from "./directorQualityRules";
import type { ProjectTimeline } from "./projectTimeline";
import type { TtsWordTiming } from "./voiceTtsAlignment";
/**
 * §14's route line reads the REAL predicates, so it can never claim a flag state the pipeline does
 * not act on. Every one of these is a pure env read with no side effects, and scenePool imports
 * videoPipeline for types only, so none of this introduces a runtime cycle.
 */
import { describePoolRankingV2 } from "./scenePool";
import { sceneCandidatePoolEnabled, formatYoutubeReadiness } from "./sourcingPolicy";
import { aiDirectorEnabled } from "./aiDirector/featureFlags";
import { searchGateStrict } from "./searchQueryContract";

/* ═══════════════════════ §19/§20 — the two switches ═══════════════════════ */

/**
 * Should this render PLAN with the cinematic engine?
 *
 * `CINEMATIC_EDITING_ENGINE=true`. Planning is safe to turn on ahead of rendering: the timeline is
 * stored alongside the render the old path produced, the editor can open it, and nothing about the
 * delivered video changes.
 */
export function cinematicPlanningEnabled(): boolean {
  return cinematicRouteEnabled();
}

/**
 * Should the cinematic timeline PRODUCE the delivered video?
 *
 * A second, narrower switch, and it is deliberately not the same one. §19 asks for the old compose
 * path to survive only as an explicit, measurable, logged, feature-flagged fallback — and the
 * honest reading of "measurable" is that somebody has measured it. Until a real render has been
 * compared against the old path, this stays off, and a deployment turns it on when it has that
 * comparison.
 *
 * §20's `RENDER_FALLBACK_USED` line is emitted by `formatRenderRoute` below whenever this is off or
 * the plan could not be built, so a render that took the old path always says so.
 */
export function cinematicRenderPathEnabled(): boolean {
  return process.env.CINEMATIC_RENDER_PATH === "true";
}

/**
 * How long a render may wait for its own cinematic pass before the watchdog is allowed back in.
 *
 * The pipeline renders the timeline in-process now, and `timelineRenderer` spawns ffmpeg through
 * its own exec — the render watchdog never sees those children, so for the length of that render
 * the pipeline looks idle. The pipeline pings the watchdog while it waits, and this is the bound on
 * how long it may keep doing that: past it the pings stop and a genuinely stuck render is caught by
 * the same mechanism that catches every other one.
 *
 * Twenty minutes by default. Not a timeout on the render (its ffmpeg children are not the
 * pipeline's to kill) — a bound on how long the pipeline vouches for it.
 */
export function inProcessCinematicRenderBudgetMs(): number {
  const raw = parseInt(process.env.CINEMATIC_INPROCESS_RENDER_BUDGET_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 60 * 60_000);
  return 20 * 60_000;
}

/* ═══════════════════════ what a planning attempt reports ═══════════════════════ */

export const CINEMATIC_PLAN_ERROR = {
  ROUTE_DISABLED: "CINEMATIC_ROUTE_DISABLED",
  NO_PLANNABLE_BEATS: "CINEMATIC_NO_PLANNABLE_BEATS",
  TIMELINE_INVALID: "CINEMATIC_TIMELINE_INVALID",
  PERSIST_FAILED: "CINEMATIC_PERSIST_FAILED",
  PLANNER_THREW: "CINEMATIC_PLANNER_THREW",
} as const;

export type CinematicPlanErrorCode =
  (typeof CINEMATIC_PLAN_ERROR)[keyof typeof CINEMATIC_PLAN_ERROR];

export type CinematicPlanOutcome =
  | {
      ok: true;
      timeline: ProjectTimeline;
      timelineVersion: number;
      /** Everything a planner asked for that could not be carried, with its own reason. */
      unsupported: string[];
      /** Beats and scenes that are not in the plan, with the reason each one is out. */
      dropped: string[];
      /** RONDE 157B — editorial findings. Advisory: nothing was changed because of them. */
      quality: QualityFinding[];
      /** Lines for the render log, already formatted. */
      log: string[];
    }
  | {
      ok: false;
      code: CinematicPlanErrorCode;
      reason: string;
      log: string[];
    };

export type CinematicPlanParams = {
  videoId: number;
  scenes: SceneFacts[];
  extractors?: EntityExtractors;
  sceneOffsetsSec?: number[];
  /** The persisted narration. RONDE 146 stores it; this never regenerates it. */
  voice?: { url: string; durationSec: number } | null;
  /** The measured TTS word boundaries, so captions land where the words are. §12. */
  words?: TtsWordTiming[];
  format?: ProjectTimeline["format"];
  /** Injected so a test can run the whole route without a database. */
  persist: (params: {
    id: number;
    timeline: unknown;
    expectedVersion: number;
    nextVersion: number;
  }) => Promise<{ saved: boolean }>;
  /** What the row already holds, so the version this plan is stored at is the next one. */
  storedVersion?: number;
  /**
   * The Documentary Planning Engine's emotional curve, when this render built one.
   *
   * Only used to spot the score. Passed rather than re-derived because the engine has already read
   * the whole script to produce it, and a second reading here would be a second opinion about the
   * same film — the thing this codebase has spent rounds removing.
   */
  emotionalCurve?: readonly CurvePoint[];
};

/**
 * Plan one video the cinematic way, validate the plan, and store it.
 *
 * ── §5: a blocking validation issue means NO timeline is stored ─────────────────────────────
 *
 * Not "stored with a warning". A timeline that fails validation is one the renderer would either
 * refuse or render wrongly, and storing it would put that failure in front of a person the next
 * time they opened the editor. The reason is returned and logged instead.
 *
 * `video_gap` and the rest of `NON_BLOCKING_ISSUES` stay non-blocking, per the existing policy this
 * round is explicitly told not to change.
 */
export async function planAndStoreCinematicTimeline(
  params: CinematicPlanParams
): Promise<CinematicPlanOutcome> {
  const log: string[] = [];

  if (!cinematicPlanningEnabled()) {
    return {
      ok: false,
      code: CINEMATIC_PLAN_ERROR.ROUTE_DISABLED,
      reason: "CINEMATIC_EDITING_ENGINE is not enabled for this deployment",
      log,
    };
  }

  let built;
  let result;
  try {
    built = buildCinematicSceneInputs({
      scenes: params.scenes,
      extractors: params.extractors,
      sceneOffsetsSec: params.sceneOffsetsSec,
    });
    log.push(formatCinematicInputs(built));
    /**
     * §2 — every dropped beat is named, one line each. This is the report that makes the
     * difference between "the edit is shorter than the script" and a silence.
     */
    for (const reason of built.dropped) log.push(`[CinematicPipeline] dropped ${reason}`);

    if (built.scenes.length === 0) {
      /**
       * RENDER 562 — say which of the two things happened, because they have different causes.
       *
       * This reason was a single sentence: "no scene had a beat with both a voice window and a
       * rehydratable clip". On 562 it was printed for a render whose adapter had been handed
       * `beats=0` — no beat was examined at all, so nothing failed that test — and it sent the
       * investigation after voice windows and lineage records for a bug that was neither.
       *
       * `stats.beats` counts beats HANDED OVER, before any check runs. Zero means the caller
       * passed none; non-zero means they were examined and refused, and only then does the
       * per-beat sentence describe what happened.
       */
      const reason =
        built.stats.beats === 0
          ? `no beats reached the planner (scenes=${params.scenes.length}, beats=0): the caller ` +
            "passed no beats to plan, so no beat was examined"
          : `no beat had both a voice window and a rehydratable clip ` +
            `(beats=${built.stats.beats}): ${built.dropped.slice(0, 3).join("; ")}`;
      return { ok: false, code: CINEMATIC_PLAN_ERROR.NO_PLANNABLE_BEATS, reason, log };
    }

    result = runCinematicPipeline({
      videoId: params.videoId,
      scenes: built.scenes,
      voice: params.voice ?? null,
      words: params.words,
      format: params.format,
      /**
       * The film's emotional shape, so the score follows the story rather than the clock.
       *
       * Absent is fine and is not the same as flat: `planMusicCues` gives an unmeasured film a
       * neutral cue sheet with a real opening and close, because those exist whether or not
       * anything measured the intensity between them.
       */
      emotionalCurve: params.emotionalCurve,
    });
  } catch (err) {
    /**
     * A planner that throws must not take the render with it. The old path has already produced a
     * video by the time this runs; losing it because a caption planner hit an edge case would be
     * the worst possible trade. Reported, never silent.
     */
    return {
      ok: false,
      code: CINEMATIC_PLAN_ERROR.PLANNER_THREW,
      reason: (err as Error).message.slice(0, 400),
      log,
    };
  }

  log.push(formatCinematicPlan(result));
  /**
   * RONDE 178 — the graphics line, so a plan/render mismatch is visible per render.
   *
   * `formatCinematicPlan` prints one `unsupported=N` covering effects, transitions, caption
   * positions and graphics together, which cannot tell anyone that all N were graphics, or which
   * ones, or why. This names each skipped graphic with the planner's own reason, and carries the
   * render's correlation id so it joins the rest of that render's log.
   */
  log.push(formatCinematicGraphics(result));
  /**
   * RONDE 189 — the audio verdict, including the one thing this build cannot do.
   *
   * `formatCinematicAudio` was written in R166 and had no caller, so `musicSourceUnavailable` — the
   * honest statement that this build has no music catalogue and lays down no music — appeared in no
   * render log. A silent MUSIC track and a deliberately empty one look identical to a reader, and
   * §1 is explicit that the difference must be stated rather than guessed at.
   */
  log.push(formatCinematicAudio(result.audio));
  for (const missing of result.audio.unavailable) {
    log.push(`[Audio] unavailable ${missing}`);
  }
  log.push(`[Audio] music ${result.audio.music.reason}`);
  /**
   * The cue sheet, always — scored or not.
   *
   * `[Audio] music …` says why there is no catalogue. This says what a catalogue WOULD have been
   * asked for: an intro over the opening, a build through the third act, deliberate silence under
   * the quietest passage. That turns "this build has no music" from a dead end into a
   * specification, and a deployment that registers a catalogue can see immediately whether it
   * covered the film. See `musicDirector.ts`.
   */
  for (const line of formatCueSheet(result.cueSheet)) log.push(line);
  /**
   * §9 — one line per sound effect the beat asked for, found or not.
   *
   * Built from the FINISHED timeline plus the planner's own refusals, so a FOUND line names a
   * recording that is really on the document and a NOT_AVAILABLE line names a sound the render
   * deliberately did not approximate. The Freesound id is a public asset identity, not a secret.
   */
  for (const line of formatSfxPlan(result.timeline, result.unsupported)) log.push(line);
  for (const line of result.unsupported) log.push(`[EDL] unsupported ${line}`);
  /**
   * Every hold, in the render log where a reader will actually meet it.
   *
   * A hold means a beat had no usable picture and the neighbouring shot was stretched over it.
   * Left unreported it looks like an editorial choice — a slightly slower cut — instead of the
   * sourcing failure it is. See `holdPictureUnderVoice`.
   */
  for (const line of result.covered) log.push(`[EDL] HELD ${line}`);

  /**
   * The losslessness check on the REAL edit, not only in a test. A decision that failed to cross
   * from the EDL into the timeline is named here, on the video where it happened.
   */
  for (const lost of lostEditorialIntent(result.edl, result.timeline)) {
    log.push(`[EDL] LOST ${lost}`);
  }

  /**
   * RONDE 157B — the editorial rules, reported before the technical ones.
   *
   * These never block and never repair: §157B puts them in planning so a planner can act on them
   * and a human can overrule them. A renderer that silently dropped the fourth Ken Burns move would
   * produce a video better than its plan and a plan that no longer describes the video.
   */
  const quality = judgeTimeline(result.timeline);
  log.push(...formatQualityFindings(quality));
  log.push(formatQualitySummary(quality));

  const validation = validateTimeline(result.timeline);
  const blocking = validation.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
  for (const issue of validation.issues) {
    log.push(
      `[Validator] ${NON_BLOCKING_ISSUES.has(issue.code) ? "advisory" : "BLOCKING"} ` +
        formatTimelineIssue(issue)
    );
  }
  if (blocking.length > 0) {
    return {
      ok: false,
      code: CINEMATIC_PLAN_ERROR.TIMELINE_INVALID,
      reason: `${blocking.length} blocking issue(s): ${blocking.map((i) => i.code).join(", ")}`,
      log,
    };
  }

  /**
   * The version this plan is stored at.
   *
   * `expectedVersion` is what the row holds now, so the conditional UPDATE in `saveVideoTimeline`
   * still does its job: if a person saved an edit between the render starting and finishing, this
   * write loses and says so rather than overwriting their work with a freshly generated plan.
   */
  const expectedVersion = params.storedVersion ?? 0;
  const nextVersion = expectedVersion + 1;
  const stored = { ...result.timeline, version: nextVersion };

  const { saved } = await params.persist({
    id: params.videoId,
    timeline: stored,
    expectedVersion,
    nextVersion,
  });
  if (!saved) {
    return {
      ok: false,
      code: CINEMATIC_PLAN_ERROR.PERSIST_FAILED,
      reason:
        `the video's timeline moved from version ${expectedVersion} while this render was ` +
        "planning — the stored edit was left alone",
      log,
    };
  }

  log.push(
    `[Timeline] stored video=${params.videoId} version=${nextVersion} ` +
      `schema=${stored.schemaVersion ?? 1} durationSec=${stored.durationSec.toFixed(2)}`
  );

  return {
    ok: true,
    timeline: stored,
    timelineVersion: nextVersion,
    unsupported: result.unsupported,
    dropped: built.dropped,
    quality,
    log,
  };
}

/* ═══════════════════════ §9 — what the SFX track actually holds ═══════════════════════ */

/**
 * One `[SFX]` line per planned sound: the ones that reached the timeline, and the ones that had no
 * recording behind them.
 *
 * ── Why it reads the timeline rather than the plan ──────────────────────────────────────────
 *
 * The plan is what was asked for; the timeline is what will play. Reporting from the plan would let
 * a render claim a sound that was dropped in translation — the exact class of thing the SFX seam
 * itself turned out to be. A FOUND line therefore names a clip that is on the document, with the
 * catalogue identity it will be fetched by.
 */
export function formatSfxPlan(
  timeline: ProjectTimeline,
  unsupported: readonly string[]
): string[] {
  const track = timeline.tracks.find((t) => t.kind === "SFX");
  const clips = track?.kind === "SFX" ? track.clips : [];
  const lines = clips.map((c) => {
    /** Element ids are built as `sfx_<beatId>_<soundType>_<time>`; the beat is what a reader needs. */
    const parts = c.id.split("_");
    const beat = parts[1] ?? "?";
    const type = parts.slice(2, -1).join("_") || "?";
    return (
      `[SFX] beat=${beat} type=${type} status=FOUND ` +
      `source=${c.source.provider ?? "?"}:${c.source.providerAssetId ?? "?"} ` +
      `start=${c.start.toFixed(2)} dur=${(c.end - c.start).toFixed(2)} gain=${c.gain.toFixed(2)}`
    );
  });
  /** The planner's refusals, which `edlToTimeline` records with the SFX_NOT_AVAILABLE marker. */
  for (const reason of unsupported) {
    if (!reason.includes("SFX_NOT_AVAILABLE")) continue;
    lines.push(`[SFX] status=NOT_AVAILABLE ${reason}`);
  }
  if (lines.length === 0) lines.push("[SFX] none planned for this video");
  return lines;
}

/* ═══════════════════════ §20/§25 — which route produced the video ═══════════════════════ */

export type RenderRoute = "cinematic_timeline" | "legacy_compose";

/**
 * Which route delivered this video, and why — one line, always emitted.
 *
 * §20 forbids a silent fallback. The word `RENDER_FALLBACK_USED` is in the line whenever the old
 * compose path produced the file, so a deployment can grep for it and count exactly how many of
 * its renders still take the legacy route. A migration nobody can measure is a migration that
 * never finishes.
 */
export function formatRenderRoute(params: {
  videoId: number;
  route: RenderRoute;
  planOk: boolean;
  reason?: string;
}): string {
  if (params.route === "cinematic_timeline") {
    return `[RenderJob] video=${params.videoId} route=cinematic_timeline`;
  }
  const why = params.planOk
    ? "CINEMATIC_RENDER_PATH is not enabled"
    : `the cinematic plan was not usable: ${params.reason ?? "unknown"}`;
  return `[RenderJob] video=${params.videoId} route=legacy_compose RENDER_FALLBACK_USED reason=${why}`;
}

/**
 * FINAL VALIDATION §14 — the route and the flags that chose it, at the TOP of every render.
 *
 * ── Why a second route line ─────────────────────────────────────────────────────────────────
 *
 * `formatRenderRoute` above reports the outcome, and it is emitted only inside the
 * `cinematicPlanningEnabled()` branch. So a deployment with the engine switched off — which is what
 * the first real production render was — produces NO route line at all, and the only way to learn
 * which route ran is to notice the absence of `[Graphics]`, `[Captions]` and `[EDL]` lines and
 * infer it. Reading a log by what is missing from it is exactly the guesswork §14 removes.
 *
 * This line is unconditional, it is printed before any work happens, and it names the flag behind
 * every field. A render that takes the legacy route now SAYS so, on line one, with the reason.
 *
 * Each value is read from the real predicate rather than from `process.env` here, so the line
 * cannot drift away from the behaviour it claims to describe.
 */
export function formatProductionRoute(videoId: number): string {
  const planning = cinematicPlanningEnabled();
  const renderPath = cinematicRenderPathEnabled();
  /**
   * The route this render will take if planning succeeds. Both flags are needed: planning alone
   * stores a timeline the editor can open, but the delivered MP4 still comes from compose.
   */
  const route = planning && renderPath ? "cinematic_timeline" : "legacy_compose";
  const why =
    route === "cinematic_timeline"
      ? ""
      : ` reason=${!planning ? "CINEMATIC_EDITING_ENGINE is not enabled" : "CINEMATIC_RENDER_PATH is not enabled"}`;
  const on = (b: boolean) => (b ? "on" : "off");
  /**
   * WHICH SWITCH DECIDED THE RANKING.
   *
   * `POOL_RANKING_V2` is unset on a normal deployment, and then it follows
   * `CINEMATIC_EDITING_ENGINE` — so turning the cinematic engine off also changes which asset every
   * beat picks, and nothing about that variable's name says so. `POOL_RANKING_V2=on` alone cannot
   * tell an operator whether someone asked for this ranking or whether the render inherited it,
   * and those call for different actions when a film's footage choices look wrong.
   */
  const ranking = describePoolRankingV2();
  return (
    `[ProductionRoute] video=${videoId} route=${route}${why}` +
    ` CINEMATIC_EDITING_ENGINE=${on(planning)} CINEMATIC_RENDER_PATH=${on(renderPath)}` +
    ` POOL_RANKING_V2=${on(ranking.on)}(${ranking.decidedBy}) scenePool=${on(sceneCandidatePoolEnabled())}` +
    ` ${formatYoutubeReadiness()} aiDirector=${on(aiDirectorEnabled())}` +
    ` searchGateStrict=${on(searchGateStrict())}`
  );
}

/* ═══════════════════════ R159 §24 — the cutover ═══════════════════════ */

export type CutoverOutcome =
  | { ok: true; renderJobId: number; timelineVersion: number; log: string[] }
  | { ok: false; reason: string; log: string[] };

/**
 * Turn a stored cinematic plan into a queued render job.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────────────────────
 *
 * It does not render. The render job worker already knows how to rehydrate, validate, drive
 * ffmpeg, ask Remotion for a graphics overlay, composite, probe and upload — and it is the SAME
 * worker that renders a video a person edited by hand. §26's "één timeline, dezelfde renderer" is
 * kept by not building a second path here: this function's whole job is to put a row in the queue.
 *
 * ── Why a new attempt number ────────────────────────────────────────────────────────────────
 *
 * `claimVideoRenderAttempt` fences the output. A late render can then be recognised as superseded
 * rather than overwriting a newer one — the same mechanism an editor-triggered render uses, for the
 * same reason. Taking a shortcut here would leave the cinematic route as the one path where two
 * renders can race.
 */
export async function enqueueCinematicRender(params: {
  videoId: number;
  timelineVersion: number;
  requestedByUserId?: number | null;
  claimAttempt: (videoId: number) => Promise<number | null>;
  createJob: (p: {
    videoId: number;
    requestedByUserId?: number | null;
    timelineVersion: number;
    attempt: number;
  }) => Promise<{ id: number } | null>;
}): Promise<CutoverOutcome> {
  const log: string[] = [];

  if (!cinematicRenderPathEnabled()) {
    return {
      ok: false,
      reason: "CINEMATIC_RENDER_PATH is not enabled",
      log,
    };
  }

  const attempt = await params.claimAttempt(params.videoId);
  if (attempt == null) {
    return {
      ok: false,
      reason: "could not claim a render attempt for this video",
      log,
    };
  }

  const job = await params.createJob({
    videoId: params.videoId,
    requestedByUserId: params.requestedByUserId ?? null,
    timelineVersion: params.timelineVersion,
    attempt,
  });
  if (!job) {
    return { ok: false, reason: "the render job could not be created", log };
  }

  log.push(
    `[RenderJob] video=${params.videoId} job=${job.id} attempt=${attempt} ` +
      `timelineVersion=${params.timelineVersion} route=cinematic_timeline queued`
  );
  return { ok: true, renderJobId: job.id, timelineVersion: params.timelineVersion, log };
}
