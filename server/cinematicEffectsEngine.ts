/**
 * Cinematic Effects Engine — content-aware zoom/pan hints, overlays, particles, SFX, animated text.
 * Years appear bottom-left in a documentary date-card style.
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";
import {
  DOC_STYLE_VIDEO_HEIGHT,
  DOC_STYLE_VIDEO_WIDTH,
  renderNameBadgeOverlay,
  type TimedOverlay,
} from "./documentaryStyle";
import { documentaryOverlaysEnabled } from "./sourcingPolicy";

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

/** On by default; set ENABLE_CINEMATIC_EFFECTS=false to disable. */
export function cinematicEffectsEnabled(): boolean {
  return process.env.ENABLE_CINEMATIC_EFFECTS !== "false";
}

/** Full-frame particle layer — off by default (can look like a dirty overlay). */
export function cinematicParticlesEnabled(): boolean {
  return process.env.ENABLE_CINEMATIC_PARTICLES === "true";
}

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

export function extractStatFromText(text: string): string | null {
  const money = text.match(/\$[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|M|B|K))?/i);
  if (money?.[0]) return money[0].trim().slice(0, 24);
  const pct = text.match(/\d[\d,.]*\s*(?:%|percent|procent)/i);
  if (pct?.[0]) return pct[0].trim().slice(0, 24);
  const count = text.match(/\b[\d,.]+\s+(?:people|soldiers|tanks|planes|victims|doden|slachtoffers)\b/i);
  if (count?.[0]) return count[0].trim().slice(0, 24);
  return null;
}

export function buildStatCountSteps(stat: string): string[] {
  const raw = stat.trim();
  const money = raw.match(/\$[\d,.]+(?:\s*(?:million|billion|miljoen|miljard|M|B|K))?/i)?.[0];
  if (money) {
    const suffix = /billion|miljard|B/i.test(money) ? "B" : /million|miljoen|M/i.test(money) ? "M" : "K";
    return [`$0`, `$100${suffix}`, `$300${suffix}`, `$700${suffix}`, money.replace(/\s+/g, " ").slice(0, 18)];
  }
  const pct = raw.match(/\d[\d,.]*\s*(?:%|percent|procent)/i)?.[0];
  if (pct) {
    const n = parseFloat(pct.replace(/[^\d.]/g, ""));
    if (!isNaN(n)) {
      return ["0%", `${Math.round(n * 0.25)}%`, `${Math.round(n * 0.5)}%`, `${Math.round(n * 0.75)}%`, pct.slice(0, 12)];
    }
  }
  return [raw.slice(0, 20)];
}

export type FacelessLine = { text: string; emphasis: boolean };

/** Split narration into faceless-channel subtitle lines (emphasis words larger). */
export function parseFacelessSubtitleLines(text: string, maxLines = 4): FacelessLine[] {
  const cleaned = text.replace(/\[visual:[^\]]+\]/gi, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= maxLines) {
    return words.map((w, i) => ({
      text: w.toUpperCase(),
      emphasis: i === 0 || w.length >= 5 || /^[A-Z]/.test(w),
    }));
  }
  const emphasisIdx = new Set<number>([0, words.length - 1]);
  emphasisIdx.add(Math.floor(words.length / 2));
  const chunk = Math.ceil(words.length / maxLines);
  const lines: FacelessLine[] = [];
  for (let i = 0; i < words.length && lines.length < maxLines; i += chunk) {
    const slice = words.slice(i, i + chunk);
    const line = slice.join(" ");
    lines.push({
      text: emphasisIdx.has(i) ? line.toUpperCase() : line,
      emphasis: emphasisIdx.has(i) || slice.some((w) => w.length >= 6),
    });
  }
  return lines;
}

export type FacelessSubtitlePlacement = "bottom-left" | "bottom-center";

const FACELESS_VIDEO_PREP_VF =
  `scale=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${DOC_STYLE_VIDEO_WIDTH}:${DOC_STYLE_VIDEO_HEIGHT}:(iw-${DOC_STYLE_VIDEO_WIDTH})/2:(ih-${DOC_STYLE_VIDEO_HEIGHT})/2,` +
  `fps=25,format=yuv420p,setsar=1`;

/** Drawtext filters for faceless kinetic subtitles (no PNG overlay — avoids FFmpeg auto_scale failures). */
export function buildFacelessDrawtextVF(
  lines: FacelessLine[],
  sceneDuration: number,
  placement: FacelessSubtitlePlacement = "bottom-left"
): string {
  if (!lines.length) return "";
  const startTime = 0.35;
  const endTime = Math.min(sceneDuration - 0.2, startTime + Math.min(4.5, sceneDuration * 0.55));
  const enable = `between(t\\,${startTime.toFixed(2)}\\,${endTime.toFixed(2)})`;
  const marginL = 56;
  const marginB = 72;
  const lineHeights = lines.map((line) => (line.emphasis ? 68 : 48));
  const totalH = lineHeights.reduce((s, h) => s + h, 0);
  const baseY = DOC_STYLE_VIDEO_HEIGHT - marginB - totalH;
  return lines
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line.text, 36);
      const fs = line.emphasis ? 58 : 38;
      const y = baseY + lineHeights.slice(0, i).reduce((s, h) => s + h, 0);
      const x = placement === "bottom-center" ? "(w-text_w)/2" : String(marginL);
      const color = line.emphasis ? "white" : "0xDDDDDD";
      return `drawtext=text='${safe}':fontcolor=${color}:fontsize=${fs}:x=${x}:y=${y}:enable='${enable}'`;
    })
    .join(",");
}

export async function renderFacelessSubtitleOverlay(
  lines: FacelessLine[],
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number,
  placement: FacelessSubtitlePlacement = "bottom-left"
): Promise<TimedOverlay | null> {
  if (!lines.length) return null;
  const startTime = 0.35;
  const endTime = Math.min(sceneDuration - 0.2, startTime + Math.min(4.5, sceneDuration * 0.55));
  const pngPath = path.join(workDir, `scene_${sceneIndex}_faceless_sub.png`);
  const marginL = 56;
  const marginB = 72;
  const lineHeights = lines.map((line) => (line.emphasis ? 68 : 48));
  const totalH = lineHeights.reduce((s, h) => s + h, 0);
  const baseY = DOC_STYLE_VIDEO_HEIGHT - marginB - totalH;
  const draws = lines
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line.text, 36);
      const fs = line.emphasis ? 58 : 38;
      const y = baseY + lineHeights.slice(0, i).reduce((s, h) => s + h, 0);
      const x = placement === "bottom-center" ? "(w-text_w)/2" : String(marginL);
      const color = line.emphasis ? "white" : "0xDDDDDD";
      return `drawtext=text='${safe}':fontcolor=${color}:fontsize=${fs}:x=${x}:y=${y}`;
    })
    .join(",");
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "${draws}" -frames:v 1 -pix_fmt rgba "${pngPath}"`,
      10_000,
      `Faceless subs scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return { path: pngPath, startTime, endTime, fullFrame: true };
    }
  } catch {
    /* non-fatal */
  }
  return null;
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

  const drawtext = buildFacelessDrawtextVF(lines, holdSec, "bottom-left");
  if (!drawtext) return clipPath;

  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_vtext.mp4`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -i "${clipPath}" -t ${holdSec.toFixed(3)} ` +
        `-vf "${FACELESS_VIDEO_PREP_VF},${drawtext}" ` +
        `-an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 "${outPath}"`,
      45_000,
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

export async function renderCameraFlashOverlay(
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  flashTime: number,
  sceneDuration: number
): Promise<TimedOverlay | null> {
  const pngPath = path.join(workDir, `scene_${sceneIndex}_flash.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=white@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "colorchannelmixer=aa=0.55" -frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Camera flash scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return {
        path: pngPath,
        startTime: Math.max(0, flashTime),
        endTime: Math.min(sceneDuration, flashTime + 0.12),
        fullFrame: true,
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function renderStatStepOverlay(
  stat: string,
  sceneIndex: number,
  stepIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  startTime: number,
  endTime: number
): Promise<TimedOverlay | null> {
  const safeStat = sanitizeForDrawtext(stat.trim().toUpperCase(), 24);
  const FONT_SIZE = 56;
  const PAD_X = 28;
  const PAD_Y = 16;
  const MARGIN = 48;
  const estW = Math.min(safeStat.length * FONT_SIZE * 0.55, DOC_STYLE_VIDEO_WIDTH / 2);
  const boxW = Math.round(estW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = DOC_STYLE_VIDEO_WIDTH - boxW - MARGIN;
  const boxY = DOC_STYLE_VIDEO_HEIGHT - boxH - MARGIN;
  const pngPath = path.join(workDir, `scene_${sceneIndex}_stat_${stepIndex}.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.96:t=fill,` +
        `drawtext=text='${safeStat}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Stat step ${stepIndex} scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return {
        path: pngPath,
        startTime,
        endTime,
        isStatCallout: true,
        fullFrame: true,
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function renderAnimatedHeadlineOverlay(
  headline: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number
): Promise<TimedOverlay | null> {
  const safe = sanitizeForDrawtext(headline.toUpperCase().slice(0, 48), 48);
  const FONT_SIZE = 52;
  const pngPath = path.join(workDir, `scene_${sceneIndex}_headline_card.png`);
  const startTime = 0.5;
  const endTime = Math.min(sceneDuration - 0.3, startTime + 3.2);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=280:y=420:w=1360:h=120:color=0x141818@0.88:t=fill,` +
        `drawtext=text='${safe}':fontcolor=0xFFD200:fontsize=${FONT_SIZE}:x=(w-text_w)/2:y=455" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Headline card scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return { path: pngPath, startTime, endTime, fullFrame: true };
    }
  } catch {
    /* non-fatal */
  }
  return null;
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

export type BeatYearInput = { text: string; holdSec: number };

export type TimedYearLabel = { year: string; startTime: number; endTime: number };

/** Year labels on the voice timeline (when the year is spoken). */
export function planBeatAlignedYears(beats: BeatYearInput[], sceneDuration: number): TimedYearLabel[] {
  const labels: TimedYearLabel[] = [];
  let voiceT = 0;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const years = extractYearsFromText(beat.text);
    const beatStart = voiceT;
    voiceT += beat.holdSec;
    for (let yi = 0; yi < years.length; yi++) {
      const startTime = Math.max(0.08, beatStart + 0.12 + yi * 0.05);
      const endTime = Math.min(sceneDuration - 0.1, beatStart + beat.holdSec - 0.05);
      if (endTime > startTime + 0.35) {
        labels.push({ year: years[yi], startTime, endTime });
      }
    }
  }
  return labels;
}

/** Burn year numbers on B-roll — white text + shadow, no black box over the video. */
export function buildYearDrawtextFilterChain(
  inLabel: string,
  outLabel: string,
  years: TimedYearLabel[]
): string {
  if (!years.length) return `;[${inLabel}]copy[${outLabel}]`;
  let chain = "";
  let prev = inLabel;
  years.forEach((entry, i) => {
    const next = i === years.length - 1 ? outLabel : `yr${i}`;
    const safe = sanitizeForDrawtext(entry.year, 8);
    const enable = `enable='between(t\\,${entry.startTime.toFixed(2)}\\,${entry.endTime.toFixed(2)})'`;
    chain +=
      `;[${prev}]drawtext=text='${safe}':fontcolor=white:fontsize=68:x=52:y=h-th-58:` +
      `borderw=3:bordercolor=0x00000066:box=0:${enable}[${next}]`;
    prev = next;
  });
  return chain;
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
        `drawbox=x=0:y=0:w=${boxW}:h=${boxH}:color=0x141418@0.88:t=fill,` +
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
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function renderKeywordPillOverlay(
  keyword: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number,
  slotIndex: number
): Promise<TimedOverlay | null> {
  const safeKw = sanitizeForDrawtext(keyword.toUpperCase(), 28);
  const FONT_SIZE = 44;
  const PAD_X = 22;
  const PAD_Y = 12;
  const estW = Math.min(safeKw.length * FONT_SIZE * 0.55, DOC_STYLE_VIDEO_WIDTH / 2);
  const boxW = Math.round(estW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = Math.round((DOC_STYLE_VIDEO_WIDTH - boxW) / 2);
  const boxY = Math.round(DOC_STYLE_VIDEO_HEIGHT * 0.12);

  const startTime = Math.max(0.6, sceneDuration * (0.2 + slotIndex * 0.25));
  const endTime = Math.min(sceneDuration - 0.3, startTime + 2.0);

  const pngPath = path.join(workDir, `scene_${sceneIndex}_kw_${slotIndex}.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.94:t=fill,` +
        `drawtext=text='${safeKw}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Keyword pill scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return { path: pngPath, startTime, endTime, fullFrame: true };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

/** Subtle film-dust particle layer (full frame, low opacity). */
export async function renderParticleDustOverlay(
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number
): Promise<TimedOverlay | null> {
  const pngPath = path.join(workDir, `scene_${sceneIndex}_particles.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "noise=alls=8:allf=t+u,format=rgba,colorchannelmixer=aa=0.12" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      10_000,
      `Particle dust scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return {
        path: pngPath,
        startTime: 0,
        endTime: sceneDuration,
        isParticle: true,
        fullFrame: true,
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function renderStatCalloutOverlay(
  stat: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<TimedOverlay | null> {
  const safeStat = sanitizeForDrawtext(stat.trim().toUpperCase(), 30);
  const FONT_SIZE = 56;
  const PAD_X = 32;
  const PAD_Y = 20;
  const MARGIN = 48;
  const estW = Math.min(safeStat.length * FONT_SIZE * 0.58, DOC_STYLE_VIDEO_WIDTH / 2);
  const boxW = Math.round(estW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = DOC_STYLE_VIDEO_WIDTH - boxW - MARGIN;
  const boxY = DOC_STYLE_VIDEO_HEIGHT - boxH - MARGIN;

  const pngPath = path.join(workDir, `scene_${sceneIndex}_cine_stat.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.96:t=fill,` +
        `drawtext=text='${safeStat}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`,
      8_000,
      `Cinematic stat scene ${sceneIndex}`
    );
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      return {
        path: pngPath,
        startTime: 1.0,
        endTime: 3.8,
        isStatCallout: true,
        fullFrame: true,
      };
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

export async function buildCinematicOverlays(
  plan: CinematicScenePlan,
  scene: SceneLike,
  durationSec: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  opts: { facelessSubs?: boolean; docOverlays?: boolean; videoTextOnly?: boolean; yearsOnly?: boolean } = {}
): Promise<TimedOverlay[]> {
  const overlays: TimedOverlay[] = [];
  const exec = execWithTimeout;

  if (opts.yearsOnly) {
    for (let i = 0; i < plan.years.length; i++) {
      const badge = await renderYearBadgeOverlay(
        plan.years[i],
        scene.index,
        workDir,
        ffmpegBin,
        exec,
        durationSec,
        i,
        plan.years.length
      );
      if (badge) overlays.push(badge);
    }
    return overlays;
  }

  // Legacy: skip scene overlays when text was burned per beat on B-roll.
  if (opts.videoTextOnly) {
    return overlays;
  }

  for (let i = 0; i < plan.years.length; i++) {
    const badge = await renderYearBadgeOverlay(
      plan.years[i],
      scene.index,
      workDir,
      ffmpegBin,
      exec,
      durationSec,
      i,
      plan.years.length
    );
    if (badge) overlays.push(badge);

    if (opts.docOverlays !== false && i === 0) {
      const slot = durationSec / Math.max(1, plan.years.length);
      const flashTime = Math.max(0.2, i * slot + 0.15);
      const flash = await renderCameraFlashOverlay(
        scene.index,
        workDir,
        ffmpegBin,
        exec,
        flashTime,
        durationSec
      );
      if (flash) overlays.push(flash);
    }
  }

  if (plan.statText && opts.docOverlays !== false) {
    const steps = buildStatCountSteps(plan.statText);
    const stepDur = Math.min(0.55, (durationSec * 0.35) / steps.length);
    const baseStart = Math.max(0.8, durationSec * 0.15);
    for (let i = 0; i < steps.length; i++) {
      const start = baseStart + i * stepDur;
      const stepOverlay = await renderStatStepOverlay(
        steps[i],
        scene.index,
        i,
        workDir,
        ffmpegBin,
        exec,
        start,
        start + stepDur + 0.05
      );
      if (stepOverlay) overlays.push(stepOverlay);
    }
  }

  if (scene.sectionTitle?.trim() && opts.docOverlays !== false) {
    const headline = await renderAnimatedHeadlineOverlay(
      scene.sectionTitle,
      scene.index,
      workDir,
      ffmpegBin,
      exec,
      durationSec
    );
    if (headline) overlays.push(headline);
  }

  for (let i = 0; i < plan.keywords.length; i++) {
    const pill = await renderKeywordPillOverlay(
      plan.keywords[i],
      scene.index,
      workDir,
      ffmpegBin,
      exec,
      durationSec,
      i
    );
    if (pill) overlays.push(pill);
  }

  for (const name of (scene.personNames ?? []).slice(0, 1)) {
    const badge = await renderNameBadgeOverlay(
      name,
      scene.index,
      workDir,
      ffmpegBin,
      exec,
      Math.min(durationSec, 4)
    );
    if (badge) overlays.push(badge);
  }

  if (opts.facelessSubs) {
    const lines = parseFacelessSubtitleLines(scene.text);
    const subs = await renderFacelessSubtitleOverlay(
      lines,
      scene.index,
      workDir,
      ffmpegBin,
      exec,
      durationSec,
      "bottom-left"
    );
    if (subs) overlays.push(subs);
  }

  if (documentaryOverlaysEnabled()) {
    const dust = await renderParticleDustOverlay(scene.index, workDir, ffmpegBin, exec, durationSec);
    if (dust) overlays.push(dust);
  }

  return overlays;
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

export function overlayUsesFullFrame(frame: TimedOverlay): boolean {
  return (
    frame.fullFrame === true ||
    frame.isStatCallout === true ||
    frame.isNameBadge === true ||
    frame.isParticle === true
  );
}
