/**
 * Archive Ingestion V2 — enhanced multi-signal analysis during ingest.
 *
 * All functions run at ingest/backfill time only.
 * Zero LLM calls or network requests during video rendering.
 *
 * Feature flag: ARCHIVE_INGESTION_V2_ENABLED (default: true)
 *
 * New capabilities added on top of the existing pipeline:
 *  - Audio-transition-based scene splitting (silence gaps → cut candidates)
 *  - Shot boundary refinement (black frame + fade trim recommendations)
 *  - Standardized shot type classification (from existing annotation, pure)
 *  - Timed audio event detection (per-second ebur128 loudness analysis)
 *  - OCR named entity extraction (persons, dates, locations from OCR text)
 *  - Ingestion explainability log (structured decision trail)
 */

import { exec as execCb } from "child_process";
import { promisify } from "util";
import path from "path";

import type {
  ClipAnnotation,
  AudioEvent,
  BoundaryRefinement,
  OcrNamedEntity,
  IngestionLogEntry,
} from "../drizzle/annotationTypes";

const execPromise = promisify(execCb);

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function ingestionV2Enabled(): boolean {
  return process.env.ARCHIVE_INGESTION_V2_ENABLED !== "false";
}

// ─── Internal types ────────────────────────────────────────────────────────────

export type IngestionDecision = {
  stage: string;
  action: string;
  reason: string;
  value?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

async function safeExec(cmd: string, timeoutMs: number): Promise<string> {
  try {
    const r = await execPromise(cmd, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return String(r.stderr ?? "") + String(r.stdout ?? "");
  } catch (err: unknown) {
    return (
      String((err as { stderr?: string }).stderr ?? "") +
      String((err as { stdout?: string }).stdout ?? "")
    );
  }
}

// ─── 1. Audio transition cut detection ────────────────────────────────────────

/**
 * Detect audio-based cut candidates from silence gaps in the source file.
 *
 * Silence gaps of 0.2–3 s in speech-heavy content reliably mark scene or topic
 * boundaries. The centre of each qualifying gap is returned as a cut timestamp
 * that can be merged with visual shot boundaries.
 *
 * Only called on the original source file — individual clips have audio stripped.
 */
export async function detectAudioTransitionCuts(
  filePath: string,
  duration: number,
  timeoutMs = 25_000
): Promise<number[]> {
  if (duration < 2) return [];

  const output = await safeExec(
    `${ffmpegBin()} -i "${filePath}" -vn -af "silencedetect=n=-38dB:d=0.2" -f null -`,
    timeoutMs
  );

  const starts: number[] = [];
  const ends: number[] = [];

  const sRe = /silence_start:\s*([0-9.]+)/g;
  const eRe = /silence_end:\s*([0-9.]+)/g;
  let m: RegExpExecArray | null;

  while ((m = sRe.exec(output)) !== null) starts.push(parseFloat(m[1]));
  while ((m = eRe.exec(output)) !== null) ends.push(parseFloat(m[1]));

  const cuts: number[] = [];
  const count = Math.min(starts.length, ends.length);

  for (let i = 0; i < count; i++) {
    const silDur = ends[i] - starts[i];
    // 0.2–3 s silence = plausible scene boundary; shorter = breath, longer = whole section
    if (silDur >= 0.2 && silDur <= 3.0 && ends[i] > 0.5 && starts[i] < duration - 0.5) {
      cuts.push(starts[i] + silDur / 2);
    }
  }

  if (cuts.length > 0) {
    console.log(
      `[IngestionV2] audio transitions: ${cuts.length} silence-gap cut(s) in ${path.basename(filePath)}`
    );
  }
  return cuts;
}

// ─── 2. Shot boundary refinement ──────────────────────────────────────────────

/**
 * Recommend start/end trim offsets to remove unwanted leading/trailing material.
 *
 * Detects:
 *  - Leading black frames (broadcast leader / inter-clip gap)
 *  - Trailing black frames (broadcast tail)
 *  - Fade-in from black (luminance ramp at start)
 *  - Fade-out to black (luminance ramp at end)
 *
 * Returns a BoundaryRefinement record.  The trim is ADVISORY — it is stored in the
 * annotation and can be applied later; the stored clip file is not re-encoded.
 */
export async function refineShotBoundaries(
  filePath: string,
  duration: number,
  timeoutMs = 20_000
): Promise<BoundaryRefinement> {
  const noOp: BoundaryRefinement = {
    trimStartSec: 0,
    trimEndSec: 0,
    leadingBlackFrames: 0,
    trailingBlackFrames: 0,
    fadeInDetected: false,
    fadeOutDetected: false,
    reason: "no refinement needed",
  };

  if (duration < 0.5) return noOp;

  const window = Math.min(2.5, duration * 0.3);
  const perPass = Math.floor(timeoutMs / 4);

  const reasons: string[] = [];
  let trimStartSec = 0;
  let trimEndSec = 0;
  let leadingBlackFrames = 0;
  let trailingBlackFrames = 0;
  let fadeInDetected = false;
  let fadeOutDetected = false;

  // ── Leading black frames ────────────────────────────────────────────────────
  {
    const out = await safeExec(
      `${ffmpegBin()} -i "${filePath}" -t ${window.toFixed(2)} ` +
        `-vf "blackdetect=d=0:pix_th=0.15" -an -f null -`,
      perPass
    );
    const re = /black_end:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    let cnt = 0;
    while ((m = re.exec(out)) !== null) {
      const t = parseFloat(m[1]);
      if (t > 0 && t <= window) {
        lastEnd = Math.max(lastEnd, t);
        cnt++;
      }
    }
    if (lastEnd > 0.04) {
      trimStartSec = Math.min(lastEnd + 0.04, duration * 0.25);
      leadingBlackFrames = cnt;
      reasons.push(`leading black ends at ${lastEnd.toFixed(2)}s`);
    }
  }

  // ── Trailing black frames ───────────────────────────────────────────────────
  {
    const startAt = Math.max(0, duration - window);
    const out = await safeExec(
      `${ffmpegBin()} -i "${filePath}" -ss ${startAt.toFixed(2)} ` +
        `-vf "blackdetect=d=0:pix_th=0.15" -an -f null -`,
      perPass
    );
    const re = /black_start:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    let firstStart = duration;
    let cnt = 0;
    while ((m = re.exec(out)) !== null) {
      const t = startAt + parseFloat(m[1]);
      if (t > duration * 0.5 && t < duration - 0.04) {
        firstStart = Math.min(firstStart, t);
        cnt++;
      }
    }
    if (firstStart < duration - 0.1) {
      trimEndSec = Math.min(duration - firstStart + 0.04, duration * 0.25);
      trailingBlackFrames = cnt;
      reasons.push(`trailing black from ${firstStart.toFixed(2)}s`);
    }
  }

  // ── Fade-in detection via luminance ramp ─────────────────────────────────────
  {
    const fadeWin = Math.min(1.5, duration * 0.2);
    const out = await safeExec(
      `${ffmpegBin()} -i "${filePath}" -t ${fadeWin.toFixed(2)} ` +
        `-vf "signalstats" -an -f null -`,
      perPass
    );
    const yavg: number[] = [];
    const re = /YAVG=([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) yavg.push(parseFloat(m[1]));

    if (yavg.length >= 6) {
      const q = Math.ceil(yavg.length / 4);
      const firstQ = yavg.slice(0, q).reduce((a, b) => a + b, 0) / q;
      const lastQ = yavg.slice(-q).reduce((a, b) => a + b, 0) / q;
      if (firstQ < 20 && lastQ > 60) {
        fadeInDetected = true;
        reasons.push(`fade-in (YAVG ${firstQ.toFixed(0)}→${lastQ.toFixed(0)})`);
        if (trimStartSec < 0.1) {
          const fadeEnd = yavg.findIndex((v) => v > 40);
          if (fadeEnd > 0) trimStartSec = Math.max(trimStartSec, (fadeEnd / yavg.length) * fadeWin);
        }
      }
    }
  }

  // ── Fade-out detection ──────────────────────────────────────────────────────
  if (trimEndSec < 0.1 && duration > 2) {
    const fadeWin = Math.min(1.5, duration * 0.2);
    const startAt = Math.max(0, duration - fadeWin);
    const out = await safeExec(
      `${ffmpegBin()} -i "${filePath}" -ss ${startAt.toFixed(2)} ` +
        `-vf "signalstats" -an -f null -`,
      perPass
    );
    const yavg: number[] = [];
    const re = /YAVG=([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) yavg.push(parseFloat(m[1]));

    if (yavg.length >= 6) {
      const half = Math.ceil(yavg.length / 2);
      const firstH = yavg.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const lastH = yavg.slice(-half).reduce((a, b) => a + b, 0) / half;
      if (firstH > 60 && lastH < 20) {
        fadeOutDetected = true;
        reasons.push(`fade-out (YAVG ${firstH.toFixed(0)}→${lastH.toFixed(0)})`);
      }
    }
  }

  const hasRefinement =
    trimStartSec > 0.04 || trimEndSec > 0.04 || fadeInDetected || fadeOutDetected;

  const result: BoundaryRefinement = {
    trimStartSec: Math.round(trimStartSec * 1000) / 1000,
    trimEndSec: Math.round(trimEndSec * 1000) / 1000,
    leadingBlackFrames,
    trailingBlackFrames,
    fadeInDetected,
    fadeOutDetected,
    reason: hasRefinement ? reasons.join("; ") : "no refinement needed",
  };

  if (hasRefinement) {
    console.log(
      `[IngestionV2] boundary refinement ${path.basename(filePath)}: ${result.reason} ` +
        `(trimStart=${result.trimStartSec}s trimEnd=${result.trimEndSec}s)`
    );
  }

  return result;
}

// ─── 3. Shot classification ────────────────────────────────────────────────────

const SHOT_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/\bextreme[\s-]?close[\s-]?up\b|\bECU\b|\bXCU\b/i, "Extreme Close-up"],
  [/\bclose[\s-]?up\b|\bCU\b/i, "Close-up"],
  [/\bmedium[\s-]?close\b|\bMCU\b/i, "Medium Close-up"],
  [/\bmedium\b|\bMS\b|\bmid[\s-]?shot\b/i, "Medium"],
  [/\bwide\b|\blong[\s-]?shot\b|\bLS\b/i, "Wide"],
  [/\bestablish\w+/i, "Establishing"],
  [/\baerial\b|\bdrone\b|\bbird[\s-]?[''s]*[\s-]?eye\b/i, "Aerial"],
  [/\bPOV\b|\bpoint[\s-]?of[\s-]?view\b/i, "POV"],
  [/\binsert[\s-]?shot\b|\binsert\b/i, "Insert"],
  [/\bcutaway\b/i, "Cutaway"],
  [/\btracking\b|\bfollow[\s-]?shot\b|\bdolly\b|\bcrane\b/i, "Tracking"],
  [/\bpanning\b|\bpan(?!\w)/i, "Pan"],
  [/\btilting\b|\btilt(?!\w)/i, "Tilt"],
  [/\bzoom\b/i, "Zoom"],
  [/\bhandheld\b|\bhand[\s-]?held\b|\bshaky\b/i, "Handheld"],
  [/\bstatic\b|\blocked[\s-]?off\b|\btripod\b/i, "Static"],
  [/\bslow[\s-]?mo\w*\b|\bhigh[\s-]?speed[\s-]?cam\b/i, "Slow motion"],
  [/\btime[\s-]?lapse\b|\bhyper[\s-]?lapse\b/i, "Time-lapse"],
];

/**
 * Derive a standardized shot type label set from the existing ClipAnnotation.
 *
 * Pure function — no LLM, no network, O(1) per clip.
 * Sources: cinematicTags[], timeline[].shotType, cameraMovementDetail, descriptions.
 *
 * Example results: ["Wide", "Static", "Establishing"] | ["Close-up", "Handheld"] | ["Aerial"]
 */
export function deriveShotClassification(annotation: ClipAnnotation): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  // Combine all text sources that may contain shot-type descriptions
  const sources = [
    ...(annotation.cinematicTags ?? []),
    ...(annotation.timeline ?? []).map((s) => s.shotType).filter(Boolean),
    ...(annotation.timeline ?? []).map((s) => s.cameraMovement ?? "").filter(Boolean),
    annotation.cameraMovementDetail ?? "",
    annotation.descriptions?.short ?? "",
    annotation.descriptions?.normal ?? "",
  ].join(" ");

  for (const [pattern, label] of SHOT_TYPE_PATTERNS) {
    if (pattern.test(sources) && !seen.has(label)) {
      seen.add(label);
      found.push(label);
    }
  }

  // Ensure exactly one primary framing label (prefer most specific)
  const framingOrder = [
    "Extreme Close-up",
    "Close-up",
    "Medium Close-up",
    "Medium",
    "Wide",
    "Establishing",
    "Aerial",
  ];
  const hasFraming = found.some((l) => framingOrder.includes(l));
  if (!hasFraming) {
    // Default framing from editorialScore.cinematicQuality or nothing
    const qual = annotation.editorialScore?.cinematicQuality ?? 0;
    if (qual >= 70) found.unshift("Wide"); // high-quality without a label → probably wide
  }

  return found.slice(0, 6);
}

// ─── 4. Timed audio event detection ───────────────────────────────────────────

/**
 * Detect and localize audio events with per-second timestamps.
 *
 * Uses ffmpeg ebur128 filter (momentary loudness, 400 ms windows) to produce
 * a loudness time series, then classifies 1-second buckets into event types.
 *
 * Called on the source file (before splitting) because per-clip files have
 * audio stripped.  The results are stored with clip-relative start times.
 *
 * Event types: "silence" | "speech" | "music" | "loud_event" | "crowd"
 */
export async function detectTimedAudioEvents(
  filePath: string,
  duration: number,
  timeoutMs = 40_000
): Promise<AudioEvent[]> {
  if (duration < 1) return [];

  const output = await safeExec(
    `${ffmpegBin()} -i "${filePath}" -vn -af "ebur128=framelog=verbose" -f null -`,
    timeoutMs
  );

  // Parse: "t: 0.4     M: -23.0   S: -21.5 …"
  const measurements: Array<{ t: number; M: number }> = [];
  const lineRe = /t:\s*([0-9.]+)\s+M:\s*([-0-9.inf]+)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const t = parseFloat(m[1]);
    const ml = parseFloat(m[2]);
    if (!isNaN(t) && !isNaN(ml) && isFinite(ml)) {
      measurements.push({ t, M: ml });
    }
  }

  if (measurements.length === 0) return [];

  // Aggregate measurements into 1-second buckets
  const buckets = new Map<number, number[]>();
  for (const { t, M } of measurements) {
    const bucket = Math.floor(t);
    const arr = buckets.get(bucket) ?? [];
    arr.push(M);
    buckets.set(bucket, arr);
  }

  // Classify each bucket
  type EvtKind = "silence" | "speech" | "music" | "loud_event" | "crowd";
  const timeline: Array<{ t: number; kind: EvtKind }> = [];

  for (const [t, values] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    if (t > duration + 1) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    let kind: EvtKind;
    if (avg < -60) {
      kind = "silence";
    } else if (avg > -12) {
      kind = "loud_event"; // explosion, gunfire, applause, cheering
    } else if (avg > -25) {
      kind = "crowd"; // crowd noise, heavy music, multiple speakers
    } else if (avg > -40) {
      kind = "speech"; // individual speaker, dialogue
    } else {
      kind = "music"; // quiet background music, ambient
    }
    timeline.push({ t, kind });
  }

  // Merge consecutive same-kind into events
  const events: AudioEvent[] = [];
  let runStart = 0;
  let runKind: EvtKind | null = null;
  let runLen = 0;

  for (const { t, kind } of timeline) {
    if (kind !== runKind) {
      if (runKind !== null && runLen >= 1) {
        events.push({
          type: runKind,
          startSec: runStart,
          durationSec: runLen,
          confidence: 0.72,
        });
      }
      runKind = kind;
      runStart = t;
      runLen = 1;
    } else {
      runLen++;
    }
  }
  if (runKind !== null && runLen >= 1) {
    events.push({
      type: runKind,
      startSec: runStart,
      durationSec: runLen,
      confidence: 0.72,
    });
  }

  // Skip trivial silence-only results (no audio in file)
  const nonSilence = events.filter((e) => e.type !== "silence");
  if (nonSilence.length === 0) return [];

  console.log(
    `[IngestionV2] timed audio: ${events.length} event(s) in ${path.basename(filePath)} ` +
      `(${nonSilence.map((e) => e.type).join(", ")})`
  );
  return events;
}

/**
 * Filter source-level audio events to those that fall within a clip's time range.
 * Returns events with startSec re-zeroed to clip-relative time.
 */
export function filterAudioEventsForClip(
  sourceEvents: AudioEvent[],
  clipStartSec: number,
  clipEndSec: number
): AudioEvent[] {
  return sourceEvents
    .filter((e) => {
      const start = e.startSec ?? 0;
      const end = start + (e.durationSec ?? 1);
      return end > clipStartSec && start < clipEndSec;
    })
    .map((e) => ({
      ...e,
      startSec: Math.max(0, (e.startSec ?? 0) - clipStartSec),
      durationSec: Math.min(
        (e.durationSec ?? 1),
        clipEndSec - Math.max(clipStartSec, e.startSec ?? 0)
      ),
    }));
}

// ─── 5. OCR named entity extraction ───────────────────────────────────────────

// Common words that look like names but aren't (all-caps UI elements, labels)
const FALSE_POSITIVE_NAME_WORDS = new Set([
  "THE", "AND", "FOR", "FROM", "THIS", "THAT", "WITH", "INTO",
  "BBC", "CNN", "NBC", "CBS", "SKY", "ITV", "PBS",
  "NEWS", "LIVE", "BREAKING", "ALERT", "FLASH", "UPDATE",
  "PART", "CLIP", "VIDEO", "FILE", "TAPE",
  "UNITED", "STATES", "NATIONS", "KINGDOM", "REPUBLIC",
  "PRESS", "PHOTO", "AGENCY", "WIRE",
]);

/**
 * Extract named entities from all OCR text stored in the annotation.
 *
 * Detects: years, full dates, locations (preposition patterns), names (all-caps pairs),
 * headlines (all-caps lines > 10 chars).
 *
 * Pure function — regex only, no LLM, no network.
 */
export function extractOcrNamedEntities(annotation: ClipAnnotation): OcrNamedEntity[] {
  const entities: OcrNamedEntity[] = [];
  const seen = new Set<string>();

  function add(text: string, type: OcrNamedEntity["type"], confidence: number, timestamp?: number) {
    const key = `${type}:${text.trim()}`;
    if (seen.has(key) || text.trim().length < 2) return;
    seen.add(key);
    entities.push({ text: text.trim(), type, confidence, timestamp });
  }

  // Collect all OCR text with timestamps
  const sources: Array<{ text: string; timestamp?: number }> = [];
  for (const t of annotation.ocrText ?? []) {
    if (t && t.trim().length > 0) sources.push({ text: t });
  }
  for (const entry of annotation.ocrTimeline ?? []) {
    if (entry.text && entry.text.trim().length > 0) {
      sources.push({ text: entry.text, timestamp: entry.startSec });
    }
  }
  for (const seg of annotation.timeline ?? []) {
    if (seg.ocrText && seg.ocrText.trim().length > 0) {
      sources.push({ text: seg.ocrText, timestamp: seg.startSec });
    }
  }

  for (const { text, timestamp } of sources) {
    // ── Years ────────────────────────────────────────────────────────────────
    const yearRe = /\b(1[5-9]\d\d|20\d\d)\b/g;
    let m: RegExpExecArray | null;
    while ((m = yearRe.exec(text)) !== null) {
      add(m[1], "date", 0.90, timestamp);
    }

    // ── Full dates (e.g. "March 15, 1943", "15 April 1944", "04/06/1944") ──
    const fullDateRe =
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.,]?\s+\d{1,2}[,.]?\s+\d{4}\b/gi;
    while ((m = fullDateRe.exec(text)) !== null) {
      add(m[0], "date", 0.95, timestamp);
    }

    const dmyRe = /\b\d{1,2}[\s./]\d{1,2}[\s./]\d{4}\b/g;
    while ((m = dmyRe.exec(text)) !== null) {
      add(m[0], "date", 0.80, timestamp);
    }

    // ── Locations (preposition patterns) ─────────────────────────────────────
    const locRe = /\b(?:IN|AT|NEAR|OUTSIDE|FROM|REPORTED FROM|REPORTING FROM|LIVE FROM)\s+([A-Z][A-Za-z\s,]{3,35}?)(?=[.,:\n]|$)/gm;
    while ((m = locRe.exec(text)) !== null) {
      const loc = m[1].trim().replace(/,$/, "");
      if (loc.length >= 3 && loc.length <= 35) add(loc, "location", 0.72, timestamp);
    }

    // ── Named persons (ALL CAPS FIRSTNAME LASTNAME — news ticker style) ──────
    const namePairRe = /\b([A-Z]{2,})\s+([A-Z]{2,})\b/g;
    while ((m = namePairRe.exec(text)) !== null) {
      const first = m[1];
      const last = m[2];
      if (
        !FALSE_POSITIVE_NAME_WORDS.has(first) &&
        !FALSE_POSITIVE_NAME_WORDS.has(last) &&
        first.length <= 18 &&
        last.length <= 18
      ) {
        add(`${first} ${last}`, "person", 0.60, timestamp);
      }
    }

    // ── Headlines / titles (all-caps lines > 10 chars) ────────────────────────
    const headlineRe = /^([A-Z][A-Z\s:,''"-]{10,80})$/gm;
    while ((m = headlineRe.exec(text)) !== null) {
      const hl = m[1].trim();
      // Must contain at least one word > 3 chars and not be all numbers
      if (/[A-Z]{4,}/.test(hl) && !/^\d+$/.test(hl)) {
        add(hl, "headline", 0.75, timestamp);
      }
    }
  }

  return entities.slice(0, 60);
}

// ─── 6. Ingestion explainability log ─────────────────────────────────────────

/**
 * Compile a structured explainability log from ingestion decisions and annotation signals.
 * Stored as annotation.ingestionLog for audit and debugging.
 */
export function buildIngestionLog(
  annotation: ClipAnnotation,
  decisions: IngestionDecision[]
): IngestionLogEntry[] {
  const ts = new Date().toISOString();
  const entries: IngestionLogEntry[] = [];

  // Caller-supplied decisions (stage-by-stage)
  for (const d of decisions) {
    entries.push({ stage: d.stage, action: d.action, reason: d.reason, timestamp: ts, value: d.value });
  }

  // Auto-derive additional entries from annotation state

  if (annotation.qualityFlags?.nearDuplicateOf) {
    entries.push({
      stage: "Stage 4 (dedup)",
      action: "flagged_as_near_duplicate",
      reason: `Embedding cosine similarity > 0.97 vs asset ${annotation.qualityFlags.nearDuplicateOf}`,
      timestamp: ts,
    });
  }

  if (annotation.qualityFlags?.isBlack) {
    entries.push({
      stage: "Stage 2 (quality)",
      action: "flagged_black_clip",
      reason: "Dominant fraction of frames are black (blackdetect)",
      timestamp: ts,
    });
  }

  if (annotation.boundaryRefinement && annotation.boundaryRefinement.reason !== "no refinement needed") {
    entries.push({
      stage: "Stage 18 (boundary)",
      action: "boundary_refinement",
      reason: annotation.boundaryRefinement.reason,
      timestamp: ts,
      value: `trimStart=${annotation.boundaryRefinement.trimStartSec}s trimEnd=${annotation.boundaryRefinement.trimEndSec}s`,
    });
  }

  if (annotation.shotClassification && annotation.shotClassification.length > 0) {
    entries.push({
      stage: "Stage 19 (classification)",
      action: "shot_classified",
      reason: `Derived from cinematicTags + timeline shotTypes + cameraMovement`,
      timestamp: ts,
      value: annotation.shotClassification.join(", "),
    });
  }

  if (annotation.ocrNamedEntities && annotation.ocrNamedEntities.length > 0) {
    const types = annotation.ocrNamedEntities.map((e) => e.type).join(", ");
    entries.push({
      stage: "Stage 20 (OCR NER)",
      action: "ocr_entities_extracted",
      reason: `${annotation.ocrNamedEntities.length} entities found via regex NER`,
      timestamp: ts,
      value: types,
    });
  }

  if (annotation.healthScore) {
    entries.push({
      stage: "Stage 15 (health)",
      action: "health_score",
      reason: `metadata=${annotation.healthScore.metadataCompleteness} technical=${annotation.healthScore.technicalQuality} editorial=${annotation.healthScore.editorialQuality} uniqueness=${annotation.healthScore.archiveUniqueness}`,
      timestamp: ts,
      value: String(annotation.healthScore.score),
    });
  }

  if (annotation.editorialIntent?.narrativeFunctions.length) {
    entries.push({
      stage: "Stage 17 (intent)",
      action: "editorial_intent",
      reason: annotation.editorialIntent.visualPurpose,
      timestamp: ts,
      value: annotation.editorialIntent.narrativeFunctions.join(", "),
    });
  }

  return entries;
}

// ─── 7. Pipeline scheduling ───────────────────────────────────────────────────

/**
 * Schedule the Archive Intelligence Pipeline for an asset asynchronously.
 * Safe to call from the upload path — does not block the HTTP response.
 */
export function scheduleV2IntelligencePipeline(assetId: number): void {
  void import("./archiveIntelligencePipeline")
    .then(({ runArchiveIntelligencePipelineForAssetId }) =>
      runArchiveIntelligencePipelineForAssetId(assetId)
    )
    .catch((err) =>
      console.warn(
        `[IngestionV2] background pipeline failed for asset ${assetId}:`,
        (err as Error).message?.slice(0, 100)
      )
    );
}
