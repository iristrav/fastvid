/** Visual Matching Engine V2 — Vision Score Cache.
 *
 *  Permanent disk-backed cache for LLM Vision scores. Mirrors the same JSON-on-disk
 *  pattern used by server/archiveClipEmbedding.ts and visualMatchingV2/clipEmbeddingCache.ts.
 *
 *  Cache key: (intentHash, candidateId, visionModel, promptVersion) — all four must match
 *  for a hit, so a prompt bump or model change always forces a fresh LLM call with no
 *  manual cache invalidation needed. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { LOCAL_UPLOADS_DIR } from "../storageLocal";
import type { VisionScores } from "./types";

export type StoredVisionScore = {
  intentHash: string;
  candidateId: string;
  visionModel: string;
  promptVersion: string;
  scores: VisionScores;
  createdAt: string;
};

function cacheDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "v2-vision-scores");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKeyHash(intentHash: string, candidateId: string, visionModel: string, promptVersion: string): string {
  return crypto.createHash("sha1").update(`${intentHash}|${candidateId}|${visionModel}|${promptVersion}`).digest("hex");
}

function cachePath(keyHash: string): string {
  return path.join(cacheDir(), `${keyHash}.json`);
}

export function loadVisionScore(
  intentHash: string,
  candidateId: string,
  visionModel: string,
  promptVersion: string
): VisionScores | null {
  const p = cachePath(cacheKeyHash(intentHash, candidateId, visionModel, promptVersion));
  if (!fs.existsSync(p)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(p, "utf8")) as StoredVisionScore;
    if (stored.intentHash !== intentHash || stored.candidateId !== candidateId ||
        stored.visionModel !== visionModel || stored.promptVersion !== promptVersion) return null;
    return stored.scores;
  } catch {
    return null;
  }
}

export function storeVisionScore(
  intentHash: string,
  candidateId: string,
  visionModel: string,
  promptVersion: string,
  scores: VisionScores
): void {
  const record: StoredVisionScore = {
    intentHash,
    candidateId,
    visionModel,
    promptVersion,
    scores,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(cachePath(cacheKeyHash(intentHash, candidateId, visionModel, promptVersion)), JSON.stringify(record));
  } catch {
    // Best-effort cache — a write failure just means this candidate is re-scored next time.
  }
}
