/** Cinematic Editing Engine — Caption Planner (Phase 4).
 *
 *  Decides which on-screen text appears for a beat, when, where, how long, and how it
 *  animates — extending textOverlay/planner.ts's TextOverlay vocabulary (which already makes
 *  exactly these when/where/how-long/how-animated decisions for a narrower type list:
 *  headline/label/quote/year/location/person) to the full Phase 4 text-instruction list
 *  (titles, subtitles, lower thirds, dates, locations, statistics, quotes, names, callouts,
 *  timeline labels, chapter titles, animated text). Not a rewrite of that module — this
 *  planner reads the same kinds of upstream signals (Scene's statCallout/highlightWords/
 *  chapterTitle, VisualIntent's location/time/people/events) and reuses its animation
 *  vocabulary (typewriter/fade/slide/scale/blur) so a future renderer can point both at the
 *  same drawtext/PNG-overlay machinery (textOverlay/renderer.ts) without a second one.
 *
 *  Distinguishing "name"/"lower_third" (this module) from visualDirector's richer
 *  "person_label" motion-graphic card (name + title/role, pulsing/animated): this module's
 *  `name` caption is a plain identifying text overlay; MotionGraphicsPlanner (this same
 *  directory) owns the richer animated card. Two different presentations of "who is this,"
 *  not a duplicate decision.
 *
 *  Multiple captions can be active for the same beat (e.g. a location tag and a date both
 *  visible) — unlike the other planners, this one returns an array, one entry per applicable
 *  text instruction, or an empty array when nothing about the beat calls for on-screen text.
 */
import { statSpokenInBeat } from "./motionGraphicsPlanner";
import type { Scene } from "../pipeline/types";
import type { VisualIntent } from "../visualMatchingV2/types";
import type { CaptionInstruction, VisualContinuityState } from "./types";
import type { TtsWordTiming } from "../voiceTtsAlignment";

const YEAR_RE = /\b(1[0-9]{3}|20[0-9]{2})\b/;
const QUOTE_RE = /["“”](.+?)["“”]/;

/** Phase 9: the shortest a single kinetic-typography word can stay on screen and still be
 *  legible. Without a floor, `beatVoiceDurationSec / words.length` degrades silently as beats
 *  get shorter or the highlight-word list gets longer — a 1.2s beat with 4 words would flash
 *  each one for 0.3s, unreadable. 0.35s is the same order of magnitude as the shortest
 *  hard-coded caption hold elsewhere in this planner (`shortDur`'s 1.5s floor for a whole
 *  phrase, scaled down for a single word). */
const MIN_WORD_DISPLAY_SEC = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type CaptionPlannerOptions = {
  scene?: Scene;
  isFirstBeatOfScene?: boolean;
  continuity?: VisualContinuityState;
  /** Off by default — full-narration subtitles are typically an existing, separately-toggled
   *  accessibility feature (renderComposer's own subtitle flag), not an editorial decision
   *  this planner should duplicate. Set true only when a caller specifically wants the EDL to
   *  carry its own subtitle instruction instead of relying on that existing toggle. */
  includeSubtitle?: boolean;
  /** This beat's word-level timing from the voice, when there is any; same clock as the beat. */
  wordTimings?: TtsWordTiming[];
};

/** A subtitle line holds this many characters; a subtitle shows at most two lines at once. */
export const SUBTITLE_CHARS_PER_LINE = 42;
const SUBTITLE_MAX_LINES = 2;
/** A chunk that has reached this share of its room may end at a comma or a full stop. */
const SUBTITLE_PAUSE_BREAK_CHARS = 18;

/** How many lines this text takes when wrapped at `SUBTITLE_CHARS_PER_LINE`. */
function subtitleLines(words: readonly string[]): number {
  let lines = 1;
  let used = 0;
  for (const w of words) {
    const add = used === 0 ? w.length : w.length + 1;
    if (used + add > SUBTITLE_CHARS_PER_LINE && used > 0) {
      lines++;
      used = w.length;
    } else used += add;
  }
  return lines;
}

/**
 * Video 614 — a subtitle is read in pieces, in time with the voice.
 *
 * The whole beat used to be one caption for the whole beat: a 25-word sentence became a block of
 * three or four lines standing at the bottom of the frame for six seconds, ahead of the voice and
 * then behind it. Now the sentence is cut into pieces of at most two lines, ending at a comma or a
 * full stop where one falls, and each piece is on screen while it is being spoken: read off the
 * voice's own word timing when every word has one, otherwise shared out by character count. The
 * pieces follow each other without a gap, and the last one ends with the beat.
 */
export function planSubtitleChunks(
  text: string,
  beatStartSec: number,
  beatDurationSec: number,
  wordTimings?: readonly TtsWordTiming[]
): Array<{ text: string; startSec: number; endSec: number }> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !(beatDurationSec > 0)) return [];
  const groups: number[][] = [];
  let current: number[] = [];
  const chars = (idx: number[]) => idx.reduce((n, i) => n + words[i]!.length, 0) + Math.max(0, idx.length - 1);
  words.forEach((_, i) => {
    const next = [...current, i];
    if (current.length > 0 && subtitleLines(next.map((j) => words[j]!)) > SUBTITLE_MAX_LINES) {
      groups.push(current);
      current = [i];
    } else current = next;
    if (/[.,;:!?…]["”’)]*$/.test(words[i]!) && chars(current) >= SUBTITLE_PAUSE_BREAK_CHARS && i < words.length - 1) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);

  const endSec = beatStartSec + beatDurationSec;
  const timed = wordTimings && wordTimings.length === words.length;
  const totalChars = chars(words.map((_, i) => i));
  let charsBefore = 0;
  const starts = groups.map((g) => {
    const at = timed
      ? wordTimings![g[0]!]!.startSec
      : beatStartSec + (beatDurationSec * charsBefore) / Math.max(1, totalChars);
    charsBefore += chars(g) + 1;
    return Math.min(Math.max(at, beatStartSec), endSec);
  });
  starts[0] = beatStartSec;
  return groups
    .map((g, k) => ({
      text: g.map((i) => words[i]!).join(" "),
      startSec: starts[k]!,
      endSec: k + 1 < groups.length ? starts[k + 1]! : endSec,
    }))
    .filter((c) => c.endSec > c.startSec);
}

/**
 * Builds every caption instruction that applies to this beat. Order in the returned array is
 * not meaningful — each instruction carries its own startSec/endSec/position, so multiple can
 * legitimately overlap in time as long as they don't collide in position (a future renderer's
 * concern, same as textOverlay/planner.ts's existing noOverlap handling).
 */
export function planCaptions(
  intent: VisualIntent,
  beatVoiceStartSec: number,
  beatVoiceDurationSec: number,
  options: CaptionPlannerOptions = {}
): CaptionInstruction[] {
  const { scene, isFirstBeatOfScene = false, continuity, includeSubtitle = false } = options;
  const out: CaptionInstruction[] = [];
  const shortDur = clamp(beatVoiceDurationSec, 1.5, 3);

  if (isFirstBeatOfScene && scene?.isChapterCard && scene.chapterTitle) {
    out.push({
      captionType: "chapter_title",
      text: scene.chapterTitle,
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + clamp(beatVoiceDurationSec, 2, 3.5),
      animation: "fade",
      position: "center",
      reason: `Scene is marked as a chapter card with title "${scene.chapterTitle}".`,
    });
  } else if (isFirstBeatOfScene && scene?.sectionTitle) {
    out.push({
      captionType: "title",
      text: scene.sectionTitle,
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + clamp(beatVoiceDurationSec, 1.5, 3),
      animation: "fade",
      position: "top",
      reason: `Scene carries a section title ("${scene.sectionTitle}") to introduce — shown once, at the start of the scene.`,
    });
  }

  const yearMatch = intent.visualTime.match(YEAR_RE);
  if (yearMatch) {
    if (intent.historicalContext.trim() && intent.events.length > 0) {
      out.push({
        captionType: "timeline_label",
        text: yearMatch[0],
        subtitle: intent.events[0],
        startSec: beatVoiceStartSec,
        endSec: beatVoiceStartSec + shortDur,
        animation: "slide",
        position: "bottom",
        reason: `Beat marks a dated historical event ("${intent.events[0]}", ${yearMatch[0]}) — a timeline label anchors it chronologically.`,
      });
    } else {
      out.push({
        captionType: "date",
        text: yearMatch[0],
        startSec: beatVoiceStartSec,
        endSec: beatVoiceStartSec + shortDur,
        animation: "fade",
        position: "bottom-left",
        reason: `Beat's visual time ("${intent.visualTime}") names a specific year — shown as a date card.`,
      });
    }
  }

  if (intent.visualLocation.trim()) {
    out.push({
      captionType: "location",
      text: intent.visualLocation,
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + shortDur,
      animation: "slide",
      position: "bottom-left",
      reason: `Beat's visual location ("${intent.visualLocation}") is shown as a location tag.`,
    });
  }

  /** OCTOBER 2026 — only under the sentence that says the figure (see statSpokenInBeat). */
  if (scene?.statCallout && statSpokenInBeat(scene.statCallout, intent.spokenText)) {
    out.push({
      captionType: "statistic",
      text: scene.statCallout,
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + clamp(beatVoiceDurationSec, 2, 3.5),
      animation: "scale",
      position: "bottom-right",
      reason: `Scene carries a stat callout ("${scene.statCallout}") — emphasized as an animated statistic.`,
    });
  }

  const quoteMatch = intent.spokenText.match(QUOTE_RE);
  if (quoteMatch) {
    out.push({
      captionType: "quote",
      text: quoteMatch[1]!.trim(),
      subtitle: intent.people[0],
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + beatVoiceDurationSec,
      animation: "typewriter",
      position: "center",
      reason: intent.people[0]
        ? `Beat contains a direct quote, attributed to ${intent.people[0]}.`
        : "Beat contains a direct quote in the narration.",
    });
  }

  if (intent.people.length > 0) {
    const person = intent.people[0]!;
    const alreadyNamed = continuity?.establishedSubjects.some((s) => s.toLowerCase() === person.toLowerCase());
    if (!alreadyNamed) {
      out.push({
        captionType: "name",
        text: person,
        startSec: beatVoiceStartSec,
        endSec: beatVoiceStartSec + shortDur,
        animation: "slide",
        position: "lower-third",
        reason: `First time "${person}" appears in this scene — a name caption identifies them.`,
      });
    }
  }

  if (intent.events.length > 0 && !yearMatch) {
    out.push({
      captionType: "callout",
      text: intent.events[0]!,
      startSec: beatVoiceStartSec,
      endSec: beatVoiceStartSec + shortDur,
      animation: "fade",
      position: "bottom-right",
      reason: `Beat references a named event ("${intent.events[0]}") without an accompanying date — called out as a label.`,
    });
  }

  if (scene?.highlightWords && scene.highlightWords.length > 0) {
    const words = scene.highlightWords;
    // Floored per Phase 9 (see MIN_WORD_DISPLAY_SEC) — a short beat with several highlight
    // words would otherwise flash each one faster than a viewer can read it. When the floor
    // pushes total display time past the beat's own duration, the last word's caption simply
    // outlives the beat slightly rather than being illegible — a deliberate trade-off.
    const perWord = Math.max(MIN_WORD_DISPLAY_SEC, beatVoiceDurationSec / words.length);
    words.forEach((word, i) => {
      out.push({
        captionType: "animated_text",
        text: word,
        startSec: beatVoiceStartSec + i * perWord,
        endSec: beatVoiceStartSec + (i + 1) * perWord,
        animation: "typewriter",
        position: "center",
        reason: `Scene's kinetic-typography word list includes "${word}" — animated in sync with the narration.`,
      });
    });
  }

  if (includeSubtitle && intent.spokenText.trim()) {
    for (const chunk of planSubtitleChunks(intent.spokenText, beatVoiceStartSec, beatVoiceDurationSec, options.wordTimings)) {
      out.push({
        captionType: "subtitle",
        text: chunk.text,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        animation: "none",
        position: "bottom",
        reason: "Caller opted into EDL-driven subtitles for this beat.",
      });
    }
  }

  return out;
}
