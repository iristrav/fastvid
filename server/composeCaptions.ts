/**
 * RONDE 201 — THE SUBTITLE SWITCH THAT DID NOTHING.
 *
 * ── The defect, in two lines of the compose route ───────────────────────────────────────────
 *
 *     const subtitleDrawtext = enableSubtitles ? "" : "";
 *     const fadeFilter = documentaryStyleEnabled() ? colorGrade : `${colorGrade}${subtitleDrawtext}`;
 *
 * The first is a ternary whose branches are the same empty string: an operator switch, stored per
 * video in the database and offered in the UI, that cannot affect a single frame. The second is a
 * second defect hiding behind it — even if the first produced a filter, the documentary look drops
 * it on the floor. Two dead ends in adjacent lines, which is why neither was noticed: the feature
 * had no visible half to be missing.
 *
 * The render contract already states the consequence in as many words: "compose burns in no
 * captions at all. The only route that carries them is the cinematic one." So which of the two
 * delivery routes ran decided whether the viewer got subtitles — for a switch they had ticked
 * themselves.
 *
 * ── Why this is allowed, checked before writing a line of it ────────────────────────────────
 *
 * RONDE 113's policy is that the render burns no text into the picture, and it names the seven
 * engines it governs. It then exempts this one, deliberately and in writing: "Subtitles are also
 * not covered, deliberately. They are a per-video switch the operator ticks themselves
 * (`enableSubtitles`, default off), so silencing them here would override an explicit choice
 * rather than remove an unrequested one."
 *
 * So this is the one kind of text the pipeline is meant to draw, and it never drew it.
 *
 * ── What this module is, and what it deliberately is not ────────────────────────────────────
 *
 * A FORMATTER. It turns timings and words the render has already measured into a subtitle file.
 *
 *   · It decides no content. The words are the beat's own narration, unchanged.
 *   · It invents no timing. A beat whose voice window the TTS alignment never measured gets NO
 *     caption, and is counted as skipped. A subtitle that drifts against the voice is worse than
 *     no subtitle, and guessing from `holdSec` would drift on every scene where narration ran
 *     faster or slower than the plan — which RONDE 190 measured happening routinely.
 *   · It is not a second caption engine. The cinematic route builds its caption track from the
 *     same beats through the EDL; this builds a file from the same beats for the route that has
 *     no EDL. Two renderers, one source of truth about when a sentence is spoken.
 *   · It runs no ffmpeg and touches no filter graph. It returns text and a path; the caller
 *     splices the filter.
 */
import fs from "fs";
import path from "path";

/** One beat as this module needs it — the shape `SceneBeat` already has. */
export type CaptionBeat = {
  text: string;
  /** TTS-aligned window within the scene's voice track, in seconds. */
  voiceStartSec?: number;
  voiceEndSec?: number;
};

export type CaptionCue = {
  startSec: number;
  endSec: number;
  /** Already wrapped: at most two lines, in reading order. */
  lines: string[];
};

export type CaptionPlan = {
  cues: CaptionCue[];
  /** Beats that had no measured voice window. Reported, never guessed at. */
  skippedUnmeasured: number;
  /** Beats whose window fell entirely outside the scene's real length. */
  skippedOutOfRange: number;
};

/**
 * Broadcast practice, and the reason each number is what it is.
 *
 * Two lines is the ceiling every subtitle guideline agrees on — a third line covers picture the
 * viewer is meant to be watching. 42 characters is the BBC/Netflix line length; at the reading
 * speeds below it is comfortably readable on a phone.
 */
const MAX_LINES = 2;
const MAX_LINE_CHARS = 42;
/** Below this a caption flashes rather than reads. */
const MIN_CUE_SEC = 0.8;
/** Two cues closer than this read as one flicker; the earlier one is trimmed to make the gap. */
const MIN_GAP_SEC = 0.08;

/**
 * Wrap one sentence to at most two lines, breaking on whitespace.
 *
 * Returns null when the text cannot be fitted — the caller splits the beat instead of shipping a
 * clipped sentence. Never truncates: a subtitle that ends mid-word is a defect a viewer sees.
 */
export function wrapCaptionText(text: string): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    /** A single word longer than the line is placed alone; breaking words is worse than a long line. */
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_LINE_CHARS || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === MAX_LINES) return null;
  }
  if (current) lines.push(current);
  return lines.length <= MAX_LINES ? lines : null;
}

/**
 * Split one beat's words into as many parts as it takes to fit, and give each part a share of the
 * beat's own window proportional to its length.
 *
 * THE SPLIT DIVIDES THE WINDOW; IT NEVER WIDENS IT. Every part lands inside the time that sentence
 * is actually spoken, so no part of a caption appears before its words are said.
 *
 * A part can still come out too short to read — a three-word tail of a long sentence gets a small
 * share — and the readability pass in `planSceneCaptions` may then let that one LINGER into free
 * time after it. That is ordinary subtitling: a caption may stay up a moment after the voice
 * moves on, and it is bounded there by the next caption and by the end of the picture. What it
 * may never do is start early, overlap its neighbour, or run past the scene.
 */
function splitBeat(text: string, startSec: number, endSec: number): CaptionCue[] {
  const wrapped = wrapCaptionText(text);
  if (wrapped) return [{ startSec, endSec, lines: wrapped }];

  const words = text.trim().split(/\s+/).filter(Boolean);
  const perPart = MAX_LINES * MAX_LINE_CHARS;
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= perPart || !current) current = candidate;
    else {
      parts.push(current);
      current = word;
    }
  }
  if (current) parts.push(current);

  const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
  const span = Math.max(0, endSec - startSec);
  const cues: CaptionCue[] = [];
  let cursor = startSec;
  parts.forEach((part, i) => {
    const share = (part.length / totalChars) * span;
    const partEnd = i === parts.length - 1 ? endSec : cursor + share;
    const lines = wrapCaptionText(part);
    if (lines) cues.push({ startSec: cursor, endSec: partEnd, lines });
    cursor = partEnd;
  });
  return cues;
}

/**
 * The scene's captions, from its own beats and its own measured length.
 *
 * `sceneOutSec` is the length the scene will actually be cut to — the caller has probed it. A cue
 * that would run past the end is clamped; one that starts past the end is dropped and counted,
 * because a caption on picture nobody will see is not a caption.
 */
export function planSceneCaptions(
  beats: readonly CaptionBeat[],
  sceneOutSec: number
): CaptionPlan {
  const cues: CaptionCue[] = [];
  let skippedUnmeasured = 0;
  let skippedOutOfRange = 0;

  for (const beat of beats) {
    const text = (beat.text ?? "").trim();
    if (!text) continue;
    const start = beat.voiceStartSec;
    const end = beat.voiceEndSec;
    /**
     * No measured window, no caption. See the header: `holdSec` is a PLAN, and narration
     * routinely runs faster or slower than one, so a caption timed from it drifts against the
     * voice it is supposed to transcribe.
     */
    if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) {
      skippedUnmeasured += 1;
      continue;
    }
    if (start >= sceneOutSec) {
      skippedOutOfRange += 1;
      continue;
    }
    const clampedEnd = Math.min(end, sceneOutSec);
    if (clampedEnd - start <= 0) {
      skippedOutOfRange += 1;
      continue;
    }
    cues.push(...splitBeat(text, Math.max(0, start), clampedEnd));
  }

  cues.sort((a, b) => a.startSec - b.startSec);

  /** A cue too short to read is extended, never past the next one's start. */
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    const ceiling = next ? next.startSec - MIN_GAP_SEC : sceneOutSec;
    if (cue.endSec - cue.startSec < MIN_CUE_SEC) {
      cue.endSec = Math.min(Math.max(cue.endSec, cue.startSec + MIN_CUE_SEC), Math.max(ceiling, cue.startSec + 0.01));
    }
    /** And never overlaps its successor: two subtitles on screen at once is a fault. */
    if (next && cue.endSec > next.startSec - MIN_GAP_SEC) {
      cue.endSec = Math.max(cue.startSec + 0.01, next.startSec - MIN_GAP_SEC);
    }
  }

  return { cues, skippedUnmeasured, skippedOutOfRange };
}

/** `HH:MM:SS,mmm` — SubRip's own format, which libass reads without a conversion step. */
export function srtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const ms = Math.round(clamped * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

/** The cues as a SubRip document. Empty string when there is nothing to write. */
export function renderSrt(cues: readonly CaptionCue[]): string {
  if (cues.length === 0) return "";
  return (
    cues
      .map((cue, i) =>
        [
          String(i + 1),
          `${srtTimestamp(cue.startSec)} --> ${srtTimestamp(cue.endSec)}`,
          ...cue.lines,
        ].join("\n")
      )
      .join("\n\n") + "\n"
  );
}

/**
 * ffmpeg's filter syntax eats three characters inside a filter argument, and a Windows-shaped or
 * timestamped path contains two of them. Escaped here rather than at the call site so the one
 * place that builds the filter cannot forget.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * How the subtitles look. One place, so the compose route and any later caller agree.
 *
 * White on a semi-transparent box is the accessibility default: it survives a light frame, a dark
 * frame and a busy one, which a plain outline does not. `Alignment=2` is bottom-centre, and the
 * margin lifts it clear of a phone's home indicator.
 */
export function captionForceStyle(fontSizePx: number): string {
  return [
    "FontName=DejaVu Sans",
    `FontSize=${Math.round(fontSizePx)}`,
    "PrimaryColour=&H00FFFFFF",
    "BackColour=&H80000000",
    "BorderStyle=3",
    "Outline=0",
    "Shadow=0",
    "Alignment=2",
    "MarginV=48",
  ].join(",");
}

/**
 * Write the scene's subtitle file and return the ffmpeg filter fragment that burns it in.
 *
 * Returns null when there is nothing to burn — no cues, or the file could not be written. Null is
 * the honest answer and the caller adds no filter; it never returns a fragment for a file that is
 * not on disk, which would fail the whole scene's encode over a subtitle.
 */
export function writeSceneCaptionFilter(params: {
  beats: readonly CaptionBeat[];
  sceneOutSec: number;
  sceneIndex: number;
  workDir: string;
  /** Video height, so the type scales with the format instead of being tuned for one of them. */
  frameHeight: number;
}): { filter: string; filePath: string; plan: CaptionPlan } | null {
  const plan = planSceneCaptions(params.beats, params.sceneOutSec);
  if (plan.cues.length === 0) return null;

  const body = renderSrt(plan.cues);
  const filePath = path.join(params.workDir, `captions_s${params.sceneIndex}.srt`);
  try {
    fs.writeFileSync(filePath, body, "utf8");
  } catch {
    return null;
  }
  /** ~4.4% of the frame height: 48px on 1080p, which reads on a phone without covering the shot. */
  const fontSize = Math.max(16, Math.round(params.frameHeight * 0.044));
  const filter =
    `,subtitles='${escapeFilterPath(filePath)}':force_style='${captionForceStyle(fontSize)}'`;
  return { filter, filePath, plan };
}
