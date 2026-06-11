/**
 * Procedural motion graphics — text cards, maps, news overlays, portrait cutouts (FFmpeg only).
 * YouTube documentary style (Safety First, Borderless Asia, etc.).
 */
import * as fs from "fs";
import * as path from "path";
import { sanitizeForDrawtext } from "./ffmpegSanitize";
import {
  buildKenBurnsTail,
  buildStillEncodeArgs,
  DOC_STYLE_VIDEO_HEIGHT,
  DOC_STYLE_VIDEO_WIDTH,
} from "./documentaryStyle";
import { maxMotionGraphicsPerVideo, motionGraphicsInVideosEnabled } from "./sourcingPolicy";

export type MotionGraphicKind = "text_card" | "map_card" | "news_card" | "portrait_cutout";

export type MotionGraphicPlan = {
  kind: MotionGraphicKind;
  lines: string[];
  mapTitle?: string;
  headline?: string;
  bodyLines?: string[];
  source?: string;
  dateStr?: string;
};

const NEWS_SOURCES =
  /\b(The Guardian|Reuters|BBC News|BBC|SMH|SMH\.com\.au|New York Times|Washington Post|Associated Press|Bloomberg|CNN|Financial Times|Al Jazeera|NOS|Volkskrant|Telegraaf)\b/i;

const MONTHS =
  "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec";

const ROTATION: MotionGraphicKind[] = [
  "text_card",
  "news_card",
  "portrait_cutout",
  "map_card",
  "news_card",
];

/** Every beat gets a rotating style — topic-agnostic; budget caps renders per video. */
export function motionGraphicSlotKind(sceneIndex: number, beatIndex: number): MotionGraphicKind {
  if (sceneIndex === 0 && beatIndex === 0) return "text_card";
  const slot = sceneIndex * 5 + beatIndex;
  return ROTATION[slot % ROTATION.length];
}

/** Motion graphics on ~15–20% of beats — opening + scattered text/map slides, mostly B-roll. */
export function shouldUseMotionGraphicBeat(sceneIndex: number, beatIndex: number): boolean {
  if (sceneIndex === 0 && beatIndex === 0) return true;
  if (beatIndex === 0 && sceneIndex > 0) return true;
  const slot = sceneIndex * 31 + beatIndex;
  return slot % 5 === 2;
}

export function motionGraphicsEnabled(): boolean {
  return motionGraphicsInVideosEnabled();
}

export function motionGraphicNeedsSourceImage(kind: MotionGraphicKind): boolean {
  return kind === "news_card" || kind === "portrait_cutout";
}

export function wrapTextCardLines(text: string, maxChars = 38): string[] {
  const cleaned = text.replace(/\[visual:[^\]]+\]/gi, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

export function formatNewsDate(d = new Date()): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export function extractNewsSource(text: string, videoTitle?: string): string {
  const m = text.match(NEWS_SOURCES);
  if (m) return m[1].replace(/SMH/i, "SMH.com.au");
  const head = videoTitle?.split(/[:–—-]/)[0]?.trim();
  if (head && head.length >= 4) return head.slice(0, 28);
  return "Documentary Report";
}

export function extractNewsCardContent(
  beatText: string,
  videoTitle?: string
): {
  headline: string;
  bodyLines: string[];
  source: string;
  dateStr: string;
} {
  const text = beatText.replace(/\[visual:[^\]]+\]/gi, "").replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const headline = (sentences[0] ?? text).slice(0, 90);
  const rest = sentences.slice(1).join(" ").trim() || text.slice(headline.length).trim();
  const bodyLines = wrapTextCardLines(rest || headline, 54).slice(0, 3);
  const dateMatch = text.match(
    new RegExp(`\\b(\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\.?\\s+\\d{4})\\b`, "i")
  );
  return {
    headline,
    bodyLines,
    source: extractNewsSource(text, videoTitle),
    dateStr: dateMatch?.[1] ?? formatNewsDate(),
  };
}

export function extractMapTitle(beatText: string, videoTitle?: string): string {
  const combined = `${beatText} ${videoTitle ?? ""}`;
  const city = combined.match(
    /\b(Berlin|Paris|London|Amsterdam|New York|Chicago|Tokyo|Rome|Moscow|Vienna|Warsaw|Dublin|Brussels|Rotterdam|Utrecht|Den Haag|Singapore|München|Munich|Hamburg|Frankfurt|Melbourne|Sydney|Toronto|Beijing|Seoul|Cairo|Athens|Oslo|Stockholm|Helsinki|Wellington|Mexico City|São Paulo|Buenos Aires)\b/i
  )?.[1];
  if (city) return city.toUpperCase();

  const titleHead = videoTitle?.split(/[:–—-]/)[0]?.trim();
  if (titleHead && titleHead.length >= 4) return titleHead.toUpperCase().slice(0, 28);

  const cap = beatText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  if (cap?.[1]) return cap[1].toUpperCase().slice(0, 28);

  const words = beatText
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 3);
  if (words.length) return words.join(" ").toUpperCase().slice(0, 28);

  return "TOPIC MAP";
}

function buildPlanForKind(
  kind: MotionGraphicKind,
  text: string,
  videoTitle?: string
): MotionGraphicPlan {
  const lines = wrapTextCardLines(text, 36);

  if (kind === "news_card") {
    const news = extractNewsCardContent(text, videoTitle);
    return {
      kind,
      lines: [news.headline, ...news.bodyLines],
      headline: news.headline,
      bodyLines: news.bodyLines,
      source: news.source,
      dateStr: news.dateStr,
    };
  }

  if (kind === "map_card") {
    const sub = wrapTextCardLines(text, 32).slice(0, 2);
    return {
      kind,
      mapTitle: extractMapTitle(text, videoTitle),
      lines: sub.length ? sub : ["Key facts", "Context map"],
    };
  }

  if (kind === "portrait_cutout") {
    return { kind, lines: lines.slice(0, 1) };
  }

  return { kind: "text_card", lines: lines.slice(0, 4) };
}

export function planMotionGraphicBeat(
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  videoTitle?: string
): MotionGraphicPlan | null {
  if (!motionGraphicsEnabled()) return null;
  const text = beatText.replace(/\[visual:[^\]]+\]/gi, "").trim();
  if (text.length < 10) return null;

  return buildPlanForKind(motionGraphicSlotKind(sceneIndex, beatIndex), text, videoTitle);
}

export type StillStyleContext = {
  beatText?: string;
  videoTitle?: string;
  motionGraphicsBudget?: MotionGraphicsBudget;
};

/** Pick FFmpeg filter for still/image beats — motion graphic or gray mat fallback. */
export function resolveStillImageFilterComplex(
  duration: number,
  sceneIndex: number,
  beatIndex: number,
  styleContext?: StillStyleContext
): { filterComplex: string; consumedBudget: boolean } | null {
  if (styleContext?.beatText) {
    const plan = planMotionGraphicBeat(
      styleContext.beatText,
      sceneIndex,
      beatIndex,
      styleContext.videoTitle
    );
    if (canUseMotionGraphicStyle(plan, styleContext.motionGraphicsBudget)) {
      const styled = buildImageMotionGraphicFilter(duration, plan!);
      if (styled) {
        return { filterComplex: styled, consumedBudget: true };
      }
    }
  }

  return null;
}

function drawtextChain(lines: string[], startY: number, fontSize: number, color: string): string {
  return lines
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line.toUpperCase(), 48);
      const y = startY + i * Math.round(fontSize * 1.15);
      return `drawtext=text='${safe}':fontcolor=${color}:fontsize=${fontSize}:x=(w-text_w)/2:y=${y}`;
    })
    .join(",");
}

function drawNewsHeadlineLines(headline: string): string {
  return wrapTextCardLines(headline, 44)
    .slice(0, 2)
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line, 52);
      return `drawtext=text='${safe}':fontcolor=0x1D4ED8:fontsize=40:x=220:y=${392 + i * 48}`;
    })
    .join(",");
}

function drawNewsBodyLines(bodyLines: string[]): string {
  return bodyLines
    .slice(0, 3)
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line, 58);
      return `drawtext=text='${safe}':fontcolor=0x444444:fontsize=26:x=220:y=${510 + i * 34}`;
    })
    .join(",");
}

function newsCardDrawFilters(plan: MotionGraphicPlan): string {
  const source = sanitizeForDrawtext(plan.source ?? "News Report", 32);
  const dateStr = sanitizeForDrawtext(plan.dateStr ?? formatNewsDate(), 20);
  const headline = plan.headline ?? plan.lines[0] ?? "";
  const bodyLines = plan.bodyLines ?? plan.lines.slice(1);
  const headDraws = drawNewsHeadlineLines(headline);
  const bodyDraws = drawNewsBodyLines(bodyLines);
  return (
    `drawbox=x=178:y=318:w=1564:h=44:color=0x000000@0.16:t=fill,` +
    `drawbox=x=168:y=308:w=1584:h=464:color=white@0.97:t=fill,` +
    `drawbox=x=172:y=312:w=1576:h=456:color=0xFAFAFA@0.98:t=fill,` +
    `drawbox=x=1330:y=340:w=340:h=340:color=0xE8E8E8:t=fill,` +
    `drawtext=text='${source}':fontcolor=0x666666:fontsize=28:x=220:y=340,` +
    `${headDraws}` +
    (bodyDraws ? `,${bodyDraws}` : "") +
    `,drawtext=text='${dateStr}':fontcolor=0x888888:fontsize=24:x=220:y=720`
  );
}

export function buildTextCardVF(lines: string[]): string {
  const fontSize = lines.some((l) => l.length > 28) ? 54 : 64;
  const blockH = lines.length * Math.round(fontSize * 1.15);
  const startY = Math.round((DOC_STYLE_VIDEO_HEIGHT - blockH) / 2);
  return drawtextChain(lines, startY, fontSize, "0xFFD200");
}

/** Opening / chapter name plate — blue box on grid (YouTube documentary style). */
export function buildOpeningNameCardVF(title: string, subtitleLines: string[]): string {
  const name = sanitizeForDrawtext(title.toUpperCase(), 24);
  const sub = subtitleLines
    .slice(0, 2)
    .map((line, i) => {
      const safe = sanitizeForDrawtext(line, 58);
      return `drawtext=text='${safe}':fontcolor=white:fontsize=30:x=(w-text_w)/2:y=${870 + i * 38}`;
    })
    .join(",");
  return (
    `drawbox=x=0:y=0:w=${DOC_STYLE_VIDEO_WIDTH}:h=${DOC_STYLE_VIDEO_HEIGHT}:color=0x2a2a2a@0.92:t=fill,` +
    `drawgrid=w=80:h=80:t=1:c=0x444444@0.22,` +
    `drawbox=x=560:y=300:w=800:h=200:color=0x5B9BD5@0.35:t=fill,` +
    `drawbox=x=580:y=320:w=760:h=160:color=0x3B82C4@0.22:t=fill,` +
    `drawtext=text='${name}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=380,` +
    `drawbox=x=660:y=450:w=600:h=4:color=0x2563EB:t=fill` +
    (sub ? `,${sub}` : "")
  );
}

export function buildMapCardVF(mapTitle: string, subtitleLines: string[]): string {
  const title = sanitizeForDrawtext(mapTitle, 24);
  const sub = subtitleLines
    .slice(0, 2)
    .map((l, i) => {
      const safe = sanitizeForDrawtext(l, 40);
      return `drawtext=text='${safe}':fontcolor=0x333333:fontsize=34:x=680:y=${720 + i * 42}`;
    })
    .join(",");
  return (
    `drawbox=x=520:y=120:w=880:h=640:color=0xE8E4DC:t=fill,` +
    `drawbox=x=540:y=140:w=840:h=600:color=0x3B82C4@0.12:t=fill,` +
    `drawgrid=w=80:h=80:t=1:c=0x999999@0.35,` +
    `drawbox=x=700:y=280:w=520:h=8:color=0x2563EB@0.55:t=fill,` +
    `drawbox=x=700:y=420:w=8:h=260:color=0x2563EB@0.55:t=fill,` +
    `drawbox=x=880:y=360:w=28:h=28:color=0xEF4444@0.9:t=fill,` +
    `drawbox=x=892:y=372:w=4:h=80:color=0xEF4444@0.75:t=fill,` +
    `drawbox=x=860:y=452:w=68:h=4:color=0xEF4444@0.75:t=fill,` +
    `drawtext=text='${title}':fontcolor=0x111111:fontsize=52:x=680:y=200` +
    (sub ? `,${sub}` : "")
  );
}

/** News article card on blurred photo — Borderless Asia / Guardian style. */
export function buildNewsCardStillVF(duration: number, plan: MotionGraphicPlan): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const ken = buildKenBurnsTail(duration, 1.015, "center");
  const card = newsCardDrawFilters(plan);
  return (
    `[0:v]split=2[bgsrc][thsrc];` +
    `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=34,eq=brightness=-0.07:saturation=0.9[bg];` +
    `[thsrc]scale=320:320:force_original_aspect_ratio=increase,crop=320:320[thumb];` +
    `[bg]${card}[card];` +
    `[card][thumb]overlay=1340:360[composed];` +
    `[composed]${ken}[vout]`
  );
}

/** Portrait with light glow on blurred background. */
export function buildPortraitCutoutStillVF(duration: number, fgScale = 0.58): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const ken = buildKenBurnsTail(duration, 1.02, "center");
  return (
    `[0:v]split=2[bg_src][fg_src];` +
    `[bg_src]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=30,eq=brightness=-0.06:saturation=0.92[bg];` +
    `[fg_src]scale='min(${w}*${fgScale}/iw\\,${h}*0.9/ih)*iw':-2[fg];` +
    `[fg]pad=iw+32:ih+32:16:16:color=0xD6EBFF[glowpad];` +
    `[glowpad]gblur=sigma=12[glow];` +
    `[bg][glow]overlay=(W-w)/2:(H-h)/2[b1];` +
    `[b1][fg]overlay=(W-w)/2+16:(H-h)/2+16[composed];` +
    `[composed]${ken}[vout]`
  );
}

/** News card overlay on moving video (blurred b-roll underneath). */
export function buildNewsCardVideoVF(plan: MotionGraphicPlan): string {
  const w = DOC_STYLE_VIDEO_WIDTH;
  const h = DOC_STYLE_VIDEO_HEIGHT;
  const card = newsCardDrawFilters(plan);
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=28,eq=brightness=-0.06:saturation=0.9,${card},format=yuv420p`
  );
}

export type MotionGraphicsBudget = { used: number; max: number };

export function canUseMotionGraphicStyle(
  plan: MotionGraphicPlan | null,
  budget?: MotionGraphicsBudget
): plan is MotionGraphicPlan {
  if (!plan || !motionGraphicsEnabled()) return false;
  if (!budget) return true;
  return budget.used < budget.max;
}

export function buildImageMotionGraphicFilter(
  duration: number,
  plan: MotionGraphicPlan
): string | null {
  if (plan.kind === "news_card") return buildNewsCardStillVF(duration, plan);
  if (plan.kind === "portrait_cutout") return buildPortraitCutoutStillVF(duration);
  return null;
}

export async function renderMotionGraphicClip(
  plan: MotionGraphicPlan,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  durationSec: number,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>,
  beatText = "",
  videoTitle?: string
): Promise<string | null> {
  const tag =
    plan.kind === "map_card"
      ? "map"
      : plan.kind === "news_card"
        ? "news"
        : plan.kind === "portrait_cutout"
          ? "portrait"
          : "text";
  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_mgfx_${tag}.mp4`);
  const dur = Math.max(3, Math.min(8, durationSec));
  const bg =
    plan.kind === "map_card" || plan.kind === "news_card"
      ? "0xCFCFCF"
      : plan.kind === "portrait_cutout"
        ? "0x1a1a2e"
        : plan.kind === "text_card" && beatIndex === 0
          ? "0x2a2a2a"
          : "0x140818";
  const vf =
    plan.kind === "map_card"
      ? buildMapCardVF(plan.mapTitle ?? "CITY", plan.lines)
      : plan.kind === "text_card" && beatIndex === 0
        ? buildOpeningNameCardVF(
            extractMapTitle(beatText || plan.lines.join(" "), videoTitle),
            wrapTextCardLines(beatText || plan.lines.join(" "), 52).slice(0, 2)
          )
        : plan.kind === "text_card"
          ? buildTextCardVF(plan.lines)
          : null;

  if (!vf) return null;

  try {
    await execWithTimeout(
      `${ffmpegBin} -y -f lavfi -i "color=c=${bg}:s=${DOC_STYLE_VIDEO_WIDTH}x${DOC_STYLE_VIDEO_HEIGHT}:rate=25" ` +
        `-vf "${vf}" -t ${dur.toFixed(3)} -an ` +
        `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p "${outPath}"`,
      25_000,
      `Motion graphic ${tag} scene ${sceneIndex}`
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 800) {
      return outPath;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function tryRenderMotionGraphicBeatClip(
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  workDir: string,
  holdSec: number,
  motionGraphicsUsed: number,
  videoTitle: string | undefined,
  ffmpegBin: string,
  execWithTimeout: (cmd: string, ms: number, label: string) => Promise<unknown>
): Promise<string | null> {
  if (!motionGraphicsEnabled()) return null;
  if (!shouldUseMotionGraphicBeat(sceneIndex, beatIndex)) return null;
  if (motionGraphicsUsed >= maxMotionGraphicsPerVideo()) return null;

  const plan = planMotionGraphicBeat(beatText, sceneIndex, beatIndex, videoTitle);
  if (!plan || motionGraphicNeedsSourceImage(plan.kind)) return null;

  return renderMotionGraphicClip(
    plan,
    workDir,
    sceneIndex,
    beatIndex,
    holdSec,
    ffmpegBin,
    execWithTimeout,
    beatText,
    videoTitle
  );
}

