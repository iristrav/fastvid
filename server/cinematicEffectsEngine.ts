/**
 * Cinematic Effects Engine — content-aware zoom/pan hints, overlays, particles, SFX, animated text.
 * Years appear bottom-left in a documentary date-card style.
 */
import { burnedInTextAllowed } from "./onScreenTextPolicy";
import { envFlagIsNotOff } from "./envFlag";
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext, isCaptionTextCorrupt } from "./ffmpegSanitize";
import { DOC_STYLE_VIDEO_HEIGHT, DOC_STYLE_VIDEO_WIDTH, type TimedOverlay } from "./documentaryStyle";
import { ffmpegThreadFlag } from "./sourcingPolicy";
import { clampVidrushClipDuration } from "./vidrushQuality";

export type CinematicAudioCue = {
  type: "whoosh" | "impact" | "shutter";
  timeSec: number;
  volume: number;
};

export type CinematicScenePlan = {
  overlays: TimedOverlay[];
  audioCues: CinematicAudioCue[];
  /** Per-beat Ken Burns variant hints (for still encoders). */
  motionVariants: Array<"zoom-in" | "zoom-out" | "pan-left" | "pan-right">;
  transitionStyle: "dissolve" | "fade";
  keywords: string[];
  years: string[];
  statText: string | null;
};

export type SceneLike = {
  index: number;
  text: string;
  title?: string;
  sectionTitle?: string;
  statCallout?: string;
  highlightWords?: string[];
  personNames?: string[];
};

const YEAR_RE = /\b(?:1[0-9]{3}|20[0-9]{2})\b/g;

export function extractYearsFromText(text: string): string[] {
  const matches = text.match(YEAR_RE) ?? [];
  const seen = new Set<string>();
  const years: string[] = [];
  for (const y of matches) {
    if (!seen.has(y)) {
      seen.add(y);
      years.push(y);
    }
  }
  return years;
}

/** Max words shown per on-screen text beat (Vidrush-style kinetic labels). */
export const MAX_ONSCREEN_WORDS = 2;

export function limitOnScreenText(text: string, maxWords = MAX_ONSCREEN_WORDS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}

export function extractStatFromText(text: string): string | null {
  // Euro amounts: €10.000, €1 miljoen, €50 miljard
  const euro = text.match(/€\s*[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|biljoen|M|B|K))?/i);
  if (euro?.[0]) return euro[0].trim().replace(/€\s+/, "€").replace(/\s+/g, " ").slice(0, 24);
  // Dollar amounts
  const money = text.match(/\$[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|M|B|K))?/i);
  if (money?.[0]) return money[0].trim().slice(0, 24);
  // Dutch numeric amounts: "10 miljoen", "5 miljard", "2,5 biljoen"
  const dutchAmt = text.match(/\b[\d,.]+\s*(?:miljoen|miljard|biljoen|duizend)\b/i);
  if (dutchAmt?.[0]) return dutchAmt[0].trim().replace(/\s+/g, " ").slice(0, 24);
  // Percentages — Dutch "procent" and English "percent" / symbol
  const pct = text.match(/\d[\d,.]*\s*(?:%|percent|procent)/i);
  if (pct?.[0]) return pct[0].trim().slice(0, 24);
  // People / casualty counts
  const count = text.match(/\b[\d,.]+\s+(?:people|soldiers|tanks|planes|victims|doden|slachtoffers|mensen|inwoners)\b/i);
  if (count?.[0]) return count[0].trim().slice(0, 24);
  return null;
}

type VoiceoverKeywordHit = { index: number; length: number; value: string };

function normalizeVoiceoverKeyword(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "";
  const pctWord = s.match(/^(\d[\d,.]*)\s*(?:percent|procent)$/i);
  if (pctWord?.[1]) return `${pctWord[1].replace(/\s/g, "")}%`.slice(0, 28);
  if (/\d[\d,.]*\s*%/.test(s)) return s.replace(/\s+/g, "").slice(0, 28);
  return s.toUpperCase().slice(0, 28);
}

function addVoiceoverKeywordHit(hits: VoiceoverKeywordHit[], index: number, raw: string): void {
  const value = normalizeVoiceoverKeyword(raw);
  if (!value || index < 0) return;
  const end = index + raw.length;
  for (const h of hits) {
    const hEnd = h.index + h.length;
    if (index < hEnd && end > h.index) return;
  }
  hits.push({ index, length: raw.length, value });
}

/** Pull on-screen keywords from narration: %, years, money, Dutch amounts, large counts. */
export function extractVoiceoverKeywords(text: string, maxItems = 2): string[] {
  const cleaned = text.replace(/\[visual:[^\]]+\]/gi, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const hits: VoiceoverKeywordHit[] = [];
  const patterns: RegExp[] = [
    // RONDE 30: the trailing \b applied to the "%" alternative too, and "%" is not a word
    // character — so a percentage at the end of a sentence ("en 15%") never matched, because
    // end-of-string after a non-word character is not a word boundary. Only the spelled-out
    // forms ever worked. The boundary now applies to the words that need it, not to the symbol.
    /\d[\d,.]*\s*(?:%|(?:percent|procent)\b)/gi,
    /€\s*[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|biljoen|M|B|K))?/gi,
    /\$[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|M|B|K))?/gi,
    /\b[\d,.]+\s*(?:miljoen|miljard|biljoen|duizend)\b/gi,
    /\b(?:1[0-9]{3}|20[0-9]{2})\b/g,
    /\b[\d,.]+\s+(?:people|soldiers|tanks|planes|victims|doden|slachtoffers|mensen|inwoners)\b/gi,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      addVoiceoverKeywordHit(hits, m.index, m[0]);
    }
  }

  hits.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    const key = h.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h.value);
    if (out.length >= maxItems) break;
  }
  return out;
}

export type FacelessLine = { text: string; emphasis: boolean; posFrac?: number };

/** Voiceover keywords only (% / years / amounts) — max 2 lines for faceless B-roll overlays.
 *  posFrac is each keyword's approximate fractional position within the narration text (same
 *  proportional-position approximation visualBeatTags.ts's termStartInBeat already uses for the
 *  sibling year-overlay path), so the caller can schedule the overlay near when it's actually
 *  spoken instead of always at a fixed offset regardless of content. */
export function parseFacelessSubtitleLines(text: string, maxLines = 2): FacelessLine[] {
  const cleaned = text.replace(/\[visual:[^\]]+\]/gi, " ").replace(/\s+/g, " ").trim();
  const keywords = extractVoiceoverKeywords(text, maxLines);
  return keywords.map((kw) => {
    const idx = cleaned.toLowerCase().indexOf(kw.toLowerCase());
    const posFrac = idx >= 0 && cleaned.length > 0 ? idx / cleaned.length : undefined;
    return { text: kw, emphasis: true, posFrac };
  });
}

export type FacelessSubtitlePlacement = "bottom-left" | "bottom-center";

const FACELESS_VIDEO_PREP_VF =
  `scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:(iw-${DOC_STYLE_VIDEO_WIDTH})/2:(ih-${DOC_STYLE_VIDEO_HEIGHT})/2,` +
  `fps=25,format=yuv420p,setsar=1`;

const FACELESS_TYPEWRITER_HOLD_SEC = 0.9;
const FACELESS_TYPEWRITER_FADE_SEC = 0.22;
const FACELESS_KEYWORD_FONT_SIZE = 58;

/** Typewriter drawtext chain — substring reveal per keyword line (bottom-left/center). */
export function buildFacelessTypewriterDrawtextChain(
  inLabel: string,
  outLabel: string,
  lines: FacelessLine[],
  sceneDuration: number,
  placement: FacelessSubtitlePlacement = "bottom-left"
): string {
  if (!lines.length) return `[${inLabel}]copy[${outLabel}]`;

  const marginL = 56;
  const marginB = 72;
  const lineHeights = lines.map((line) => (line.emphasis ? 68 : 48));
  const totalH = lineHeights.reduce((s, h) => s + h, 0);
  const baseY = DOC_STYLE_VIDEO_HEIGHT - marginB - totalH;

  let chain = "";
  let prev = inLabel;
  let lineStart = 0.35;

  lines.forEach((line, lineIdx) => {
    const safeFull = sanitizeForDrawtext(line.text.toUpperCase(), 28);
    if (safeFull.length < 1) return;

    const fs = line.emphasis ? FACELESS_KEYWORD_FONT_SIZE : 42;
    const y = baseY + lineHeights.slice(0, lineIdx).reduce((s, h) => s + h, 0);
    const x = placement === "bottom-center" ? "(w-text_w)/2" : String(marginL);
    const typeEnd = lineStart + safeFull.length * TYPEWRITER_CHAR_SEC;
    const holdEnd = typeEnd + FACELESS_TYPEWRITER_HOLD_SEC;
    const fadeEnd = Math.min(sceneDuration - 0.12, holdEnd + FACELESS_TYPEWRITER_FADE_SEC);
    const isLastLine = lineIdx === lines.length - 1;

    for (let k = 1; k <= safeFull.length; k++) {
      const sub = sanitizeForDrawtext(safeFull.slice(0, k), k);
      const t0 = lineStart + (k - 1) * TYPEWRITER_CHAR_SEC;
      const isLastChar = k === safeFull.length;
      const t1 = isLastChar ? fadeEnd : lineStart + k * TYPEWRITER_CHAR_SEC;
      const charOut = isLastLine && isLastChar ? outLabel : `fb${lineIdx}_${k}`;
      const charEnable = `enable='between(t\\,${t0.toFixed(3)}\\,${t1.toFixed(3)})'`;
      const alphaParam = isLastChar
        ? `alpha='if(gt(t\\,${holdEnd.toFixed(3)})\\,max(0\\,1-(t-${holdEnd.toFixed(3)})/${FACELESS_TYPEWRITER_FADE_SEC})\\,1)':`
        : "";
      chain +=
        `;[${prev}]drawtext=text='${sub}':fontcolor=white:fontsize=${fs}:` +
        `x=${x}:y=${y}:` +
        `${alphaParam}` +
        `${charEnable}[${charOut}]`;
      prev = charOut;
    }

    lineStart = typeEnd + 0.12;
  });

  if (!chain) return `[${inLabel}]copy[${outLabel}]`;
  return chain;
}

/** Legacy comma-join drawtext (static) — prefer buildFacelessTypewriterDrawtextChain. */
export function buildFacelessDrawtextVF(
  lines: FacelessLine[],
  sceneDuration: number,
  placement: FacelessSubtitlePlacement = "bottom-left"
): string {
  if (!lines.length) return "";
  const chain = buildFacelessTypewriterDrawtextChain("v0", "v1", lines, sceneDuration, placement);
  return chain.replace(/^\;?\[v0\]/, "").replace(/\[v1\]$/, "") || "";
}

/** Burn faceless kinetic text onto a B-roll clip — bottom-left only, no other overlays. */
export async function burnFacelessTextOnVideoClip(
  clipPath: string,
  text: string,
  sceneIndex: number,
  beatIndex: number,
  workDir: string,
  holdSec: number,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<string> {
  const lines = parseFacelessSubtitleLines(text);
  if (!lines.length) return clipPath;

  const chain = buildFacelessTypewriterDrawtextChain("vprep", "vout", lines, holdSec, "bottom-left");
  const filterComplex = `[0:v]${FACELESS_VIDEO_PREP_VF}[vprep]${chain}`;

  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_vtext.mp4`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -i "${clipPath}" -t ${holdSec.toFixed(3)} ` +
        `-filter_complex "${filterComplex}" -map "[vout]" ` +
        `-an -c:v libx264 ${ffmpegThreadFlag()} -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 "${outPath}"`,
      60_000,
      `Video beat text s${sceneIndex} b${beatIndex}`
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 800) {
      return outPath;
    }
  } catch {
    /* non-fatal */
  }
  return clipPath;
}

function extractKeywords(text: string, count = 2): string[] {
  const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "have", "has", "had",
    "this", "that", "these", "those", "it", "its", "not", "no", "de", "het", "een",
    "en", "van", "in", "op", "te", "dat", "die", "zijn", "was", "werd", "wordt",
  ]);
  const words = text
    .replace(/[^a-zA-ZÀ-ÿ0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w.charAt(0).toUpperCase() + w.slice(1));
    if (out.length >= count) break;
  }
  return out;
}

export function planCinematicScene(scene: SceneLike, durationSec: number): CinematicScenePlan {
  const years = extractYearsFromText(scene.text);
  const statText =
    (scene.statCallout?.trim() || extractStatFromText(scene.text) || null)?.slice(0, 24) ?? null;
  const keywords = (scene.highlightWords ?? []).filter(Boolean).slice(0, 2);
  const fallbackKw = keywords.length === 0 ? extractKeywords(scene.text, 1) : [];
  const allKeywords = [...keywords, ...fallbackKw];

  const audioCues: CinematicAudioCue[] = [];
  const clipCount = Math.max(1, Math.ceil(durationSec / 6));
  for (let i = 1; i < clipCount; i++) {
    audioCues.push({
      type: "whoosh",
      timeSec: Math.min(durationSec - 0.3, i * (durationSec / clipCount)),
      volume: 0.22,
    });
  }

  years.forEach((year, i) => {
    const slot = durationSec / Math.max(1, years.length);
    const start = Math.max(0.35, i * slot + 0.25);
    audioCues.push({ type: "impact", timeSec: start, volume: 0.38 });
    if (i === 0) {
      audioCues.push({ type: "shutter", timeSec: Math.max(0.1, start - 0.05), volume: 0.18 });
    }
  });

  const motionVariants: CinematicScenePlan["motionVariants"] = [];
  const variants: CinematicScenePlan["motionVariants"][number][] = [
    "zoom-in",
    "pan-left",
    "zoom-out",
    "pan-right",
  ];
  for (let i = 0; i < clipCount; i++) {
    motionVariants.push(variants[(scene.index + i) % variants.length]);
  }

  return {
    overlays: [],
    audioCues,
    motionVariants,
    transitionStyle: "dissolve",
    keywords: allKeywords,
    years,
    statText,
  };
}

export type YearBadgeTiming = { startTime: number; endTime: number };

/** Cumulative start time per montage beat (hard cuts — xfadeSec should be 0). */
export function computeMontageBeatStarts(durations: number[], xfadeSec = 0): number[] {
  const starts: number[] = [];
  let t = 0;
  for (let i = 0; i < durations.length; i++) {
    starts.push(t);
    t += durations[i] - (i < durations.length - 1 ? xfadeSec : 0);
  }
  return starts;
}

export type BeatYearInput = {
  text: string;
  holdSec: number;
  /** Scene-local TTS start (seconds) — montage cuts align here when set. */
  voiceStartSec?: number;
  voiceEndSec?: number;
  visualDescription?: string;
  searchQuery?: string;
};

export type BeatLabelInput = BeatYearInput & {
  powerWord?: string;
  highlightWords?: string[];
};

function beatsHaveTtsWindows(beats: BeatYearInput[]): boolean {
  return (
    beats.length > 0 &&
    beats.every((b) => b.voiceStartSec != null && b.voiceEndSec != null)
  );
}

/** ≥50% beats with TTS windows — enough to anchor hard-cut montage. */
export function beatsHavePartialTtsWindows(beats: BeatYearInput[], minRatio = 0.5): boolean {
  if (beats.length === 0) return false;
  const withTts = beats.filter((b) => b.voiceStartSec != null).length;
  return withTts / beats.length >= minRatio;
}

/** Word-weighted fill for beats missing voiceStartSec between known TTS anchors. */
export function fillPartialTtsVoiceStarts(beats: BeatYearInput[], voiceDur: number): BeatYearInput[] {
  const out = beats.map((b) => ({ ...b }));
  const anchors = out.map((b, i) => (b.voiceStartSec != null ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) return out;

  const distribute = (fromIdx: number, toIdx: number, startSec: number, endSec: number) => {
    if (toIdx < fromIdx || endSec <= startSec) return;
    const words = out.slice(fromIdx, toIdx + 1).map((b) =>
      Math.max(1, b.text.replace(/\[visual:[^\]]+\]/gi, "").split(/\s+/).filter(Boolean).length)
    );
    const total = words.reduce((s, w) => s + w, 0) || words.length;
    let t = startSec;
    for (let j = 0; j <= toIdx - fromIdx; j++) {
      const slot = ((endSec - startSec) * words[j]!) / total;
      out[fromIdx + j]!.voiceStartSec = t;
      out[fromIdx + j]!.voiceEndSec = t + slot;
      t += slot;
    }
  };

  const first = anchors[0]!;
  if (first > 0) {
    distribute(0, first - 1, 0, out[first]!.voiceStartSec!);
  }
  for (let a = 0; a < anchors.length - 1; a++) {
    const i0 = anchors[a]!;
    const i1 = anchors[a + 1]!;
    const gapStart = out[i0]!.voiceEndSec ?? out[i0]!.voiceStartSec!;
    const gapEnd = out[i1]!.voiceStartSec!;
    if (i1 - i0 > 1) {
      distribute(i0 + 1, i1 - 1, gapStart, gapEnd);
    }
  }
  const last = anchors[anchors.length - 1]!;
  if (last < out.length - 1) {
    const gapStart = out[last]!.voiceEndSec ?? out[last]!.voiceStartSec!;
    distribute(last + 1, out.length - 1, gapStart, voiceDur);
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.voiceEndSec == null && out[i]!.voiceStartSec != null) {
      const next = i + 1 < out.length ? out[i + 1]!.voiceStartSec : voiceDur;
      out[i]!.voiceEndSec = next ?? voiceDur;
    }
  }
  return out;
}

export type TtsMontagePlan = {
  durations: number[];
  cutStartsSec: number[];
  xfadeSec: number;
  ttsHardCut: boolean;
};

/** Hard cuts on TTS voiceStartSec — no xfade drift (default on). */
export function ttsHardCutMontageEnabled(): boolean {
  if (!envFlagIsNotOff("ENABLE_TTS_HARD_CUT_MONTAGE")) return false;
  return true;
}

/**
 * Montage plan with clip cuts anchored to TTS voiceStartSec (xfade=0).
 * Returns null when TTS windows are unavailable or hard-cut is disabled.
 */
export function computeTtsHardCutMontagePlan(
  beats: BeatYearInput[],
  voiceDur: number,
  clipBeatIndices: number[],
  sceneIndex = 0
): TtsMontagePlan | null {
  if (
    !ttsHardCutMontageEnabled() ||
    clipBeatIndices.length === 0 ||
    voiceDur <= 0
  ) {
    return null;
  }
  const fullTts = beatsHaveTtsWindows(beats);
  const partialTts = !fullTts && beatsHavePartialTtsWindows(beats);
  if (!fullTts && !partialTts) {
    return null;
  }
  const timedBeats = fullTts ? beats : fillPartialTtsVoiceStarts(beats, voiceDur);

  const n = clipBeatIndices.length;
  const cutStartsSec = new Array<number>(n).fill(0);
  let ci = 0;
  while (ci < n) {
    const beatIdx = clipBeatIndices[ci] ?? 0;
    let runEnd = ci;
    while (runEnd < n && (clipBeatIndices[runEnd] ?? 0) === beatIdx) runEnd++;
    const runLen = runEnd - ci;
    const beat = timedBeats[beatIdx];
    if (beat?.voiceStartSec == null) return null;
    const beatStart = beat.voiceStartSec;
    const beatEnd =
      beatIdx + 1 < timedBeats.length && timedBeats[beatIdx + 1]!.voiceStartSec != null
        ? timedBeats[beatIdx + 1]!.voiceStartSec!
        : Math.max(beat.voiceEndSec ?? beatStart, voiceDur);
    const window = Math.max(0.35 * runLen, beatEnd - beatStart);
    const slot = window / runLen;
    for (let j = 0; j < runLen; j++) {
      cutStartsSec[ci + j] = beatStart + j * slot;
    }
    ci = runEnd;
  }

  const durations = cutStartsSec.map((start, i) => {
    const end = i < n - 1 ? cutStartsSec[i + 1]! : voiceDur;
    return clampVidrushClipDuration(Math.max(0.35, end - start), i, sceneIndex);
  });

  return { durations, cutStartsSec, xfadeSec: 0, ttsHardCut: true };
}

export type TimedYearLabel = {
  year: string;
  /** Short label in the yellow pill (keyword or context words). */
  caption: string;
  /** Combined string for logs. */
  displayText: string;
  startTime: number;
  endTime: number;
};

/** How long each on-screen label stays visible. */
export const YEAR_LABEL_ON_SCREEN_SEC = 4;
export const SCREEN_LABEL_INTERVAL_SEC = 30;
export const TYPEWRITER_CHAR_SEC = 0.042;
/** V3 overlay style — bold centered text, no background. */
export const SCREEN_LABEL_FONT_SIZE = 42; // kept for legacy callers
export const SCREEN_LABEL_BOX_H = 60;
export const SCREEN_LABEL_PAD_X = 22;
export const SCREEN_LABEL_MAX_W = 680;
export const SCREEN_LABEL_MARGIN_L = 48;
export const SCREEN_LABEL_MARGIN_B = 72;
/** V3: large bold font for center-screen impact overlays. */
const V3_FONT_SIZE = 84;
const V3_BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
/** Seconds text stays fully visible after typewriter completes, before fade. */
const V3_HOLD_SEC = 1.5;
/** Fade-out duration (200-300 ms). */
const V3_FADE_SEC = 0.25;

const YEAR_CAPTION_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "this", "that", "these", "those", "it", "its", "not", "no", "de", "het", "een",
  "en", "van", "op", "te", "dat", "die", "zijn", "werd", "wordt", "when", "then",
  "year", "years", "during", "after", "before", "into", "over", "under", "when",
  "while", "where", "which", "who", "whom", "whose", "there", "their", "they",
]);

function findYearOccurrenceIndex(text: string, year: string, occurrence = 0): number {
  const re = new RegExp(`\\b${year}\\b`, "g");
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(text)) !== null) {
    if (n === occurrence) return match.index;
    n++;
  }
  return -1;
}

/** Local caption words right before a year in the beat text. */
export function buildYearCaption(beatText: string, year: string, occurrence = 0): string {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, "").replace(/\s+/g, " ").trim();
  const yearIdx = findYearOccurrenceIndex(cleaned, year, occurrence);
  if (yearIdx < 0) return "";

  const before = cleaned.slice(0, yearIdx).trim();
  const beforeWords = before
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-ZÀ-ÿ0-9'-]/g, ""))
    .filter((w) => w.length >= 3 && !YEAR_CAPTION_STOP.has(w.toLowerCase()));

  const caption = beforeWords.slice(-2).join(" ").toUpperCase().slice(0, 24);
  // F3-25 hard quality gate: this caption is only ever real words pulled straight from
  // beatText, so it must always appear verbatim in it — if it doesn't, something upstream
  // glued/interleaved fragments that don't belong together (the exact defect a production
  // render showed: "THE GUNINSHOT ECHOESVSTEEL AND FLAMES LICK"). Reject rather than burn in.
  if (isCaptionTextCorrupt(caption, beatText)) return "";
  return caption;
}

/** Local words right before a year — not the whole beat stitched together. */
export function buildYearDisplayText(beatText: string, year: string, occurrence = 0): string {
  const caption = buildYearCaption(beatText, year, occurrence);
  if (!caption) return year;
  return `${caption}, ${year}`;
}

function yearStartInBeat(
  beatText: string,
  year: string,
  beatStart: number,
  beatHoldSec: number,
  occurrence = 0
): number {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, "");
  const yearIdx = findYearOccurrenceIndex(cleaned, year, occurrence);
  if (yearIdx < 0) return beatStart + 0.12;
  const pos = yearIdx / Math.max(1, cleaned.length);
  return beatStart + Math.max(0.08, pos * beatHoldSec * 0.88);
}

function resolveOverlappingYearLabels(labels: TimedYearLabel[], sceneDuration: number): TimedYearLabel[] {
  const sorted = [...labels].sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startTime < prev.endTime - 0.15) {
      cur.startTime = prev.endTime + 0.08;
      cur.endTime = Math.min(sceneDuration - 0.1, cur.startTime + YEAR_LABEL_ON_SCREEN_SEC);
    }
  }
  return sorted;
}

/** Year labels on the voice timeline (when the year is spoken). */
export function planBeatAlignedYears(beats: BeatYearInput[], sceneDuration: number): TimedYearLabel[] {
  const labels: TimedYearLabel[] = [];
  let voiceT = 0;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const years = extractYearsFromText(beat.text);
    const beatStart = voiceT;
    voiceT += beat.holdSec;
    const yearCounts = new Map<string, number>();
    for (const year of years) {
      const occurrence = yearCounts.get(year) ?? 0;
      yearCounts.set(year, occurrence + 1);
      const startTime = yearStartInBeat(beat.text, year, beatStart, beat.holdSec, occurrence);
      const endTime = Math.min(sceneDuration - 0.1, startTime + YEAR_LABEL_ON_SCREEN_SEC);
      if (endTime > startTime + 0.35) {
        const caption = buildYearCaption(beat.text, year, occurrence);
        labels.push({
          year,
          caption,
          displayText: caption ? `${caption}, ${year}` : year,
          startTime,
          endTime,
        });
      }
    }
  }
  return resolveOverlappingYearLabels(labels, sceneDuration);
}

function labelTextForEntry(entry: TimedYearLabel): string {
  const cap = (entry.caption || "").trim().toUpperCase();
  if (/^\d{4}$/.test(entry.year)) {
    return cap.length >= 2 ? `${cap} — ${entry.year}` : entry.year;
  }
  return cap || entry.year || entry.displayText;
}

function extractKeywordFromBeat(beat: BeatLabelInput): string | null {
  const pw = beat.powerWord?.trim();
  if (pw && pw.length >= 3 && !/^\d{4}$/.test(pw)) {
    return pw.toUpperCase().slice(0, 28);
  }
  for (const hw of beat.highlightWords ?? []) {
    const w = hw?.trim();
    if (w && w.length >= 3 && !YEAR_CAPTION_STOP.has(w.toLowerCase())) {
      return w.toUpperCase().slice(0, 28);
    }
  }
  const words = beat.text
    .replace(/\[visual:[^\]]+\]/gi, "")
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-ZÀ-ÿ0-9'-]/g, ""))
    .filter((w) => w.length >= 4 && !YEAR_CAPTION_STOP.has(w.toLowerCase()));
  if (words.length === 0) return null;
  return words[Math.min(words.length - 1, Math.floor(words.length / 2))]!.toUpperCase().slice(0, 28);
}

/** Yellow-pill labels every ~30s — years and important keywords, scene-local times. */
export function planIntervalScreenLabels(
  sceneStartSec: number,
  sceneDurationSec: number,
  beats: BeatLabelInput[],
  intervalSec = SCREEN_LABEL_INTERVAL_SEC
): TimedYearLabel[] {
  const sceneEnd = sceneStartSec + sceneDurationSec;
  const pool: Array<{ text: string; caption: string; priority: number; voiceTime: number }> = [];
  let voiceT = sceneStartSec;

  for (const beat of beats) {
    const years = extractYearsFromText(beat.text);
    const yearCounts = new Map<string, number>();
    for (const year of years) {
      const occurrence = yearCounts.get(year) ?? 0;
      yearCounts.set(year, occurrence + 1);
      const caption = buildYearCaption(beat.text, year, occurrence);
      pool.push({
        text: year,
        caption,
        priority: 12,
        voiceTime: yearStartInBeat(beat.text, year, voiceT - sceneStartSec, beat.holdSec, occurrence) + sceneStartSec,
      });
    }
    const kw = extractKeywordFromBeat(beat);
    if (kw && !pool.some((p) => p.text === kw)) {
      pool.push({
        text: kw,
        caption: kw,
        priority: 8,
        voiceTime: voiceT + beat.holdSec * 0.35,
      });
    }
    voiceT += beat.holdSec;
  }

  const labels: TimedYearLabel[] = [];
  const used = new Set<string>();

  for (let tick = 0; tick < sceneEnd - 0.5; tick += intervalSec) {
    if (tick < sceneStartSec - 0.01 || tick >= sceneEnd - 1.2) continue;
    const localStart = tick - sceneStartSec;
    if (localStart < 0 || localStart >= sceneDurationSec - 1.2) continue;

    let best: (typeof pool)[0] | null = null;
    let bestScore = -Infinity;
    for (const item of pool) {
      if (used.has(item.text)) continue;
      const dist = Math.abs(item.voiceTime - tick);
      const score = item.priority * 20 - dist;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (!best) continue;
    used.add(best.text);
    const endTime = Math.min(sceneDurationSec - 0.08, localStart + YEAR_LABEL_ON_SCREEN_SEC);
    labels.push({
      year: /^\d{4}$/.test(best.text) ? best.text : best.caption,
      caption: /^\d{4}$/.test(best.text) ? best.caption : "",
      displayText: labelTextForEntry({
        year: best.text,
        caption: best.caption,
        displayText: best.text,
        startTime: localStart,
        endTime,
      }),
      startTime: localStart,
      endTime,
    });
  }

  return resolveOverlappingYearLabels(labels, sceneDurationSec);
}

function ensureEvenDim(n: number, min = 2): number {
  const v = Math.max(min, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

/** Apply screen labels one-at-a-time (2-input overlay) — avoids FFmpeg auto_scale failures. */
export async function burnScreenLabelOverlaysSequential(
  inputVideoPath: string,
  outputVideoPath: string,
  overlays: TimedOverlay[],
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<string> {
  if (!overlays.length) {
    if (inputVideoPath !== outputVideoPath) {
      fs.copyFileSync(inputVideoPath, outputVideoPath);
    }
    return outputVideoPath;
  }
  let current = inputVideoPath;
  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i]!;
    const isLast = i === overlays.length - 1;
    const out = isLast ? outputVideoPath : path.join(workDir, `_screen_label_pass_${i}.mp4`);
    const x = Math.round(o.overlayX ?? 0);
    const y = Math.round(o.overlayY ?? 0);
    const enable = `enable='between(t\\,${o.startTime.toFixed(2)}\\,${o.endTime.toFixed(2)})'`;
    // Full-frame VP9 WebM overlays have an alpha channel — preserve it during compositing.
    const isFullFrame =
      (o.overlayW ?? 0) >= DOC_STYLE_VIDEO_WIDTH - 2 &&
      (o.overlayH ?? 0) >= DOC_STYLE_VIDEO_HEIGHT - 2;
    const prepareFilter = isFullFrame
      ? `[1:v]format=yuva420p,setpts=PTS-STARTPTS[lbl]`
      : `[1:v]scale=${ensureEvenDim(o.overlayW ?? SCREEN_LABEL_MAX_W)}:${ensureEvenDim(o.overlayH ?? SCREEN_LABEL_BOX_H)}:flags=fast_bilinear,format=yuva420p,setpts=PTS-STARTPTS[lbl]`;
    await execWithTimeout(
      `${ffmpegBin} -y -i "${current}" -i "${o.path}" ` +
        `-filter_complex "${prepareFilter};` +
        `[0:v][lbl]overlay=x=${x}:y=${y}:${enable}[outv]" ` +
        `-map "[outv]" -c:v libx264 ${ffmpegThreadFlag()} -preset ultrafast -crf 18 -pix_fmt yuv420p -an "${out}"`,
      120_000,
      `Burn screen label ${i + 1}/${overlays.length}`
    );
    current = out;
  }
  return outputVideoPath;
}

/**
 * V3 overlay clip — full-frame transparent (VP9 alpha), bold white text centered,
 * typewriter reveal, hold 1.5 s, then 250 ms fade-out. No background.
 */
export async function renderYellowTypewriterLabelClip(
  text: string,
  sceneIndex: number,
  labelIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<{ path: string; w: number; h: number; x: number; y: number } | null> {
  const safe = sanitizeForDrawtext(text.toUpperCase(), 28);
  if (safe.length < 1) return null;
  const FS = V3_FONT_SIZE;
  const fontFileParam = fs.existsSync(V3_BOLD_FONT)
    ? `:fontfile='${V3_BOLD_FONT}'`
    : "";
  const W = DOC_STYLE_VIDEO_WIDTH;
  const H = DOC_STYLE_VIDEO_HEIGHT;
  const typingDur = safe.length * TYPEWRITER_CHAR_SEC;
  const totalDur = typingDur + V3_HOLD_SEC + V3_FADE_SEC;
  const fadeStart = typingDur + V3_HOLD_SEC;
  // Output as WebM so VP9 alpha channel is preserved.
  const outPath = path.join(workDir, `scene_${sceneIndex}_screen_label_${labelIndex}.webm`);

  let chain = "";
  let prev = "0:v";
  for (let k = 1; k <= safe.length; k++) {
    const sub = sanitizeForDrawtext(safe.slice(0, k), k);
    const t0 = ((k - 1) * TYPEWRITER_CHAR_SEC).toFixed(3);
    const t1 = (k < safe.length ? k * TYPEWRITER_CHAR_SEC : totalDur).toFixed(3);
    const outLabel = k === safe.length ? "vtyped" : `sl${labelIndex}_${k}`;
    chain +=
      `[${prev}]drawtext=text='${sub}':fontcolor=white:fontsize=${FS}${fontFileParam}:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:` +
      `enable='between(t\\,${t0}\\,${t1})'[${outLabel}];`;
    prev = outLabel;
  }
  // Fade out after hold period
  chain += `[vtyped]fade=t=out:st=${fadeStart.toFixed(3)}:d=${V3_FADE_SEC}[vout]`;

  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=black@0.0:s=${W}x${H}:r=25:d=${totalDur.toFixed(3)}" ` +
        `-filter_complex "${chain}" -map "[vout]" -t ${totalDur.toFixed(3)} ` +
        `-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -an "${outPath}"`,
      30_000,
      `Screen label ${text.slice(0, 12)} scene ${sceneIndex}`
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
      return { path: outPath, w: W, h: H, x: 0, y: 0 };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Interval labels as positioned overlay clips (works on Railway batched compose). */
export async function buildIntervalScreenLabelOverlays(
  labels: TimedYearLabel[],
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<TimedOverlay[]> {
  /**
   * RONDE 113 — every label below draws characters.
   *
   * Both of these were reachable only through screenLabelsEnabled() at the call site, and that
   * gate is now closed too. The check is repeated HERE because a call-site gate is one `if` a
   * future caller can forget, and this builder's whole output is text.
   */
  if (!burnedInTextAllowed()) return [];
  const overlays: TimedOverlay[] = [];
  for (let i = 0; i < labels.length; i++) {
    const entry = labels[i]!;
    const display = labelTextForEntry(entry).toUpperCase();
    if (display.length < 1) continue;
    const clip = await renderYellowTypewriterLabelClip(
      display,
      sceneIndex,
      i,
      workDir,
      ffmpegBin,
      execWithTimeout
    );
    if (!clip) continue;
    overlays.push({
      path: clip.path,
      startTime: entry.startTime,
      endTime: entry.endTime,
      overlayX: clip.x,
      overlayY: clip.y,
      overlayW: clip.w,
      overlayH: clip.h,
      isScreenLabel: true,
      isVideoOverlay: true,
    });
  }
  return overlays;
}

/** Year badges timed to the beat when the year is spoken (bottom-left overlay). */
export async function buildBeatAlignedYearOverlays(
  beats: BeatYearInput[],
  montageDurations: number[],
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number,
  xfadeSec = 0
): Promise<TimedOverlay[]> {
  /**
   * RONDE 113 — every label below draws characters.
   *
   * Both of these were reachable only through screenLabelsEnabled() at the call site, and that
   * gate is now closed too. The check is repeated HERE because a call-site gate is one `if` a
   * future caller can forget, and this builder's whole output is text.
   */
  if (!burnedInTextAllowed()) return [];
  const overlays: TimedOverlay[] = [];
  const n = Math.min(beats.length, montageDurations.length);
  if (n === 0) return overlays;
  const starts = computeMontageBeatStarts(montageDurations.slice(0, n), xfadeSec);

  for (let i = 0; i < n; i++) {
    const years = extractYearsFromText(beats[i].text);
    if (!years.length) continue;
    const beatStart = starts[i] ?? 0;
    const beatDur = montageDurations[i] ?? beats[i].holdSec;
    for (let yi = 0; yi < years.length; yi++) {
      const year = years[yi];
      const startTime = Math.max(0.08, beatStart + 0.1 + yi * 0.05);
      const endTime = Math.min(sceneDuration - 0.12, beatStart + beatDur - 0.06);
      if (endTime <= startTime + 0.35) continue;
      const badge = await renderYearBadgeOverlay(
        year,
        sceneIndex,
        workDir,
        ffmpegBin,
        execWithTimeout,
        sceneDuration,
        i * 10 + yi,
        1,
        { startTime, endTime }
      );
      if (badge) overlays.push(badge);
    }
  }
  return overlays;
}

export async function renderYearBadgeOverlay(
  year: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number,
  slotIndex: number,
  slotCount: number,
  explicitTiming?: YearBadgeTiming
): Promise<TimedOverlay | null> {
  const safeYear = sanitizeForDrawtext(year, 8);
  const FONT_SIZE = 72;
  const PAD_X = 28;
  const PAD_Y = 18;
  const ACCENT_W = 4;
  const MARGIN_L = 48;
  const MARGIN_B = 52;
  const boxW = Math.round(safeYear.length * FONT_SIZE * 0.52 + PAD_X * 2 + ACCENT_W + 8);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = MARGIN_L;
  const boxY = DOC_STYLE_VIDEO_HEIGHT - boxH - MARGIN_B;

  const slot = sceneDuration / Math.max(1, slotCount);
  const startTime =
    explicitTiming?.startTime ?? Math.max(0.3, slotIndex * slot + 0.2);
  const endTime =
    explicitTiming?.endTime ??
    Math.min(sceneDuration - 0.25, startTime + Math.min(3.2, slot * 0.85));

  const pngPath = path.join(workDir, `scene_${sceneIndex}_year_${slotIndex}_${safeYear}.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${boxW}x${boxH}:rate=1" ` +
        `-vf "` +
        `drawbox=x=0:y=0:w=${boxW}:h=${boxH}:color=0x2A2A2A@0.92:t=fill,` +
        `drawbox=x=0:y=0:w=${ACCENT_W}:h=${boxH}:color=FF7A00@0.95:t=fill,` +
        `drawtext=text='${safeYear}':fontcolor=white:fontsize=${FONT_SIZE}:x=${ACCENT_W + PAD_X}:y=${PAD_Y}` +
        `" -frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Year badge ${year} scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return {
        path: pngPath,
        startTime,
        endTime,
        isYearBadge: true,
        fullFrame: false,
        overlayX: boxX,
        overlayY: boxY,
        overlayW: boxW,
        overlayH: boxH,
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

/** Build FFmpeg audio filter suffix mixing SFX cues into voice track. */
export function buildCinematicSfxAudioFilter(
  voiceLabel: string,
  sfxInputs: Array<{ inputIndex: number; timeSec: number; volume: number }>,
  voiceDurSec: number,
  outLabel = "aout"
): string {
  if (sfxInputs.length === 0) {
    return `[${voiceLabel}]atrim=0:${voiceDurSec.toFixed(3)},asetpts=PTS-STARTPTS[${outLabel}]`;
  }
  let chain = "";
  const mixLabels: string[] = [voiceLabel];
  sfxInputs.forEach((sfx, i) => {
    const delayMs = Math.round(sfx.timeSec * 1000);
    const lbl = `sfx${i}`;
    chain += `[${sfx.inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${sfx.volume.toFixed(2)},` +
      `atrim=0:0.35,asetpts=PTS-STARTPTS[${lbl}];`;
    mixLabels.push(lbl);
  });
  chain += `[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2:normalize=0,` +
    `atrim=0:${voiceDurSec.toFixed(3)},asetpts=PTS-STARTPTS[${outLabel}]`;
  return chain;
}
