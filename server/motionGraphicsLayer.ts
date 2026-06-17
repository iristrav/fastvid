/**
 * Automatic motion graphics layer — minimalist white typewriter overlays,
 * voice-synced timing, consistent image animation + crossfade metadata.
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";
import {
  computeVoiceBeatWindows,
  extractYearsFromText,
  limitOnScreenText,
  MAX_ONSCREEN_WORDS,
  TYPEWRITER_CHAR_SEC,
  type BeatLabelInput,
} from "./cinematicEffectsEngine";
import { DOC_STYLE_VIDEO_HEIGHT } from "./documentaryStyle";
import { termStartInBeat } from "./visualBeatTags";

export const STANDARD_IMAGE_ANIMATION = "slow_zoom_in" as const;
export const STANDARD_TRANSITION = "crossfade" as const;
export const STANDARD_CROSSFADE_MS = 400;

export const MG_OVERLAY_FONT_SIZE = 68;
export const MG_OVERLAY_MARGIN_L = 56;
export const MG_OVERLAY_MARGIN_B = 80;
export const MG_OVERLAY_ON_SCREEN_SEC = 3.8;
export const MG_OVERLAY_MIN_GAP_SEC = 0.35;

export type MotionOverlayKind =
  | "year"
  | "percentage"
  | "amount"
  | "statistic"
  | "keyword"
  | "quote";

export type MotionOverlayPlan = {
  text: string;
  animation: "typewriter";
  position: "bottom_left";
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
]);

function normalizePercentDisplay(raw: string): string {
  const num = raw.match(/[\d.,]+/)?.[0]?.replace(",", ".") ?? "";
  if (!num) return raw.trim().slice(0, 12);
  const n = parseFloat(num);
  if (Number.isNaN(n)) return raw.trim().slice(0, 12);
  const rounded = Number.isInteger(n) ? String(Math.round(n)) : String(n);
  return `${rounded}%`;
}

function normalizeEuroDisplay(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 22);
}

/** Detect years, %, amounts, stats, and power keywords from narration. */
export function extractMotionOverlayCandidates(
  beatText: string,
  beat?: BeatLabelInput
): OverlayCandidate[] {
  const cleaned = beatText.replace(/\[visual:[^\]]+\]/gi, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const out: OverlayCandidate[] = [];
  const seen = new Set<string>();

  const push = (c: OverlayCandidate) => {
    const text = limitOnScreenText(c.text, MAX_ONSCREEN_WORDS);
    if (!text) return;
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
    /\b[\d.,]+\s+(?:miljoen|miljard|million|billion|duizend|thousand|miljard|mln|mrd)\b/gi;
  while ((m = scaleRe.exec(cleaned)) !== null) {
    push({
      text: m[0].replace(/\s+/g, " ").trim().slice(0, 22),
      trigger_word: m[0].trim(),
      kind: "statistic",
      priority: 82,
    });
  }

  const countRe =
    /\b[\d.,]+\s+(?:people|users|customers|bedrijven|companies|doden|slachtoffers|victims|soldiers|tanks|planes)\b/gi;
  while ((m = countRe.exec(cleaned)) !== null) {
    push({
      text: m[0].replace(/\s+/g, " ").trim().slice(0, 22),
      trigger_word: m[0].trim(),
      kind: "statistic",
      priority: 78,
    });
  }

  const pw = beat?.powerWord?.trim();
  if (pw && pw.length >= 3 && !/^\d{4}$/.test(pw) && !STOP_WORDS.has(pw.toLowerCase())) {
    push({
      text: limitOnScreenText(pw.toUpperCase(), MAX_ONSCREEN_WORDS),
      trigger_word: pw,
      kind: "keyword",
      priority: 55,
    });
  }

  for (const hw of beat?.highlightWords ?? []) {
    const w = hw?.trim();
    if (!w || w.length < 4 || STOP_WORDS.has(w.toLowerCase())) continue;
    push({
      text: limitOnScreenText(w.toUpperCase(), MAX_ONSCREEN_WORDS),
      trigger_word: w,
      kind: "keyword",
      priority: 50,
    });
  }

  const quoteRe = /"([^"]{8,60})"|'([^']{8,60})'/g;
  while ((m = quoteRe.exec(cleaned)) !== null) {
    const quote = (m[1] ?? m[2] ?? "").trim();
    if (quote.length >= 8) {
      push({
        text: limitOnScreenText(quote, MAX_ONSCREEN_WORDS),
        trigger_word: limitOnScreenText(quote, MAX_ONSCREEN_WORDS),
        kind: "quote",
        priority: 72,
      });
    }
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
  const end = start + MG_OVERLAY_ON_SCREEN_SEC;
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
    const end = Math.min(timelineEnd - 0.08, start + MG_OVERLAY_ON_SCREEN_SEC);
    if (end <= start + 0.25) continue;
    out.push({ ...o, start_time: start, end_time: end });
    lastEnd = end;
  }
  return out;
}

/** Voice-synced overlay plan for one scene (white typewriter, bottom-left). */
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
      for (const candidate of extractMotionOverlayCandidates(beat.text, beat)) {
        const { start, end } = resolveOverlayTiming(beat.text, candidate, beatStart, beatDur);
        overlays.push({
          text: candidate.text,
          animation: "typewriter",
          position: "bottom_left",
          trigger_word: candidate.trigger_word,
          kind: candidate.kind,
          start_time: start,
          end_time: end,
        });
      }
    }
  }

  const localOverlays = resolveOverlappingOverlays(overlays, sceneDurationSec);

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
        text,
        animation: "typewriter",
        position: "bottom_left",
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

/** White typewriter drawtext chain — bottom-left, subtle shadow, no background box. */
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
  const x = MG_OVERLAY_MARGIN_L;
  const y = `h-${MG_OVERLAY_MARGIN_B}`;

  valid.forEach((entry, i) => {
    const safeFull = sanitizeForDrawtext(entry.text, 20);
    if (safeFull.length < 1) return;

    const next = i === valid.length - 1 ? outLabel : `mg${i}`;
    const enableFull = `enable='between(t\\,${entry.start_time.toFixed(2)}\\,${entry.end_time.toFixed(2)})'`;
    const typeEnd = Math.min(
      entry.end_time,
      entry.start_time + safeFull.length * TYPEWRITER_CHAR_SEC + 0.05
    );

    let step = prev;
    for (let k = 1; k <= safeFull.length; k++) {
      const sub = sanitizeForDrawtext(safeFull.slice(0, k), k);
      const t0 = entry.start_time + (k - 1) * TYPEWRITER_CHAR_SEC;
      const t1 = k < safeFull.length ? entry.start_time + k * TYPEWRITER_CHAR_SEC : typeEnd;
      const charOut = k === safeFull.length ? next : `mgt${i}_${k}`;
      const charEnable = `enable='between(t\\,${t0.toFixed(3)}\\,${t1.toFixed(3)})'`;
      chain +=
        `;[${step}]drawtext=text='${sub}':fontcolor=white:fontsize=${FS}:` +
        `shadowcolor=black@0.55:shadowx=2:shadowy=2:` +
        `x=${x}:y=${y}:box=0:${charEnable}[${charOut}]`;
      step = charOut;
    }
    prev = next;
  });
  return chain;
}

/** Burn voice-synced white typewriter overlays onto a montage clip. */
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

/** Pre-render transparent overlay clips for batched compose (white typewriter). */
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

  for (let i = 0; i < plan.overlays.length; i++) {
    const entry = plan.overlays[i]!;
    const safe = sanitizeForDrawtext(entry.text, 20);
    if (safe.length < 1) continue;

    const FS = MG_OVERLAY_FONT_SIZE;
    const w = ensureEvenDim(Math.min(720, Math.round(safe.length * FS * 0.58 + 16)));
    const h = ensureEvenDim(FS + 24);
    const textY = Math.max(8, Math.round((h - FS) / 2));
    const dur = Math.max(0.5, entry.end_time - entry.start_time);
    const outPath = path.join(workDir, `scene_${sceneIndex}_mg_overlay_${i}.mp4`);

    let chain = "";
    let prev = "0:v";
    for (let k = 1; k <= safe.length; k++) {
      const sub = sanitizeForDrawtext(safe.slice(0, k), k);
      const t0 = ((k - 1) * TYPEWRITER_CHAR_SEC).toFixed(3);
      const t1 = (k < safe.length ? k * TYPEWRITER_CHAR_SEC : dur).toFixed(3);
      const outLabel = k === safe.length ? "vout" : `mg${i}_${k}`;
      chain +=
        `[${prev}]drawtext=text='${sub}':fontcolor=white:fontsize=${FS}:` +
        `shadowcolor=black@0.55:shadowx=2:shadowy=2:` +
        `x=8:y=${textY}:box=0:enable='between(t\\,${t0}\\,${t1})'[${outLabel}];`;
      prev = outLabel;
    }

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
          overlayX: MG_OVERLAY_MARGIN_L,
          overlayY: DOC_STYLE_VIDEO_HEIGHT - MG_OVERLAY_MARGIN_B - h,
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
