/**
 * VIDEO 650 — SENTENCE WINDOWS MEASURED FROM THE SCENE'S OWN AUDIO, when the voice has no word timing.
 *
 * ── The gap ────────────────────────────────────────────────────────────────────────────────────
 *
 * The TTS word alignment (ElevenLabs) gives every sentence a spoken window, and the coverage check
 * proves a film sentence by sentence against those windows. The voice FALLBACKS (Fish Audio, Google)
 * return audio and no timestamps, so their sentences were laid out from the planner's holds and
 * recorded as `estimated` — and an estimated window is not proof: the delivery gate refuses the film
 * as SENTENCE_COVERAGE_UNPROVEN. A fallback voice therefore could not deliver at all.
 *
 * ── What this measures, and what it never invents ──────────────────────────────────────────────
 *
 * The scene's audio file is real and its length is measured. Between spoken sentences a narrator
 * pauses, and `silencedetect` finds those pauses in the waveform. For N sentences this takes the
 * N−1 longest pauses strictly inside the file, cuts each at its midpoint, and the sentence windows
 * are what lies between the cuts — every boundary is a measured pause, the first window starts
 * where the file starts and the last ends where it ends. Nothing is interpolated from character
 * counts; character counts are used only to REFUSE a measurement that cannot be right (a window far
 * too short or too long for its words), in which case the scene stays `estimated` and the gate
 * refuses it exactly as before. A scene with ONE sentence needs no pause: its window is the file.
 *
 * The timeline records the basis as `measured_silence`, apart from the alignment's `measured`, so a
 * report can always say which measurement a film's coverage rests on.
 */
import { execFile } from "child_process";

export type SilenceSpan = { startSec: number; endSec: number };

export type SentenceWindow = { startSec: number; endSec: number };

/** One boundary: the cut (the pause's midpoint) and the pause it lies in — the true boundary is somewhere inside that pause. */
export type SentenceBoundary = { cutSec: number; pauseSec: number };

export type SilenceTimingResult =
  | {
      ok: true;
      windows: SentenceWindow[];
      pausesFound: number;
      pausesUsed: number;
      boundaries: SentenceBoundary[];
      /** Shortest chosen pause ÷ longest pause NOT chosen; Infinity when every inner pause was used. Always ≥ AMBIGUOUS_PAUSE_MARGIN on an ok result. */
      marginRatio: number;
    }
  | { ok: false; reason: string; pausesFound: number };

export const SILENCE_NOISE_DB = -35;
export const SILENCE_MIN_SEC = 0.22;
/** A spoken sentence is never shorter than this; a window below it is a wrong cut, not a sentence. */
export const MIN_SENTENCE_WINDOW_SEC = 0.4;
/** Seconds per character may differ between sentences by at most this factor from the median. */
export const SENTENCE_RATE_TOLERANCE = 3;
/**
 * PRE-DEPLOY CHECK — the shortest chosen pause must be this many times the longest inner pause NOT
 * chosen, or the measurement is REFUSED. Measured on synthesised narration with known boundaries
 * (video650VoiceTimingFixtures.test.ts): a comma pause longer than the sentence pauses puts two cuts
 * inside one sentence, the text sanity check does not catch it (the rates stay within a factor 3),
 * and the only sign is this margin at 1.0. Below the margin the scene stays `estimated`.
 */
export const AMBIGUOUS_PAUSE_MARGIN = 1.25;

/** `silence_start: 1.23` / `silence_end: 1.80` lines, paired in order; an open silence runs to `totalSec`. */
export function parseSilences(stderr: string, totalSec: number): SilenceSpan[] {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/gi)].map((m) => parseFloat(m[1]!));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/gi)].map((m) => parseFloat(m[1]!));
  const out: SilenceSpan[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = Math.max(0, starts[i]!);
    const e = i < ends.length ? ends[i]! : totalSec;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ startSec: s, endSec: e });
  }
  return out;
}

/**
 * The windows, or the reason there are none. Pure: the audio's measured length and its measured
 * pauses in, sentence windows out.
 */
export function sentenceWindowsFromSilences(
  sentences: ReadonlyArray<{ text: string }>,
  silences: readonly SilenceSpan[],
  totalSec: number
): SilenceTimingResult {
  const n = sentences.length;
  if (!(totalSec > 0)) return { ok: false, reason: "the audio has no measured length", pausesFound: 0 };
  if (n === 0) return { ok: false, reason: "no sentences", pausesFound: 0 };
  /** leading and trailing silence are not pauses between sentences */
  const inner = silences.filter((s) => s.startSec > 0.15 && s.endSec < totalSec - 0.15);
  const speechStart = silences.find((s) => s.startSec <= 0.05)?.endSec ?? 0;
  const speechEnd = silences.find((s) => s.endSec >= totalSec - 0.05 && s.startSec > speechStart)?.startSec ?? totalSec;
  if (n === 1) {
    return {
      ok: true,
      windows: [{ startSec: r3(speechStart), endSec: r3(Math.max(speechStart + MIN_SENTENCE_WINDOW_SEC, speechEnd)) }],
      pausesFound: inner.length,
      pausesUsed: 0,
      boundaries: [],
      marginRatio: Infinity,
    };
  }
  if (inner.length < n - 1) {
    return { ok: false, reason: `${n} sentences need ${n - 1} pauses; ${inner.length} measured`, pausesFound: inner.length };
  }
  const byLength = [...inner].sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec));
  const chosen = byLength.slice(0, n - 1).sort((a, b) => a.startSec - b.startSec);
  const shortestChosen = Math.min(...chosen.map((s) => s.endSec - s.startSec));
  const longestUnchosen = byLength.length > n - 1 ? byLength[n - 1]!.endSec - byLength[n - 1]!.startSec : 0;
  const marginRatio = longestUnchosen > 0 ? shortestChosen / longestUnchosen : Infinity;
  if (marginRatio < AMBIGUOUS_PAUSE_MARGIN) {
    return {
      ok: false,
      reason:
        `the pauses do not tell the sentences apart: the shortest pause chosen as a boundary (${shortestChosen.toFixed(2)}s) is only ` +
        `${marginRatio.toFixed(2)}x the longest pause not chosen (${longestUnchosen.toFixed(2)}s), ${AMBIGUOUS_PAUSE_MARGIN}x is needed`,
      pausesFound: inner.length,
    };
  }
  const cuts = chosen.map((s) => (s.startSec + s.endSec) / 2);
  const windows: SentenceWindow[] = [];
  let cursor = speechStart;
  for (let i = 0; i < n; i++) {
    const end = i < n - 1 ? cuts[i]! : speechEnd;
    windows.push({ startSec: r3(cursor), endSec: r3(end) });
    cursor = end;
  }
  if (windows.some((w) => w.endSec - w.startSec < MIN_SENTENCE_WINDOW_SEC)) {
    return { ok: false, reason: "a measured window is shorter than a spoken sentence can be", pausesFound: inner.length };
  }
  /** the sanity lock: seconds per character must be of one order across the scene */
  const rates = windows.map((w, i) => (w.endSec - w.startSec) / Math.max(8, sentences[i]!.text.trim().length));
  const median = [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)]!;
  if (rates.some((r) => r > median * SENTENCE_RATE_TOLERANCE || r < median / SENTENCE_RATE_TOLERANCE)) {
    return { ok: false, reason: "the pauses do not divide the audio like the sentences divide the text", pausesFound: inner.length };
  }
  return {
    ok: true,
    windows,
    pausesFound: inner.length,
    pausesUsed: n - 1,
    boundaries: chosen.map((s, i) => ({ cutSec: r3(cuts[i]!), pauseSec: r3(s.endSec - s.startSec) })),
    marginRatio: Number.isFinite(marginRatio) ? Math.round(marginRatio * 100) / 100 : Infinity,
  };
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Runs silencedetect over the file. Empty on any failure — a measurement that could not be taken is not a measurement. */
export async function detectSilences(
  ffmpegBin: string,
  audioPath: string,
  totalSec: number,
  opts: { noiseDb?: number; minSilenceSec?: number; timeoutMs?: number } = {}
): Promise<SilenceSpan[]> {
  const noise = opts.noiseDb ?? SILENCE_NOISE_DB;
  const minSec = opts.minSilenceSec ?? SILENCE_MIN_SEC;
  const stderr = await new Promise<string>((resolve) => {
    execFile(
      ffmpegBin,
      ["-hide_banner", "-nostats", "-i", audioPath, "-vn", "-af", `silencedetect=n=${noise}dB:d=${minSec}`, "-f", "null", "-"],
      { timeout: opts.timeoutMs ?? Math.min(120_000, Math.max(20_000, totalSec * 1000)), maxBuffer: 16 * 1024 * 1024 },
      (_err, _stdout, err) => resolve(String(err ?? ""))
    );
  });
  return parseSilences(stderr, totalSec);
}

export async function measureSentenceWindows(
  ffmpegBin: string,
  audioPath: string,
  totalSec: number,
  sentences: ReadonlyArray<{ text: string }>
): Promise<SilenceTimingResult> {
  const silences = await detectSilences(ffmpegBin, audioPath, totalSec);
  return sentenceWindowsFromSilences(sentences, silences, totalSec);
}
