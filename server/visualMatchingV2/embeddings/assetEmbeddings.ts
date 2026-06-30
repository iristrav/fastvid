/** Visual Matching Engine V2 — own-archive asset embedding storage (stage 3).
 *  Infrastructure only: lets a (future) backfill job or per-upload hook store and read
 *  embeddings for media_archive_assets rows. No backfill is triggered by this stage —
 *  the media_archive_asset_embeddings table stays empty until something explicitly calls
 *  storeAssetEmbedding(). Every embedding carries provider/model/embeddingVersion so old
 *  and new embeddings (e.g. across a model switch) coexist side by side. */

import {
  createMediaArchiveAssetEmbedding,
  getMediaArchiveAssetEmbedding,
  listMediaArchiveAssetIdsWithEmbedding,
} from "../../db";

export async function getAssetEmbedding(
  assetId: number,
  model: string,
  embeddingVersion: string
): Promise<number[] | undefined> {
  const row = await getMediaArchiveAssetEmbedding(assetId, model, embeddingVersion);
  return row?.embedding;
}

export async function storeAssetEmbedding(
  assetId: number,
  provider: string,
  model: string,
  embeddingVersion: string,
  embedding: number[]
): Promise<void> {
  await createMediaArchiveAssetEmbedding({ assetId, provider, model, embeddingVersion, embedding });
}

/** Asset ids that already have a current (provider, model, embeddingVersion) embedding —
 *  the backfill uses this to skip already-embedded assets instead of re-embedding the
 *  whole archive on every run. */
export async function getAssetIdsWithCurrentEmbedding(
  provider: string,
  model: string,
  embeddingVersion: string
): Promise<Set<number>> {
  return listMediaArchiveAssetIdsWithEmbedding(provider, model, embeddingVersion);
}
