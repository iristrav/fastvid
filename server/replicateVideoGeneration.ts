/**
 * REPLICATE p-video-2 — the SECOND generated-video provider in the generated-picture rung.
 *
 * ── Where it sits ───────────────────────────────────────────────────────────────────────────────
 *
 * Inside `fetchBeatGeneratedVideo` (videoPipeline.ts), after ElevenLabs and before the generated
 * still — which is after YouTube, the own archive, the open sources, stock, the late stock round
 * and the main-subject rescue have all had their turn for the sentence (`generateMissingBeatImages`
 * runs only for sentences STILL without a picture). It generates the missing sentence's seconds
 * and nothing else; it is never asked for a sentence that has a picture.
 *
 * ── The API, as Replicate's HTTP reference describes it ────────────────────────────────────────
 *
 *   GET  /v1/models/{owner}/{name}                 the model record: `latest_version.id` and its
 *                                                  `openapi_schema` — the INPUT fields the model
 *                                                  declares, with defaults and enums
 *   POST /v1/models/{owner}/{name}/predictions     create a prediction for the official model:
 *                                                  body `{ input: {...} }`; answer carries `id`,
 *                                                  `status`, `urls.get`
 *   GET  /v1/predictions/{id}                      status: starting → processing → succeeded |
 *                                                  failed | canceled; `output` (a URL, or an array
 *                                                  of URLs), `error`, `metrics.predict_time`
 *   Authorization: Bearer <token>                  the token is REPLICATE_API_TOKEN, never logged
 *
 * The model's input field NAMES are not hard-coded as a guess: the schema is read at run time and
 * only the fields the model declares are sent (`inputForSchema`), each from a candidate the
 * operator can override (REPLICATE_PVIDEO_INPUT_JSON). A field the model does not declare is
 * dropped and named in the log, so a renamed parameter costs a log line, never a refused request.
 * This sandbox could not reach replicate.com, so the schema was not pinned here — see the report.
 *
 * ── Cost and bounds ─────────────────────────────────────────────────────────────────────────────
 *
 * Every request is checked against four per-film ceilings BEFORE it is sent: seconds generated,
 * requests made, estimated cost (seconds × REPLICATE_PVIDEO_PRICE_PER_SEC_USD), and retries per
 * sentence. The price is the operator's number for the model's current rate; without it the cost
 * ceiling cannot be enforced and no request is sent (said in the log). A ceiling reached is logged
 * with the ceiling and the count. The archive is the duplicate guard across worker retries and
 * replicas: the clip's provider asset id is a hash of model + prompt + duration, and an archive row
 * READY under that id is reused instead of generated again.
 *
 * ── What the file must prove before it is a clip ───────────────────────────────────────────────
 *
 * The download is written to a unique temporary file, then normalised with ffmpeg to the film's
 * format (DEFAULT_FORMAT: 1920×1080, 30 fps — the model answers 24 fps) with its audio removed.
 * The result must decode, run at least the sentence's seconds, and MOVE (freezedetect); then it
 * takes exactly the route every generated picture takes — `adoptClip`, the technical gate, the
 * picture editor against this sentence, the ledger, the archive — and the timeline carries it under
 * provider `replicate_pvideo`, read everywhere as AI-generated footage, never as real footage.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { classifyProviderFailure, formatProviderCooldown } from "./providerFailureClass";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { clipHasMotion } from "./genericFootageFallback";

const execFileAsync = promisify(execFile);

export const REPLICATE_VIDEO_FALLBACK = "REPLICATE_VIDEO_FALLBACK";
/** The provider name the clip carries through the lineage, the archive and the timeline. */
export const REPLICATE_VIDEO_PROVIDER = "replicate_pvideo";
export const REPLICATE_MODEL = "prunaai/p-video-2";
const API_BASE = "https://api.replicate.com";

export const DEFAULT_PVIDEO_DURATION_SEC = 5;
export const DEFAULT_PVIDEO_RESOLUTION = "720p";
export const DEFAULT_PVIDEO_FPS = 24;
export const DEFAULT_PVIDEO_ASPECT = "16:9";
/** Draft mode (faster, cheaper, lower quality) is OFF unless the operator turns it on: the quoted "$0.025/s" is the 720p full-quality rate. */
export const DEFAULT_PVIDEO_DRAFT = false;
export const DEFAULT_MAX_SECONDS_PER_VIDEO = 30;
export const DEFAULT_MAX_REQUESTS_PER_VIDEO = 6;
export const DEFAULT_MAX_COST_PER_VIDEO_USD = 1.0;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_MAX_WAIT_MS = 4 * 60_000;
export const POLL_MIN_MS = 3_000;
export const GENERATED_MIN_BYTES = 50_000;
const CREATE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/**
 * PRE-DEPLOY CHECK — the rates Pruna publishes for p-video-2, per second of RETURNED video, billed in
 * whole seconds (docs.api.pruna.ai/guides/models/p-video-2 and docs.pruna.ai, read on
 * PUBLISHED_RATES_AS_OF via search; Replicate's own listing says "from $0.025/s" and was not reachable
 * from the sandbox that wrote this). They are a REFERENCE, not the price: the operator confirms the
 * current price on replicate.com and sets REPLICATE_PVIDEO_PRICE_PER_SEC_USD. The table never lowers
 * an estimate — it can only raise one: a configured price BELOW the published rate for the configured
 * resolution and draft setting is taken as a mistake, the published rate bounds the cost ceiling and
 * the log says so (`effectiveRatePerSec`). A resolution the table does not know has no floor.
 */
export const PUBLISHED_PVIDEO2_RATES_USD_PER_SEC: Readonly<Record<string, { full: number; draft: number }>> = {
  "720p": { full: 0.025, draft: 0.015 },
  "1080p": { full: 0.05, draft: 0.03 },
};
export const PUBLISHED_RATES_AS_OF = "2026-10-13";
/**
 * GO/NO-GO CHECK (13 Oct 2026) — NOT A CONFIRMED PRICE. The table above is Pruna's own API price list
 * (docs.api.pruna.ai / docs.pruna.ai, read through search results; the sandbox could not open the
 * pages), and Replicate's listing of prunaai/p-video-2 says "from $0.025/s" (also read through search
 * results; replicate.com was unreachable). Neither is Replicate's confirmed price for 720p/full.
 * Both are therefore used ONLY as a floor: the cost ceiling never computes with less than
 *   max(the table's rate for the configured resolution/draft, the listed "from" price)
 * — so a configured price that is too low, or a resolution the table does not know, can never make
 * the ceiling admit more than it should. The configured price (REPLICATE_PVIDEO_PRICE_PER_SEC_USD)
 * remains required, and it is what the ceiling uses whenever it is at or above the floor.
 */
export const REPLICATE_LISTED_MIN_USD_PER_SEC = 0.025;

export type ReplicateVideoConfig = {
  token: string | null;
  model: string;
  durationSec: number;
  resolution: string;
  fps: number;
  aspectRatio: string;
  /** Draft mode asked for (sent only when the model's schema declares `draft` or a `mode` enum). */
  draft: boolean;
  pricePerSecUsd: number | null;
  maxSecondsPerVideo: number;
  maxRequestsPerVideo: number;
  maxCostPerVideoUsd: number;
  maxRetries: number;
  maxWaitMs: number;
  pollMs: number;
  extraInput: Record<string, unknown>;
};

function num(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function replicateVideoConfig(env: NodeJS.ProcessEnv = process.env): ReplicateVideoConfig {
  let extraInput: Record<string, unknown> = {};
  const raw = env.REPLICATE_PVIDEO_INPUT_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraInput = parsed as Record<string, unknown>;
    } catch {
      /* an unreadable override is ignored, not obeyed */
    }
  }
  const price = Number.parseFloat(env.REPLICATE_PVIDEO_PRICE_PER_SEC_USD ?? "");
  return {
    token: env.REPLICATE_API_TOKEN?.trim() || null,
    model: env.REPLICATE_PVIDEO_MODEL?.trim() || REPLICATE_MODEL,
    durationSec: num(env.REPLICATE_PVIDEO_DURATION_SEC, DEFAULT_PVIDEO_DURATION_SEC, 1),
    resolution: env.REPLICATE_PVIDEO_RESOLUTION?.trim() || DEFAULT_PVIDEO_RESOLUTION,
    fps: Math.round(num(env.REPLICATE_PVIDEO_FPS, DEFAULT_PVIDEO_FPS, 1)),
    aspectRatio: env.REPLICATE_PVIDEO_ASPECT_RATIO?.trim() || DEFAULT_PVIDEO_ASPECT,
    draft: /^(1|true|yes|on)$/i.test(env.REPLICATE_PVIDEO_DRAFT?.trim() ?? "") ? true : DEFAULT_PVIDEO_DRAFT,
    /** only a positive number is a price: empty, 0, negative or text leaves the rung off (no request, no model read) */
    pricePerSecUsd: Number.isFinite(price) && price > 0 ? price : null,
    maxSecondsPerVideo: num(env.REPLICATE_PVIDEO_MAX_SECONDS_PER_VIDEO, DEFAULT_MAX_SECONDS_PER_VIDEO),
    maxRequestsPerVideo: Math.round(num(env.REPLICATE_PVIDEO_MAX_REQUESTS_PER_VIDEO, DEFAULT_MAX_REQUESTS_PER_VIDEO)),
    maxCostPerVideoUsd: num(env.REPLICATE_PVIDEO_MAX_COST_PER_VIDEO_USD, DEFAULT_MAX_COST_PER_VIDEO_USD),
    maxRetries: Math.round(num(env.REPLICATE_PVIDEO_MAX_RETRIES, DEFAULT_MAX_RETRIES)),
    maxWaitMs: num(env.REPLICATE_PVIDEO_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, POLL_MIN_MS),
    pollMs: Math.max(POLL_MIN_MS, num(env.REPLICATE_PVIDEO_POLL_MS, POLL_MIN_MS)),
    extraInput,
  };
}

export function replicateVideoConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return replicateVideoConfig(env).token !== null;
}

/* ═══════════════════════ the per-film ledger and the ceilings ═══════════════════════ */

export type PVideoSpend = { requests: number; secondsRequested: number; costUsd: number; retriesBySentence: Map<string, number> };

export function newPVideoSpend(): PVideoSpend {
  return { requests: 0, secondsRequested: 0, costUsd: 0, retriesBySentence: new Map() };
}

export type PVideoBudgetDecision =
  | { allowed: true; estimatedCostUsd: number; billableSec: number; rate: EffectiveRate }
  | { allowed: false; reason: string };

/** The published rate for the configured resolution and draft setting, or null when the table does not know the resolution. */
export function publishedRateFor(cfg: Pick<ReplicateVideoConfig, "resolution" | "draft">): number | null {
  const row = PUBLISHED_PVIDEO2_RATES_USD_PER_SEC[cfg.resolution.trim().toLowerCase()];
  if (!row) return null;
  return cfg.draft ? row.draft : row.full;
}

export type EffectiveRate = {
  /** The rate the ceiling is computed with, or null: no configured price means no request. */
  perSecUsd: number | null;
  configured: number | null;
  published: number | null;
  /** "configured" when the operator's price is used; "published_floor" when it was below the published rate and the published rate bounds the ceiling. */
  source: "configured" | "published_floor" | "none";
};

/** The lowest rate the ceiling may ever compute with: the table's rate for these settings, and never below the listed "from" price. */
export function floorRateFor(cfg: Pick<ReplicateVideoConfig, "resolution" | "draft">): number {
  return Math.max(publishedRateFor(cfg) ?? 0, REPLICATE_LISTED_MIN_USD_PER_SEC);
}

/**
 * The rate per second the cost ceiling is enforced with. The configured price is the price — the
 * operator confirmed it on replicate.com for THESE settings; the floor (`floorRateFor`) only guards
 * against a price typed too low, or settings no published rate covers.
 */
export function effectiveRatePerSec(cfg: Pick<ReplicateVideoConfig, "pricePerSecUsd" | "resolution" | "draft">): EffectiveRate {
  const published = floorRateFor(cfg);
  if (cfg.pricePerSecUsd == null) return { perSecUsd: null, configured: null, published, source: "none" };
  if (cfg.pricePerSecUsd < published - 1e-9) {
    return { perSecUsd: published, configured: cfg.pricePerSecUsd, published, source: "published_floor" };
  }
  return { perSecUsd: cfg.pricePerSecUsd, configured: cfg.pricePerSecUsd, published, source: "configured" };
}

/** Billing is per WHOLE second of returned video: 4.2 s asked for is billed as 5 s. */
export function billableSeconds(durationSec: number): number {
  /** a millisecond of float noise is not a second; anything more is — 5.5 s returned is 6 billed seconds */
  return Math.max(1, Math.ceil(durationSec - 1e-3));
}

export function formatEffectiveRate(cfg: Pick<ReplicateVideoConfig, "resolution" | "draft">, rate: EffectiveRate): string {
  const settings = `${cfg.resolution}${cfg.draft ? " draft" : " full"}`;
  const published = rate.published != null ? `floor ${settings} $${rate.published}/s (published/listed, unconfirmed, as of ${PUBLISHED_RATES_AS_OF})` : `no floor known for ${settings}`;
  if (rate.source === "none") return `rate=none (REPLICATE_PVIDEO_PRICE_PER_SEC_USD not set; ${published})`;
  if (rate.source === "published_floor") {
    return `rate=$${rate.perSecUsd}/s (PUBLISHED FLOOR — configured $${rate.configured}/s is below the ${published}; the configured price looks wrong, check it)`;
  }
  return `rate=$${rate.perSecUsd}/s (configured; ${published})`;
}

/**
 * The four ceilings, asked BEFORE a request, on THIS process's ledger. Every "no" names the ceiling
 * and the count. The ledger the film is bound by across worker replicas and retries is the
 * database's (`PVideoSpendStore.claim`); this check is the cheap first answer and the log's.
 */
export function pVideoBudgetDecision(
  spend: PVideoSpend,
  cfg: Pick<ReplicateVideoConfig, "pricePerSecUsd" | "resolution" | "draft" | "maxSecondsPerVideo" | "maxRequestsPerVideo" | "maxCostPerVideoUsd" | "maxRetries">,
  durationSec: number,
  sentenceKey: string
): PVideoBudgetDecision {
  const rate = effectiveRatePerSec(cfg);
  if (rate.perSecUsd == null) {
    return { allowed: false, reason: "REPLICATE_PVIDEO_PRICE_PER_SEC_USD is not set — the cost ceiling cannot be enforced, so no request is sent" };
  }
  const retries = spend.retriesBySentence.get(sentenceKey) ?? 0;
  if (retries > cfg.maxRetries) {
    return { allowed: false, reason: `retries for ${sentenceKey}: ${retries - 1} of ${cfg.maxRetries} spent` };
  }
  if (spend.requests >= cfg.maxRequestsPerVideo) {
    return { allowed: false, reason: `requests per video: ${spend.requests} of ${cfg.maxRequestsPerVideo} spent` };
  }
  const billableSec = billableSeconds(durationSec);
  if (spend.secondsRequested + billableSec > cfg.maxSecondsPerVideo + 1e-9) {
    return { allowed: false, reason: `seconds per video: ${spend.secondsRequested.toFixed(0)} + ${billableSec} > ${cfg.maxSecondsPerVideo}` };
  }
  const estimatedCostUsd = Number((billableSec * rate.perSecUsd).toFixed(4));
  if (spend.costUsd + estimatedCostUsd > cfg.maxCostPerVideoUsd + 1e-9) {
    return { allowed: false, reason: `cost per video: $${spend.costUsd.toFixed(3)} + $${estimatedCostUsd.toFixed(3)} > $${cfg.maxCostPerVideoUsd.toFixed(2)}` };
  }
  return { allowed: true, estimatedCostUsd, billableSec, rate };
}

/**
 * THE LEDGER THE FILM IS BOUND BY — kept by the database, one row per video, across worker replicas,
 * a requeue after a deploy, a stale-job recovery and a user pressing "try again". `claim` adds one
 * request atomically (a conditional UPDATE that only succeeds while every ceiling still holds AFTER
 * the request) and answers true for exactly the callers whose request fits. False for any other
 * outcome — the ceilings reached, no video id, the database unreachable — and no request is sent:
 * a film without an AI clip falls through to the still and the generic floor, a film past its
 * cost ceiling is a broken promise. Failed and cancelled requests stay on the ledger: Replicate
 * states failed runs are not billed, cancelled runs on official models can be; this ledger counts
 * every request it sent as spent and never refunds, so it only ever over-estimates.
 */
export type PVideoSpendStore = {
  claim(
    videoId: number,
    add: { seconds: number; costUsd: number; model: string },
    caps: { maxRequests: number; maxSeconds: number; maxCostUsd: number }
  ): Promise<boolean>;
  load(videoId: number): Promise<{ requests: number; seconds: number; costUsd: number } | null>;
  /**
   * The returned clip was longer than the seconds claimed: the difference is ADDED, unconditionally —
   * the money is already spent, so no ceiling may refuse the record of it. Later claims see it.
   */
  reconcile(videoId: number, add: { seconds: number; costUsd: number }): Promise<void>;
};

let spendStoreOverride: PVideoSpendStore | null = null;
export function setPVideoSpendStoreForTests(s: PVideoSpendStore | null): void {
  spendStoreOverride = s;
}
export function pVideoSpendStoreOverride(): PVideoSpendStore | null {
  return spendStoreOverride;
}

export function notePVideoRequest(spend: PVideoSpend, durationSec: number, costUsd: number, sentenceKey: string): void {
  spend.requests += 1;
  spend.secondsRequested += durationSec;
  spend.costUsd = Number((spend.costUsd + costUsd).toFixed(4));
  spend.retriesBySentence.set(sentenceKey, (spend.retriesBySentence.get(sentenceKey) ?? 0) + 1);
}

/** The model's own duration bounds, read from its schema when it states them; the config's seconds, clamped. */
export function pVideoDurationFor(neededSec: number, cfg: Pick<ReplicateVideoConfig, "durationSec">, schema: ModelInputSchema | null): number {
  let dur = Math.max(cfg.durationSec, Math.ceil(neededSec));
  const prop = schema?.properties?.duration ?? schema?.properties?.duration_seconds ?? schema?.properties?.num_seconds;
  if (prop) {
    if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "number")) {
      const options = (prop.enum as number[]).filter((v) => v >= dur).sort((a, b) => a - b);
      dur = options[0] ?? Math.max(...(prop.enum as number[]));
    } else {
      if (typeof prop.minimum === "number") dur = Math.max(dur, prop.minimum);
      if (typeof prop.maximum === "number") dur = Math.min(dur, prop.maximum);
    }
  }
  return dur;
}

/* ═══════════════════════ the model's input, from its schema ═══════════════════════ */

export type ModelInputSchema = {
  properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; description?: string }>;
  required?: string[];
};

/**
 * The candidate fields, each under the names a video model commonly declares, and the one answer:
 * only names the schema declares are sent. With no schema (the model record could not be read) the
 * primary names are sent as they are and the model's own validation is the judge.
 */
export function inputForSchema(
  candidates: { prompt: string; durationSec: number; resolution: string; fps: number; aspectRatio: string; draft?: boolean; extra: Record<string, unknown> },
  schema: ModelInputSchema | null
): { input: Record<string, unknown>; dropped: string[] } {
  const byField: Array<[string[], unknown]> = [
    [["prompt"], candidates.prompt],
    [["duration", "duration_seconds", "num_seconds", "video_length"], candidates.durationSec],
    [["resolution"], candidates.resolution],
    [["fps", "frames_per_second"], candidates.fps],
    [["aspect_ratio"], candidates.aspectRatio],
    /** the draft setting is stated explicitly (never left to the model's default) — when the model declares the field */
    [["draft"], candidates.draft ?? DEFAULT_PVIDEO_DRAFT],
  ];
  const input: Record<string, unknown> = {};
  const dropped: string[] = [];
  const declared = schema?.properties ? new Set(Object.keys(schema.properties)) : null;
  for (const [names, value] of byField) {
    const name = declared ? names.find((n) => declared.has(n)) : names[0];
    if (!name) {
      /** `draft` without a schema is not sent on a guess: only a declared field carries it */
      if (names[0] === "draft") {
        const modeProp = schema?.properties?.mode;
        if (modeProp && Array.isArray(modeProp.enum)) {
          /** a model that spells draft as a `mode` enum (speed|quality): the declared value that means the same */
          const want = (candidates.draft ?? DEFAULT_PVIDEO_DRAFT) ? ["draft", "speed", "fast"] : ["quality", "standard", "full"];
          const pick = want.find((v) => modeProp.enum!.includes(v));
          if (pick) {
            input.mode = pick;
            continue;
          }
        }
        dropped.push(`draft=${String(value)} (the model declares neither draft nor a matching mode)`);
      } else dropped.push(names[0]!);
      continue;
    }
    if (names[0] === "draft" && !declared) {
      dropped.push("draft (no schema read — not sent on a guess)");
      continue;
    }
    const prop = schema?.properties?.[name];
    if (prop && Array.isArray(prop.enum) && prop.enum.length > 0 && !prop.enum.includes(value)) {
      /** an enum the model does not offer: the model's default decides, and the log says so */
      dropped.push(`${name}=${String(value)} (not in ${prop.enum.slice(0, 8).map(String).join("|")})`);
      continue;
    }
    input[name] = value;
  }
  for (const [k, v] of Object.entries(candidates.extra)) {
    if (!declared || declared.has(k)) input[k] = v;
    else dropped.push(`${k} (override not declared by the model)`);
  }
  return { input, dropped };
}

/**
 * A short, concrete English prompt for documentary b-roll: the subject, the visible action, the
 * setting, a documentary camera move and a natural look; no text, no logos, no real person.
 */
export function pVideoPrompt(input: { sentence: string; visualDescription?: string | null; searchQuery?: string | null; cameraMove?: string }): string {
  const sentence = input.sentence.replace(/\s+/g, " ").trim();
  const planned = [input.visualDescription, input.searchQuery]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter((s) => s && s.toLowerCase() !== "documentary broll scene");
  const shows = planned.length ? planned.join("; ") : sentence;
  const camera = input.cameraMove ?? "slow handheld documentary camera, gentle push-in";
  return (
    `Realistic documentary b-roll footage, natural light, real-world setting. ` +
    `Subject and action: ${shows}. ` +
    `Context: it illustrates the narration "${sentence}". ` +
    `Camera: ${camera}. ` +
    `Cinematic 16:9, natural colours, no on-screen text, no captions, no logos, no watermarks, no abstract animation, no recognisable real person.`
  ).slice(0, 1500);
}

/* ═══════════════════════ the API ═══════════════════════ */

const ACCOUNT_REFUSAL_STATUSES = new Set([401, 402, 403]);
export const ACCOUNT_REFUSAL_COOLDOWN_MS = 30 * 60_000;
let standingDownUntil = 0;
export function replicateStandingDown(now = Date.now()): boolean {
  return now < standingDownUntil;
}
export function resetReplicateStandDownForTests(): void {
  standingDownUntil = 0;
}
function noteAccountRefusal(status: number): void {
  if (!ACCOUNT_REFUSAL_STATUSES.has(status)) return;
  standingDownUntil = Math.max(standingDownUntil, Date.now() + ACCOUNT_REFUSAL_COOLDOWN_MS);
  console.warn(formatProviderCooldown(REPLICATE_VIDEO_PROVIDER, classifyProviderFailure({ status }), ACCOUNT_REFUSAL_COOLDOWN_MS));
}

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
export function setReplicatePollSleepForTests(s: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = s ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

async function fetchWithAbort(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type Prediction = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string; cancel?: string };
  metrics?: { predict_time?: number };
  version?: string;
  [k: string]: unknown;
};

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
}

/**
 * GO/NO-GO CHECK — the model record, cached per model for SCHEMA_CACHE_MS after a successful read, so
 * the pipeline can choose the duration FROM the schema before it claims the budget (the seconds
 * claimed are then the seconds sent), and the generator reads the same record without a second call.
 * A failed read is never cached.
 */
const SCHEMA_CACHE_MS = 10 * 60_000;
const schemaCache = new Map<string, { at: number; value: { schema: ModelInputSchema | null; versionId: string | null; status: number } }>();
export function resetReplicateSchemaCacheForTests(): void {
  schemaCache.clear();
}
export async function getModelSchemaCached(token: string, model: string, now = Date.now()): Promise<{ schema: ModelInputSchema | null; versionId: string | null; status: number }> {
  const hit = schemaCache.get(model);
  if (hit && now - hit.at < SCHEMA_CACHE_MS) return hit.value;
  const value = await readModelSchema(token, model);
  if (value.schema) schemaCache.set(model, { at: now, value });
  return value;
}

/** The model record's input schema, or null when it cannot be read (the request is then sent with the primary field names). */
export async function readModelSchema(token: string, model: string): Promise<{ schema: ModelInputSchema | null; versionId: string | null; status: number }> {
  try {
    const resp = await fetchWithAbort(`${API_BASE}/v1/models/${model}`, { method: "GET", headers: authHeaders(token) }, CREATE_TIMEOUT_MS);
    if (!resp.ok) return { schema: null, versionId: null, status: resp.status };
    const body = (await resp.json()) as { latest_version?: { id?: string; openapi_schema?: { components?: { schemas?: { Input?: ModelInputSchema } } } } };
    const input = body.latest_version?.openapi_schema?.components?.schemas?.Input ?? null;
    return { schema: input, versionId: body.latest_version?.id ?? null, status: resp.status };
  } catch (err) {
    console.warn(`[${REPLICATE_VIDEO_FALLBACK}] the model record could not be read: ${(err as Error).message?.slice(0, 100)}`);
    return { schema: null, versionId: null, status: 0 };
  }
}

/** The first URL in `output`: a string, or the first string of an array; anything else is no output. */
export function outputUrlOf(output: unknown): string | null {
  const first = typeof output === "string" ? output : Array.isArray(output) ? output.find((o) => typeof o === "string") : (output as { url?: unknown } | null)?.url;
  if (typeof first !== "string") return null;
  return /^https:\/\//.test(first) ? first : null;
}

export type GeneratedVideoResult =
  /** `outputDurationSec`: the RETURNED clip's measured length — what the service bills, in whole seconds */
  | { ok: true; predictionId: string; predictTimeSec: number | null; outputDurationSec: number | null }
  /** `retryable: false`: nothing was sent and sending again would not change that (a budget/schema mismatch) */
  | { ok: false; reason: string; predictionId: string | null; charged: boolean; retryable?: false };

/** Writes the normalised MP4 (video only, the film's format) to `outMp4`; a file that does not decode, cover or move is a refusal. */
export type ReplicateVideoGenerator = (
  prompt: string,
  outMp4: string,
  opts: { durationSec: number; deadlineAtMs: number; format: { widthPx: number; heightPx: number; fps: number }; neededSec: number }
) => Promise<GeneratedVideoResult>;

let generatorOverride: ReplicateVideoGenerator | null = null;
export function setReplicateVideoGeneratorForTests(g: ReplicateVideoGenerator | null): void {
  generatorOverride = g;
}

/**
 * The download, normalised: scaled and padded to the film's frame, converted to the film's frame
 * rate (`fps=`, and `-r` stated on the encode as every encode is since VIDEO 650), audio removed.
 * Then measured: a decodable stream of at least `neededSec`, and motion over its first seconds.
 */
export async function normaliseGeneratedVideo(
  ffmpegBin: string,
  downloaded: string,
  outMp4: string,
  format: { widthPx: number; heightPx: number; fps: number },
  neededSec: number
): Promise<{ ok: true; durationSec: number } | { ok: false; reason: string }> {
  const vf =
    `scale=${format.widthPx}:${format.heightPx}:force_original_aspect_ratio=decrease,` +
    `pad=${format.widthPx}:${format.heightPx}:(ow-iw)/2:(oh-ih)/2,fps=${format.fps},format=yuv420p`;
  try {
    await execFileAsync(ffmpegBin, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", downloaded, "-vf", vf, "-r", String(format.fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", outMp4,
    ], { timeout: 180_000, maxBuffer: 1 << 20 });
  } catch (err) {
    return { ok: false, reason: `the download could not be normalised: ${(err as Error).message?.slice(0, 120)}` };
  }
  let size = 0;
  try { size = fs.statSync(outMp4).size; } catch { /* missing */ }
  if (size < GENERATED_MIN_BYTES / 2) return { ok: false, reason: `the normalised file is ${size} bytes` };
  const probe = await probeStream(ffmpegBin, outMp4);
  if (!probe) return { ok: false, reason: "the normalised file has no decodable video stream" };
  if (probe.durationSec + 0.05 < neededSec) return { ok: false, reason: `the clip runs ${probe.durationSec.toFixed(2)}s, the sentence needs ${neededSec.toFixed(2)}s` };
  if (Math.abs(probe.fps - format.fps) > 0.5) return { ok: false, reason: `the normalised file runs at ${probe.fps} fps, not ${format.fps}` };
  const motion = await clipHasMotion(ffmpegBin, outMp4);
  if (!motion.moving) return { ok: false, reason: `the generated picture does not move (${motion.detail})` };
  return { ok: true, durationSec: probe.durationSec };
}

/** ffprobe beside the ffmpeg binary, or on PATH: the stream's fps and duration. Null when it cannot be read. */
async function probeStream(ffmpegBin: string, file: string): Promise<{ fps: number; durationSec: number } | null> {
  const candidates = [process.env.FFPROBE_PATH, path.join(path.dirname(ffmpegBin), "ffprobe"), "ffprobe"].filter((c): c is string => Boolean(c));
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,duration", "-of", "json", file], { timeout: 15_000 });
      const st = (JSON.parse(stdout).streams ?? [])[0] ?? {};
      const [n, d] = String(st.avg_frame_rate ?? "0/1").split("/").map(Number);
      const fps = d ? n / d : 0;
      const durationSec = Number(st.duration);
      if (!(fps > 0) || !(durationSec > 0)) return null;
      return { fps, durationSec };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "EACCES") continue;
      return null;
    }
  }
  return null;
}

/** Create, poll within the deadline, download to a unique temporary file, normalise, measure. */
const replicateGenerator: ReplicateVideoGenerator = async (prompt, outMp4, opts) => {
  const cfg = replicateVideoConfig();
  if (!cfg.token) return { ok: false, reason: "REPLICATE_API_TOKEN is not set", predictionId: null, charged: false };
  if (replicateStandingDown()) return { ok: false, reason: "the service refused this account recently; standing down", predictionId: null, charged: false };
  const token = cfg.token;
  const startedAt = Date.now();
  const { schema, versionId, status: modelStatus } = await getModelSchemaCached(token, cfg.model);
  if (ACCOUNT_REFUSAL_STATUSES.has(modelStatus)) {
    noteAccountRefusal(modelStatus);
    return { ok: false, reason: `the model record answered HTTP ${modelStatus}`, predictionId: null, charged: false };
  }
  /**
   * GO/NO-GO CHECK — the seconds sent must be the seconds budgeted. The pipeline chose them from this
   * same schema; if the schema now says otherwise (it changed between the two reads), nothing is sent:
   * a duration the model would drop or raise is a cost the claim did not cover.
   */
  const schemaDuration = pVideoDurationFor(opts.neededSec, { durationSec: opts.durationSec }, schema);
  if (schema && schemaDuration !== opts.durationSec) {
    console.warn(`[${REPLICATE_VIDEO_FALLBACK}] not sent — the model's schema asks ${schemaDuration}s, ${opts.durationSec}s was budgeted`);
    return { ok: false, reason: `the model's schema asks ${schemaDuration}s, ${opts.durationSec}s was budgeted`, predictionId: null, charged: false, retryable: false };
  }
  const { input, dropped } = inputForSchema(
    { prompt: prompt.slice(0, 2000), durationSec: opts.durationSec, resolution: cfg.resolution, fps: cfg.fps, aspectRatio: cfg.aspectRatio, draft: cfg.draft, extra: cfg.extraInput },
    schema
  );
  console.log(
    `[${REPLICATE_VIDEO_FALLBACK}] model=${cfg.model} version=${versionId ?? "unknown"} schema=${schema ? "read" : "not read (HTTP " + modelStatus + ")"} ` +
      `settings=${cfg.resolution}/${cfg.fps}fps/${opts.durationSec}s/${cfg.draft ? "draft" : "full"} ` +
      `input=[${Object.keys(input).join(",")}]${dropped.length ? ` dropped=[${dropped.join("; ")}]` : ""} window=${Math.max(0, Math.round((opts.deadlineAtMs - Date.now()) / 1000))}s`
  );
  let id: string | null = null;
  let getUrl: string | null = null;
  try {
    const created = await fetchWithAbort(
      `${API_BASE}/v1/models/${cfg.model}/predictions`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ input }) },
      CREATE_TIMEOUT_MS
    );
    if (!created.ok) {
      let detail = "";
      try { detail = String(((await created.json()) as { detail?: unknown }).detail ?? "").slice(0, 160); } catch { /* no body */ }
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] create answered HTTP ${created.status}${detail ? ` — ${detail}` : ""}`);
      noteAccountRefusal(created.status);
      return { ok: false, reason: `create answered HTTP ${created.status}`, predictionId: null, charged: false };
    }
    const answer = (await created.json().catch(() => null)) as Prediction | null;
    id = typeof answer?.id === "string" && answer.id ? answer.id : null;
    if (!id) {
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] create answered without an id (fields: ${answer ? Object.keys(answer).slice(0, 12).join(",") : "none"})`);
      return { ok: false, reason: "create answered without a prediction id", predictionId: null, charged: false };
    }
    getUrl = typeof answer?.urls?.get === "string" ? answer.urls.get : `${API_BASE}/v1/predictions/${encodeURIComponent(id)}`;
    console.log(`[${REPLICATE_VIDEO_FALLBACK}] started id=${id} status=${answer?.status ?? "?"} duration=${opts.durationSec}s`);
  } catch (err) {
    console.warn(`[${REPLICATE_VIDEO_FALLBACK}] create failed: ${(err as Error).message?.slice(0, 120)}`);
    return { ok: false, reason: `create failed: ${(err as Error).message?.slice(0, 80)}`, predictionId: null, charged: false };
  }

  let outputUrl: string | null = null;
  let predictTimeSec: number | null = null;
  let pollErrors = 0;
  let last: Prediction | null = null;
  while (Date.now() < opts.deadlineAtMs) {
    const waitMs = Math.min(cfg.pollMs, Math.max(0, opts.deadlineAtMs - Date.now()));
    if (waitMs <= 0) break;
    await sleepImpl(waitMs);
    if (Date.now() >= opts.deadlineAtMs) break;
    let resp: Response;
    try {
      resp = await fetchWithAbort(getUrl!, { method: "GET", headers: authHeaders(token) }, POLL_TIMEOUT_MS);
    } catch (err) {
      pollErrors++;
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} poll failed (${pollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}): ${(err as Error).message?.slice(0, 100)}`);
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, reason: "polling failed repeatedly", predictionId: id, charged: true };
      continue;
    }
    if (ACCOUNT_REFUSAL_STATUSES.has(resp.status)) {
      noteAccountRefusal(resp.status);
      return { ok: false, reason: `poll answered HTTP ${resp.status}`, predictionId: id, charged: true };
    }
    if (!resp.ok) {
      pollErrors++;
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} poll answered HTTP ${resp.status} (${pollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS})`);
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, reason: `poll answered HTTP ${resp.status}`, predictionId: id, charged: true };
      continue;
    }
    pollErrors = 0;
    last = (await resp.json().catch(() => null)) as Prediction | null;
    const status = String(last?.status ?? "").toLowerCase();
    if (status === "succeeded") {
      outputUrl = outputUrlOf(last?.output);
      predictTimeSec = typeof last?.metrics?.predict_time === "number" ? last.metrics.predict_time : null;
      if (!outputUrl) {
        console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} succeeded without a usable output URL (output type: ${Array.isArray(last?.output) ? "array" : typeof last?.output})`);
        return { ok: false, reason: "succeeded without a usable output URL", predictionId: id, charged: true };
      }
      console.log(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} succeeded in ${Math.round((Date.now() - startedAt) / 1000)}s predict_time=${predictTimeSec ?? "?"}s`);
      break;
    }
    if (status === "failed" || status === "canceled") {
      const why = String(typeof last?.error === "string" ? last.error : "").replace(/\s+/g, " ").slice(0, 160);
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} ${status} after ${Math.round((Date.now() - startedAt) / 1000)}s — ${why || "no reason given"}`);
      return { ok: false, reason: `${status}: ${why || "no reason given"}`, predictionId: id, charged: status === "failed" };
    }
    /* starting / processing: keep waiting */
  }
  if (!outputUrl) {
    /** the window closed: the prediction is cancelled so it does not run on and cost for nothing placed */
    const cancel = typeof last?.urls?.cancel === "string" ? last.urls.cancel : `${API_BASE}/v1/predictions/${encodeURIComponent(id)}/cancel`;
    await fetchWithAbort(cancel, { method: "POST", headers: authHeaders(token) }, POLL_TIMEOUT_MS).catch(() => undefined);
    console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} not finished within ${Math.round((Date.now() - startedAt) / 1000)}s — cancelled; nothing placed`);
    return { ok: false, reason: "not finished within the window", predictionId: id, charged: true };
  }

  const tmp = `${outMp4}.download-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  try {
    const dl = await fetchWithAbort(outputUrl, { method: "GET" }, DOWNLOAD_TIMEOUT_MS);
    if (!dl.ok) {
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} download answered HTTP ${dl.status}`);
      return { ok: false, reason: `download answered HTTP ${dl.status}`, predictionId: id, charged: true };
    }
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.length < GENERATED_MIN_BYTES) {
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} download too small (${bytes.length} bytes)`);
      return { ok: false, reason: `download too small (${bytes.length} bytes)`, predictionId: id, charged: true };
    }
    fs.writeFileSync(tmp, bytes);
    /** the RETURNED clip's own length — the billing basis — measured before anything is re-encoded */
    const returned = await probeStream(resolveFFmpegBin(), tmp);
    const norm = await normaliseGeneratedVideo(resolveFFmpegBin(), tmp, outMp4, opts.format, opts.neededSec);
    if (!norm.ok) {
      console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} refused: ${norm.reason}`);
      try { fs.unlinkSync(outMp4); } catch { /* not written */ }
      return { ok: false, reason: norm.reason, predictionId: id, charged: true };
    }
    const outputDurationSec = returned?.durationSec ?? norm.durationSec;
    console.log(
      `[${REPLICATE_VIDEO_FALLBACK}] id=${id} on disk: ${bytes.length} bytes downloaded (returned ${outputDurationSec.toFixed(2)}s = ${billableSeconds(outputDurationSec)} billable s), ` +
        `normalised to ${opts.format.widthPx}x${opts.format.heightPx}@${opts.format.fps} ${norm.durationSec.toFixed(2)}s, audio removed, moving`
    );
    return { ok: true, predictionId: id, predictTimeSec, outputDurationSec };
  } catch (err) {
    console.warn(`[${REPLICATE_VIDEO_FALLBACK}] id=${id} download failed: ${(err as Error).message?.slice(0, 120)}`);
    return { ok: false, reason: `download failed: ${(err as Error).message?.slice(0, 80)}`, predictionId: id, charged: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
};

export function replicateVideoGenerator(): ReplicateVideoGenerator {
  return generatorOverride ?? replicateGenerator;
}
