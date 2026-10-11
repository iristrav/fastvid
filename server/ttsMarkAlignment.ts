/**
 * MEASURED WORD TIMING FROM THE GOOGLE CLOUD TTS ENGINE — THE SECOND MEASURED ROUTE.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The hard quality gate passes a sentence only on a MEASURED spoken window. Until now the only
 * measurement was ElevenLabs' with-timestamps response; when ElevenLabs refused (video 645: HTTP 401
 * quota_exceeded) the narration was spoken by Fish Audio, which returns audio and nothing else, and
 * every sentence stayed `estimated` — a render that cannot be delivered.
 *
 * Google Cloud TTS, already the last voice in this pipeline's fallback chain, can report WHERE in
 * its own output each SSML `<mark/>` falls (`enableTimePointing: ["SSML_MARK"]`, v1beta1). A mark
 * before every word and a mark after the last word of every sentence give word starts and sentence
 * ends read off the engine's own clock — not a transcription, not an estimate, not an alignment of
 * one thing against another: the synthesizer says at which second it spoke each word of exactly the
 * text it was given.
 *
 * ── What is measured and what is derived ────────────────────────────────────────────────────
 *
 *   measured   every word's START (its mark), every sentence's END (its end mark)
 *   derived    a word's end is the next word's start inside the sentence (the inter-word gap belongs
 *              to the word before it); the last word of a sentence ends at the sentence's end mark.
 *              A sentence window (first word start → end mark) is therefore measured at both ends.
 *
 * ── What is refused ─────────────────────────────────────────────────────────────────────────
 *
 * A response is rejected — no alignment, the beats stay laid out, the gate blocks — when a mark is
 * missing or doubled, the times do not run forward with the text, a time lies outside the audio, or
 * the speech ends long before the audio does (the audio and the text do not agree). Nothing here
 * invents a time: an invalid response is an invalid response.
 *
 * Pure functions here are tested without a network; `synthesizeGoogleTimepointed` takes its fetch,
 * probe and concat as dependencies for the same reason. No new package: ffmpeg/ffprobe and the
 * Google TTS key this pipeline already has.
 */
import fs from "fs";
import path from "path";
import type { TtsCharacterAlignment } from "./voiceTtsAlignment";

export const GOOGLE_TTS_TIMEPOINT_URL = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
/** Google's input limit is 5000 bytes INCLUDING the SSML; marks are kept well under it. */
export const SSML_REQUEST_MAX_BYTES = 4_500;
export const GOOGLE_TTS_VOICE = { languageCode: "en-US", name: "en-US-Neural2-D" } as const;
/** Speech may end this far before the audio does (the engine's own tail) and still be the same text. */
export const TIMEPOINT_TAIL_TOLERANCE_SEC = 1.5;
export const TIMEPOINT_OVERRUN_TOLERANCE_SEC = 0.1;

export type MarkTimepoint = { markName: string; timeSeconds: number };

export type MarkedSsml = {
  ssml: string;
  /** The whitespace tokens of the text, in order: word i carries mark `w{i}`. */
  words: string[];
  /** Sentence end marks: `e{k}` sits after word `lastWordIndex`. */
  sentenceEnds: Array<{ mark: string; lastWordIndex: number }>;
  bytes: number;
};

export function escapeSsml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const SENTENCE_END_RE = /[.!?…]["')\]]*$/;

/** The text as SSML with a mark before every word and a mark after every sentence's last word. */
export function buildMarkedSsml(text: string): MarkedSsml {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const parts: string[] = [];
  const sentenceEnds: MarkedSsml["sentenceEnds"] = [];
  words.forEach((w, i) => {
    parts.push(`<mark name="w${i}"/>${escapeSsml(w)}`);
    const last = i === words.length - 1;
    if (last || SENTENCE_END_RE.test(w)) {
      const mark = `e${sentenceEnds.length}`;
      sentenceEnds.push({ mark, lastWordIndex: i });
      parts.push(`<mark name="${mark}"/>`);
    }
  });
  const ssml = `<speak>${parts.join(" ")}</speak>`;
  return { ssml, words, sentenceEnds, bytes: Buffer.byteLength(ssml, "utf8") };
}

/**
 * Split a text into pieces whose marked SSML stays under the request budget: whole sentences where
 * they fit, words where one sentence alone does not. Never cuts inside a word.
 */
export function splitForSsmlBudget(text: string, maxBytes = SSML_REQUEST_MAX_BYTES): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  /** sentences as runs of words */
  const sentences: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (SENTENCE_END_RE.test(w)) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  const fits = (ws: string[]) => buildMarkedSsml(ws.join(" ")).bytes <= maxBytes;
  const out: string[] = [];
  let acc: string[] = [];
  const flush = () => {
    if (acc.length) out.push(acc.join(" "));
    acc = [];
  };
  for (const s of sentences) {
    if (fits([...acc, ...s])) {
      acc.push(...s);
      continue;
    }
    flush();
    if (fits(s)) {
      acc = [...s];
      continue;
    }
    /** one sentence over the budget: by words */
    let run: string[] = [];
    for (const w of s) {
      if (run.length && !fits([...run, w])) {
        out.push(run.join(" "));
        run = [];
      }
      run.push(w);
    }
    acc = run;
  }
  flush();
  return out;
}

export type TimepointAlignment = {
  alignment: TtsCharacterAlignment;
  words: Array<{ word: string; startSec: number; endSec: number }>;
  sentenceWindows: Array<{ startSec: number; endSec: number }>;
};

/**
 * The engine's timepoints, read against the marks that were sent, into a character alignment of the
 * same shape ElevenLabs returns (so the stored alignment, the scene split and the beat planner are
 * untouched). Returns `{ error }` for anything that is not a clean, forward-running reading of the
 * whole text inside the audio.
 */
export function alignmentFromTimepoints(params: {
  marked: MarkedSsml;
  timepoints: readonly MarkTimepoint[];
  audioDurationSec: number;
}): TimepointAlignment | { error: string } {
  const { marked, timepoints, audioDurationSec } = params;
  if (!(audioDurationSec > 0)) return { error: "audio has no duration" };
  const byName = new Map<string, number>();
  for (const tp of timepoints) {
    if (!tp || typeof tp.markName !== "string" || typeof tp.timeSeconds !== "number" || !Number.isFinite(tp.timeSeconds)) {
      return { error: "a timepoint is malformed" };
    }
    if (byName.has(tp.markName)) return { error: `mark ${tp.markName} reported twice` };
    byName.set(tp.markName, tp.timeSeconds);
  }
  const expected = [...marked.words.map((_, i) => `w${i}`), ...marked.sentenceEnds.map((e) => e.mark)];
  for (const m of expected) if (!byName.has(m)) return { error: `mark ${m} missing from the response (${byName.size}/${expected.length} marks)` };
  /** the reading in text order: w0 … (e after its sentence's last word) */
  const ordered: Array<{ mark: string; t: number }> = [];
  marked.words.forEach((_, i) => {
    ordered.push({ mark: `w${i}`, t: byName.get(`w${i}`)! });
    const end = marked.sentenceEnds.find((e) => e.lastWordIndex === i);
    if (end) ordered.push({ mark: end.mark, t: byName.get(end.mark)! });
  });
  for (let i = 0; i < ordered.length; i++) {
    const { mark, t } = ordered[i]!;
    if (t < -1e-6) return { error: `mark ${mark} before the audio starts (${t.toFixed(3)}s)` };
    if (t > audioDurationSec + TIMEPOINT_OVERRUN_TOLERANCE_SEC) return { error: `mark ${mark} past the audio's end (${t.toFixed(3)}s of ${audioDurationSec.toFixed(3)}s)` };
    if (i > 0 && t + 1e-6 < ordered[i - 1]!.t) return { error: `marks run backwards at ${mark} (${t.toFixed(3)}s after ${ordered[i - 1]!.t.toFixed(3)}s)` };
  }
  const lastEnd = ordered[ordered.length - 1]!.t;
  if (audioDurationSec - lastEnd > TIMEPOINT_TAIL_TOLERANCE_SEC) {
    return { error: `speech ends at ${lastEnd.toFixed(2)}s but the audio runs ${audioDurationSec.toFixed(2)}s: the audio and the text do not agree` };
  }
  const first = ordered[0]!.t;
  if (first > audioDurationSec * 0.5) return { error: `the first word starts at ${first.toFixed(2)}s of ${audioDurationSec.toFixed(2)}s` };

  const endMarkOf = new Map<number, string>(marked.sentenceEnds.map((e) => [e.lastWordIndex, e.mark]));
  const words = marked.words.map((word, i) => {
    const startSec = byName.get(`w${i}`)!;
    const endMark = endMarkOf.get(i);
    const endSec = endMark != null ? byName.get(endMark)! : byName.get(`w${i + 1}`)!;
    return { word, startSec, endSec: Math.max(startSec, endSec) };
  });
  const sentenceWindows: TimepointAlignment["sentenceWindows"] = [];
  let sentenceStart = 0;
  marked.sentenceEnds.forEach((e) => {
    sentenceWindows.push({ startSec: words[sentenceStart]!.startSec, endSec: byName.get(e.mark)! });
    sentenceStart = e.lastWordIndex + 1;
  });

  /** the character alignment: each character of a word at the word's window; one space between words */
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  words.forEach((w, i) => {
    for (const ch of [...w.word]) {
      characters.push(ch);
      starts.push(w.startSec);
      ends.push(w.endSec);
    }
    if (i < words.length - 1) {
      characters.push(" ");
      starts.push(w.endSec);
      ends.push(words[i + 1]!.startSec);
    }
  });
  return { alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }, words, sentenceWindows };
}

export type TimepointedSynthesisDeps = {
  apiKey: string;
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  /** Duration of an audio file on disk (ffprobe), seconds; ≤ 0 when it could not be read. */
  probeDurationSec: (filePath: string) => Promise<number>;
  /** Join several mp3 parts into one file (the pipeline's own concat). */
  concatParts: (partPaths: string[], outputPath: string, workDir: string) => Promise<void>;
  voice?: { languageCode: string; name: string };
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type TimepointedSynthesisResult =
  | { ok: true; durationSec: number; alignment: TtsCharacterAlignment; requests: number; words: number; sentences: number }
  | { ok: false; reason: string; /** audio was produced but its timing was refused: the file is there, the timing is not */ audioWritten: boolean; durationSec: number };

/**
 * Speak one narration part with Google Cloud TTS and read its own timepoints into an alignment.
 * The part is split to the SSML budget; each request's audio is written, probed and concatenated;
 * each request's timepoints are offset by the audio before it.
 */
export async function synthesizeGoogleTimepointed(
  text: string,
  outputPath: string,
  workDir: string,
  deps: TimepointedSynthesisDeps
): Promise<TimepointedSynthesisResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const pieces = splitForSsmlBudget(text);
  if (pieces.length === 0) return { ok: false, reason: "no words to speak", audioWritten: false, durationSec: 0 };
  const partPaths: string[] = [];
  const parts: Array<{ offsetSec: number; alignment: TtsCharacterAlignment }> = [];
  let offsetSec = 0;
  let refused: string | null = null;
  let words = 0;
  let sentences = 0;
  for (let i = 0; i < pieces.length; i++) {
    const marked = buildMarkedSsml(pieces[i]!);
    let response: Awaited<ReturnType<TimepointedSynthesisDeps["fetchImpl"]>>;
    try {
      response = await deps.fetchImpl(GOOGLE_TTS_TIMEPOINT_URL, {
        method: "POST",
        headers: { "X-Goog-Api-Key": deps.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { ssml: marked.ssml },
          voice: deps.voice ?? GOOGLE_TTS_VOICE,
          audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
          enableTimePointing: ["SSML_MARK"],
        }),
      });
    } catch (err) {
      return { ok: false, reason: `request ${i + 1}/${pieces.length} failed: ${(err as Error).message?.slice(0, 150)}`, audioWritten: false, durationSec: 0 };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, reason: `request ${i + 1}/${pieces.length} HTTP ${response.status}: ${body.slice(0, 150)}`, audioWritten: false, durationSec: 0 };
    }
    const data = (await response.json().catch(() => null)) as { audioContent?: string; timepoints?: MarkTimepoint[] } | null;
    if (!data?.audioContent) return { ok: false, reason: `request ${i + 1}/${pieces.length}: no audio in the response`, audioWritten: false, durationSec: 0 };
    const audio = Buffer.from(data.audioContent, "base64");
    if (audio.length < 100) return { ok: false, reason: `request ${i + 1}/${pieces.length}: empty audio`, audioWritten: false, durationSec: 0 };
    const piecePath = path.join(workDir, `${path.basename(outputPath, path.extname(outputPath))}_tp${i}.mp3`);
    fs.writeFileSync(piecePath, audio);
    partPaths.push(piecePath);
    const dur = await deps.probeDurationSec(piecePath);
    if (!(dur > 0)) {
      refused = refused ?? `request ${i + 1}/${pieces.length}: the audio's duration could not be read`;
    } else if (!refused) {
      const read = alignmentFromTimepoints({ marked, timepoints: data.timepoints ?? [], audioDurationSec: dur });
      if ("error" in read) refused = `request ${i + 1}/${pieces.length}: ${read.error}`;
      else {
        parts.push({ offsetSec, alignment: read.alignment });
        words += read.words.length;
        sentences += read.sentenceWindows.length;
      }
    }
    offsetSec += dur > 0 ? dur : 0;
  }
  await deps.concatParts(partPaths, outputPath, workDir);
  for (const p of partPaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  const durationSec = await deps.probeDurationSec(outputPath);
  if (refused) {
    log(`[TtsAlign] Google timepoints refused: ${refused} — the audio is kept, the timing is not`);
    return { ok: false, reason: refused, audioWritten: true, durationSec: durationSec > 0 ? durationSec : offsetSec };
  }
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const part of parts) {
    for (let k = 0; k < part.alignment.characters.length; k++) {
      characters.push(part.alignment.characters[k]!);
      starts.push(part.alignment.character_start_times_seconds[k]! + part.offsetSec);
      ends.push(part.alignment.character_end_times_seconds[k]! + part.offsetSec);
    }
    /** a space between requests, so the two words do not fuse */
    if (part !== parts[parts.length - 1]) {
      characters.push(" ");
      const t = ends[ends.length - 1]!;
      starts.push(t);
      ends.push(t);
    }
  }
  log(`[TtsAlign] Google timepoints: ${words} word(s), ${sentences} sentence end(s) measured over ${pieces.length} request(s), ${(durationSec > 0 ? durationSec : offsetSec).toFixed(1)}s`);
  return {
    ok: true,
    durationSec: durationSec > 0 ? durationSec : offsetSec,
    alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends },
    requests: pieces.length,
    words,
    sentences,
  };
}
