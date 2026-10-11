/**
 * TUNELIO — THE FIRST YOUTUBE DOWNLOAD ROUTE, AHEAD OF THE OWN yt-dlp SERVICE.
 *
 * What this module does, and nothing more: for one YouTube video id it asks Tunelio
 * (https://tunelio.dev, docs at /docs) for a 720p MP4 of the WHOLE video, downloads it to a
 * temporary directory, checks with ffprobe that the file is readable media with a video stream and
 * an audio stream, and hands the path back. `downloadYouTubeCCClip` in videoPipeline.ts cuts the
 * window a beat asked for out of that source with ffmpeg, validates the cut with the same
 * `validateAcquiredFile` every other route passes, and falls through to the yt-dlp service when
 * anything here says no. This module never throws into the pipeline: every failure is a value.
 *
 * The API, as the documentation describes it (verified 2026-10-11 through the documentation's
 * indexed text; the host is not reachable from the development sandbox):
 *
 *     GET https://tunelio.dev/credits                       0 credits   { credits|balance: n }
 *     GET https://tunelio.dev/create?quality=720p&url=<yt>  10 credits  { status:"ok", url, filename,
 *                                                                          quality, mode, file_size,
 *                                                                          expires }
 *     Authorization: Bearer <TUNELIO_API_KEY>   on the API calls only
 *     4xx/5xx are not billed; the signed `url` serves the file for a few hours.
 *     400 invalid_request · 401 unauthorized · 402 insufficient_credits · 404 not_found ·
 *     410 gone · 429 rate_limited (Retry-After) · 500 server_error
 *
 * The rules this module enforces, in the order they bite:
 *
 *   · OFF unless `TUNELIO_ENABLED` is exactly "true" AND `TUNELIO_API_KEY` is set — an opt-in, so a
 *     deployment that carries the key but not the switch keeps its old downloader. The key is read
 *     from `process.env` at call time and is never printed, logged or included in any error text;
 *     `redactSecrets` scrubs it and every URL out of whatever is reported.
 *   · The balance is checked before a paid call. A balance that cannot be read is treated as
 *     insufficient: the route is skipped and the yt-dlp service gets the video.
 *   · ONE paid `/create` per video per process, with the result (or the refusal) kept for a while:
 *     concurrent callers for the same video share the in-flight request, later callers reuse the
 *     downloaded source, and a video that failed after being paid for is not paid for again.
 *   · A 402 or a 429 puts the route on a cooldown so the next video does not pay the same lesson.
 *   · The signed download URL is validated before a byte moves: https only, no credentials in it,
 *     a hostname (never an IP literal), no localhost or private/link-local address — also after
 *     DNS resolution — and redirects are refused rather than followed. The API key is never sent
 *     to the download host.
 *   · Hard timeouts and a byte ceiling on the transfer; partial files are deleted.
 *
 * Everything that talks to the network, the file system probes and the clock is injected through
 * `TunelioDeps`, so the behaviour above is tested without a single paid call.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { lookup as dnsLookup } from "dns/promises";

export const TUNELIO_BASE_URL = "https://tunelio.dev";
/** What one `/create` costs, per the pricing table. The balance must cover at least this. */
export const TUNELIO_CREATE_COST = 10;
/** Only this quality is ever asked for: a 720p source is plenty for 1080p B-roll and keeps the transfer small. */
export const TUNELIO_QUALITY = "720p";
/** Default ceiling on one source file. A 720p video of an hour is well under this. */
export const TUNELIO_DEFAULT_MAX_SOURCE_BYTES = 1_536 * 1024 * 1024;
/** How long a downloaded source is kept for other beats of the same video. */
export const TUNELIO_SOURCE_TTL_MS = 45 * 60_000;
/** How long a read balance is trusted before `/credits` is asked again. */
export const TUNELIO_CREDITS_TTL_MS = 10 * 60_000;
/** How long a video that failed after a paid call is left alone. */
export const TUNELIO_VIDEO_REFUSAL_TTL_MS = 60 * 60_000;
/** Cooldowns the route puts itself on, so one lesson is not paid for per video. */
export const TUNELIO_COOLDOWN_MS = {
  insufficientCredits: 10 * 60_000,
  unauthorized: 15 * 60_000,
  rateLimitedDefault: 60_000,
  rateLimitedMax: 5 * 60_000,
  serverError: 60_000,
  timeout: 60_000,
  creditsUnknown: 5 * 60_000,
} as const;
const API_TIMEOUT_MS = 60_000;
const CREDITS_TIMEOUT_MS = 20_000;
const MIN_SOURCE_BYTES = 10_000;

export type TunelioFailCode =
  | "DISABLED"
  | "NO_KEY"
  | "COOLDOWN"
  | "VIDEO_REFUSED"
  | "CLAIMED_ELSEWHERE"
  | "CLAIM_UNKNOWN"
  | "CREDITS_UNKNOWN"
  | "INSUFFICIENT_CREDITS"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "INVALID_URL"
  | "DOWNLOAD_FAILED"
  | "TOO_LARGE"
  | "EMPTY"
  | "INVALID_FILE"
  | "NO_VIDEO_STREAM"
  | "NO_AUDIO_STREAM"
  | "RENDER_LIMIT"
  | "THREW";

export type TunelioSource = {
  ok: true;
  path: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
  /** True when no paid call was made for this answer: the source was already on disk. */
  cached: boolean;
};
export type TunelioFailure = {
  ok: false;
  code: TunelioFailCode;
  /** Safe to log: no key, no URL. */
  detail: string;
  /** True when a paid `/create` was made for this attempt (billed or not, the call went out). */
  paid: boolean;
};
export type TunelioOutcome = TunelioSource | TunelioFailure;

export type SourceProbe = {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
};

export type TunelioDeps = {
  env?: NodeJS.ProcessEnv;
  /** For the API calls (`/credits`, `/create`). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * The transfer of the signed URL to `outPath`. Must NOT add an Authorization header, must not
   * follow redirects, must stop at `maxBytes` (throw or return ok:false) and must honour `timeoutMs`.
   */
  download: (
    url: string,
    outPath: string,
    timeoutMs: number,
    maxBytes: number
  ) => Promise<{ ok: boolean; status: number; bytes: number | null; detail?: string }>;
  /** ffprobe on the downloaded source. `null` when the file is not readable media. */
  probe: (filePath: string) => Promise<SourceProbe | null>;
  /** DNS resolution of the download host, every address. Defaults to dns.promises.lookup. */
  lookup?: (hostname: string) => Promise<string[]>;
  /**
   * Across worker replicas: the paid call for `claimKey` (see `tunelioCreateClaimKey`) goes out
   * only when this returns true. False: another worker already paid for this video in this window,
   * and this one takes the existing route. A throw means the claim store could not answer, and no
   * paid call is made either. Absent: single-process behaviour (tests, local).
   */
  claimCreate?: (claimKey: string) => Promise<boolean>;
  /**
   * VIDEO 645 — the render's paid-call slots (`tunelioRenderSlotKey`), across replicas: true when
   * this slot is now held by this worker, false when it is already taken. A throw: the store could
   * not answer, and no paid call is made. Absent: slots are counted in this process only.
   */
  reserveRenderSlot?: (slotKey: string) => Promise<boolean>;
  /** Gives a slot back when the paid call it was reserved for was refused before acceptance. Best effort. */
  releaseRenderSlot?: (slotKey: string) => Promise<void>;
  now?: () => number;
  /** Where sources are kept. Defaults to `<tmpdir>/fastvid-tunelio`. */
  sourceDir?: string;
  log?: (line: string) => void;
};

export type TunelioAcquireOptions = {
  /** Ceiling on the whole transfer. */
  timeoutMs: number;
  maxBytes?: number;
  /** VIDEO 645 — the render this call is for: at most `TUNELIO_PAID_CALLS_PER_RENDER` paid calls per render. Absent: no per-render limit. */
  renderId?: string | number;
};

/* ═══════════════════════ switches ═══════════════════════ */

export function tunelioApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = env.TUNELIO_API_KEY?.trim();
  return k ? k : undefined;
}

/**
 * The opt-in: `TUNELIO_ENABLED` must be exactly "true" (trimmed, case-insensitive). Missing, empty,
 * "false", "1", "yes", "on" — anything else — leaves the route off.
 */
export function tunelioSwitchedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TUNELIO_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function tunelioSwitchedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return !tunelioSwitchedOn(env);
}

/** On only when the switch is "true" AND a key is present. */
export function tunelioEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return tunelioSwitchedOn(env) && tunelioApiKey(env) !== undefined;
}

/**
 * One paid `/create` per video per source window, across replicas: the key the claim store is
 * asked for. The window is the source TTL, so a video can be paid for again only once every
 * worker would have forgotten its copy anyway.
 */
export function tunelioCreateClaimKey(videoId: string, now: number = Date.now()): string {
  return `tunelio:create:${videoId}:${Math.floor(now / TUNELIO_SOURCE_TTL_MS)}`;
}

/* ═══════════════════════ secrets never leave this module ═══════════════════════ */

export function redactSecrets(text: unknown, key?: string): string {
  let v = String(text ?? "");
  if (key) v = v.split(key).join("[REDACTED]");
  v = v.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  v = v.replace(/https?:\/\/\S+/gi, "<url>");
  return v;
}

/* ═══════════════════════ the download URL is checked before a byte moves ═══════════════════════ */

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^224\./,
  /^255\./,
];

export function isPrivateOrLocalAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (!a) return true;
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("::ffff:")) return isPrivateOrLocalAddress(a.slice(7));
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(a)) return true; // unique local
  if (/^fe[89ab][0-9a-f]:/i.test(a)) return true; // link local
  if (a.includes(":")) return false; // other IPv6: public
  return PRIVATE_V4.some((re) => re.test(a));
}

export function looksLikeIpLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** The static checks: scheme, credentials, host shape, port. DNS is checked separately. */
export function validateDownloadUrl(raw: unknown): UrlVerdict {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "no url" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol.replace(":", "")} is not https` };
  if (url.username || url.password) return { ok: false, reason: "credentials in url" };
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "no host" };
  if (looksLikeIpLiteral(host)) return { ok: false, reason: "ip literal host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "local host name" };
  }
  if (!host.includes(".")) return { ok: false, reason: "host without a domain" };
  if (url.port && url.port !== "443") return { ok: false, reason: `port ${url.port}` };
  return { ok: true, url };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const found = await dnsLookup(hostname, { all: true });
  return found.map((f) => f.address);
}

/** Static checks plus DNS: every resolved address must be public. */
export async function validateDownloadUrlResolved(
  raw: unknown,
  lookup: (hostname: string) => Promise<string[]> = defaultLookup
): Promise<UrlVerdict> {
  const v = validateDownloadUrl(raw);
  if (!v.ok) return v;
  let addresses: string[];
  try {
    addresses = await lookup(v.url.hostname);
  } catch (err) {
    return { ok: false, reason: `dns failed: ${(err as Error).message?.slice(0, 60) ?? "lookup threw"}` };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns returned no address" };
  const bad = addresses.find((a) => isPrivateOrLocalAddress(a));
  if (bad) return { ok: false, reason: "host resolves to a private or local address" };
  return v;
}

/* ═══════════════════════ reading the API's answers ═══════════════════════ */

/** The balance, whichever of the plausible field names the API uses. NaN when none is numeric. */
export function readCreditsBalance(json: unknown): number {
  if (!json || typeof json !== "object") return NaN;
  const o = json as Record<string, unknown>;
  for (const k of ["credits", "balance", "credits_left", "remaining", "credits_remaining", "available"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return NaN;
}

export function retryAfterMs(header: string | null | undefined): number {
  const n = Number((header ?? "").trim());
  if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, TUNELIO_COOLDOWN_MS.rateLimitedMax);
  return TUNELIO_COOLDOWN_MS.rateLimitedDefault;
}

/* ═══════════════════════ process-wide state ═══════════════════════ */

type SourceEntry = {
  path: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
  createdAt: number;
};

type TunelioState = {
  credits: { value: number; checkedAt: number } | null;
  cooldownUntil: number;
  cooldownReason: string;
  sources: Map<string, SourceEntry>;
  inflight: Map<string, Promise<TunelioOutcome>>;
  videoRefusals: Map<string, { code: TunelioFailCode; detail: string; at: number }>;
  /** VIDEO 645 — the paid-call slots held in this process per render (no claim store: the only ledger). */
  renderSlots: Map<string, Set<string>>;
  /** Counters for the render log; never money, never secrets. */
  stats: { createCalls: number; creditsCalls: number; sourcesServed: number; sourcesDownloaded: number; renderLimitHits: number; transferRetries: number };
};

const freshState = (): TunelioState => ({
  credits: null,
  cooldownUntil: 0,
  cooldownReason: "",
  sources: new Map(),
  inflight: new Map(),
  videoRefusals: new Map(),
  renderSlots: new Map(),
  stats: { createCalls: 0, creditsCalls: 0, sourcesServed: 0, sourcesDownloaded: 0, renderLimitHits: 0, transferRetries: 0 },
});

let state: TunelioState = freshState();

/** Tests only: forget balances, cooldowns, refusals and sources (files are left to the caller). */
export function resetTunelioStateForTests(): void {
  state = freshState();
}

export function tunelioStateSnapshot(now: number = Date.now()): {
  credits: number | null;
  cooldownMsLeft: number;
  cooldownReason: string;
  sources: number;
  refusals: number;
  stats: TunelioState["stats"];
} {
  return {
    credits: state.credits?.value ?? null,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
    cooldownReason: state.cooldownReason,
    sources: state.sources.size,
    refusals: state.videoRefusals.size,
    stats: { ...state.stats },
  };
}

/** Delete sources past their TTL (and forget expired refusals). Safe to call often. */
export function sweepTunelioSources(now: number = Date.now()): number {
  let removed = 0;
  for (const [id, entry] of state.sources) {
    if (now - entry.createdAt > TUNELIO_SOURCE_TTL_MS || !fs.existsSync(entry.path)) {
      try {
        fs.unlinkSync(entry.path);
      } catch {
        /* already gone */
      }
      state.sources.delete(id);
      removed++;
    }
  }
  for (const [id, r] of state.videoRefusals) {
    if (now - r.at > TUNELIO_VIDEO_REFUSAL_TTL_MS) state.videoRefusals.delete(id);
  }
  return removed;
}

/**
 * VIDEO 645 — THE WHOLE SOURCE IS ALREADY HERE.
 *
 * Tunelio delivers the entire video (645: nine sources, 36–288 MB, 10 credits each) and the pipeline
 * cut ONE 40 s section from each — 4 to 7 shots, many under 3 s — and never looked at the rest. The
 * source is kept for `TUNELIO_SOURCE_TTL_MS`; this names it, so another section can be cut from the
 * file on disk: no request, no credits, no transfer. `null` when nothing is kept (or the file is gone).
 */
export function keptTunelioSource(
  videoId: string,
  now: number = Date.now()
): { path: string; durationSec: number; bytes: number; width: number; height: number } | null {
  sweepTunelioSources(now);
  const entry = state.sources.get(videoId);
  if (!entry || !fs.existsSync(entry.path)) return null;
  return { path: entry.path, durationSec: entry.durationSec, bytes: entry.bytes, width: entry.width, height: entry.height };
}

/**
 * VIDEO 645 — one of the render's `TUNELIO_PAID_CALLS_PER_RENDER` slots, or why none: the store across
 * replicas when the caller has one, this process otherwise. The slots are tried in order; the first
 * that lands is held. A store that cannot answer means no paid call (`CLAIM_UNKNOWN`).
 */
async function reserveRenderSlot(
  renderKey: string,
  deps: TunelioDeps
): Promise<{ ok: true; slotKey: string } | { ok: false; code: "RENDER_LIMIT" | "CLAIM_UNKNOWN"; detail: string }> {
  const held = state.renderSlots.get(renderKey) ?? new Set<string>();
  state.renderSlots.set(renderKey, held);
  for (let n = 1; n <= TUNELIO_PAID_CALLS_PER_RENDER; n++) {
    const slotKey = tunelioRenderSlotKey(renderKey, n);
    if (held.has(slotKey)) continue;
    if (deps.reserveRenderSlot) {
      let won: boolean;
      try {
        won = await deps.reserveRenderSlot(slotKey);
      } catch (err) {
        return { ok: false, code: "CLAIM_UNKNOWN", detail: `slot store ${classifyThrow(err).detail}` };
      }
      if (!won) {
        /** another worker holds it: remembered here so this process does not ask the store for it again */
        held.add(slotKey);
        continue;
      }
    }
    held.add(slotKey);
    return { ok: true, slotKey };
  }
  return { ok: false, code: "RENDER_LIMIT", detail: `${TUNELIO_PAID_CALLS_PER_RENDER} paid calls already reserved for render ${renderKey}` };
}

/** VIDEO 645 — how many paid-call slots this process holds or saw taken for a render (tests and the render log). */
export function tunelioRenderSlotsHeld(renderId: string | number): number {
  return state.renderSlots.get(String(renderId))?.size ?? 0;
}

/**
 * VIDEO 645 — THE PAID CALLS ONE RENDER MAY MAKE.
 *
 * 645 made ten paid `/create` calls (100 credits) for ten pre-fetched stock videos of which three
 * reached the film. A render now reserves a slot — `tunelioRenderSlotKey(renderId, 1..3)` — before
 * every paid call: across worker replicas in the same `worker_once_claims` table as the per-video
 * claim (`TunelioDeps.reserveRenderSlot`), in this process when there is no store. A `/create` that
 * Tunelio refuses (any answer but HTTP 200) gives its slot back: a refused request is not a paid one.
 * A call that timed out or threw keeps its slot — it may have been accepted, and the limit guards money.
 */
export const TUNELIO_PAID_CALLS_PER_RENDER = 3;
/** A render's n-th paid-call slot in the claim store; `renderId` is the FastVid video id. */
export function tunelioRenderSlotKey(renderId: string | number, n: number): string {
  return `tunelio:render:${String(renderId)}:paid:${n}`;
}
/** The least time a second transfer attempt is given (`TRANSFER_RETRY`); below it the first failure stands. */
export const TUNELIO_TRANSFER_RETRY_MIN_MS = 10_000;

/** Delete every kept source now (end of a render, or a test's teardown). */
export function dropTunelioSources(): void {
  for (const entry of state.sources.values()) {
    try {
      fs.unlinkSync(entry.path);
    } catch {
      /* already gone */
    }
  }
  state.sources.clear();
}

function putOnCooldown(ms: number, reason: string, now: number): void {
  state.cooldownUntil = Math.max(state.cooldownUntil, now + ms);
  state.cooldownReason = reason;
}

/* ═══════════════════════ the one entry point ═══════════════════════ */

const fail = (code: TunelioFailCode, detail: string, paid = false): TunelioFailure => ({ ok: false, code, detail, paid });

const classifyThrow = (err: unknown): { code: TunelioFailCode; detail: string } => {
  const msg = (err as Error)?.message ?? String(err);
  if ((err as Error)?.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(msg)) {
    return { code: "TIMEOUT", detail: msg.slice(0, 100) };
  }
  if (/exceeds maximum size|too large|bytes-plafond/i.test(msg)) return { code: "TOO_LARGE", detail: msg.slice(0, 100) };
  return { code: "THREW", detail: msg.slice(0, 100) };
};

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  key: string,
  timeoutMs: number
): Promise<{ status: number; json: unknown; headers: Headers | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual",
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, headers: r.headers ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole 720p source for one video, from disk when it is already there, from one paid call
 * otherwise. Never throws; never logs the key or a URL.
 */
export async function acquireTunelioSource(
  videoId: string,
  deps: TunelioDeps,
  opts: TunelioAcquireOptions
): Promise<TunelioOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!tunelioSwitchedOn(env)) return fail("DISABLED", "TUNELIO_ENABLED is not \"true\"");
  const key = tunelioApiKey(env);
  if (!key) return fail("NO_KEY", "TUNELIO_API_KEY not set");
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) return fail("INVALID_RESPONSE", "not a YouTube video id");

  sweepTunelioSources(now());

  const cached = state.sources.get(videoId);
  if (cached && fs.existsSync(cached.path)) {
    state.stats.sourcesServed++;
    return { ok: true, path: cached.path, bytes: cached.bytes, durationSec: cached.durationSec, width: cached.width, height: cached.height, cached: true };
  }
  const refused = state.videoRefusals.get(videoId);
  if (refused) return fail("VIDEO_REFUSED", `${refused.code.toLowerCase()} earlier (${refused.detail})`);
  if (state.cooldownUntil > now()) {
    return fail("COOLDOWN", `${state.cooldownReason} — ${Math.ceil((state.cooldownUntil - now()) / 1000)}s left`);
  }
  const running = state.inflight.get(videoId);
  if (running) return running;

  const run = (async (): Promise<TunelioOutcome> => {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const started = now();
    const safe = (s: unknown) => redactSecrets(s, key);

    /* 1. balance, cached for a while, never printed as money — only as a number of credits */
    if (!state.credits || now() - state.credits.checkedAt > TUNELIO_CREDITS_TTL_MS) {
      let read: { status: number; json: unknown };
      try {
        state.stats.creditsCalls++;
        read = await fetchJson(fetchImpl, `${TUNELIO_BASE_URL}/credits`, key, CREDITS_TIMEOUT_MS);
      } catch (err) {
        const c = classifyThrow(err);
        putOnCooldown(TUNELIO_COOLDOWN_MS.creditsUnknown, "credits unreadable", now());
        log(`[YouTubeTunelio] video=${videoId} step=credits ${c.code.toLowerCase()} — route skipped for a while: ${safe(c.detail)}`);
        return fail("CREDITS_UNKNOWN", `credits call ${c.code.toLowerCase()}`);
      }
      if (read.status === 401) {
        putOnCooldown(TUNELIO_COOLDOWN_MS.unauthorized, "unauthorized", now());
        log(`[YouTubeTunelio] video=${videoId} step=credits http=401 — key refused, route skipped for ${TUNELIO_COOLDOWN_MS.unauthorized / 60_000} min`);
        return fail("UNAUTHORIZED", "credits http 401");
      }
      const balance = read.status === 200 ? readCreditsBalance(read.json) : NaN;
      if (!Number.isFinite(balance)) {
        putOnCooldown(TUNELIO_COOLDOWN_MS.creditsUnknown, "credits unknown", now());
        const keys = read.json && typeof read.json === "object" ? Object.keys(read.json as object).slice(0, 8).join(",") : "none";
        log(`[YouTubeTunelio] video=${videoId} step=credits http=${read.status} balance=unknown fields=${keys} — route skipped for a while`);
        return fail("CREDITS_UNKNOWN", `credits http ${read.status}, no numeric balance`);
      }
      state.credits = { value: balance, checkedAt: now() };
    }
    if (state.credits.value < TUNELIO_CREATE_COST) {
      putOnCooldown(TUNELIO_COOLDOWN_MS.insufficientCredits, "insufficient credits", now());
      log(`[YouTubeTunelio] video=${videoId} step=credits balance=${state.credits.value} < ${TUNELIO_CREATE_COST} — route skipped for ${TUNELIO_COOLDOWN_MS.insufficientCredits / 60_000} min`);
      return fail("INSUFFICIENT_CREDITS", `balance ${state.credits.value} < ${TUNELIO_CREATE_COST}`);
    }

    /* 1b. across replicas: only the worker whose claim lands makes the paid call */
    if (deps.claimCreate) {
      let won: boolean;
      try {
        won = await deps.claimCreate(tunelioCreateClaimKey(videoId, now()));
      } catch (err) {
        const c = classifyThrow(err);
        log(`[YouTubeTunelio] video=${videoId} step=claim unknown — no paid call: ${safe(c.detail)}`);
        return fail("CLAIM_UNKNOWN", `claim store ${safe(c.detail)}`);
      }
      if (!won) {
        state.videoRefusals.set(videoId, { code: "CLAIMED_ELSEWHERE", detail: "another worker holds the paid call", at: now() });
        log(`[YouTubeTunelio] video=${videoId} step=claim held_elsewhere — another worker paid for this video; existing route`);
        return fail("CLAIMED_ELSEWHERE", "another worker holds the paid call for this video");
      }
    }

    /* 1c. VIDEO 645 — the render's paid-call slot: none left, no paid call */
    const renderKey = opts.renderId != null ? String(opts.renderId) : null;
    let heldSlot: string | null = null;
    if (renderKey != null) {
      const slot = await reserveRenderSlot(renderKey, deps);
      if (!slot.ok) {
        if (slot.code === "RENDER_LIMIT") {
          state.stats.renderLimitHits++;
          log(
            `[YouTubeTunelio] video=${videoId} step=render_limit — ${TUNELIO_PAID_CALLS_PER_RENDER} paid calls already reserved for render ${renderKey}; ` +
              `no paid call; existing route`
          );
        } else {
          log(`[YouTubeTunelio] video=${videoId} step=render_slot unknown — no paid call: ${safe(slot.detail)}`);
        }
        return fail(slot.code, slot.detail);
      }
      heldSlot = slot.slotKey;
    }
    /** A `/create` Tunelio answered with anything but 200 was not accepted: the slot goes back. */
    const giveSlotBack = async (): Promise<void> => {
      if (heldSlot == null || renderKey == null) return;
      const key = heldSlot;
      heldSlot = null;
      state.renderSlots.get(renderKey)?.delete(key);
      if (deps.releaseRenderSlot) {
        try {
          await deps.releaseRenderSlot(key);
        } catch {
          /* the slot stays taken in the store: the limit errs towards fewer paid calls */
        }
      }
    };

    /* 2. the one paid call */
    let created: { status: number; json: unknown; headers: Headers | null };
    state.stats.createCalls++;
    const createUrl = `${TUNELIO_BASE_URL}/create?quality=${TUNELIO_QUALITY}&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    try {
      created = await fetchJson(fetchImpl, createUrl, key, API_TIMEOUT_MS);
    } catch (err) {
      const c = classifyThrow(err);
      if (c.code === "TIMEOUT") putOnCooldown(TUNELIO_COOLDOWN_MS.timeout, "create timed out", now());
      log(`[YouTubeTunelio] video=${videoId} step=create ${c.code.toLowerCase()} ms=${now() - started}: ${safe(c.detail)}`);
      return fail(c.code, `create ${safe(c.detail)}`, true);
    }
    const createMs = now() - started;
    if (created.status !== 200) {
      await giveSlotBack();
      const body = created.json && typeof created.json === "object" ? JSON.stringify(created.json).slice(0, 120) : "";
      const detail = `create http ${created.status}${body ? ` ${safe(body)}` : ""}`;
      switch (created.status) {
        case 402:
          state.credits = { value: 0, checkedAt: now() };
          putOnCooldown(TUNELIO_COOLDOWN_MS.insufficientCredits, "insufficient credits (402)", now());
          log(`[YouTubeTunelio] video=${videoId} step=create http=402 ms=${createMs} — no credits, route skipped for ${TUNELIO_COOLDOWN_MS.insufficientCredits / 60_000} min`);
          return fail("INSUFFICIENT_CREDITS", detail);
        case 429: {
          const wait = retryAfterMs(created.headers?.get("retry-after"));
          putOnCooldown(wait, "rate limited (429)", now());
          log(`[YouTubeTunelio] video=${videoId} step=create http=429 ms=${createMs} — rate limited, route skipped for ${Math.round(wait / 1000)}s`);
          return fail("RATE_LIMITED", detail);
        }
        case 401:
          putOnCooldown(TUNELIO_COOLDOWN_MS.unauthorized, "unauthorized (401)", now());
          log(`[YouTubeTunelio] video=${videoId} step=create http=401 ms=${createMs} — key refused`);
          return fail("UNAUTHORIZED", detail);
        case 404:
        case 400:
          state.videoRefusals.set(videoId, { code: "NOT_FOUND", detail: `http ${created.status}`, at: now() });
          log(`[YouTubeTunelio] video=${videoId} step=create http=${created.status} ms=${createMs} — this video is not served; not asked again`);
          return fail("NOT_FOUND", detail);
        default:
          if (created.status >= 500) putOnCooldown(TUNELIO_COOLDOWN_MS.serverError, `server error (${created.status})`, now());
          log(`[YouTubeTunelio] video=${videoId} step=create http=${created.status} ms=${createMs}`);
          return fail(created.status >= 300 && created.status < 400 ? "INVALID_RESPONSE" : "HTTP_ERROR", detail);
      }
    }
    /* 200: a paid answer. From here on a failure is remembered so the video is not paid for twice. */
    state.credits = { value: Math.max(0, state.credits.value - TUNELIO_CREATE_COST), checkedAt: state.credits.checkedAt };
    const paidFailure = (code: TunelioFailCode, detail: string): TunelioFailure => {
      state.videoRefusals.set(videoId, { code, detail, at: now() });
      log(`[YouTubeTunelio] video=${videoId} step=${code.toLowerCase()} ms=${now() - started} — paid answer unusable: ${safe(detail)}`);
      return fail(code, detail, true);
    };
    const answer = (created.json && typeof created.json === "object" ? created.json : {}) as Record<string, unknown>;
    if (answer.status !== "ok") return paidFailure("INVALID_RESPONSE", `status ${String(answer.status ?? "missing")}`);
    if (answer.mode !== undefined && answer.mode !== "video") return paidFailure("INVALID_RESPONSE", `mode ${String(answer.mode)}`);
    const verdict = await validateDownloadUrlResolved(answer.url, deps.lookup);
    if (!verdict.ok) return paidFailure("INVALID_URL", verdict.reason);
    const declaredBytes = typeof answer.file_size === "number" ? answer.file_size : null;
    const maxBytes = opts.maxBytes ?? TUNELIO_DEFAULT_MAX_SOURCE_BYTES;
    if (declaredBytes != null && declaredBytes > maxBytes) return paidFailure("TOO_LARGE", `declared ${declaredBytes} > ${maxBytes} bytes`);
    log(`[YouTubeTunelio] video=${videoId} step=create http=200 ms=${createMs} declared_bytes=${declaredBytes ?? "unknown"} quality=${String(answer.quality ?? "?")}`);

    /* 3. the transfer: no key, no redirects, a ceiling and a clock */
    const dir = deps.sourceDir ?? path.join(os.tmpdir(), "fastvid-tunelio");
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${videoId}-${crypto.randomBytes(4).toString("hex")}.mp4`);
    const partPath = `${finalPath}.part`;
    const transferStarted = now();
    const dropPart = () => {
      try {
        fs.unlinkSync(partPath);
      } catch {
        /* nothing written */
      }
    };
    type Transfer = { ok: boolean; status: number; bytes: number | null; detail?: string };
    const bytesOnDisk = () => (fs.existsSync(partPath) ? fs.statSync(partPath).size : 0);
    const transfer = async (timeoutMs: number): Promise<{ got: Transfer; threw: null } | { got: null; threw: { code: TunelioFailCode; detail: string } }> => {
      try {
        return { got: await deps.download(verdict.url.toString(), partPath, timeoutMs, maxBytes), threw: null };
      } catch (err) {
        return { got: null, threw: classifyThrow(err) };
      }
    };
    let attempt = await transfer(opts.timeoutMs);
    /**
     * VIDEO 645 — ONE MORE TRY ON THE SAME SIGNED URL. 645 paid for a source whose transfer broke
     * ("response exceeds"/reset) and then fetched the video again through the yt-dlp service. A broken
     * or short transfer (a throw that is not a timeout, an HTTP 5xx or no status, fewer bytes than a
     * video has) is tried once more on the URL already paid for — no new `/create` — when the clock
     * has at least `TUNELIO_TRANSFER_RETRY_MIN_MS` left. A timeout, a 4xx (the URL is refused) or a
     * file that is too large stands as it is. The file is validated after the retry exactly as before.
     */
    const brokenTransfer = attempt.threw
      ? attempt.threw.code !== "TIMEOUT" && attempt.threw.code !== "TOO_LARGE"
      : !attempt.got.ok
        ? attempt.got.status === 0 || attempt.got.status >= 500
        : (attempt.got.bytes ?? bytesOnDisk()) < MIN_SOURCE_BYTES;
    const leftForRetry = opts.timeoutMs - (now() - transferStarted);
    if (brokenTransfer && leftForRetry >= TUNELIO_TRANSFER_RETRY_MIN_MS) {
      const why = attempt.threw ? `threw ${safe(attempt.threw.detail)}` : attempt.got && !attempt.got.ok ? `http ${attempt.got.status}` : `${attempt.got?.bytes ?? bytesOnDisk()} bytes`;
      dropPart();
      state.stats.transferRetries++;
      log(`[YouTubeTunelio] video=${videoId} step=transfer_retry — first transfer broke (${why}); one more try on the same paid URL, ${Math.round(leftForRetry / 1000)}s left; no new paid call`);
      attempt = await transfer(leftForRetry);
    }
    if (attempt.threw) {
      dropPart();
      return paidFailure(attempt.threw.code === "THREW" ? "DOWNLOAD_FAILED" : attempt.threw.code, `download ${safe(attempt.threw.detail)}`);
    }
    const got: Transfer = attempt.got;
    const bytes = got.bytes ?? bytesOnDisk();
    if (!got.ok) {
      dropPart();
      return paidFailure("DOWNLOAD_FAILED", `download http ${got.status}${got.detail ? ` ${safe(got.detail)}` : ""}`);
    }
    if (bytes > maxBytes) {
      dropPart();
      return paidFailure("TOO_LARGE", `${bytes} > ${maxBytes} bytes`);
    }
    if (bytes < MIN_SOURCE_BYTES) {
      dropPart();
      return paidFailure("EMPTY", `${bytes} bytes`);
    }

    /* 4. is it a video with sound? */
    let probe: SourceProbe | null;
    try {
      probe = await deps.probe(partPath);
    } catch {
      probe = null;
    }
    if (!probe) {
      dropPart();
      return paidFailure("INVALID_FILE", "ffprobe could not read the file");
    }
    if (!(probe.width > 0 && probe.height > 0)) {
      dropPart();
      return paidFailure("NO_VIDEO_STREAM", "no video stream");
    }
    if (!probe.hasAudio) {
      dropPart();
      return paidFailure("NO_AUDIO_STREAM", "no audio stream");
    }
    if (!(probe.durationSec > 0)) {
      dropPart();
      return paidFailure("INVALID_FILE", "no duration");
    }
    try {
      fs.renameSync(partPath, finalPath);
    } catch (err) {
      dropPart();
      return paidFailure("INVALID_FILE", `rename failed: ${(err as Error).message?.slice(0, 60)}`);
    }
    const entry: SourceEntry = { path: finalPath, bytes, durationSec: probe.durationSec, width: probe.width, height: probe.height, createdAt: now() };
    state.sources.set(videoId, entry);
    state.stats.sourcesDownloaded++;
    log(
      `[YouTubeTunelio] video=${videoId} step=ready bytes=${bytes} duration=${probe.durationSec.toFixed(1)}s ` +
        `size=${probe.width}x${probe.height} transfer_ms=${now() - transferStarted} total_ms=${now() - started} credits_left=${state.credits.value}`
    );
    return { ok: true, path: finalPath, bytes, durationSec: probe.durationSec, width: probe.width, height: probe.height, cached: false };
  })().catch((err): TunelioOutcome => {
    const c = classifyThrow(err);
    return fail(c.code, `unexpected: ${redactSecrets(c.detail, key)}`);
  });

  state.inflight.set(videoId, run);
  try {
    return await run;
  } finally {
    if (state.inflight.get(videoId) === run) state.inflight.delete(videoId);
  }
}

/* ═══════════════════════ the window a beat asked for ═══════════════════════ */

/**
 * Where to cut `[start, start+duration]` out of a source of `sourceSec`: a window that runs past
 * the end slides back, a window that cannot fit at all starts at zero. Pure, for the tests.
 */
export function clampWindow(clipStart: number, duration: number, sourceSec: number): { start: number; duration: number } {
  const dur = Math.max(0.5, Math.min(duration, sourceSec > 0 ? sourceSec : duration));
  let start = Math.max(0, clipStart);
  if (sourceSec > 0 && start + dur > sourceSec) start = Math.max(0, sourceSec - dur);
  return { start: Number(start.toFixed(3)), duration: Number(dur.toFixed(3)) };
}

/** The ffmpeg arguments for the cut: seek before the input, re-encode, faststart — the same cut the service makes. */
export function cutWindowArgs(src: string, dst: string, start: number, duration: number): string[] {
  return [
    "-y", "-v", "error",
    "-ss", start.toFixed(3),
    "-i", src,
    "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac",
    "-movflags", "+faststart",
    dst,
  ];
}
