/**
 * Text overlay system V3 — centered white typewriter highlights,
 * voice-synced timing, no background box, sparse selection.
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";
import {
  computeVoiceBeatWindows,
  extractYearsFromText,
  limitOnScreenText,
  TYPEWRITER_CHAR_SEC,
  type BeatLabelInput,
} from "./cinematicEffectsEngine";
import { DOC_STYLE_VIDEO_HEIGHT, DOC_STYLE_VIDEO_WIDTH } from "./documentaryStyle";
import { extractVoiceLabelTerms, termStartInBeat } from "./visualBeatTags";

export const STANDARD_IMAGE_ANIMATION = "slow_zoom_in" as const;
export const STANDARD_TRANSITION = "crossfade" as const;
export const STANDARD_CROSSFADE_MS = 400;

/** V3: large centered impact text — no box, no shadow. */
export const MG_OVERLAY_FONT_SIZE = 84;
export const MG_OVERLAY_MAX_WORDS = 3;
export const MG_OVERLAY_HOLD_AFTER_TYPE_SEC = 1.5;
export const MG_OVERLAY_FADE_OUT_SEC = 0.25;
/** Minimum gap between overlays — keeps usage sparse. */
export const MG_OVERLAY_MIN_GAP_SEC = 3.5;
/** @deprecated Use per-text hold timing; kept for tests referencing legacy constant. */
export const MG_OVERLAY_ON_SCREEN_SEC =
  MG_OVERLAY_HOLD_AFTER_TYPE_SEC + 4 * TYPEWRITER_CHAR_SEC;
export const MG_OVERLAY_MARGIN_L = 56;
export const MG_OVERLAY_MARGIN_B = 80;

export type MotionOverlayKind =
  | "year"
  | "percentage"
  | "amount"
  | "statistic"
  | "keyword"
  | "country"
  | "person"
  | "event";

export type MotionOverlayPlan = {
  text: string;
  animation: "typewriter";
  position: "center";
  trigger_word: string;
  kind: MotionOverlayKind;
  start_time: number;
  end_time: number;
};

export type MotionGraphicsScenePlan = {
  scene_id: number;
  start_time: number;
  end_time: number;
  visual_description?: string;
  image_animation: typeof STANDARD_IMAGE_ANIMATION;
  transition: typeof STANDARD_TRANSITION;
  overlays: MotionOverlayPlan[];
};

type OverlayCandidate = {
  text: string;
  trigger_word: string;
  kind: MotionOverlayKind;
  priority: number;
};

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "de", "het", "een", "en", "van", "op", "te", "dat", "die", "is", "zijn", "was",
  "wordt", "this", "that", "these", "those", "not", "no", "also", "very", "more",
  "maar", "dan", "door", "naar", "bij", "uit", "als", "om", "er", "nog", "wel",
]);

const PERSON_ENTRIES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bhitler\b|\badolf\b/i, label: "HITLER" },
  { pattern: /\bstalin\b/i, label: "STALIN" },
  { pattern: /\bchurchill\b/i, label: "CHURCHILL" },
  { pattern: /\brommel\b/i, label: "ROMMEL" },
  { pattern: /\beisenhower\b/i, label: "EISENHOWER" },
  { pattern: /\bgoebbels\b/i, label: "GOEBBELS" },
  { pattern: /\btruman\b/i, label: "TRUMAN" },
  { pattern: /\broosevelt\b|\bfdr\b/i, label: "ROOSEVELT" },
  { pattern: /\bmao\b|\bmao zedong\b/i, label: "MAO" },
  { pattern: /\bnapoleon\b/i, label: "NAPOLEON" },
  { pattern: /\bkennedy\b|\bjfk\b/i, label: "KENNEDY" },
  { pattern: /\bputin\b/i, label: "PUTIN" },
  { pattern: /\btrump\b/i, label: "TRUMP" },
  { pattern: /\bbiden\b/i, label: "BIDEN" },
  { pattern: /\bmusk\b|\belon\b/i, label: "MUSK" },
];

const EVENT_ENTRIES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\binvasie\b|\binvasion\b/i, label: "INVASIE" },
  { pattern: /\bmislukt\b|\bfailed\b|\bfailure\b|\bfaalde\b/i, label: "MISLUKT" },
  { pattern: /\bholocaust\b/i, label: "HOLOCAUST" },
  { pattern: /\bd-day\b|\bdddag\b/i, label: "D-DAY" },
  { pattern: /\bblitzkrieg\b/i, label: "BLITZKRIEG" },
  { pattern: /\bsurrender\b|\bovergave\b|\bcapitulatie\b/i, label: "OVERGAVE" },
  { pattern: /\bgenocide\b|\bvolkenmoord\b/i, label: "GENOCIDE" },
  { pattern: /\bbombardement\b|\bbombing\b|\bbombardment\b/i, label: "BOMBARDEMENT" },
  { pattern: /\bstrategische fout\b|\bstrategic mistake\b|\bstrategic error\b/i, label: "STRATEGISCHE FOUT" },
  { pattern: /\boorlog\b|\bworld war\b|\bwereldoorlog\b/i, label: "OORLOG" },
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function displayOverlayText(raw: string): string {
  const limited = limitOnScreenText(raw.replace(/\s+/g, " ").trim(), MG_OVERLAY_MAX_WORDS);
  if (!limited) return "";
  return limited.toUpperCase();
}

function normalizePercentDisplay(raw: string): string {
  const num = raw.match(/[\d.,]+/)?.[0]?.replace(",", ".") ?? "";
  if (!num) return displayOverlayText(raw);
  const n = parseFloat(num);
  if (Number.isNaN(n)) return displayOverlayText(raw);
  const rounded = Number.isInteger(n) ? String(Math.round(n)) : String(n);
  return `${rounded}%`;
}

function normalizeEuroDisplay(raw: string): string {
  return displayOverlayText(raw.replace(/\s+/g, " ").trim());
}

function overlayTotalDurationSec(text: string): number {
  const safe = sanitizeForDrawtext(text, 24);
  return safe.length * TYPEWRITER_CHAR_SEC + MG_OVERLAY_HOLD_AFTER_TYPE_SEC;
}

/** Resolve bundled Bebas Neue (or OVERLAY_FONT_PATH) for FFmpeg drawtext. */
export function overlayFontDrawtextSuffix(): string {
  const envPath = process.env.OVERLAY_FONT_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    const escaped = envPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    return `:fontfile='${escaped}'`;
  }
  const candidates = [
    path.join(__dirname, "assets", "fonts", "BebasNeue-Regular.ttf"),
    path.join(process.cwd(), "server", "assets", "fonts", "BebasNeue-Regular.ttf"),
  ];
  for (const fontPath of candidates) {
    if (!fs.existsSync(fontPath)) continue;
    const escaped = fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    return `:fontfile='${escaped}'`;
  }
  return "";
}

/** Detect years, %, amounts, places, people, events, and power keywords. Max 3 words each. */
export function extractMotionOverlayCandidates(
  beatText: string,
  beat?: BeatLabelInput
): OverlayCandidate[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const out: OverlayCandidate[] = [];
  const seen = new Set<string>();

  const push = (c: OverlayCandidate) => {
    const text = displayOverlayText(c.text);
    if (!text || wordCount(text) > MG_OVERLAY_MAX_WORDS) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, text });
  };

  for (const year of extractYearsFromText(cleaned)) {
    push({ text: year, trigger_word: year, kind: "year", priority: 100 });
  }

  const pctRe = /\d[\d.,]*\s*(?:%|procent|percent)/gi;
  let m: RegExpExecArray | null;
  while ((m = pctRe.exec(cleaned)) !== null) {
    push({
      text: normalizePercentDisplay(m[0]),
      trigger_word: m[0].trim(),
      kind: "percentage",
      priority: 95,
    });
  }

  const euroRe =
    /€\s*[\d.,]+(?:\s*(?:miljoen|miljard|million|billion|mrd|mln|k|K|M|B))?/gi;
  while ((m = euroRe.exec(cleaned)) !== null) {
    push({
      text: normalizeEuroDisplay(m[0]),
      trigger_word: m[0].trim(),
      kind: "amount",
      priority: 90,
    });
  }

  const dollarRe =
    /\$\s*[\d.,]+(?:\s*(?:miljoen|miljard|million|billion|mrd|mln|k|K|M|B))?/gi;
  while ((m = dollarRe.exec(cleaned)) !== null) {
    push({
      text: normalizeEuroDisplay(m[0]),
      trigger_word: m[0].trim(),
      kind: "amount",
      priority: 88,
    });
  }

  const scaleRe =
    /\b[\d.,]+\s+(?:miljoen|miljard|million|billion|duizend|thousand|mln|mrd)\b/gi;
  while ((m = scaleRe.exec(cleaned)) !== null) {
    const raw = m[0].replace(/\s+/g, " ").trim();
    if (wordCount(raw) <= MG_OVERLAY_MAX_WORDS) {
      push({
        text: raw,
        trigger_word: m[0].trim(),
        kind: "statistic",
        priority: 82,
      });
    }
  }

  for (const term of extractVoiceLabelTerms(cleaned)) {
    const label = term.label.trim();
    if (label.length < 2 || wordCount(label) > MG_OVERLAY_MAX_WORDS) continue;
    push({
      text: label,
      trigger_word: term.matchText ?? label,
      kind: "country",
      priority: 85,
    });
  }

  for (const entry of PERSON_ENTRIES) {
    const match = cleaned.match(entry.pattern);
    if (!match) continue;
    push({
      text: entry.label,
      trigger_word: match[0].trim(),
      kind: "person",
      priority: 80,
    });
  }

  for (const entry of EVENT_ENTRIES) {
    const match = cleaned.match(entry.pattern);
    if (!match) continue;
    push({
      text: entry.label,
      trigger_word: match[0].trim(),
      kind: "event",
      priority: 75,
    });
  }

  const pw = beat?.powerWord?.trim();
  if (pw && pw.length >= 3 && !/^\d{4}$/.test(pw) && !STOP_WORDS.has(pw.toLowerCase())) {
    push({
      text: pw,
      trigger_word: pw,
      kind: "keyword",
      priority: 55,
    });
  }

  for (const hw of beat?.highlightWords ?? []) {
    const w = hw?.trim();
    if (!w || w.length < 4 || STOP_WORDS.has(w.toLowerCase())) continue;
    push({
      text: w,
      trigger_word: w,
      kind: "keyword",
      priority: 50,
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

function resolveOverlayTiming(
  beatText: string,
  candidate: OverlayCandidate,
  beatStart: number,
  beatDur: number
): { start: number; end: number } {
  const start = termStartInBeat(beatText, candidate.text, beatStart, beatDur, candidate.trigger_word);
  const end = start + overlayTotalDurationSec(candidate.text);
  return { start, end };
}

function resolveOverlappingOverlays(
  overlays: MotionOverlayPlan[],
  timelineEnd: number
): MotionOverlayPlan[] {
  const sorted = [...overlays].sort((a, b) => a.start_time - b.start_time);
  let lastEnd = -Infinity;
  const out: MotionOverlayPlan[] = [];
  for (const o of sorted) {
    let start = o.start_time;
    if (start < lastEnd + MG_OVERLAY_MIN_GAP_SEC) {
      start = lastEnd + MG_OVERLAY_MIN_GAP_SEC;
    }
    const end = Math.min(timelineEnd - 0.08, start + overlayTotalDurationSec(o.text));
    if (end <= start + 0.25) continue;
    out.push({ ...o, start_time: start, end_time: end });
    lastEnd = end;
  }
  return out;
}

/** Keep only the strongest overlay per beat, then cap count for the scene. */
function sparseSelectOverlays(
  overlays: MotionOverlayPlan[],
  sceneDurationSec: number
): MotionOverlayPlan[] {
  const maxOverlays = Math.max(1, Math.min(5, Math.floor(sceneDurationSec / 8)));
  const sorted = [...overlays].sort((a, b) => {
    const pri = (k: MotionOverlayKind) =>
      ({
        year: 100,
        percentage: 95,
        amount: 90,
        country: 85,
        statistic: 82,
        person: 80,
        event: 75,
        keyword: 50,
      })[k] ?? 0;
    return pri(b.kind) - pri(a.kind) || a.start_time - b.start_time;
  });
  const picked: MotionOverlayPlan[] = [];
  for (const o of sorted) {
    if (picked.length >= maxOverlays) break;
    const tooClose = picked.some(
      (p) => Math.abs(p.start_time - o.start_time) < MG_OVERLAY_MIN_GAP_SEC
    );
    if (tooClose) continue;
    picked.push(o);
  }
  return picked.sort((a, b) => a.start_time - b.start_time);
}

/** Voice-synced overlay plan for one scene (V3: centered white typewriter). */
export function planMotionGraphicsScene(
  sceneId: number,
  sceneStartSec: number,
  sceneDurationSec: number,
  beats: BeatLabelInput[],
  visualDescription?: string
): MotionGraphicsScenePlan {
  const overlays: MotionOverlayPlan[] = [];
  if (beats.length > 0 && sceneDurationSec > 0) {
    const windows = computeVoiceBeatWindows(beats, sceneDurationSec, 0);
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i]!;
      const beatStart = windows[i]!.start;
      const beatDur = windows[i]!.dur;
      const candidates = extractMotionOverlayCandidates(beat.text, beat);
      if (candidates.length === 0) continue;
      const best = candidates[0]!;
      const { start, end } = resolveOverlayTiming(beat.text, best, beatStart, beatDur);
      overlays.push({
        text: best.text,
        animation: "typewriter",
        position: "center",
        trigger_word: best.trigger_word,
        kind: best.kind,
        start_time: start,
        end_time: end,
      });
    }
  }

  const sparse = sparseSelectOverlays(overlays, sceneDurationSec);
  const localOverlays = resolveOverlappingOverlays(sparse, sceneDurationSec);

  return {
    scene_id: sceneId,
    start_time: sceneStartSec,
    end_time: sceneStartSec + sceneDurationSec,
    visual_description: visualDescription?.trim() || undefined,
    image_animation: STANDARD_IMAGE_ANIMATION,
    transition: STANDARD_TRANSITION,
    overlays: localOverlays.map((o) => ({
      ...o,
      start_time: sceneStartSec + o.start_time,
      end_time: sceneStartSec + o.end_time,
    })),
  };
}

export function motionGraphicsScenePlansToMetadata(
  plans: MotionGraphicsScenePlan[]
): Record<string, unknown> {
  return { motionGraphicsScenes: plans };
}

export function parseMotionGraphicsScenesFromMetadata(metadata: unknown): MotionGraphicsScenePlan[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).motionGraphicsScenes;
  if (!Array.isArray(raw)) return [];
  const out: MotionGraphicsScenePlan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const overlaysRaw = row.overlays;
    if (!Array.isArray(overlaysRaw)) continue;
    const overlays: MotionOverlayPlan[] = [];
    for (const o of overlaysRaw) {
      if (!o || typeof o !== "object") continue;
      const ov = o as Record<string, unknown>;
      const text = String(ov.text ?? "").trim();
      if (!text) continue;
      overlays.push({
        text: displayOverlayText(text),
        animation: "typewriter",
        position: "center",
        trigger_word: String(ov.trigger_word ?? text).trim(),
        kind: (String(ov.kind ?? "keyword") as MotionOverlayKind) || "keyword",
        start_time: Number(ov.start_time ?? 0),
        end_time: Number(ov.end_time ?? 0),
      });
    }
    out.push({
      scene_id: Number(row.scene_id ?? 0),
      start_time: Number(row.start_time ?? 0),
      end_time: Number(row.end_time ?? 0),
      visual_description: String(row.visual_description ?? "").trim() || undefined,
      image_animation: STANDARD_IMAGE_ANIMATION,
      transition: STANDARD_TRANSITION,
      overlays,
    });
  }
  return out;
}

/** Fixed crossfade duration (seconds) for all montage transitions. */
export function standardMontageCrossfadeSec(): number {
  const raw = process.env.MONTAGE_CROSSFADE_MS?.trim();
  if (raw) {
    const ms = parseInt(raw, 10);
    if (!isNaN(ms) && ms >= 300 && ms <= 500) return ms / 1000;
  }
  return STANDARD_CROSSFADE_MS / 1000;
}

/** FFmpeg xfade transition name — single crossfade style for all joins. */
export function standardMontageTransitionName(): "dissolve" {
  return "dissolve";
}

function ensureEvenDim(n: number, min = 2): number {
  const v = Math.max(min, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

/** V3 drawtext chain — centered, white, typewriter + hold + fade, no box/shadow. */
export function buildWhiteTypewriterDrawtextFilterChain(
  inLabel: string,
  outLabel: string,
  overlays: MotionOverlayPlan[]
): string {
  if (!overlays.length) return `;[${inLabel}]copy[${outLabel}]`;

  let chain = "";
  let prev = inLabel;
  const valid = overlays.filter((o) => o.text.trim().length > 0);
  if (!valid.length) return `;[${inLabel}]copy[${outLabel}]`;

  const FS = MG_OVERLAY_FONT_SIZE;
  const x = "(w-text_w)/2";
  const y = "(h-text_h)/2";
  const fontArg = overlayFontDrawtextSuffix();

  valid.forEach((entry, i) => {
    const safeFull = sanitizeForDrawtext(entry.text, 24);
    if (safeFull.length < 1) return;

    const next = i === valid.length - 1 ? outLabel : `mg${i}`;
    const charSec = TYPEWRITER_CHAR_SEC;
    const typeEnd = entry.start_time + safeFull.length * charSec;
    const holdEnd = Math.min(entry.end_time, typeEnd + MG_OVERLAY_HOLD_AFTER_TYPE_SEC);
    const fadeStart = Math.max(typeEnd, holdEnd - MG_OVERLAY_FADE_OUT_SEC);
    const fadeDur = MG_OVERLAY_FADE_OUT_SEC.toFixed(3);
    const alphaExpr =
      `if(lt(t\\,${fadeStart.toFixed(3)})\\,1\\,max(0\\,1-(t-${fadeStart.toFixed(3)})/${fadeDur}))`;

    let step = prev;
    const len = safeFull.length;

    for (let k = 1; k < len; k++) {
      const sub = sanitizeForDrawtext(safeFull.slice(0, k), k);
      const t0 = entry.start_time + (k - 1) * charSec;
      const t1 = entry.start_time + k * charSec;
      const charOut = `mgt${i}_${k}`;
      const charEnable = `enable='between(t\\,${t0.toFixed(3)}\\,${t1.toFixed(3)})'`;
      chain +=
        `;[${step}]drawtext=text='${sub}':fontcolor=white:fontsize=${FS}${fontArg}:` +
        `x=${x}:y=${y}:box=0:${charEnable}[${charOut}]`;
      step = charOut;
    }

    const finalT0 = entry.start_time + Math.max(0, len - 1) * charSec;
    const finalEnable = `enable='between(t\\,${finalT0.toFixed(3)}\\,${holdEnd.toFixed(3)})'`;
    chain +=
      `;[${step}]drawtext=text='${safeFull}':fontcolor=white:fontsize=${FS}${fontArg}:` +
      `x=${x}:y=${y}:box=0:alpha='${alphaExpr}':${finalEnable}[${next}]`;
    prev = next;
  });
  return chain;
}

/** Burn voice-synced V3 overlays onto a montage clip. */
export async function burnMotionGraphicsOverlaysDrawtext(
  inputVideoPath: string,
  outputVideoPath: string,
  overlays: MotionOverlayPlan[],
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<string> {
  if (!overlays.length) {
    if (inputVideoPath !== outputVideoPath) {
      fs.copyFileSync(inputVideoPath, outputVideoPath);
    }
    return outputVideoPath;
  }
  const drawChain = buildWhiteTypewriterDrawtextFilterChain("0:v", "vout", overlays);
  await execWithTimeout(
    `${ffmpegBin} -y -i "${inputVideoPath}" -filter_complex "${drawChain.slice(1)}" ` +
      `-map "[vout]" -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -an "${outputVideoPath}"`,
    180_000,
    `Burn motion graphics overlays (${overlays.length})`
  );
  return outputVideoPath;
}

/** Pre-render transparent overlay clips for batched compose (centered typewriter). */
export async function buildMotionGraphicsTypewriterOverlays(
  plan: MotionGraphicsScenePlan,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<
  Array<{
    path: string;
    startTime: number;
    endTime: number;
    overlayX: number;
    overlayY: number;
    overlayW: number;
    overlayH: number;
  }>
> {
  const out: Array<{
    path: string;
    startTime: number;
    endTime: number;
    overlayX: number;
    overlayY: number;
    overlayW: number;
    overlayH: number;
  }> = [];

  const fontArg = overlayFontDrawtextSuffix();

  for (let i = 0; i < plan.overlays.length; i++) {
    const entry = plan.overlays[i]!;
    const safe = sanitizeForDrawtext(entry.text, 24);
    if (safe.length < 1) continue;

    const FS = MG_OVERLAY_FONT_SIZE;
    const w = ensureEvenDim(DOC_STYLE_VIDEO_WIDTH);
    const h = ensureEvenDim(DOC_STYLE_VIDEO_HEIGHT);
    const dur = Math.max(0.5, entry.end_time - entry.start_time);
    const outPath = path.join(workDir, `scene_${sceneIndex}_mg_overlay_${i}.mp4`);
    const charSec = TYPEWRITER_CHAR_SEC;
    const typeEnd = safe.length * charSec;
    const holdEnd = Math.min(dur, typeEnd + MG_OVERLAY_HOLD_AFTER_TYPE_SEC);
    const fadeStart = Math.max(typeEnd, holdEnd - MG_OVERLAY_FADE_OUT_SEC);
    const fadeDur = MG_OVERLAY_FADE_OUT_SEC.toFixed(3);
    const alphaExpr =
      `if(lt(t\\,${fadeStart.toFixed(3)})\\,1\\,max(0\\,1-(t-${fadeStart.toFixed(3)})/${fadeDur}))`;
    const x = "(w-text_w)/2";
    const y = "(h-text_h)/2";

    let chain = "";
    let prev = "0:v";
    const len = safe.length;

    for (let k = 1; k < len; k++) {
      const sub = sanitizeForDrawtext(safe.slice(0, k), k);
      const t0 = ((k - 1) * charSec).toFixed(3);
      const t1 = (k * charSec).toFixed(3);
      const outLabel = `mg${i}_${k}`;
      chain +=
        `[${prev}]drawtext=text='${sub}':fontcolor=white:fontsize=${FS}${fontArg}:` +
        `x=${x}:y=${y}:box=0:enable='between(t\\,${t0}\\,${t1})'[${outLabel}];`;
      prev = outLabel;
    }

    const finalT0 = Math.max(0, len - 1) * charSec;
    chain +=
      `[${prev}]drawtext=text='${safe}':fontcolor=white:fontsize=${FS}${fontArg}:` +
      `x=${x}:y=${y}:box=0:alpha='${alphaExpr}':enable='between(t\\,${finalT0.toFixed(3)}\\,${holdEnd.toFixed(3)})'[vout];`;

    try {
      await execWithTimeout(
        `${ffmpegBin} -y -f lavfi -i "color=c=black@0.0:s=${w}x${h}:r=25:d=${dur.toFixed(2)}" ` +
          `-filter_complex "${chain.slice(0, -1)}" -map "[vout]" -t ${dur.toFixed(2)} ` +
          `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuva420p "${outPath}"`,
        25_000,
        `Motion overlay ${entry.text.slice(0, 12)} scene ${sceneIndex}`
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
        out.push({
          path: outPath,
          startTime: entry.start_time,
          endTime: entry.end_time,
          overlayX: 0,
          overlayY: 0,
          overlayW: w,
          overlayH: h,
        });
      }
    } catch {
      /* fall through */
    }
  }
  return out;
}

export function mergeMotionGraphicsIntoMetadata(
  metadata: unknown,
  plans: MotionGraphicsScenePlan[]
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (plans.length > 0) {
    base.motionGraphicsScenes = plans;
  }
  return base;
}
