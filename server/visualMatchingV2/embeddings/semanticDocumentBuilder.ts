/** Visual Matching Engine V2 — Semantic Document Builder (Priority 1).
 *  Sole responsibility: turn a media_archive_assets row, or a VisualIntent, into the plain
 *  text string that gets embedded. Keeping this in one place means the asset side (backfill)
 *  and the query side (semanticOwnArchiveAdapter) always build documents the same way —
 *  embedding a row with one document shape and querying with a differently-shaped one would
 *  silently degrade retrieval quality.
 *
 *  When an asset has annotationJson, the enriched document is used automatically —
 *  this produces significantly better embeddings for historical/archival content. */

import type { MediaArchiveAsset } from "../../../drizzle/schema";
import { buildEnrichedSemanticDocument } from "../../clipAnnotator";
import type { VisualIntent } from "../types";

/** Builds the text document embedded for one archive asset at backfill time.
 *  Uses annotation data when available for richer embeddings. */
export function buildAssetSemanticDocument(asset: MediaArchiveAsset): string {
  if (asset.annotationJson) {
    return buildEnrichedSemanticDocument(asset, asset.annotationJson);
  }
  const parts: string[] = [];
  if (asset.title) parts.push(asset.title);
  if (asset.tags?.length) parts.push(asset.tags.join(", "));
  if (asset.sourceNote) parts.push(asset.sourceNote);
  parts.push(asset.mediaType === "video" ? "video footage" : "photo image");
  if (asset.mixKind) parts.push(asset.mixKind.replace(/_/g, " "));
  return parts.filter(Boolean).join(". ");
}

/** Builds the text document embedded for one beat's query at retrieval time. Mirrors the
 *  same plain-text style as buildAssetSemanticDocument so both sides land in the same
 *  embedding space as closely as possible. */
export function buildIntentSemanticDocument(intent: VisualIntent): string {
  const parts: string[] = [
    intent.visualDescription,
    intent.primaryKeyword,
    intent.secondaryKeyword,
    intent.visualSubject,
    intent.visualAction,
    intent.emotion,
    intent.historicalContext,
  ];
  return parts.filter(Boolean).join(". ");
}
