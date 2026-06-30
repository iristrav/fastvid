/** Visual Matching Engine V2 — own-archive asset embedding storage (stage 3).
 *  Infrastructure only: lets a (future) backfill job or per-upload hook store and read
 *  embeddings for media_archive_assets rows. No backfill is triggered by this stage —
 *  the media_archive_asset_embeddings table stays empty until something explicitly calls
 *  storeAssetEmbedding(). */

import { createMediaArchiveAssetEmbedding, getMediaArchiveAssetEmbedding } from "../../db";

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
  model: string,
  embeddingVersion: string,
  embedding: number[]
): Promise<void> {
  await createMediaArchiveAssetEmbedding({ assetId, model, embeddingVersion, embedding });
}
