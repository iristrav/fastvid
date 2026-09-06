/**
 * THE RENDER THAT CAN BE ASKED AGAIN.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * Five rounds in a row ended the same way: a fix that was proven statically, and a production
 * render as the only instrument that could say whether it worked. Each render costs real money and
 * about twenty minutes, and each one answered exactly one question before raising the next.
 *
 * This records what the WORLD said during a render — what the archive search found, what the
 * picture editor judged — so the render's decisions can be recomputed later, offline, for free,
 * against whatever the code says today.
 *
 * ── Facts, not decisions ────────────────────────────────────────────────────────────────────
 *
 * The distinction this file is built on. A bundle that stored `eligible=false` could only ever
 * replay that same refusal, and would call every future fix a no-op. So it stores the INPUTS a
 * decision was made from — this fetch found asset 57488 in archive "ww2"; the editor said APPROVED
 * for that content key — and lets the current code derive eligibility, adoption and the export
 * gates from scratch. That is what makes a replay able to disagree with the render it came from,
 * which is the only reason to keep one.
 *
 * The recorded decisions ARE kept, in `adoptions`, but only as the thing to diff against. They are
 * never fed back in as input.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here stores a URL, an API response body, a signed link or an absolute path. A fetch is
 * identified by basename, content key, asset id and archive name — everything the ledger needs and
 * nothing a credential could hide in. That is a design choice rather than a redaction pass,
 * because a redactor is only as good as its list and this way there is no list to get wrong.
 *
 * ── Honesty ─────────────────────────────────────────────────────────────────────────────────
 *
 * A replayed run is not a render. It exercises the lineage ledger, the eligibility rule, the
 * adoption guard and the export gates against real recorded facts; it does not fetch, does not
 * decode a frame, does not encode a film. Anything downstream of compose is outside what a bundle
 * can answer, and the replay report says so on every run rather than leaving the reader to assume.
 */
import * as fs from "fs";
import * as path from "path";

export const REPLAY_FORMAT_VERSION = 1 as const;

/** What one curated fetch found. `pick: null` means the fetch returned a clip with no pick. */
export type ReplayFetchFact = {
  kind: "fetch";
  scene: number;
  beat: number;
  route: string;
  /** Basename only — never a directory, never a URL. */
  file: string;
  contentKey: string | null;
  pick: {
    assetId: number;
    archiveName: string;
    mediaType?: string;
    durationSec?: number;
    score?: number;
  } | null;
};

/** What the picture editor said about one clip. */
export type ReplayVisionFact = {
  kind: "vision";
  scene: number;
  beat: number;
  file: string;
  contentKey: string | null;
  /** The verdict as the adoption guard sees it: APPROVED / REJECTED / UNCLEAR / NOT_ASKED. */
  verdict: string;
  visionAvailable: boolean;
};

/**
 * What the render DECIDED. Kept for diffing only — never an input to a replay, or the bundle
 * could not contradict the render that produced it.
 */
export type ReplayAdoptionFact = {
  kind: "adoption";
  scene: number;
  beat: number;
  route: string;
  eligible: boolean;
  vision: string;
  visionAvailable: boolean;
  allowed: boolean;
  code: string | null;
};

/**
 * ONE YOUTUBE DOWNLOAD ATTEMPT, AND WHETHER ANY BYTES ACTUALLY MOVED.
 *
 * ── The question render 571 could not answer ────────────────────────────────────────────────
 *
 *     YouTube results 55, download attempts 14, successful 0
 *
 * and nothing to say which of the seven download statuses those fourteen were. The distinction
 * that matters most is not in the status at all: `claimDownloadSlot()` runs BEFORE the download,
 * so an "attempt" is counted before a single byte moves. Fourteen attempts is equally consistent
 * with fourteen failed transfers and with fourteen decisions to stand aside for a scene budget
 * that had less than twelve seconds left — opposite problems, identical number.
 *
 * `transferStarted` is therefore the field this fact exists for. Everything else is context.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────
 *
 * No download URL, no headers, no response body, no cookies. The YouTube video id is recorded
 * because it identifies the asset and is public; the signed format URL that the transfer actually
 * uses never enters the bundle. Same principle as the fetch fact: identity, not payload.
 */
export type ReplayDownloadFact = {
  kind: "download";
  provider: "youtube_cc";
  /** The public YouTube video id — an identity, never a URL. */
  videoId: string;
  scene: number;
  /** The route the attempt ended on: "cloud", "rapidapi", or none if it never chose one. */
  route: string | null;
  /** One of the seven YoutubeDownloadStatus values. */
  status: string;
  /** The reporter's own reason string, e.g. `scene_budget_too_short_to_start`. */
  reason: string;
  /** False when the attempt was refused before any transfer began. THE decisive field. */
  transferStarted: boolean;
  /** Milliseconds left in the scene budget when the attempt was considered, when known. */
  remainingMs: number | null;
  /** Bytes actually written, when a transfer ran. */
  bytes: number | null;
};

export type ReplayMetaFact = {
  kind: "meta";
  formatVersion: typeof REPLAY_FORMAT_VERSION;
  videoId: number | null;
  commit: string | null;
  recordedAt: string;
};

export type ReplayFact =
  | ReplayFetchFact
  | ReplayVisionFact
  | ReplayAdoptionFact
  | ReplayDownloadFact
  | ReplayMetaFact;

export type ReplayBundle = {
  meta: ReplayMetaFact | null;
  fetches: ReplayFetchFact[];
  visions: ReplayVisionFact[];
  adoptions: ReplayAdoptionFact[];
  downloads: ReplayDownloadFact[];
};

/* ═══════════════════════════ recording ═══════════════════════════ */

/**
 * Append-only JSONL, one fact per line.
 *
 * Not an in-memory buffer flushed at the end: a render that dies at minute eighteen is exactly the
 * render worth replaying, and a buffer would lose it. Every line written is a line kept.
 */
let recorderPath: string | null = null;
let recorderFailed = false;

/** Reads the env once per process, the way the render itself is configured. */
export function replayRecordingPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const on = (env.RENDER_REPLAY_RECORD ?? "").trim().toLowerCase() === "true";
  if (!on) return null;
  const p = env.RENDER_REPLAY_BUNDLE?.trim();
  return p && p.length > 0 ? p : null;
}

export function beginReplayRecording(
  videoId: number | null,
  commit: string | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  recorderPath = replayRecordingPath(env);
  recorderFailed = false;
  if (!recorderPath) return false;
  try {
    fs.mkdirSync(path.dirname(recorderPath), { recursive: true });
    fs.writeFileSync(recorderPath, "");
    recordReplayFact({
      kind: "meta",
      formatVersion: REPLAY_FORMAT_VERSION,
      videoId,
      commit,
      recordedAt: new Date().toISOString(),
    });
    console.log(`[RenderReplay] recording facts to ${recorderPath}`);
    return true;
  } catch (err) {
    recorderFailed = true;
    console.warn(`[RenderReplay] could not open the bundle — recording off: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Recording must never be able to break a render. A failed write is reported once and then the
 * recorder stands down — losing a diagnostic is a nuisance, losing the film is not.
 */
export function recordReplayFact(fact: ReplayFact): void {
  if (!recorderPath || recorderFailed) return;
  try {
    fs.appendFileSync(recorderPath, `${JSON.stringify(fact)}\n`);
  } catch (err) {
    recorderFailed = true;
    console.warn(`[RenderReplay] recording stopped after a write error: ${(err as Error).message}`);
  }
}

/** True while a bundle is open. Call sites use it to skip building a fact nobody will read. */
export function replayRecordingActive(): boolean {
  return recorderPath !== null && !recorderFailed;
}

/** Test seam: forget any open bundle. */
export function resetReplayRecordingForTest(): void {
  recorderPath = null;
  recorderFailed = false;
}

/* ═══════════════════════════ loading ═══════════════════════════ */

/**
 * A malformed line is named and skipped rather than aborting the load — a bundle from a render
 * that was killed mid-write ends in half a line, and that bundle is still worth reading.
 */
export function parseReplayBundle(text: string): { bundle: ReplayBundle; skipped: number } {
  const bundle: ReplayBundle = { meta: null, fetches: [], visions: [], adoptions: [], downloads: [] };
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let fact: ReplayFact;
    try {
      fact = JSON.parse(trimmed) as ReplayFact;
    } catch {
      skipped += 1;
      continue;
    }
    switch (fact.kind) {
      case "meta":
        bundle.meta = fact;
        break;
      case "fetch":
        bundle.fetches.push(fact);
        break;
      case "vision":
        bundle.visions.push(fact);
        break;
      case "adoption":
        bundle.adoptions.push(fact);
        break;
      case "download":
        bundle.downloads.push(fact);
        break;
      default:
        skipped += 1;
    }
  }
  return { bundle, skipped };
}

export function loadReplayBundle(file: string): { bundle: ReplayBundle; skipped: number } {
  return parseReplayBundle(fs.readFileSync(file, "utf8"));
}
