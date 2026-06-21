/**
 * ElevenLabs word-level alignment → beat planner (timing-first montage).
 */
import fs from "fs";
import path from "path";
import { archiveVisualMaxClipSec, archiveVisualMinClipSec } from "./sourcingPolicy";
import { syncBeatHoldSecToVoiceTimeline, type BeatHoldInput } from "./voiceMomentSync";

export type TtsCharacterAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export type TtsWordTiming = {
  word: string;
  startSec: number;
  endSec: number;
};

export type TtsPlannedBeat = {
  index: number;
  text: string;
  holdSec: number;
  voiceStartSec: number;
  voiceEndSec: number;
};

export type StoredTtsAlignment = {
  words: TtsWordTiming[];
  totalDurationSec: number;
  updatedAt: string;
};

const SENTENCE_BREAK_RE = /[.!?…]\s*$/;

export function ttsWordAlignmentEnabled(): boolean {
  if (process.env.ENABLE_TTS_WORD_ALIGNMENT === "false") return false;
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

export function ttsAlignmentPath(workDir: string): string {
  return path.join(workDir, "tts_word_alignment.json");
}

export function loadStoredTtsAlignment(workDir: string): StoredTtsAlignment | null {
  const p = ttsAlignmentPath(workDir);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredTtsAlignment;
    if (!Array.isArray(parsed.words) || parsed.words.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredTtsAlignment(workDir: string, alignment: StoredTtsAlignment): void {
  fs.writeFileSync(ttsAlignmentPath(workDir), JSON.stringify(alignment), "utf8");
}

/** Merge chunked ElevenLabs alignments with time offsets. */
export function mergeCharacterAlignments(
  parts: Array<{ offsetSec: number; alignment: TtsCharacterAlignment }>
): TtsCharacterAlignment {
  const characters: string[] = [];
  const character_start_times_seconds: number[] = [];
  const character_end_times_seconds: number[] = [];
  for (const part of parts) {
    const off = part.offsetSec;
    for (let i = 0; i < part.alignment.characters.length; i++) {
      characters.push(part.alignment.characters[i]!);
      character_start_times_seconds.push(part.alignment.character_start_times_seconds[i]! + off);
      character_end_times_seconds.push(part.alignment.character_end_times_seconds[i]! + off);
    }
  }
  return { characters, character_start_times_seconds, character_end_times_seconds };
}

/** Convert character alignment to word timings. */
export function wordsFromCharacterAlignment(alignment: TtsCharacterAlignment): TtsWordTiming[] {
  const words: TtsWordTiming[] = [];
  let buf = "";
  let start: number | null = null;
  let end = 0;

  const flush = () => {
    const w = buf.trim();
    if (w.length > 0 && start != null) {
      words.push({ word: w, startSec: start, endSec: end });
    }
    buf = "";
    start = null;
  };

  for (let i = 0; i < alignment.characters.length; i++) {
    const ch = alignment.characters[i] ?? "";
    const cs = alignment.character_start_times_seconds[i] ?? 0;
    const ce = alignment.character_end_times_seconds[i] ?? cs;
    if (!ch.trim() && !buf) continue;
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (!buf) start = cs;
    buf += ch;
    end = ce;
  }
  flush();
  return words;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, "");
}

/** Match scene narration tokens to global word timeline. */
export function sliceWordsForSceneText(
  allWords: TtsWordTiming[],
  sceneText: string,
  cursor: { index: number }
): { words: TtsWordTiming[]; nextIndex: number } {
  const sceneTokens = sceneText
    .replace(/\[visual:[^\]]+\]/gi, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1);
  if (!sceneTokens.length) return { words: [], nextIndex: cursor.index };

  const matched: TtsWordTiming[] = [];
  let ti = cursor.index;
  let si = 0;

  while (ti < allWords.length && si < sceneTokens.length) {
    const wt = normalizeToken(allWords[ti]!.word);
    if (!wt) {
      ti++;
      continue;
    }
    if (wt === sceneTokens[si] || wt.startsWith(sceneTokens[si]!) || sceneTokens[si]!.startsWith(wt)) {
      matched.push(allWords[ti]!);
      si++;
    }
    ti++;
  }

  cursor.index = ti;
  return { words: matched, nextIndex: ti };
}

/** Plan beats from word timings inside a scene window. */
export function planBeatsFromTtsWords(
  words: TtsWordTiming[],
  options?: {
    minSec?: number;
    maxSec?: number;
    targetSec?: number;
    maxBeats?: number;
  }
): TtsPlannedBeat[] {
  if (!words.length) return [];

  const minSec = options?.minSec ?? archiveVisualMinClipSec();
  const maxSec = options?.maxSec ?? archiveVisualMaxClipSec();
  const targetSec = options?.targetSec ?? 6;
  const maxBeats = options?.maxBeats ?? 24;

  type Group = { words: TtsWordTiming[]; text: string };
  const groups: Group[] = [];
  let current: TtsWordTiming[] = [];

  const flushGroup = () => {
    if (!current.length) return;
    groups.push({
      words: current,
      text: current.map((w) => w.word).join(" "),
    });
    current = [];
  };

  for (const w of words) {
    current.push(w);
    const dur = current[current.length - 1]!.endSec - current[0]!.startSec;
    const text = current.map((x) => x.word).join(" ");
    if (SENTENCE_BREAK_RE.test(text) && dur >= minSec * 0.6) {
      flushGroup();
      continue;
    }
    if (dur >= maxSec) {
      flushGroup();
    }
  }
  flushGroup();

  while (groups.length > maxBeats && groups.length > 1) {
    let mergeIdx = 0;
    let minDur = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const g = groups[i]!;
      const dur = g.words[g.words.length - 1]!.endSec - g.words[0]!.startSec;
      if (dur < minDur) {
        minDur = dur;
        mergeIdx = i;
      }
    }
    const a = groups[mergeIdx]!;
    const b = groups[mergeIdx + 1]!;
    groups.splice(mergeIdx, 2, {
      words: [...a.words, ...b.words],
      text: `${a.text} ${b.text}`.trim(),
    });
  }

  const beats: TtsPlannedBeat[] = groups.map((g, index) => {
    const start = g.words[0]!.startSec;
    const end = g.words[g.words.length - 1]!.endSec;
    const dur = Math.max(minSec, Math.min(maxSec, end - start));
    return {
      index,
      text: g.text,
      holdSec: dur,
      voiceStartSec: start,
      voiceEndSec: end,
    };
  });

  if (beats.length > 1) {
    const shortIdx = beats.findIndex((b) => b.holdSec < minSec);
    if (shortIdx >= 0 && shortIdx < beats.length - 1) {
      const a = beats[shortIdx]!;
      const b = beats[shortIdx + 1]!;
      beats.splice(shortIdx, 2, {
        index: a.index,
        text: `${a.text} ${b.text}`.trim(),
        holdSec: Math.max(minSec, b.voiceEndSec - a.voiceStartSec),
        voiceStartSec: a.voiceStartSec,
        voiceEndSec: b.voiceEndSec,
      });
      beats.forEach((bt, i) => {
        bt.index = i;
      });
    }
  }

  const voiceSec = Math.max(
    0.5,
    (words[words.length - 1]?.endSec ?? 0) - (words[0]?.startSec ?? 0)
  );
  const holdInputs: BeatHoldInput[] = beats.map((b) => ({ text: b.text, holdSec: b.holdSec }));
  syncBeatHoldSecToVoiceTimeline(
    holdInputs,
    voiceSec,
    0.35,
    beats.map((b) => Math.max(0.35, b.voiceEndSec - b.voiceStartSec))
  );
  for (let i = 0; i < beats.length; i++) {
    beats[i]!.holdSec = holdInputs[i]!.holdSec;
  }

  return beats;
}

/** Scene boundary times from accumulated scene word spans. */
export function sceneVoiceWindowFromWords(words: TtsWordTiming[]): { startSec: number; endSec: number } {
  if (!words.length) return { startSec: 0, endSec: 0 };
  return {
    startSec: words[0]!.startSec,
    endSec: words[words.length - 1]!.endSec,
  };
}

export type ElevenLabsTimestampResponse = {
  audio_base64: string;
  alignment?: TtsCharacterAlignment;
  normalized_alignment?: TtsCharacterAlignment;
};

/** ElevenLabs TTS with character timestamps (word alignment source of truth). */
export async function fetchElevenLabsWithTimestamps(
  text: string,
  elevenVoiceId: string,
  apiKey: string,
  timeoutMs: number
): Promise<{ audioBuffer: Buffer; alignment: TtsCharacterAlignment } | null> {
  if (!apiKey.trim() || !text.trim()) return null;
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}/with-timestamps`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.58,
            similarity_boost: 0.88,
            style: 0.05,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as ElevenLabsTimestampResponse;
    const alignment = data.alignment ?? data.normalized_alignment;
    if (!alignment?.characters?.length || !data.audio_base64) return null;
    const audioBuffer = Buffer.from(data.audio_base64, "base64");
    if (audioBuffer.length < 100) return null;
    return { audioBuffer, alignment };
  } catch {
    return null;
  }
}

/** Build per-scene TTS beat plans from stored global word alignment. */
export function buildTtsSceneBeatMap(
  scenes: Array<{ index: number; text: string; duration: number }>,
  stored: StoredTtsAlignment,
  maxBeatsForScene: (sceneDuration: number) => number
): Map<number, TtsPlannedBeat[]> {
  const out = new Map<number, TtsPlannedBeat[]>();
  const cursor = { index: 0 };
  for (const scene of scenes) {
    const { words } = sliceWordsForSceneText(stored.words, scene.text, cursor);
    if (!words.length) continue;
    const planned = planBeatsFromTtsWords(words, {
      maxBeats: maxBeatsForScene(Math.max(1, scene.duration - 0.35)),
    });
    if (planned.length) out.set(scene.index, planned);
  }
  return out;
}
