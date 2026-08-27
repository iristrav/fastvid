/**
 * Editorial Graphics Engine — generates standalone MP4 clips from graphics.
 *
 * Wraps the existing VisualDirector infrastructure to produce self-contained
 * video clips that the Asset Director can select instead of footage.
 *
 * Supported graphic types:
 *  map          — world map with pulsing location marker (via cinematicMotion/mapOverlay)
 *  timeline     — horizontal timeline with highlighted year (via visualDirector/renderers/timeline)
 *  counter      — animated number counting up (via cinematicMotion/counter)
 *  name_card    — person label with name + title (via visualDirector/renderers/personLabel)
 *  quote_card   — typewriter quote with attribution
 *  comparison   — side-by-side A vs B labels
 *  stat         — large isolated statistic
 *  bullet_list  — sequential bullet points
 *  location_label — lower-third location name
 *  chapter_card — chapter heading card
 *
 * Clip generation strategy:
 *  1. Generate a PNG overlay (SVG→PNG or drawtext)
 *  2. Lay it over a dark background (ffmpeg color source)
 *  3. Output as a 5-second 1920×1080 H.264 MP4
 *
 * Detection strategy (no LLM):
 *  Reuses analyzeScene() from visualDirector/analyzer.ts
 *  + beat-level keyword pattern matching
 *
 * Feature flag: EDITORIAL_GRAPHICS_ENGINE_ENABLED (default: "true")
 */

import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { analyzeScene } from "./visualDirector/analyzer";
import { ffmpegThreadFlag, montageSegmentParallelism } from "./sourcingPolicy";
import { ffmpegSemaphore } from "./_core/semaphore";
import pLimit from "p-limit";

// Route through the shared ffmpeg concurrency gate — editorialGraphicsEnabled() is default-on
// and this runs once per graphic (per scene), previously entirely outside FFMPEG_CONCURRENCY_LIMIT.
const execRaw = promisify(exec);
const execAsync = (cmd: string) => ffmpegSemaphore.run(() => execRaw(cmd));
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const W = 1920;
const H = 1080;
const DEFAULT_DURATION = 5;
const TIMEOUT_MS = 30_000;

// ─── Feature flag ─────────────────────────────────────────────────────────────

import { burnedInTextAllowed } from "./onScreenTextPolicy";
export function editorialGraphicsEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.EDITORIAL_GRAPHICS_ENGINE_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type GraphicType =
  | "map"
  | "timeline"
  | "counter"
  | "name_card"
  | "quote_card"
  | "comparison"
  | "stat"
  | "bullet_list"
  | "location_label"
  | "chapter_card";

export type GraphicPlan = {
  type: GraphicType;
  sceneIndex: number;
  beatIndex: number;
  beatText: string;
  durationSec: number;
  /** Payload varies by type */
  payload: GraphicPayload;
};

export type GraphicPayload =
  | { type: "map"; locationName: string; normX: number; normY: number }
  | { type: "timeline"; events: Array<{ year: string; label?: string }>; highlightYear?: string }
  | { type: "counter"; value: number; suffix: string; label: string }
  | { type: "name_card"; name: string; title: string }
  | { type: "quote_card"; text: string; attribution?: string }
  | { type: "comparison"; left: string; right: string; connector?: string }
  | { type: "stat"; value: string; label: string }
  | { type: "bullet_list"; items: string[]; title?: string }
  | { type: "location_label"; name: string; subtitle?: string }
  | { type: "chapter_card"; title: string; subtitle?: string };

export type GraphicClip = {
  plan: GraphicPlan;
  clipPath: string;
  generatedAt: string;
};

// ─── Usage tracking ───────────────────────────────────────────────────────────

export type GraphicsUsageSummary = {
  maps: number;
  timelines: number;
  counters: number;
  namecards: number;
  quoteCards: number;
  comparisons: number;
  stats: number;
  bulletLists: number;
  locationLabels: number;
  chapterCards: number;
  total: number;
};

export function emptyUsageSummary(): GraphicsUsageSummary {
  return { maps: 0, timelines: 0, counters: 0, namecards: 0, quoteCards: 0, comparisons: 0, stats: 0, bulletLists: 0, locationLabels: 0, chapterCards: 0, total: 0 };
}

export function recordGraphicUsage(summary: GraphicsUsageSummary, type: GraphicType): void {
  summary.total++;
  if (type === "map") summary.maps++;
  else if (type === "timeline") summary.timelines++;
  else if (type === "counter") summary.counters++;
  else if (type === "name_card") summary.namecards++;
  else if (type === "quote_card") summary.quoteCards++;
  else if (type === "comparison") summary.comparisons++;
  else if (type === "stat") summary.stats++;
  else if (type === "bullet_list") summary.bulletLists++;
  else if (type === "location_label") summary.locationLabels++;
  else if (type === "chapter_card") summary.chapterCards++;
}

export function printGraphicsUsageReport(summary: GraphicsUsageSummary): void {
  if (summary.total === 0) return;
  const lines = [
    "",
    "┌──────────────────────────────────────────────┐",
    "│          EDITORIAL GRAPHICS USED             │",
    "├──────────────────────────────────────────────┤",
  ];
  const rows: [string, number][] = [
    ["Maps",             summary.maps],
    ["Timelines",        summary.timelines],
    ["Counters",         summary.counters],
    ["Name Cards",       summary.namecards],
    ["Quote Cards",      summary.quoteCards],
    ["Comparisons",      summary.comparisons],
    ["Stats",            summary.stats],
    ["Bullet Lists",     summary.bulletLists],
    ["Location Labels",  summary.locationLabels],
    ["Chapter Cards",    summary.chapterCards],
  ];
  for (const [label, n] of rows) {
    if (n > 0) lines.push(`│  ${label.padEnd(24)}${String(n).padStart(4)}              │`);
  }
  lines.push(`├──────────────────────────────────────────────┤`);
  lines.push(`│  Total Graphics             ${String(summary.total).padStart(4)}              │`);
  lines.push(`└──────────────────────────────────────────────┘`);
  console.log(lines.join("\n"));
}

// ─── Detection: should this beat use a graphic? ───────────────────────────────

const MAP_KW      = /\b(map|country|countries|city|cities|route|invasion|migration|trade route|location|territory|region|border|continent|ocean|sea|river|front(?:line)?|advance|retreat)\b/i;
const TIMELINE_KW = /\b(timeline|chronology|history|period|era|century|decade|\d{4}.*\d{4}|from.*to.*year|war.*began|started in|ended in)\b/i;
const COUNTER_KW  = /\b(\d[\d,]*\s*(?:million|billion|thousand|%|percent|soldiers|troops|casualties|doden|mensen|dollars|euros|km|miles))\b/i;
const PERSON_KW   = /\b(President|Prime Minister|Premier|General|Admiral|Chancellor|Emperor|King|Queen|CEO|Director|Minister|Führer|Tsar|Marshal)\s+[A-Z]/;
const QUOTE_KW    = /[""]([^"""]{15,180})[""]|"\s*([^"]{15,180})\s*"/;
const COMPARE_KW  = /\b(vs\.?|versus|compared to|larger than|smaller than|more than|less than|double|half|twice|triple)\b/i;
const STAT_KW     = /\b(\d+(?:[.,]\d+)?)\s*(%|percent|procent|million|billion|thousand|km|miles|meters)\b/i;
const BULLET_KW   = /\b(first(?:ly)?|second(?:ly)?|third(?:ly)?|four(?:th)?|five\b|step \d|phase \d|reason\b|1\.|2\.|3\.)/i;
const LOCATION_KW = /\bin (the )?([\w\s]{3,25}),?\s*((?:a )?\w+ (?:city|country|capital|region|province|state|island|peninsula|nation))?/i;

export type GraphicDetectionResult = {
  shouldUseGraphic: boolean;
  plan: GraphicPlan | null;
  confidence: number; // 0–1
};

export function detectBeatGraphic(
  beatText: string,
  sceneText: string,
  sceneIndex: number,
  beatIndex: number,
  durationSec = DEFAULT_DURATION,
  videoTitle = ""
): GraphicDetectionResult {
  const signals = analyzeScene(sceneText, "", "", [{ text: beatText }]);
  const full = beatText + " " + sceneText;

  // ── Map ──────────────────────────────────────────────────────────────────
  if (signals.locations.length >= 1 && MAP_KW.test(full)) {
    const loc = signals.locations[0]!;
    return {
      shouldUseGraphic: true,
      confidence: 0.85,
      plan: {
        type: "map", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "map", locationName: loc.name, normX: loc.normX, normY: loc.normY },
      },
    };
  }

  // ── Name card ────────────────────────────────────────────────────────────
  if (signals.persons.length >= 1 && PERSON_KW.test(full)) {
    const p = signals.persons[0]!;
    return {
      shouldUseGraphic: true,
      confidence: 0.90,
      plan: {
        type: "name_card", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "name_card", name: p.name, title: p.title },
      },
    };
  }

  // ── Quote card ───────────────────────────────────────────────────────────
  if (signals.quote) {
    return {
      shouldUseGraphic: true,
      confidence: 0.80,
      plan: {
        type: "quote_card", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "quote_card", text: signals.quote.text, attribution: signals.quote.attribution },
      },
    };
  }

  // ── Timeline ─────────────────────────────────────────────────────────────
  if (signals.years.length >= 2 && TIMELINE_KW.test(full)) {
    const events = signals.years.slice(0, 6).map((y) => ({ year: y }));
    return {
      shouldUseGraphic: true,
      confidence: 0.78,
      plan: {
        type: "timeline", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "timeline", events, highlightYear: signals.years[0] },
      },
    };
  }

  // ── Comparison ───────────────────────────────────────────────────────────
  if (signals.comparison && COMPARE_KW.test(full)) {
    return {
      shouldUseGraphic: true,
      confidence: 0.75,
      plan: {
        type: "comparison", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "comparison", left: signals.comparison.left, right: signals.comparison.right },
      },
    };
  }

  // ── Counter ──────────────────────────────────────────────────────────────
  if (signals.stats.length >= 1 && COUNTER_KW.test(full)) {
    const s = signals.stats[0]!;
    if (s.value >= 100) {
      return {
        shouldUseGraphic: true,
        confidence: 0.82,
        plan: {
          type: "counter", sceneIndex, beatIndex, beatText, durationSec,
          payload: { type: "counter", value: s.value, suffix: s.suffix, label: s.label },
        },
      };
    }
  }

  // ── Stat highlight ───────────────────────────────────────────────────────
  if (STAT_KW.test(full)) {
    const m = STAT_KW.exec(full);
    if (m) {
      return {
        shouldUseGraphic: true,
        confidence: 0.70,
        plan: {
          type: "stat", sceneIndex, beatIndex, beatText, durationSec,
          payload: { type: "stat", value: m[1] + (m[2] ?? ""), label: beatText.slice(0, 60) },
        },
      };
    }
  }

  // ── Bullet list ──────────────────────────────────────────────────────────
  if (signals.listItems.length >= 3 && BULLET_KW.test(full)) {
    return {
      shouldUseGraphic: true,
      confidence: 0.68,
      plan: {
        type: "bullet_list", sceneIndex, beatIndex, beatText, durationSec,
        payload: { type: "bullet_list", items: signals.listItems.slice(0, 5), title: videoTitle || undefined },
      },
    };
  }

  return { shouldUseGraphic: false, plan: null, confidence: 0 };
}

// ─── SVG generators ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgWrapper(content: string, bg = "#0d0d0d"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${content}
</svg>`;
}

function buildMapSvg(locationName: string, normX: number, normY: number): string {
  const x = Math.round(normX * W);
  const y = Math.round(normY * H);
  return svgWrapper(`
  <!-- Subtle grid lines for geographic context -->
  <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <line x1="${W/2}" y1="0" x2="${W/2}" y2="${H}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <!-- Location pulse rings -->
  <circle cx="${x}" cy="${y}" r="60" fill="none" stroke="#FFD54F" stroke-width="2" opacity="0.3"/>
  <circle cx="${x}" cy="${y}" r="38" fill="none" stroke="#FFD54F" stroke-width="2.5" opacity="0.6"/>
  <circle cx="${x}" cy="${y}" r="18" fill="#FFD54F" opacity="0.9"/>
  <!-- Name label -->
  <rect x="${Math.max(40, x - 160)}" y="${y + 35}" width="320" height="56" rx="6" fill="rgba(0,0,0,0.75)"/>
  <text x="${Math.max(200, x)}" y="${y + 72}" text-anchor="middle"
        font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="white">${esc(locationName)}</text>
  `, "#0a1520");
}

function buildTimelineSvg(events: Array<{ year: string; label?: string }>, highlightYear?: string): string {
  const TRACK_Y = H - 240;
  const START_X = 160;
  const END_X   = W - 160;
  const count   = events.length;
  const spacing = count > 1 ? (END_X - START_X) / (count - 1) : 0;

  let markers = "";
  for (let i = 0; i < count; i++) {
    const x  = count === 1 ? (START_X + END_X) / 2 : START_X + i * spacing;
    const ev = events[i]!;
    const hl = ev.year === highlightYear;
    markers += `
    <circle cx="${x}" cy="${TRACK_Y}" r="${hl ? 16 : 9}" fill="${hl ? "#FFD54F" : "white"}" opacity="${hl ? 1 : 0.7}"/>
    ${hl ? `<circle cx="${x}" cy="${TRACK_Y}" r="28" fill="none" stroke="#FFD54F" stroke-width="2" opacity="0.5"/>` : ""}
    <text x="${x}" y="${TRACK_Y - 32}" text-anchor="middle" font-family="Arial,sans-serif"
          font-size="${hl ? 36 : 26}" font-weight="${hl ? "bold" : "normal"}" fill="${hl ? "#FFD54F" : "white"}" opacity="${hl ? 1 : 0.8}">${esc(ev.year)}</text>
    ${ev.label ? `<text x="${x}" y="${TRACK_Y + 50}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="white" opacity="0.6">${esc(ev.label.slice(0, 20))}</text>` : ""}
    `;
  }

  const hlIdx = events.findIndex((e) => e.year === highlightYear);
  const hlX   = hlIdx >= 0 ? (count === 1 ? (START_X + END_X) / 2 : START_X + hlIdx * spacing) : -1;

  return svgWrapper(`
  <rect x="${START_X - 40}" y="${TRACK_Y - 80}" width="${END_X - START_X + 80}" height="180" rx="12" fill="rgba(0,0,0,0.70)"/>
  <line x1="${START_X}" y1="${TRACK_Y}" x2="${END_X}" y2="${TRACK_Y}" stroke="white" stroke-width="5" stroke-linecap="round" opacity="0.3"/>
  ${hlX > 0 ? `<line x1="${START_X}" y1="${TRACK_Y}" x2="${hlX}" y2="${TRACK_Y}" stroke="#FFD54F" stroke-width="5" stroke-linecap="round" opacity="0.85"/>` : ""}
  ${markers}
  `);
}

function buildNameCardSvg(name: string, title: string): string {
  return svgWrapper(`
  <rect x="0" y="${H - 200}" width="${W}" height="200" fill="rgba(0,0,0,0.80)"/>
  <rect x="0" y="${H - 204}" width="${W}" height="4" fill="#FFD54F"/>
  <text x="80" y="${H - 130}" font-family="Arial,sans-serif" font-size="54" font-weight="bold" fill="white">${esc(name)}</text>
  <text x="80" y="${H - 78}" font-family="Arial,sans-serif" font-size="34" fill="#FFD54F" opacity="0.9">${esc(title)}</text>
  `);
}

function buildQuoteCardSvg(text: string, attribution?: string): string {
  // Wrap text
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > 42 && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  const lineHeight = 68;
  const startY = (H - lines.length * lineHeight) / 2 - 30;
  const textEls = lines.map((l, i) =>
    `<text x="${W/2}" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Georgia,serif" font-size="52" fill="white" opacity="0.95" font-style="italic">${esc(l)}</text>`
  ).join("\n");

  return svgWrapper(`
  <!-- Quote mark -->
  <text x="100" y="${startY - 20}" font-family="Georgia,serif" font-size="180" fill="#FFD54F" opacity="0.2">"</text>
  ${textEls}
  ${attribution ? `<text x="${W/2}" y="${startY + lines.length * lineHeight + 50}" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" fill="#FFD54F" opacity="0.8">— ${esc(attribution)}</text>` : ""}
  <!-- Bottom accent -->
  <rect x="${W/2 - 60}" y="${startY + lines.length * lineHeight + 20}" width="120" height="3" fill="#FFD54F" opacity="0.5" rx="2"/>
  `);
}

function buildComparisonSvg(left: string, right: string, connector = "VS"): string {
  return svgWrapper(`
  <!-- Left panel -->
  <rect x="60" y="${H/2 - 120}" width="${W/2 - 100}" height="240" rx="12" fill="rgba(255,255,255,0.08)"/>
  <text x="${W/4}" y="${H/2 + 20}" text-anchor="middle" font-family="Arial,sans-serif" font-size="52" font-weight="bold" fill="white">${esc(left.slice(0, 24))}</text>
  <!-- Right panel -->
  <rect x="${W/2 + 40}" y="${H/2 - 120}" width="${W/2 - 100}" height="240" rx="12" fill="rgba(255,255,255,0.08)"/>
  <text x="${W * 3/4}" y="${H/2 + 20}" text-anchor="middle" font-family="Arial,sans-serif" font-size="52" font-weight="bold" fill="white">${esc(right.slice(0, 24))}</text>
  <!-- VS label -->
  <circle cx="${W/2}" cy="${H/2}" r="55" fill="#FFD54F"/>
  <text x="${W/2}" y="${H/2 + 16}" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="#0d0d0d">${esc(connector)}</text>
  `);
}

function buildStatSvg(value: string, label: string): string {
  return svgWrapper(`
  <text x="${W/2}" y="${H/2 - 30}" text-anchor="middle" font-family="Arial,sans-serif" font-size="160" font-weight="bold" fill="#FFD54F">${esc(value.slice(0, 12))}</text>
  <rect x="${W/2 - 300}" y="${H/2 + 30}" width="600" height="4" fill="rgba(255,255,255,0.3)" rx="2"/>
  <text x="${W/2}" y="${H/2 + 100}" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" fill="white" opacity="0.85">${esc(label.slice(0, 50))}</text>
  `);
}

function buildBulletListSvg(items: string[], title?: string): string {
  const startY = title ? 300 : 200;
  const bulletEls = items.slice(0, 5).map((item, i) => `
  <circle cx="140" cy="${startY + i * 110 + 10}" r="12" fill="#FFD54F"/>
  <text x="180" y="${startY + i * 110 + 22}" font-family="Arial,sans-serif" font-size="42" fill="white" opacity="0.95">${esc(item.slice(0, 48))}</text>
  `).join("");

  return svgWrapper(`
  ${title ? `<text x="${W/2}" y="180" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="bold" fill="#FFD54F">${esc(title.slice(0, 50))}</text>` : ""}
  <rect x="80" y="${startY - 40}" width="${W - 160}" height="${items.length * 110 + 60}" rx="12" fill="rgba(0,0,0,0.55)"/>
  ${bulletEls}
  `);
}

function buildLocationLabelSvg(name: string, subtitle?: string): string {
  return svgWrapper(`
  <rect x="0" y="${H - 180}" width="${W}" height="180" fill="rgba(0,0,0,0.75)"/>
  <rect x="0" y="${H - 184}" width="${W}" height="4" fill="#FFD54F"/>
  <text x="80" y="${H - 108}" font-family="Arial,sans-serif" font-size="62" font-weight="bold" fill="white">${esc(name.slice(0, 36))}</text>
  ${subtitle ? `<text x="80" y="${H - 54}" font-family="Arial,sans-serif" font-size="36" fill="#FFD54F" opacity="0.9">${esc(subtitle.slice(0, 50))}</text>` : ""}
  `);
}

function buildChapterCardSvg(title: string, subtitle?: string): string {
  return svgWrapper(`
  <!-- Yellow accent bar -->
  <rect x="0" y="${H/2 - 120}" width="12" height="240" fill="#FFD54F"/>
  <text x="${W/2}" y="${H/2 - 20}" text-anchor="middle" font-family="Arial,sans-serif" font-size="72" font-weight="bold" fill="white">${esc(title.slice(0, 32))}</text>
  ${subtitle ? `<text x="${W/2}" y="${H/2 + 70}" text-anchor="middle" font-family="Arial,sans-serif" font-size="40" fill="rgba(255,255,255,0.7)">${esc(subtitle.slice(0, 48))}</text>` : ""}
  <!-- Bottom line -->
  <rect x="${W/2 - 200}" y="${H/2 + 110}" width="400" height="3" fill="#FFD54F" opacity="0.6" rx="2"/>
  `);
}

function buildCounterSvg(value: number, suffix: string, label: string): string {
  // Static frame showing final value (animation done via FFmpeg drawtext)
  const display = value >= 1_000_000_000
    ? `${(value / 1_000_000_000).toFixed(1)}B`
    : value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1_000
        ? `${(value / 1_000).toFixed(1)}K`
        : String(Math.round(value));
  return buildStatSvg(display + (suffix || ""), label);
}

// ─── SVG to PNG ───────────────────────────────────────────────────────────────

async function svgToPng(svgContent: string, pngPath: string): Promise<boolean> {
  const svgPath = pngPath.replace(/\.png$/, ".svg");
  fs.writeFileSync(svgPath, svgContent, "utf8");

  // Try canvas + canvg (fast, no subprocess)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createCanvas } = require("canvas") as any;
    // eslint-disable-next-line no-new-func
    const canvgMod = await (new Function('return import("canvg")')() as Promise<any>).catch(() => null);
    if (canvgMod?.Canvg) {
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d");
      const v = await canvgMod.Canvg.from(ctx, svgContent);
      await v.render();
      fs.writeFileSync(pngPath, canvas.toBuffer("image/png"));
      try { fs.unlinkSync(svgPath); } catch { /* ignore */ }
      return fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;
    }
  } catch { /* fall through */ }

  // FFmpeg SVG→PNG fallback
  try {
    await Promise.race([
      execAsync(`${FFMPEG} -y -i "${svgPath}" -vframes 1 "${pngPath}"`),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 15_000)),
    ]);
    try { fs.unlinkSync(svgPath); } catch { /* ignore */ }
    return fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;
  } catch { /* ignore */ }

  try { fs.unlinkSync(svgPath); } catch { /* ignore */ }
  return false;
}

// ─── PNG to MP4 ───────────────────────────────────────────────────────────────

async function pngToMp4(pngPath: string, mp4Path: string, durationSec: number): Promise<boolean> {
  const fps = 25;
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    // Subtle fade in/out
    `fade=t=in:st=0:d=0.4`,
    `fade=t=out:st=${(durationSec - 0.5).toFixed(2)}:d=0.4`,
  ].join(",");

  const cmd = `${FFMPEG} -y -loop 1 -i "${pngPath}" -t ${durationSec.toFixed(2)} -vf "${vf}" -r ${fps} -c:v libx264 ${ffmpegThreadFlag()} -preset veryfast -crf 18 -pix_fmt yuv420p "${mp4Path}"`;
  try {
    await Promise.race([
      execAsync(cmd),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 5000;
  } catch {
    return false;
  }
}

// ─── Clip generator ───────────────────────────────────────────────────────────

/**
 * Generates a standalone MP4 clip from a graphic plan.
 * Returns the clip path on success, null on failure.
 * Never throws.
 */
/**
 * RONDE 83 — backpressure on graphic encoding.
 *
 * planVideoGraphics caps a video at maxPerVideo = 20 plans, and videoPipeline pre-generates
 * them with one Promise.all over the whole list. That started all twenty at once. The ffmpeg
 * child processes themselves were never the problem — execAsync above routes every one of them
 * through ffmpegSemaphore, which admits 3 process-wide — but starting twenty tasks against three
 * slots is still wrong, for a reason that is easy to miss:
 *
 *     await Promise.race([execAsync(cmd), <15s / 30s timeout>])
 *
 * execAsync's promise covers ACQUIRING the semaphore as well as running the command, and the
 * timeout starts at the same instant. A task queued behind seventeen others therefore spends its
 * whole timeout waiting for a slot it never gets, fails, and its graphic is silently dropped —
 * the more graphics a video plans, the more of them are lost. Longer videos plan more.
 *
 * The limiter is not a cap on how many graphics a video may have; all twenty plans are still
 * produced. It caps how many are IN FLIGHT, so each one's timeout measures its own encode
 * instead of the queue in front of it.
 *
 * Sized from montageSegmentParallelism — the value the pipeline already uses for "parallel
 * encodes of short clips", which is exactly what a graphic clip is — and deliberately at or
 * below the ffmpeg semaphore's own limit, so graphics can never monopolise it.
 */
const graphicEncodeLimit = pLimit(Math.max(1, montageSegmentParallelism()));

export async function generateGraphicClip(
  plan: GraphicPlan,
  workDir: string
): Promise<GraphicClip | null> {
  return graphicEncodeLimit(() => generateGraphicClipInner(plan, workDir));
}

async function generateGraphicClipInner(
  plan: GraphicPlan,
  workDir: string
): Promise<GraphicClip | null> {
  const tag = `graphic_s${plan.sceneIndex}b${plan.beatIndex}_${plan.type}`;
  const pngPath = path.join(workDir, `${tag}.png`);
  const mp4Path = path.join(workDir, `${tag}.mp4`);

  try {
    let svgContent: string;
    const p = plan.payload;

    switch (p.type) {
      case "map":
        svgContent = buildMapSvg(p.locationName, p.normX, p.normY);
        break;
      case "timeline":
        svgContent = buildTimelineSvg(p.events, p.highlightYear);
        break;
      case "counter":
        svgContent = buildCounterSvg(p.value, p.suffix, p.label);
        break;
      case "name_card":
        svgContent = buildNameCardSvg(p.name, p.title);
        break;
      case "quote_card":
        svgContent = buildQuoteCardSvg(p.text, p.attribution);
        break;
      case "comparison":
        svgContent = buildComparisonSvg(p.left, p.right, p.connector);
        break;
      case "stat":
        svgContent = buildStatSvg(p.value, p.label);
        break;
      case "bullet_list":
        svgContent = buildBulletListSvg(p.items, p.title);
        break;
      case "location_label":
        svgContent = buildLocationLabelSvg(p.name, p.subtitle);
        break;
      case "chapter_card":
        svgContent = buildChapterCardSvg(p.title, p.subtitle);
        break;
      default:
        return null;
    }

    const pngOk = await svgToPng(svgContent, pngPath);
    if (!pngOk) {
      console.warn(`[EditorialGraphics] SVG→PNG failed for ${tag}`);
      return null;
    }

    const mp4Ok = await pngToMp4(pngPath, mp4Path, plan.durationSec);
    if (!mp4Ok) {
      console.warn(`[EditorialGraphics] PNG→MP4 failed for ${tag}`);
      return null;
    }

    // Clean up PNG (keep only MP4)
    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }

    console.log(`[EditorialGraphics] ✓ s${plan.sceneIndex}b${plan.beatIndex} ${plan.type} → ${path.basename(mp4Path)}`);
    return { plan, clipPath: mp4Path, generatedAt: new Date().toISOString() };
  } catch (err) {
    console.warn(`[EditorialGraphics] Failed ${tag}:`, (err as Error).message?.slice(0, 80));
    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
    return null;
  }
}

// ─── Batch planner ────────────────────────────────────────────────────────────

/**
 * Analyses all scenes/beats and returns graphic plans where graphics
 * would improve the documentary. Used by the pipeline to pre-generate
 * graphics before retrieval of the same beats.
 *
 * Only plans graphics for beats where confidence >= threshold.
 * Max one graphic per beat. Max `maxPerVideo` graphics per video.
 */
export function planVideoGraphics(
  scenes: Array<{
    index: number;
    text: string;
    beats?: Array<{ index: number; text: string; holdSec?: number }>;
  }>,
  videoTitle = "",
  options: { confidenceThreshold?: number; maxPerVideo?: number } = {}
): GraphicPlan[] {
  if (!editorialGraphicsEnabled()) return [];

  const threshold = options.confidenceThreshold ?? 0.70;
  const maxPerVideo = options.maxPerVideo ?? 20;
  const plans: GraphicPlan[] = [];

  for (const scene of scenes) {
    const beats = scene.beats ?? [];
    for (const beat of beats) {
      if (plans.length >= maxPerVideo) break;
      const dur = beat.holdSec ?? DEFAULT_DURATION;
      const result = detectBeatGraphic(
        beat.text,
        scene.text,
        scene.index,
        beat.index,
        dur,
        videoTitle
      );
      if (result.shouldUseGraphic && result.plan && result.confidence >= threshold) {
        plans.push(result.plan);
      }
    }
    if (plans.length >= maxPerVideo) break;
  }

  if (plans.length > 0) {
    const byType: Record<string, number> = {};
    for (const p of plans) byType[p.type] = (byType[p.type] ?? 0) + 1;
    console.log(
      `[EditorialGraphics] Planned ${plans.length} graphic(s) for "${videoTitle}": ` +
      Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(", ")
    );
  }

  return plans;
}
