/**
 * Background CLIP frame index for archive assets (via localClipVision).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { LOCAL_UPLOADS_DIR } from "./storageLocal";
import {
  clipEmbeddingIndexEnabled,
  indexVideoFrameEmbeddings,
  meanEmbedding,
  embedTextQuery,
  scoreEmbeddingSimilarity,
  clipSimToScore,
  minLocalClipSimilarity,
  resolveBeatVisionQueryEmbedding,
  beatVisionContextFromProfile,
  type BeatVisionQueryContext,
} from "./localClipVision";
import type { BeatSemanticProfile } from "./semanticVisualMatching";

export type StoredClipEmbedding = {
  assetId: number;
  model: string;
  embedding: number[];
  frameEmbeddings?: number[][];
  updatedAt: string;
};

function indexDir(): string {
  const dir = path.join(LOCAL_UPLOADS_DIR, "archive-clip-embeddings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(assetId: number): string {
  return path.join(indexDir(), `${assetId}.json`);
}

export { clipEmbeddingIndexEnabled };

export function loadStoredClipEmbedding(assetId: number): StoredClipEmbedding | null {
  if (!clipEmbeddingIndexEnabled()) return null;
  const p = indexPath(assetId);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as StoredClipEmbedding;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadStoredFrameEmbeddings(assetId: number): number[][] {
  const stored = loadStoredClipEmbedding(assetId);
  if (!stored) return [];
  if (Array.isArray(stored.frameEmbeddings) && stored.frameEmbeddings.length > 0) {
    return stored.frameEmbeddings;
  }
  return [stored.embedding];
}

/** Index archive video frames with CLIP in the background after upload. */
export async function indexArchiveClipEmbedding(
  assetId: number,
  localVideoPath: string
): Promise<boolean> {
  if (!clipEmbeddingIndexEnabled() || !fs.existsSync(localVideoPath)) return false;

  const workDir = path.join(os.tmpdir(), `fv_clip_idx_${assetId}`);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const frameEmbeddings = await indexVideoFrameEmbeddings(
      localVideoPath,
      workDir,
      `a${assetId}`
    );
    if (frameEmbeddings.length === 0) return false;

    const embedding = meanEmbedding(frameEmbeddings);
    if (!embedding) return false;

    const record: StoredClipEmbedding = {
      assetId,
      model: "Xenova/clip-vit-base-patch32",
      embedding,
      frameEmbeddings,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(indexPath(assetId), JSON.stringify(record), "utf8");
    console.log(`[ClipEmbedding] Indexed asset ${assetId} (${frameEmbeddings.length} frames)`);
    const { scheduleAuditForAsset } = await import("./clipBackgroundAuditor");
    scheduleAuditForAsset(assetId);
    return true;
  } catch (err) {
    console.warn(`[ClipEmbedding] asset ${assetId}:`, (err as Error).message?.slice(0, 80));
    return false;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      if (localVideoPath.includes(os.tmpdir()) && fs.existsSync(localVideoPath)) {
        fs.unlinkSync(localVideoPath);
      }
    } catch {
      /* ignore */
    }
  }
}

export async function createClipTextEmbedding(query: string): Promise<number[] | null> {
  return embedTextQuery(query);
}

export type ClipPreRankScore = {
  worstScore10: number;
  bestScore10: number;
  hasEmbeddings: boolean;
  definiteFail: boolean;
};

/** Score indexed archive frames against a beat embedding (no FFmpeg). */
export function scoreAssetClipPreRank(
  assetId: number,
  queryEmbedding: number[],
  minScore10 = 7
): ClipPreRankScore {
  const frames = loadStoredFrameEmbeddings(assetId);
  if (!frames.length || !queryEmbedding.length) {
    return { worstScore10: 0, bestScore10: 0, hasEmbeddings: false, definiteFail: false };
  }
  const minSim = minLocalClipSimilarity(minScore10);
  let worst = Infinity;
  let best = 0;
  for (const emb of frames) {
    const sim = scoreEmbeddingSimilarity(queryEmbedding, emb);
    worst = Math.min(worst, sim);
    best = Math.max(best, sim);
  }
  const worstSim = worst === Infinity ? 0 : worst;
  return {
    worstScore10: clipSimToScore(worstSim),
    bestScore10: clipSimToScore(best),
    hasEmbeddings: true,
    definiteFail: worstSim < minSim - 0.04,
  };
}

export function clipPreRankPoolSize(fastMode = false): number {
  const raw = process.env.CLIP_PRE_RANK_POOL?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 8 && n <= 128) return n;
  }
  return fastMode ? 36 : 48;
}

export function clipPreRankMinScore10(fastMode = false): number {
  return fastMode ? 6 : 7;
}

export { beatVisionContextFromProfile, type BeatVisionQueryContext };

/** Re-rank archive candidates by stored CLIP embeddings before clip prepare. */
export async function preRankCuratedCandidatesByClipEmbedding<
  T extends { asset: { id: number }; score: number; clipVisionScore10?: number },
>(
  candidates: T[],
  ctx: BeatVisionQueryContext,
  options?: {
    fastMode?: boolean;
    minScore10?: number;
    maxPool?: number;
    queryEmb?: number[] | null;
  }
): Promise<{ ranked: T[]; queryEmb: number[] | null }> {
  if (!clipEmbeddingIndexEnabled() || candidates.length === 0) {
    return { ranked: candidates, queryEmb: null };
  }

  const queryEmb = options?.queryEmb ?? (await resolveBeatVisionQueryEmbedding(ctx));
  if (!queryEmb) return { ranked: candidates, queryEmb: null };

  const maxPool = options?.maxPool ?? clipPreRankPoolSize(options?.fastMode);
  const minScore10 = options?.minScore10 ?? clipPreRankMinScore10(options?.fastMode);
  const head = candidates.slice(0, maxPool);
  const tail = candidates.slice(maxPool);

  const scored = head.map((pick) => ({
    pick,
    pr: scoreAssetClipPreRank(pick.asset.id, queryEmb, minScore10),
  }));

  const withEmb = scored.filter((s) => s.pr.hasEmbeddings);
  const withoutEmb = scored.filter((s) => !s.pr.hasEmbeddings);
  const definiteFails = withEmb.filter((s) => s.pr.definiteFail);
  const viable = withEmb.filter((s) => !s.pr.definiteFail);

  viable.sort((a, b) => {
    if (b.pr.worstScore10 !== a.pr.worstScore10) return b.pr.worstScore10 - a.pr.worstScore10;
    return b.pick.score - a.pick.score;
  });

  const blendScore = (pick: T, worst10: number) => Math.round(pick.score * 0.5 + worst10 * 9);

  const reranked: T[] = [
    ...viable.map(({ pick, pr }) => ({
      ...pick,
      clipVisionScore10: pr.worstScore10,
      score: blendScore(pick, pr.worstScore10),
    })),
    ...withoutEmb.map(({ pick }) => pick),
    ...definiteFails.map(({ pick, pr }) => ({
      ...pick,
      clipVisionScore10: pr.worstScore10,
      score: Math.max(0, pick.score - 20),
    })),
  ];
  reranked.sort((a, b) => b.score - a.score);

  return { ranked: [...reranked, ...tail], queryEmb };
}

export function beatVisionContextForSearch(
  beat: {
    text: string;
    searchQuery?: string;
    powerWord?: string;
    visualDescription?: string;
  },
  videoTitle?: string,
  semanticProfile?: BeatSemanticProfile
): BeatVisionQueryContext {
  return beatVisionContextFromProfile(beat, videoTitle, semanticProfile);
}

export async function scoreAssetClipSimilarity(
  assetId: number,
  queryEmbedding: number[]
): Promise<number> {
  const frames = loadStoredFrameEmbeddings(assetId);
  if (!frames.length || queryEmbedding.length === 0) return 0;
  let best = 0;
  for (const emb of frames) {
    best = Math.max(best, scoreEmbeddingSimilarity(queryEmbedding, emb));
  }
  return Math.round(best * 100);
}
