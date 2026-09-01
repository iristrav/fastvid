/**
 * RONDE 113 — one rule: the render burns no text into the picture.
 *
 * ── Why this is a policy and not a patch ─────────────────────────────────────────────────────
 *
 * Text was reported in a delivered video. It did not come from one place. Three separate engines
 * can burn characters into a frame, and two of them were ON by default:
 *
 *   · visualDirector          (VISUAL_DIRECTOR !== "false")  — person labels, stat highlights,
 *                                                              A-vs-B comparisons, bullet lists,
 *                                                              pull quotes, counters, map markers
 *   · cinematicEffectsEngine  (ENABLE_CINEMATIC_EFFECTS !== "false") — year badges (drawn even in
 *                                                              the restricted "years only" mode),
 *                                                              animated stat counters, section
 *                                                              headlines
 *   · editorialGraphicsEngine (EDITORIAL_GRAPHICS_ENGINE_ENABLED !== "false") — whole generated
 *                                                              cards adopted as beat footage
 *
 * and four more were off but one environment variable away from being on again (textOverlay,
 * screenLabels, facelessSubtitles, chapter cards, editorialOverlay, motion graphics).
 *
 * Switching seven flags would have fixed the video and left the next feature free to add an
 * eighth. So the rule lives here instead, every one of those gates asks it FIRST, and a call site
 * cannot route around it because the check is inside the feature's own `…Enabled()` function
 * rather than at the place that calls it.
 *
 * ── What this does NOT cover ─────────────────────────────────────────────────────────────────
 *
 * Text that was already in the footage before FastVid saw it — a news chyron, a watermark, an
 * intertitle in an archive reel. That is a sourcing question, not a compositing one, and the
 * pipeline already has an answer for it: archiveClipHasBakedEditText rejects those clips at
 * adoption time.
 *
 * Subtitles are also not covered, deliberately. They are a per-video switch the operator ticks
 * themselves (`enableSubtitles`, default off), so silencing them here would override an explicit
 * choice rather than remove an unrequested one.
 */

/**
 * May this render burn text into the picture?
 *
 * False, and off by an environment variable rather than a code change, so the decision is
 * reversible without a redeploy — and so that reversing it is a deliberate act with a name.
 */
export function burnedInTextAllowed(): boolean {
  return process.env.ALLOW_BURNED_IN_TEXT === "true";
}

/**
 * The engines this policy governs, and the flag each one already had.
 *
 * Written down because the list is the point: the failure was not that any single gate was wrong,
 * it was that nobody could see there were seven of them.
 */
export const BURNED_IN_TEXT_SOURCES: ReadonlyArray<{ engine: string; flag: string; wasDefaultOn: boolean }> = [
  { engine: "visualDirector", flag: "VISUAL_DIRECTOR", wasDefaultOn: true },
  { engine: "cinematicEffects overlays", flag: "ENABLE_CINEMATIC_EFFECTS", wasDefaultOn: true },
  { engine: "editorialGraphics", flag: "EDITORIAL_GRAPHICS_ENGINE_ENABLED", wasDefaultOn: true },
  { engine: "textOverlay", flag: "TEXT_OVERLAY", wasDefaultOn: false },
  { engine: "screenLabels", flag: "ENABLE_SCREEN_LABELS", wasDefaultOn: false },
  { engine: "facelessSubtitles", flag: "ENABLE_FACELESS_SUBTITLES", wasDefaultOn: false },
  { engine: "extraOnScreenText", flag: "ENABLE_EXTRA_ONSCREEN_TEXT", wasDefaultOn: false },
  { engine: "motionGraphics", flag: "ENABLE_MOTION_GRAPHICS", wasDefaultOn: false },
  { engine: "editorialOverlay", flag: "EDITORIAL_OVERLAY", wasDefaultOn: false },
  { engine: "chapterCards", flag: "ENABLE_CHAPTER_CARDS", wasDefaultOn: false },
];

/** One line for the pipeline report, so a render says out loud that it drew no text. */
export function describeOnScreenTextPolicy(): string {
  return burnedInTextAllowed()
    ? `[OnScreenText] burned-in text ALLOWED (ALLOW_BURNED_IN_TEXT=true) — ` +
        `${BURNED_IN_TEXT_SOURCES.length} text engines may draw`
    : `[OnScreenText] no burned-in text — all ${BURNED_IN_TEXT_SOURCES.length} text engines held off ` +
        `(labels, stat counters, year badges, headlines, quotes, bullet lists, chapter cards, graphics)`;
}
