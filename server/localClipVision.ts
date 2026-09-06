/**
 * Local CLIP-based visual QA — no external vision API.
 * Indexes archive frames on upload; scores adopt candidates via text↔image similarity + luma.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { foldSearchText } from "./searchTextNormalize";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { cosineSimilarityVectors, type BeatSemanticProfile } from "./semanticVisualMatching";
import { inferVideoVisualTopic } from "./visualBeatTags";
import {
  asVideoTitleString,
  coerceVisionString,
} from "./stringCoercion";
import { beatVisualDescriptionFromIntent } from "./scriptVisualKeywords";
import { ffmpegSemaphore } from "./_core/semaphore";
import { throwIfActiveRenderCancelled } from "./videoGenerationCancel";
import { recordGateVerdict } from "./gateFiringStats";
import { clipModelCacheLocation } from "./clipModelCache";

export { coerceVisionString, asVideoTitleString } from "./stringCoercion";

const exec = promisify(execCb);

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
export const LOCAL_FRAME_FRACTIONS = [0.12, 0.38, 0.62, 0.88];
/** Index frames aligned with gate sampling so pre-rank scores predict adopt gates. */
const INDEX_FRAME_FRACTIONS = LOCAL_FRAME_FRACTIONS.slice(0, 3);

type ClipPipeline = (input: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let imagePipeline: ClipPipeline | null = null;
let textPipeline: ClipPipeline | null = null;
let pipelineLoadFailed = false;
let pipelineLoadInFlight: Promise<boolean> | null = null;
let imageLoadAttempts = 0;
let textLoadAttempts = 0;
const MAX_PIPELINE_LOAD_ATTEMPTS = 3;

/**
 * Writable cache dir for Hugging Face / ONNX model weights (Railway volume preferred).
 *
 * The rule — and, just as importantly, whether the chosen directory survives the container — lives
 * in `./clipModelCache`. See that module for what the worker log of 2026-09-05 proved about it.
 */
export function clipModelCacheDir(): string {
  return clipModelCacheLocation().dir;
}

let transformersEnvConfigured = false;

function configureTransformersEnv(): string {
  const cacheDir = clipModelCacheDir();
  if (!transformersEnvConfigured) {
    transformersEnvConfigured = true;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch {
      /* ignore — import may still succeed with in-memory cache */
    }
    process.env.TRANSFORMERS_CACHE = cacheDir;
    process.env.HF_HOME = cacheDir;
    process.env.XDG_CACHE_HOME = cacheDir;
  }
  return cacheDir;
}

function clipModelExistsLocally(cacheDir: string): boolean {
  // @xenova/transformers stores models under <cacheDir>/Xenova/clip-vit-base-patch32/
  // The onnx quantized file is the critical artifact.
  try {
    const modelSlug = CLIP_MODEL.replace("/", path.sep);
    const modelDir = path.join(cacheDir, modelSlug);
    if (!fs.existsSync(modelDir)) return false;
    const onnxFiles = fs.readdirSync(modelDir).filter(f => f.endsWith(".onnx"));
    return onnxFiles.length > 0;
  } catch {
    return false;
  }
}

async function importTransformersPipeline() {
  const cacheDir = configureTransformersEnv();
  const modelExists = clipModelExistsLocally(cacheDir);
  if (!modelExists) {
    /** The claim about persistence is read from the location, never asserted — see the type. */
    const where = clipModelCacheLocation();
    console.log(
      `[LocalVision] CLIP model not in cache (${cacheDir}) — downloading ~350MB now. ` +
        (where.persists
          ? `Kept: ${where.why}, so this is one-time.`
          : `NOT KEPT: ${where.why}.`)
    );
  }
  const { env, pipeline } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  // Allow the download when the model is missing. Whether it has to happen again on the next boot
  // depends on the cache location, which `clipModelCacheLocation()` reports rather than assumes.
  env.allowRemoteModels = !modelExists;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.numThreads = 1;
  return pipeline;
}

// CLIP's combined ONNX graph — the one `pipeline("feature-extraction", CLIP_MODEL)` loads via
// AutoModel — requires both `input_ids` AND `pixel_values` on every forward pass, so calling it
// with text only throws "Missing the following inputs: pixel_values". The text tower has to be
// loaded directly via CLIPTextModelWithProjection instead of the generic pipeline() helper.
async function importClipTextModelClasses() {
  const cacheDir = configureTransformersEnv();
  const modelExists = clipModelExistsLocally(cacheDir);
  const { env, AutoTokenizer, CLIPTextModelWithProjection } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  env.allowRemoteModels = !modelExists;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.numThreads = 1;
  return { AutoTokenizer, CLIPTextModelWithProjection };
}

/** Local visual QA on by default — set ENABLE_LOCAL_VISION=false to disable. */
export function localVisionEnabled(): boolean {
  return process.env.ENABLE_LOCAL_VISION !== "false";
}

/** Background CLIP index on archive upload (default on with local vision). */
export function clipEmbeddingIndexEnabled(): boolean {
  if (process.env.ENABLE_CLIP_EMBEDDING_INDEX === "false") return false;
  return localVisionEnabled();
}

export function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN?.trim() || "ffprobe";
}

export function clipSimToScore(sim: number): number {
  return Math.max(0, Math.min(10, Math.round(sim * 40)));
}

/** Minimum cosine similarity (0–1) to pass gate; derived from MIN_CLIP_QUALITY_SCORE unless overridden. */
export function minLocalClipSimilarity(minScore10 = 8): number {
  const raw = process.env.LOCAL_VISION_MIN_SIMILARITY?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.08 && n <= 0.55) return n;
  }
  return minScore10 / 40;
}

// RONDE 26: the original five probes were all indoor office/tech scenes. Renders 525-527 pulled
// present-day OUTDOOR footage into a WWII documentary — internet-archive clips of 2020s roadside
// and city protests, a 2019 NASA spacewalk — and not one of those contains a laptop, a projector
// or a conference room, so every probe stayed deep inside the CLIP noise band and the gate had
// nothing to weigh. The added probes describe modernity itself (clothing, vehicles, road markings,
// hi-vis, glass towers, HD colour video) rather than a workplace, which is what actually separates
// a 2021 street from a 1943 one. They stay deliberately subject-neutral: nothing here mentions
// protest, crowd or march, because those read equally well on a Nuremberg rally.
const MODERN_MISMATCH_QUERIES = [
  "modern business conference presentation projector screen audience",
  "laptop computer software code documentation office meeting",
  "corporate keynote speaker slide deck technology startup",
  "smartphone tablet digital app interface screen",
  "contemporary office whiteboard team meeting",
  "people wearing modern casual clothing t-shirts jeans and sneakers",
  "present day street with modern parked cars and road markings",
  "contemporary city skyline with glass and steel skyscrapers",
  "workers in high visibility safety vests and hard hats on a modern site",
  "sharp high definition colour video of a present day outdoor scene",
];

export function topicNeedsHistoricalFootage(beatText: string, videoTitle?: unknown): boolean {
  const topic = inferVideoVisualTopic(videoTitle, beatText);
  if (topic === "wwii" || topic === "cold_war") return true;
  const hay = `${asVideoTitleString(videoTitle)} ${beatText}`.toLowerCase();
  return /\b(19\d{2}|20[0-1]\d|world war|wwii|ww2|war|historical|archive|ancient|century|hitler|nazi|berlin|titanic)\b/.test(
    hay
  );
}

async function getModernMismatchEmbeddings(): Promise<number[][]> {
  if (modernMismatchEmbCache) return modernMismatchEmbCache;
  const out: number[][] = [];
  for (const q of MODERN_MISMATCH_QUERIES) {
    const emb = await embedTextQuery(q);
    if (emb) out.push(emb);
  }
  modernMismatchEmbCache = out;
  return out;
}

// ─── FASE 7.3 — evidence-safe anti-anachronism gate ──────────────────────────
//
// modernContentMismatch is a HARD veto: it feeds definiteFail/wrongSubject/matchesNarration
// as an OR term, so a single true kills a candidate outright regardless of how well it
// actually scored. Production render 512 proved the original conditions could not carry that
// weight: 14 of 14 candidates that cleared the similarity floor (scores 7.40–9.43 against a
// 7.00 floor) were destroyed by this gate, with no corroborating metadata, title or date
// evidence that any of them was actually modern.
//
// The two original conditions were:
//   (1) negSim >= beatSim - 0.01
//   (2) negSim >= 0.18 && beatSim < 0.24
//
// Both measure noise rather than modernity. CLIP text↔image cosine similarity has a high,
// content-independent baseline (~0.15–0.25 for almost any text against almost any image), so
// (1) fires whenever a generic probe lands in that same band — including when the probe is
// *worse* than the beat's own query. (2) is worse still: beatSim < 0.24 is score < 9.6/10, so
// with the gate armed it silently raised the effective pass bar from the configured 7.00 to
// ~9.6 for every candidate a probe happened to reach 0.18 against.
//
// The rule now is: uncertainty is never a reject. Modern evidence must be decisive
// (MODERN_EVIDENCE_MARGIN above the beat's own query — not a near-tie), absolute
// (MODERN_EVIDENCE_MIN_SIM, above the whole noise band), corroborated across independent
// probes (MODERN_EVIDENCE_MIN_PROBES) and corroborated across frames
// (MODERN_EVIDENCE_MIN_FRAMES). Anything less leaves the candidate to the normal
// similarity/ranking flow, where its real score decides.

/** Absolute similarity a probe must reach before it counts as modern evidence at all.
 *  Set above the entire similarity band observed for genuine historical candidates in render
 *  512 (max 0.2358), so a value inside that band can no longer flag anything. */
/**
 * RONDE 51 — recalibrated against render 530, where this gate was consulted 54 times and fired
 * zero times (`gate firing — modern_mismatch=0/54`), together with off_topic_protest 0/20 and
 * vision_gate 0/20. A veto with a 0/94 firing rate is not conservative, it is absent, and the
 * render shipped Pexels stock and a 2022 Internet Archive comment video for 1945 bunker beats.
 *
 * The floor was set to 0.26 from render 512, above the whole band seen there (max 0.2358). Render
 * 530 measured, per candidate (topNegSim / beatSim):
 *
 *   genuine archive   Bundesarchiv 0.2103/0.2145 · 0.2077/0.1974 · Klara_Hitler 0.1890/0.1974
 *   modern stock      pexels 0.2432/0.2129 · 0.2284/0.2260 · 0.2389/0.2230
 *
 * Everything sits below 0.26, so no probe ever cleared the floor. But the two groups do separate
 * on the OTHER axis: for real archive the probe scores at or below the beat's own query
 * (−0.005..+0.01), while for modern stock it scores consistently above it (+0.02..+0.03). The
 * 0.05 margin was wider than the separation that exists.
 *
 * The floor now sits just under the modern band and above the archive band, and the margin is
 * inside the observed separation. Both stay overridable from the environment; the pre-Ronde-51
 * values were 0.26 and 0.05.
 *
 * This is n≈10 from one render. It is a deliberate move from "never fires" to "fires on the
 * separation we can actually see", and the per-candidate log line makes the next render measure
 * it. If it starts rejecting genuine archive material, raise MODERN_EVIDENCE_MIN_SIM back.
 */
const MODERN_EVIDENCE_MIN_SIM = visionThreshold("MODERN_EVIDENCE_MIN_SIM", 0.235);
/** How decisively a probe must beat the beat's own query. Replaces the original `- 0.01`,
 *  which fired on near-ties and even when the probe scored below the beat query. */
const MODERN_EVIDENCE_MARGIN = visionThreshold("MODERN_EVIDENCE_MARGIN", 0.015);

function visionThreshold(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
/** Independent probes that must agree on the same frame. One probe is never enough. */
const MODERN_EVIDENCE_MIN_PROBES = 2;
/**
 * RONDE 26: probes that must agree when there is only ONE frame to look at.
 *
 * The corroboration requirement does not disappear in that case — it moves onto the probe axis,
 * where it is the only axis left. Three independent probes clearing both the absolute floor and
 * the margin over the beat's own query is a strictly harder bar per frame than the two demanded
 * when a second frame can back it up.
 */
const MODERN_EVIDENCE_SINGLE_FRAME_MIN_PROBES = 3;
/** Frames that must independently agree when more than one frame is available. */
const MODERN_EVIDENCE_MIN_FRAMES = 2;
/** Upper bound on frames compared (pure cosine math over already-computed embeddings). */
const MODERN_EVIDENCE_MAX_FRAMES = 3;

export type ModernMismatchReason =
  | "not-historical-topic"
  | "no-probes"
  | "no-frames"
  | "strong-modern-evidence"
  | "insufficient-evidence";

export type ModernMismatchVerdict = {
  /** The hard veto. True only on strong, corroborated evidence. */
  mismatch: boolean;
  reason: ModernMismatchReason;
  /** beatSim of the frame that produced topNegSim. */
  beatSim: number;
  topNegSim: number;
  topProbe: string | null;
  framesEvaluated: number;
  framesFlagged: number;
  probesEvaluated: number;
  /** Diagnostic only: would the pre-FASE-7.3 conditions have rejected this candidate?
   *  Never consulted in the decision — it exists so a production log makes the behaviour
   *  change measurable per candidate. */
  legacyWouldReject: boolean;
  /**
   * RONDE 174 — how far the best probe was from counting as evidence, in similarity units.
   *
   * A probe is evidence only when it clears BOTH the absolute floor and the margin over the
   * beat's own query, so the shortfall is whichever of the two it missed by more. 0 or less means
   * the probe qualified (the frame/probe quorum may still have refused the veto).
   *
   * This exists because `asked`/`fired` could not tell "the threshold is a hair too high" from
   * "the material is not modern at all". Render 530 read 0/54, RONDE 51 retuned on ten
   * hand-collected numbers, and the next render read 0/74 with nothing to compare it against. The
   * gate now reports its own distance from firing every time it is asked.
   */
  shortfallToFire: number;
};

/** One sampled frame's similarities: against the beat query, and against each modern probe. */
export type ModernMismatchFrameEvidence = { beatSim: number; negSims: number[] };

/**
 * Pure decision half of the gate — no embeddings, no model, no I/O. Split out from
 * evaluateModernContentMismatch so the evidence rules are directly testable with the real
 * numbers observed in production.
 */
export function decideModernContentMismatch(
  frames: ModernMismatchFrameEvidence[],
  probeLabels: string[] = MODERN_MISMATCH_QUERIES
): ModernMismatchVerdict {
  const empty = {
    mismatch: false,
    beatSim: 0,
    topNegSim: 0,
    topProbe: null as string | null,
    framesEvaluated: 0,
    framesFlagged: 0,
    probesEvaluated: 0,
    legacyWouldReject: false,
    // No frames or no probes means the gate never had evidence to be short of, not that it came
    // close. Infinity keeps it out of the "closest" statistic entirely.
    shortfallToFire: Number.POSITIVE_INFINITY,
  };
  if (frames.length === 0) return { ...empty, reason: "no-frames" };
  const probesEvaluated = frames[0]!.negSims.length;
  if (probesEvaluated === 0) return { ...empty, reason: "no-probes" };

  let framesFlagged = 0;
  let topNegSim = -Infinity;
  let topProbe: string | null = null;
  let topBeatSim = 0;
  let legacyWouldReject = false;
  let bestShortfall = Number.POSITIVE_INFINITY;

  // RONDE 26: both requirements adapt to how many frames the caller could actually supply.
  //
  // The live path is scoreClipAcrossFrames → extractSinglePreviewFrame, which yields exactly one
  // frame. Against a flat "two frames must agree" that made this gate mathematically unreachable:
  // renders 525, 526 and 527 logged 152 evaluations, every one of them frames=0/1, and rejected
  // nothing at all while legacyWouldReject was true on all 152. A veto that cannot fire is not a
  // conservative veto, it is an absent one.
  const probesRequired =
    frames.length === 1 ? MODERN_EVIDENCE_SINGLE_FRAME_MIN_PROBES : MODERN_EVIDENCE_MIN_PROBES;
  const framesRequired = Math.min(MODERN_EVIDENCE_MIN_FRAMES, frames.length);

  for (const { beatSim, negSims } of frames) {
    let probesFlagged = 0;
    for (let i = 0; i < negSims.length; i++) {
      const negSim = negSims[i]!;
      if (negSim > topNegSim) {
        topNegSim = negSim;
        topProbe = probeLabels[i] ?? null;
        topBeatSim = beatSim;
      }
      // Pre-FASE-7.3 behaviour, evaluated for observability only.
      if (negSim >= beatSim - 0.01 || (negSim >= 0.18 && beatSim < 0.24)) legacyWouldReject = true;
      // A probe is real evidence only when it clears the absolute floor AND decisively beats
      // the beat's own query. Either alone is inside the CLIP noise band.
      if (negSim >= MODERN_EVIDENCE_MIN_SIM && negSim >= beatSim + MODERN_EVIDENCE_MARGIN) {
        probesFlagged++;
      }
      // RONDE 174: the binding constraint is whichever of the two this probe missed by more.
      const shortfall = Math.max(
        MODERN_EVIDENCE_MIN_SIM - negSim,
        beatSim + MODERN_EVIDENCE_MARGIN - negSim
      );
      if (shortfall < bestShortfall) bestShortfall = shortfall;
    }
    if (probesFlagged >= probesRequired) framesFlagged++;
  }

  const framesEvaluated = frames.length;
  const mismatch = framesEvaluated > 0 && framesFlagged >= framesRequired;

  return {
    mismatch,
    reason: mismatch ? "strong-modern-evidence" : "insufficient-evidence",
    beatSim: topBeatSim,
    topNegSim: topNegSim === -Infinity ? 0 : topNegSim,
    topProbe,
    framesEvaluated,
    framesFlagged,
    probesEvaluated,
    legacyWouldReject,
    shortfallToFire: bestShortfall,
  };
}

async function evaluateModernContentMismatch(
  imageEmbeddings: number[][],
  beatQueryEmb: number[],
  beatText: string,
  videoTitle: string | undefined,
  clipPath: string
): Promise<ModernMismatchVerdict> {
  const notArmed: ModernMismatchVerdict = {
    mismatch: false,
    reason: "not-historical-topic",
    beatSim: 0,
    topNegSim: 0,
    topProbe: null,
    framesEvaluated: 0,
    framesFlagged: 0,
    probesEvaluated: 0,
    legacyWouldReject: false,
    // No frames or no probes means the gate never had evidence to be short of, not that it came
    // close. Infinity keeps it out of the "closest" statistic entirely.
    shortfallToFire: Number.POSITIVE_INFINITY,
  };
  if (!topicNeedsHistoricalFootage(beatText, videoTitle)) return notArmed;
  const negEmbs = await getModernMismatchEmbeddings();
  if (negEmbs.length === 0) return { ...notArmed, reason: "no-probes" };

  const samples = imageEmbeddings.slice(0, Math.min(MODERN_EVIDENCE_MAX_FRAMES, imageEmbeddings.length));
  const frames: ModernMismatchFrameEvidence[] = samples.map((imgEmb) => ({
    beatSim: scoreEmbeddingSimilarity(beatQueryEmb, imgEmb),
    negSims: negEmbs.map((negEmb) => scoreEmbeddingSimilarity(negEmb, imgEmb)),
  }));

  const verdict = decideModernContentMismatch(frames);

  // RONDE 29: this gate is the reason the counters exist — it ran 152 times across three
  // renders, logged every time, had its flag on, and could not return true. Recorded here,
  // after the not-armed/no-probes early returns, so "asked" means the gate genuinely judged a
  // candidate rather than declining to look at one.
  recordGateVerdict("modern_mismatch", verdict.mismatch, { shortfall: verdict.shortfallToFire });

  // Logged once per gate evaluation, never per frame, and only for the candidates where this
  // gate actually mattered: a reject now, or a reject under the old conditions. Everything
  // else — the overwhelming majority, where no probe came close — stays silent.
  if (verdict.mismatch || verdict.legacyWouldReject) {
    console.log(
      `[ModernMismatch] ${path.basename(clipPath)} decision=${verdict.mismatch ? "REJECT" : "ALLOW"} ` +
        `reason=${verdict.reason} beatSim=${verdict.beatSim.toFixed(4)} ` +
        `topNegSim=${verdict.topNegSim.toFixed(4)} probe="${(verdict.topProbe ?? "none").slice(0, 48)}" ` +
        `frames=${verdict.framesFlagged}/${verdict.framesEvaluated} probes=${verdict.probesEvaluated} ` +
        `legacyWouldReject=${verdict.legacyWouldReject}`
    );
  }
  return verdict;
}

/** Frame-path convenience wrapper. Unused today (both live call sites already hold image
 *  embeddings); kept as-is from before FASE 7.3 rather than deleted, so this phase's diff
 *  stays limited to the evidence rules. */
async function modernContentMismatchAgainstBeat(
  framePaths: string[],
  beatQueryEmb: number[],
  beatText: string,
  videoTitle?: string
): Promise<boolean> {
  const imageEmbeddings: number[][] = [];
  for (const fp of framePaths.slice(0, Math.min(MODERN_EVIDENCE_MAX_FRAMES, framePaths.length))) {
    const emb = await embedImageFromPath(fp);
    if (emb) imageEmbeddings.push(emb);
  }
  const verdict = await evaluateModernContentMismatch(
    imageEmbeddings,
    beatQueryEmb,
    beatText,
    videoTitle,
    framePaths[0] ?? "unknown"
  );
  return verdict.mismatch;
}

const TEXT_EMBED_CACHE_MAX = 320;
const textEmbeddingCache = new Map<string, number[]>();
let modernMismatchEmbCache: number[][] | null = null;

export type BeatVisionQueryContext = {
  beatText: string;
  visualDescription?: string;
  videoTitle?: string;
  searchQuery?: string;
  powerWord?: string;
  semanticSummary?: string;
  semanticPersons?: string[];
  semanticLocations?: string[];
  semanticObjects?: string[];
  semanticYears?: string[];
  semanticEvents?: string[];
};

/** Truncate to at most maxLen chars without cutting mid-word — production finding: plain
 *  .slice(0, N) on a long visualDescription/narration could chop a word in half (e.g.
 *  "Führerbunker" -> "hrerbunker"), and that fragment then went straight into the CLIP text
 *  query. Backs off to the last whitespace boundary at or before maxLen when the cut point
 *  falls inside a word; a string with no whitespace before maxLen (single long token) still
 *  falls back to a hard slice rather than returning nothing. */
function truncateAtWordBoundary(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to the space when it doesn't throw away most of the budget — otherwise a
  // single early space in an otherwise long token would truncate far more aggressively than
  // maxLen intends.
  if (lastSpace > maxLen * 0.6) return cut.slice(0, lastSpace).trimEnd();
  return cut.trimEnd();
}

function uniqueQueryParts(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const v = item.trim();
    if (!v || v.length < 2 || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** Rich CLIP query — concrete visual intent and entities before raw narration. */
export function buildBeatVisionQueryText(ctx: BeatVisionQueryContext): string {
  const parts: string[] = [];
  const visual = coerceVisionString(ctx.visualDescription)?.replace(/\[visual:[^\]]+\]/gi, " ").trim();
  if (visual && visual.length >= 8) parts.push(truncateAtWordBoundary(visual, 180));

  const summary = coerceVisionString(ctx.semanticSummary)?.trim();
  if (summary && summary !== visual) parts.push(truncateAtWordBoundary(summary, 160));

  const entityBits = uniqueQueryParts([
    ...(ctx.semanticPersons ?? []).slice(0, 2),
    ...(ctx.semanticLocations ?? []).slice(0, 2),
    ...(ctx.semanticObjects ?? []).slice(0, 2),
    ...(ctx.semanticYears ?? []).slice(0, 2),
    ...(ctx.semanticEvents ?? []).slice(0, 1),
  ]);
  if (entityBits.length) parts.push(`Subject: ${entityBits.join(", ")}`);

  const shot = coerceVisionString(ctx.searchQuery)?.trim();
  if (shot && shot.length >= 4 && !parts.some((p) => p.includes(shot.slice(0, 20)))) {
    parts.push(truncateAtWordBoundary(shot, 100));
  }
  const powerWord = coerceVisionString(ctx.powerWord);
  if (powerWord?.trim() && powerWord.length >= 3) {
    parts.push(truncateAtWordBoundary(powerWord.trim(), 40));
  }

  const hasRichVisualIntent = parts.length > 0;
  const narration = coerceVisionString(ctx.beatText)?.replace(/\[visual:[^\]]+\]/gi, " ").trim() ?? "";
  if (narration) {
    parts.push(truncateAtWordBoundary(narration, hasRichVisualIntent ? 80 : 180));
  }
  const videoTitle = coerceVisionString(ctx.videoTitle);
  if (videoTitle?.trim() && !hasRichVisualIntent) parts.push(truncateAtWordBoundary(videoTitle.trim(), 60));

  return dedupeQueryParts(parts).join(". ");
}

/**
 * RONDE 51: drop parts that say nothing the query does not already say.
 *
 * Every field feeding buildBeatVisionQueryText can fall back to the same beat sentence, and each
 * one is truncated to a different length before it lands in `parts`. The old exact-equality
 * checks never caught that, so render 530 embedded queries like:
 *
 *     "hitler hitler suicide. In April 1945. In April. In April 194"
 *
 * — four parts that are all the same sentence at four different cut points, plus a leading token
 * repeated from the part after it. CLIP gets one 77-token window: every repeated word crowds out
 * a word that carried information, which is a direct cause of the flat similarity scores that
 * render logged (beatSim ≈ topNegSim ≈ 0.21 for everything, historical and stock alike).
 *
 * A part is dropped when a kept part already begins with it (the truncation case) or when it is
 * contained in a kept part. Adjacent duplicate words inside a part are collapsed. Order is
 * preserved — the richest visual-intent parts still come first.
 */
export function dedupeQueryParts(parts: string[]): string[] {
  const kept: string[] = [];
  for (const raw of parts) {
    const part = collapseRepeatedWords(raw).trim();
    if (!part) continue;
    // RONDE 88A: folded, so "Führerbunker interior" and "fuhrerbunker interior" are recognised as
    // the same query part. Unfolded, both sides collapsed to "f hrerbunker" and a genuine
    // duplicate written the other way survived into the provider call.
    const norm = foldSearchText(part).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!norm) continue;
    const redundant = kept.some((k) => {
      const kn = foldSearchText(k).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      return kn.startsWith(norm) || norm.startsWith(kn) || kn.includes(norm);
    });
    if (redundant) continue;
    kept.push(part);
  }
  return kept;
}

/** "hitler hitler suicide" → "hitler suicide". Case-insensitive, punctuation-aware. */
export function collapseRepeatedWords(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    /** RONDE 88A: folded, so "Führer Führer" collapses however each copy was spelled. */
    const bare = (s: string) => foldSearchText(s).replace(/[^a-z0-9]/g, "");
    if (prev && bare(prev) && bare(prev) === bare(w)) continue;
    out.push(w);
  }
  return out.join(" ");
}

export function beatVisionContextFromProfile(
  beat: {
    text: string;
    searchQuery?: string;
    powerWord?: string;
    visualDescription?: string;
  },
  videoTitle?: string,
  semanticProfile?: BeatSemanticProfile
): BeatVisionQueryContext {
  const visualDescription =
    beat.visualDescription?.trim() || semanticProfile?.summary?.trim() || undefined;
  return {
    beatText: coerceVisionString(beat.text) ?? "",
    visualDescription,
    videoTitle: coerceVisionString(videoTitle),
    searchQuery: coerceVisionString(beat.searchQuery),
    powerWord: coerceVisionString(beat.powerWord),
    semanticSummary: semanticProfile?.summary,
    semanticPersons: semanticProfile?.entities.persons,
    semanticLocations: semanticProfile?.entities.locations,
    semanticObjects: semanticProfile?.entities.objects,
    semanticYears: semanticProfile?.entities.years,
    semanticEvents: semanticProfile?.entities.events,
  };
}

export async function resolveBeatVisionQueryEmbedding(
  ctx: BeatVisionQueryContext
): Promise<number[] | null> {
  return embedTextQuery(buildBeatVisionQueryText(ctx));
}

export async function resolveBeatQueryEmbedding(
  beatText: string,
  visualDescription?: string,
  videoTitle?: string
): Promise<number[] | null> {
  return resolveBeatVisionQueryEmbedding({ beatText, visualDescription, videoTitle });
}

/** Rich CLIP gate context — script [visual:] cues, beat description, semantic summary. */
export function beatGateVisualDescription(
  beat: { text: string; visualDescription?: string; searchQuery?: string; powerWord?: string },
  semanticProfile?: { summary?: string }
): string | undefined {
  const parts: string[] = [];
  const cue = beat.text.match(/\[visual:\s*([^\]]+)\]/i)?.[1];
  if (cue?.trim()) parts.push(cue.trim());
  for (const raw of [
    beat.visualDescription,
    beatVisualDescriptionFromIntent(beat.text),
    semanticProfile?.summary,
    beat.searchQuery,
    beat.powerWord,
  ]) {
    const v = coerceVisionString(raw)?.trim();
    if (v && !parts.some((p) => p.toLowerCase() === v.toLowerCase())) parts.push(v);
  }
  return parts.length ? parts.join(". ").slice(0, 320) : undefined;
}

function significantBeatTokens(beatText: string, videoTitle?: string): Set<string> {
  const text = `${asVideoTitleString(videoTitle)} ${beatText}`.toLowerCase();
  const tokens = text.match(/[a-zà-ÿ]{4,}/g) ?? [];
  const stop = new Set([
    "that", "this", "with", "from", "they", "were", "have", "been", "their", "which",
    "would", "about", "there", "these", "those", "after", "before", "during", "while",
    "also", "into", "over", "under", "more", "most", "some", "such", "than", "then",
    "when", "what", "where", "word", "words", "video", "scene", "clip",
  ]);
  return new Set(tokens.filter((t) => !stop.has(t)));
}

/** Small boost when beat keywords appear in clip filename (stock paths). */
export function filenameLexicalBoost(clipPath: string, beatText: string, videoTitle?: string): number {
  const base = path.basename(clipPath).toLowerCase().replace(/[_\-.]+/g, " ");
  const tokens = significantBeatTokens(beatText, videoTitle);
  if (tokens.size === 0) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (base.includes(t)) hits++;
  }
  return Math.min(0.06, hits * 0.02);
}

/** Timeout for loading from cache (fast). For first-time download see PIPELINE_DOWNLOAD_TIMEOUT_MS. */
const PIPELINE_LOAD_TIMEOUT_MS = 90_000;
/** Generous timeout for first-time model download (~350MB). Volume persists so this runs once. */
const PIPELINE_DOWNLOAD_TIMEOUT_MS = 900_000; // 15 min

function withPipelineTimeout<T>(promise: Promise<T>, label: string, timeoutMs = PIPELINE_LOAD_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[LocalVision] TIMEOUT after ${timeoutMs / 1000}s: ${label}`)), timeoutMs)
    ),
  ]);
}

async function loadImagePipeline(): Promise<ClipPipeline | null> {
  if (!localVisionEnabled()) return null;
  if (imagePipeline) return imagePipeline;
  if (pipelineLoadFailed && imageLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) return null;
  const isFirstDownload = !clipModelExistsLocally(clipModelCacheDir());
  const loadTimeout = isFirstDownload ? PIPELINE_DOWNLOAD_TIMEOUT_MS : PIPELINE_LOAD_TIMEOUT_MS;
  if (isFirstDownload) {
    console.log(`[LocalVision] First-time download — using ${loadTimeout / 1000}s timeout (attempt ${imageLoadAttempts + 1})`);
  } else {
    console.log(`[LocalVision] BEFORE load image pipeline (attempt ${imageLoadAttempts + 1})`);
  }
  try {
    const pipeline = await withPipelineTimeout(importTransformersPipeline(), "import @xenova/transformers", loadTimeout);
    console.log(`[LocalVision] BEFORE pipeline("image-feature-extraction")`);
    imagePipeline = (await withPipelineTimeout(
      pipeline("image-feature-extraction", CLIP_MODEL, { quantized: true }),
      `pipeline(image-feature-extraction, ${CLIP_MODEL})`,
      loadTimeout
    )) as ClipPipeline;
    console.log(`[LocalVision] AFTER pipeline("image-feature-extraction") — OK`);
    pipelineLoadFailed = false;
    return imagePipeline;
  } catch (err) {
    imageLoadAttempts++;
    console.warn(
      `[LocalVision] CLIP image pipeline failed (attempt ${imageLoadAttempts}/${MAX_PIPELINE_LOAD_ATTEMPTS}):`,
      (err as Error).message?.slice(0, 200)
    );
    if (imageLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) {
      pipelineLoadFailed = true;
    }
    return null;
  }
}

async function loadTextPipeline(): Promise<ClipPipeline | null> {
  if (!localVisionEnabled()) return null;
  if (textPipeline) return textPipeline;
  if (pipelineLoadFailed && textLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) return null;
  const isFirstDownload = !clipModelExistsLocally(clipModelCacheDir());
  const loadTimeout = isFirstDownload ? PIPELINE_DOWNLOAD_TIMEOUT_MS : PIPELINE_LOAD_TIMEOUT_MS;
  console.log(`[LocalVision] BEFORE load text pipeline (attempt ${textLoadAttempts + 1})`);
  try {
    const { AutoTokenizer, CLIPTextModelWithProjection } = await withPipelineTimeout(
      importClipTextModelClasses(), "import @xenova/transformers (text)", loadTimeout
    );
    console.log(`[LocalVision] BEFORE CLIPTextModelWithProjection.from_pretrained`);
    const [tokenizer, textModel] = await withPipelineTimeout(
      Promise.all([
        AutoTokenizer.from_pretrained(CLIP_MODEL),
        CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { quantized: true }),
      ]),
      `CLIPTextModelWithProjection.from_pretrained(${CLIP_MODEL})`,
      loadTimeout
    );
    console.log(`[LocalVision] AFTER CLIPTextModelWithProjection.from_pretrained — OK`);
    textPipeline = (async (text: string) => {
      const inputs = tokenizer(text, { padding: true, truncation: true });
      const { text_embeds } = await textModel(inputs);
      // L2-normalize so text and image embeddings stay directly comparable via cosine
      // similarity — matching the { normalize: true } behavior the old pipeline() call used.
      const data = Array.from(text_embeds.data as Float32Array | number[]);
      const norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0)) || 1;
      return { data: Float32Array.from(data.map((v) => v / norm)) };
    }) as ClipPipeline;
    pipelineLoadFailed = false;
    return textPipeline;
  } catch (err) {
    textLoadAttempts++;
    console.warn(
      `[LocalVision] CLIP text pipeline failed (attempt ${textLoadAttempts}/${MAX_PIPELINE_LOAD_ATTEMPTS}):`,
      (err as Error).message?.slice(0, 200)
    );
    if (textLoadAttempts >= MAX_PIPELINE_LOAD_ATTEMPTS) {
      pipelineLoadFailed = true;
    }
    return null;
  }
}

/** Load image + text pipelines once (sequential to reduce peak RAM on Railway). */
export async function ensureClipPipelinesLoaded(): Promise<boolean> {
  if (!localVisionEnabled()) return false;
  if (imagePipeline && textPipeline) return true;
  if (pipelineLoadInFlight) {
    console.log(`[LocalVision] BEFORE ensureClipPipelinesLoaded (in-flight, waiting)`);
    const r = await pipelineLoadInFlight;
    console.log(`[LocalVision] AFTER ensureClipPipelinesLoaded (was in-flight) => ${r}`);
    return r;
  }
  console.log(`[LocalVision] BEFORE ensureClipPipelinesLoaded (starting load)`);
  pipelineLoadInFlight = (async () => {
    const image = await loadImagePipeline();
    const text = image ? await loadTextPipeline() : null;
    pipelineLoadInFlight = null;
    const ok = !!(image && text);
    console.log(`[LocalVision] AFTER ensureClipPipelinesLoaded => image=${!!image} text=${!!text} ok=${ok}`);
    return ok;
  })();
  return pipelineLoadInFlight;
}

// Total budget for embedImageFromPath including pipeline load + inference.
// loadImagePipeline() itself has a 90s withPipelineTimeout per attempt, but we
// want a tighter cap here so a slow model download doesn't block every beat.
const EMBED_IMAGE_TIMEOUT_MS = 20_000;

export async function embedImageFromPath(imagePath: string): Promise<number[] | null> {
  if (!localVisionEnabled() || !fs.existsSync(imagePath)) return null;
  const base = path.basename(imagePath);
  const t0 = Date.now();
  console.log(`[LocalVision] BEFORE CLIP-image-embed ${base}`);
  try {
    const result = await Promise.race([
      (async () => {
        const pipe = await loadImagePipeline();
        if (!pipe) return null;
        return pipe(imagePath);
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[LocalVision] TIMEOUT CLIP-image-embed ${base} after ${EMBED_IMAGE_TIMEOUT_MS}ms`)), EMBED_IMAGE_TIMEOUT_MS)
      ),
    ]);
    if (!result) return null;
    const embedding = Array.from(result.data);
    console.log(`[LocalVision] AFTER  CLIP-image-embed ${base} in ${Date.now() - t0}ms dim=${embedding.length}`);
    return embedding.length >= 8 ? embedding : null;
  } catch (err) {
    console.warn(`[LocalVision] embedImageFromPath failed ${base} in ${Date.now() - t0}ms: ${(err as Error).message}`);
    return null;
  }
}

export type ClipBatchEmbedMode = "batch" | "sequential";

/**
 * Embed multiple images in one pipeline call when the underlying transformers.js pipeline
 * accepts array input (most image-feature-extraction pipelines do). Falls back to
 * sequential embedImageFromPath calls if batched output can't be cleanly split per image
 * (e.g. older/incompatible pipeline build) or the batched call throws. Order of the
 * returned array always matches imagePaths; missing/failed files are null.
 */
export async function embedImagesFromPaths(imagePaths: string[]): Promise<{ embeddings: (number[] | null)[]; mode: ClipBatchEmbedMode }> {
  if (!localVisionEnabled() || imagePaths.length === 0) {
    return { embeddings: imagePaths.map(() => null), mode: "sequential" };
  }
  const exists = imagePaths.map((p) => fs.existsSync(p));
  const pipe = await loadImagePipeline();
  if (!pipe) return { embeddings: imagePaths.map(() => null), mode: "sequential" };

  if (imagePaths.length > 1 && exists.every(Boolean)) {
    try {
      const result = await (pipe as unknown as (input: string[]) => Promise<{ data: Float32Array }>)(imagePaths);
      const data = Array.from(result.data);
      const dim = data.length / imagePaths.length;
      if (Number.isInteger(dim) && dim >= 8) {
        const embeddings: number[][] = [];
        for (let i = 0; i < imagePaths.length; i++) {
          embeddings.push(data.slice(i * dim, (i + 1) * dim));
        }
        return { embeddings, mode: "batch" };
      }
    } catch {
      // Fall through to sequential — batched array input isn't supported by this pipeline build.
    }
  }

  const embeddings = await Promise.all(
    imagePaths.map((p, i) => (exists[i] ? embedImageFromPath(p) : Promise.resolve(null)))
  );
  return { embeddings, mode: "sequential" };
}

// Total budget for embedTextQuery including pipeline load + inference.
const EMBED_TEXT_TIMEOUT_MS = 15_000;

export async function embedTextQuery(query: string): Promise<number[] | null> {
  const key = query.trim();
  if (!localVisionEnabled() || !key) return null;
  const cached = textEmbeddingCache.get(key);
  if (cached) return cached;
  const short = key.slice(0, 60);
  const t0 = Date.now();
  console.log(`[LocalVision] BEFORE CLIP-text-embed "${short}"`);
  try {
    const result = await Promise.race([
      (async () => {
        const pipe = await loadTextPipeline();
        if (!pipe) return null;
        return pipe(key, { pooling: "mean", normalize: true });
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[LocalVision] TIMEOUT CLIP-text-embed after ${EMBED_TEXT_TIMEOUT_MS}ms`)), EMBED_TEXT_TIMEOUT_MS)
      ),
    ]);
    if (!result) return null;
    const embedding = Array.from(result.data);
    console.log(`[LocalVision] AFTER  CLIP-text-embed "${short}" in ${Date.now() - t0}ms dim=${embedding.length}`);
    if (embedding.length < 8) return null;
    if (textEmbeddingCache.size >= TEXT_EMBED_CACHE_MAX) {
      const oldest = textEmbeddingCache.keys().next().value;
      if (oldest) textEmbeddingCache.delete(oldest);
    }
    textEmbeddingCache.set(key, embedding);
    return embedding;
  } catch (err) {
    console.warn(`[LocalVision] embedTextQuery failed "${short}" in ${Date.now() - t0}ms: ${(err as Error).message}`);
    return null;
  }
}

/** Pure CLIP cosine similarity, unclamped — negative values are preserved. Diagnostic use
 *  only (e.g. reject-log observability); the pass/fail decision still uses the clamped value
 *  from scoreEmbeddingSimilarity below, unchanged. */
export function cosineSimilarityRaw(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  return cosineSimilarityVectors(a, b);
}

export function scoreEmbeddingSimilarity(a: number[], b: number[]): number {
  return Math.max(0, cosineSimilarityRaw(a, b));
}

export async function probeImageMeanLuma(jpegPath: string): Promise<number | null> {
  if (!fs.existsSync(jpegPath)) return null;
  try {
    throwIfActiveRenderCancelled();
    const { stdout } = await ffmpegSemaphore.run(() =>
      exec(
        `"${ffmpegBin()}" -y -i "${jpegPath}" -vf "scale=1:1,format=gray" -frames:v 1 -f rawvideo -`,
        { encoding: "buffer", maxBuffer: 4096, timeout: 8_000 }
      )
    );
    const buf = stdout as Buffer;
    if (!buf?.length) return null;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]!;
    return sum / buf.length;
  } catch {
    return null;
  }
}

function isForkPressureSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EAGAIN") return true;
  const msg = (err as Error)?.message || "";
  if (/resource temporarily unavailable/i.test(msg) || /cannot fork/i.test(msg)) return true;
  // libx264/rawvideo's threaded encoder failing to spin up its worker threads under the same
  // OS process/thread pressure — same transient condition, different ffmpeg-reported message.
  // See server/_core/execForkRetry.ts for the canonical version of this check.
  if (/error initializing output stream/i.test(msg) && /error while opening encoder/i.test(msg)) return true;
  return false;
}

/** ffmpeg's -ss takes a time (seconds, or HH:MM:SS) — it has no "38%" percentage syntax, so a
 *  fraction has to be resolved against the real duration first. */
async function probeDurationSec(videoPath: string, timeoutMs = 8_000): Promise<number> {
  try {
    throwIfActiveRenderCancelled();
    const { stdout } = await ffmpegSemaphore.run(() =>
      exec(
        `"${ffprobeBin()}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { timeout: timeoutMs }
      )
    );
    const d = parseFloat(String(stdout).trim());
    return isNaN(d) || d <= 0 ? 0 : d;
  } catch {
    return 0;
  }
}

async function extractFrameAtFractionOnce(
  videoPath: string,
  outPath: string,
  seekSeconds: number,
  timeoutMs: number
): Promise<void> {
  throwIfActiveRenderCancelled();
  await ffmpegSemaphore.run(() => new Promise<void>((resolve, reject) => {
    const args = ["-y", "-ss", seekSeconds.toFixed(2), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error("frame extract timeout"));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
      // Keep enough of the tail to reliably include "Error initializing output stream" +
      // "Error while opening encoder" when present — both phrases together can run past 120
      // chars from the end of stderr, and isForkPressureSpawnError() below needs to see them.
      else reject(new Error(stderr.slice(-400) || `ffmpeg exit ${code}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }));
}

// Under heavy concurrent ffmpeg load, spawn can transiently fail with EAGAIN/"Cannot
// fork" — retry with backoff instead of dropping the CLIP candidate entirely.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// extractFrameAtFractionOnce captures ffmpeg's real stderr on failure, but the caller used to
// swallow it silently — every frame-extraction failure (corrupt file, bad codec, seek past EOF,
// etc.) was indistinguishable from a plain "no frame" result. Log a rate-limited sample so
// systemic failures (e.g. the archive CLIP backfill indexing 0/600 with no visible cause) are
// diagnosable without flooding logs for every single frame of every asset.
let lastFrameExtractFailureLogMs = 0;
const FRAME_EXTRACT_FAILURE_LOG_INTERVAL_MS = 60_000;

export async function extractFrameAtFraction(
  videoPath: string,
  outPath: string,
  fraction: number,
  timeoutMs = 12_000
): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  const durationSec = await probeDurationSec(videoPath, Math.min(timeoutMs, 8_000));
  // Duration unknown (probe failed) — grab the first frame rather than aborting outright.
  const seekSeconds = durationSec > 0 ? Math.max(0, Math.min(fraction * durationSec, durationSec - 0.1)) : 0;
  let retriesLeft = 2;
  while (true) {
    try {
      await extractFrameAtFractionOnce(videoPath, outPath, seekSeconds, timeoutMs);
      return true;
    } catch (err) {
      if (retriesLeft > 0 && isForkPressureSpawnError(err)) {
        retriesLeft--;
        await sleep(1500 * (3 - retriesLeft));
        continue;
      }
      const now = Date.now();
      if (now - lastFrameExtractFailureLogMs > FRAME_EXTRACT_FAILURE_LOG_INTERVAL_MS) {
        lastFrameExtractFailureLogMs = now;
        console.warn(
          `[LocalVision] extractFrameAtFraction failed for ${path.basename(videoPath)}: ${(err as Error).message?.slice(0, 200)}`
        );
      }
      return false;
    }
  }
}

export type LocalFrameScore = {
  similarity: number;
  /** Pure unclamped cosine similarity behind `similarity`, before the Math.max(0, ...) floor
   *  and before lexicalBoost — diagnostic only, does not affect scoring. */
  rawSimilarity: number;
  score: number;
  luma: number | null;
  wellFramed: boolean;
};

export async function scoreImagePathAgainstQuery(
  imagePath: string,
  queryEmbedding: number[],
  lexicalBoost = 0
): Promise<LocalFrameScore | null> {
  const emb = await embedImageFromPath(imagePath);
  if (!emb) return null;
  const luma = await probeImageMeanLuma(imagePath);
  const rawSim = cosineSimilarityRaw(queryEmbedding, emb);
  const sim = Math.max(0, rawSim) + lexicalBoost;
  const wellFramed = luma === null || luma >= 18;
  return {
    similarity: sim,
    rawSimilarity: rawSim,
    score: clipSimToScore(sim),
    luma,
    wellFramed,
  };
}

export type LocalClipScoreResult = {
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
  worstSimilarity: number;
  /** Unclamped cosine behind worstSimilarity — diagnostic only. */
  worstRawSimilarity: number;
  framesScored: number;
};

export type StoredEmbeddingScore = {
  definiteFail: boolean;
  similarityPass: boolean;
  modernMismatch: boolean;
  worstSimilarity: number;
  /** Unclamped cosine behind worstSimilarity — diagnostic only. */
  worstRawSimilarity: number;
  score: number;
};

export async function scoreEmbeddingsAgainstBeat(
  imageEmbeddings: number[][],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  clipPath: string,
  minScore10: number,
  queryEmb?: number[] | null
): Promise<StoredEmbeddingScore | null> {
  if (imageEmbeddings.length === 0) return null;
  const beatEmb = queryEmb ?? (await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle));
  if (!beatEmb) return null;

  const lexBoost = filenameLexicalBoost(clipPath, beatText, videoTitle);
  const minSim = minLocalClipSimilarity(minScore10);
  const frameScores: LocalFrameScore[] = imageEmbeddings.map((emb) => {
    const rawSim = cosineSimilarityRaw(beatEmb, emb);
    const sim = Math.max(0, rawSim) + lexBoost;
    return {
      similarity: sim,
      rawSimilarity: rawSim,
      score: clipSimToScore(sim),
      luma: null,
      wellFramed: true,
    };
  });

  let worst = frameScores[0]!;
  for (const s of frameScores) {
    if (s.similarity < worst.similarity) worst = s;
  }
  const avgSim =
    frameScores.reduce((sum, s) => sum + s.similarity, 0) / frameScores.length;
  const modernMismatch = (
    await evaluateModernContentMismatch(imageEmbeddings, beatEmb, beatText, videoTitle, clipPath)
  ).mismatch;
  const similarityPass = worst.similarity >= minSim && !modernMismatch;
  const definiteFail =
    worst.similarity < minSim - 0.04 || modernMismatch;

  return {
    definiteFail,
    similarityPass,
    modernMismatch,
    worstSimilarity: worst.similarity,
    worstRawSimilarity: worst.rawSimilarity,
    score: clipSimToScore(avgSim),
  };
}

export async function scoreFramePathsAgainstBeat(
  framePaths: string[],
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  clipPath: string,
  minScore10: number,
  storedEmbeddings?: number[][],
  queryEmb?: number[] | null
): Promise<LocalClipScoreResult | null> {
  const beatEmb = queryEmb ?? (await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle));
  if (!beatEmb) return null;

  const lexBoost = filenameLexicalBoost(clipPath, beatText, videoTitle);
  const minSim = minLocalClipSimilarity(minScore10);

  const frameScores: (LocalFrameScore & { _emb: number[] })[] = (
    await Promise.all(
      framePaths.map(async (fp) => {
        const [emb, luma] = await Promise.all([embedImageFromPath(fp), probeImageMeanLuma(fp)]);
        if (!emb) return null;
        const rawSim = cosineSimilarityRaw(beatEmb, emb);
        const sim = Math.max(0, rawSim) + lexBoost;
        return {
          similarity: sim,
          rawSimilarity: rawSim,
          score: clipSimToScore(sim),
          luma,
          wellFramed: luma === null || luma >= 18,
          _emb: emb,
        } as LocalFrameScore & { _emb: number[] };
      })
    )
  ).filter((s): s is LocalFrameScore & { _emb: number[] } => s != null);

  const imageEmbeddings = frameScores.map((s) => s._emb);
  for (const s of frameScores) {
    delete (s as { _emb?: number[] })._emb;
  }
  const scoredFrames: LocalFrameScore[] = frameScores.map(({ similarity, rawSimilarity, score, luma, wellFramed }) => ({
    similarity,
    rawSimilarity,
    score,
    luma,
    wellFramed,
  }));

  if (storedEmbeddings?.length) {
    for (const stored of storedEmbeddings) {
      const rawSim = cosineSimilarityRaw(beatEmb, stored);
      const sim = Math.max(0, rawSim) + lexBoost;
      scoredFrames.push({
        similarity: sim,
        rawSimilarity: rawSim,
        score: clipSimToScore(sim),
        luma: null,
        wellFramed: true,
      });
    }
  }

  if (scoredFrames.length === 0) return null;

  let worst = scoredFrames[0]!;
  for (const s of scoredFrames) {
    if (s.similarity < worst.similarity) worst = s;
  }

  const avgSim =
    scoredFrames.reduce((sum, s) => sum + s.similarity, 0) / scoredFrames.length;
  const score = clipSimToScore(avgSim);
  const allWellFramed = scoredFrames.every((s) => s.wellFramed);
  const darkReject = scoredFrames.some((s) => s.luma !== null && s.luma < 12);

  const modernMismatch = (
    await evaluateModernContentMismatch(
      imageEmbeddings.length > 0 ? imageEmbeddings : storedEmbeddings?.slice(0, 3) ?? [],
      beatEmb,
      beatText,
      videoTitle,
      clipPath
    )
  ).mismatch;

  const matchesNarration = worst.similarity >= minSim && !darkReject && !modernMismatch;
  const showsSubject = worst.similarity >= minSim;
  const wrongSubject = worst.similarity < minSim || darkReject || modernMismatch;

  return {
    score,
    matchesNarration,
    showsSubject,
    wellFramed: allWellFramed,
    wrongSubject,
    worstSimilarity: worst.similarity,
    worstRawSimilarity: worst.rawSimilarity,
    framesScored: scoredFrames.length,
  };
}

/** Index frames from a local video file (background-safe). */
export async function indexVideoFrameEmbeddings(
  localVideoPath: string,
  workDir: string,
  prefix: string
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < INDEX_FRAME_FRACTIONS.length; i++) {
    const frac = INDEX_FRAME_FRACTIONS[i]!;
    const framePath = path.join(workDir, `${prefix}_idx${i}.jpg`);
    const ok = await extractFrameAtFraction(localVideoPath, framePath, frac);
    if (!ok) continue;
    const emb = await embedImageFromPath(framePath);
    try { fs.unlinkSync(framePath); } catch { /* ignore */ }
    if (emb) embeddings.push(emb);
  }
  return embeddings;
}

export function meanEmbedding(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dim = vectors[0]!.length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** Score a remote thumbnail URL against beat text (YouTube script-guided sourcing). */
export async function scoreUrlImageAgainstBeat(
  imageUrl: string,
  beatText: string,
  videoTitle: string | undefined,
  timeoutMs = 6_000
): Promise<{ relevance: number; showsSubject: boolean } | null> {
  if (!localVisionEnabled() || !imageUrl.startsWith("http")) return null;

  const query = buildBeatVisionQueryText({ beatText, videoTitle });
  const queryEmb = await embedTextQuery(query);
  if (!queryEmb) return null;

  const tmp = path.join(
    process.env.TMPDIR || process.env.TEMP || "/tmp",
    `fv_thumb_${Date.now()}.jpg`
  );

  try {
    const resp = await Promise.race([
      fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) return null;
    fs.writeFileSync(tmp, buf);

    const emb = await embedImageFromPath(tmp);
    if (!emb) return null;
    const sim = scoreEmbeddingSimilarity(queryEmb, emb);
    const relevance = clipSimToScore(sim);
    return {
      relevance,
      showsSubject: sim >= minLocalClipSimilarity(6) - 0.04,
    };
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function getLocalVisionStatus(): {
  enabled: boolean;
  clipIndexEnabled: boolean;
  model: string;
  pipelineReady: boolean;
  cacheDir: string;
  hint: string;
} {
  const enabled = localVisionEnabled();
  const clipIndexEnabled = clipEmbeddingIndexEnabled();
  const cacheDir = clipModelCacheDir();
  const loaded = !!(imagePipeline && textPipeline);
  const pipelineReady = enabled && loaded;
  let hint = loaded
    ? `Local CLIP vision QA active (cache: ${cacheDir}).`
    : pipelineLoadFailed
      ? `CLIP model failed to load after ${MAX_PIPELINE_LOAD_ATTEMPTS} attempts — check worker logs and ${cacheDir}.`
      : "CLIP not loaded in this process yet — worker preloads on startup.";
  if (!enabled) {
    hint = "Local vision disabled — set ENABLE_LOCAL_VISION=true (default on).";
  }
  return {
    enabled,
    clipIndexEnabled,
    model: CLIP_MODEL,
    pipelineReady,
    cacheDir,
    hint,
  };
}

function resetClipPipelineLoadState(): void {
  pipelineLoadFailed = false;
  imageLoadAttempts = 0;
  textLoadAttempts = 0;
  pipelineLoadInFlight = null;
}

/** Pre-load CLIP pipelines on worker start so first clip adopt is not blocked on model download. */
export function clipPreloadEnabled(): boolean {
  if (process.env.ENABLE_CLIP_PRELOAD === "false") return false;
  return localVisionEnabled();
}

export async function warmUpLocalClipVision(): Promise<boolean> {
  if (!clipPreloadEnabled()) return false;
  const cacheDir = clipModelCacheDir();
  const isFirstDownload = !clipModelExistsLocally(cacheDir);
  if (isFirstDownload) {
    console.log(`[LocalVision] CLIP model not cached — downloading to ${cacheDir} (one-time, ~350MB)...`);
  } else {
    console.log(`[LocalVision] Loading CLIP model from cache (${cacheDir})...`);
  }
  // Single attempt — first-time download uses 15-min timeout so we never abort mid-download.
  const ok = await ensureClipPipelinesLoaded();
  if (ok) {
    console.log("[LocalVision] CLIP model warm-up complete");
    return true;
  }
  // Retry once after 5s (covers transient RAM contention, not a mid-download abort).
  if (!isFirstDownload) {
    console.warn("[LocalVision] CLIP warm-up retry in 5s...");
    resetClipPipelineLoadState();
    await new Promise((r) => setTimeout(r, 5_000));
    const ok2 = await ensureClipPipelinesLoaded();
    if (ok2) {
      console.log("[LocalVision] CLIP model warm-up complete (retry)");
      return true;
    }
  }
  console.warn("[LocalVision] CLIP warm-up incomplete — vision gate may skip or reject clips until load succeeds");
  return false;
}
