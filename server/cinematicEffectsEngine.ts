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
  type TimedOverlay,
} from "./documentaryStyle";

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

export async function renderYearBadgeOverlay(
  year: string,
  sceneIndex: number,
  workDir: string,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  sceneDuration: number,
  slotIndex: number,
  slotCount: number
): Promise<TimedOverlay | null> {
  const safeYear = sanitizeForDrawtext(year, 8);
  const FONT_SIZE = 72;
  const LABEL_SIZE = 22;
  const PAD_X = 28;
  const PAD_Y = 18;
  const ACCENT_W = 4;
  const MARGIN_L = 56;
  const MARGIN_B = 88;
  const boxW = Math.round(safeYear.length * FONT_SIZE * 0.52 + PAD_X * 2 + ACCENT_W + 8);
  const boxH = FONT_SIZE + PAD_Y * 2 + LABEL_SIZE + 6;
  const boxX = MARGIN_L;
  const boxY = DOC_STYLE_VIDEO_HEIGHT - boxH - MARGIN_B;
  const accentX = boxX;
  const textX = boxX + ACCENT_W + PAD_X;
  const textY = boxY + PAD_Y;
  const labelY = textY + FONT_SIZE + 4;

  const slot = sceneDuration / Math.max(1, slotCount);
  const startTime = Math.max(0.3, slotIndex * slot + 0.2);
  const endTime = Math.min(sceneDuration - 0.25, startTime + Math.min(3.2, slot * 0.85));

  const pngPath = path.join(workDir, `scene_${sceneIndex}_year_${slotIndex}_${safeYear}.png`);
  try {
    await execWithTimeout(
      `${ffmpegBin} -y ` +
        `-f lavfi -i "color=c=black@0:size=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=1" ` +
        `-vf "` +
        `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=0x141418@0.88:t=fill,` +
        `drawbox=x=${accentX}:y=${boxY}:w=${ACCENT_W}:h=${boxH}:color=FF7A00@0.95:t=fill,` +
        `drawtext=text='${safeYear}':fontcolor=white:fontsize=${FONT_SIZE}:x=${textX}:y=${textY},` +
        `drawtext=text='DATE':fontcolor=0xAAAAAA:fontsize=${LABEL_SIZE}:x=${textX}:y=${labelY}` +
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
        fullFrame: true,
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
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<TimedOverlay[]> {
  const overlays: TimedOverlay[] = [];

  if (cinematicParticlesEnabled()) {
    const dust = await renderParticleDustOverlay(
      scene.index,
      workDir,
      ffmpegBin,
      execWithTimeout,
      durationSec
    );
    if (dust) overlays.push(dust);
  }

  for (let i = 0; i < plan.years.length; i++) {
    const badge = await renderYearBadgeOverlay(
      plan.years[i],
      scene.index,
      workDir,
      ffmpegBin,
      execWithTimeout,
      durationSec,
      i,
      plan.years.length
    );
    if (badge) overlays.push(badge);
  }

  if (plan.statText && !plan.years.includes(plan.statText)) {
    const stat = await renderStatCalloutOverlay(
      plan.statText,
      scene.index,
      workDir,
      ffmpegBin,
      execWithTimeout
    );
    if (stat) overlays.push(stat);
  }

  for (let i = 0; i < plan.keywords.length; i++) {
    const kw = await renderKeywordPillOverlay(
      plan.keywords[i],
      scene.index,
      workDir,
      ffmpegBin,
      execWithTimeout,
      durationSec,
      i
    );
    if (kw) overlays.push(kw);
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
    frame.isYearBadge === true ||
    frame.isParticle === true
  );
}
