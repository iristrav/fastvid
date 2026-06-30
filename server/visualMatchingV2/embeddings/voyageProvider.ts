/** Visual Matching Engine V2 — Voyage AI embedding provider (stage 3 default).
 *  Chosen as the default text-embedding provider over OpenAI: Voyage's models
 *  (voyage-3 family) consistently lead retrieval-quality benchmarks (MTEB retrieval,
 *  BEIR) for RAG/semantic-search use cases like this one, at comparable or lower cost
 *  per token than OpenAI's text-embedding-3 models. Swapping to a different provider
 *  later means writing one more class implementing EmbeddingProvider — nothing else in
 *  the embedding layer changes (see embeddings/types.ts). */

import { logEmbedding } from "../logging";
import type { EmbeddingProvider } from "./types";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3-large";
/** Voyage accepts up to 128 inputs per batch call; stay comfortably under that. */
const BATCH_CHUNK_SIZE = 100;

type VoyageEmbeddingResponse = {
  data?: Array<{ embedding: number[]; index?: number }>;
};

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  private apiKey: string | undefined;

  constructor(modelId: string = DEFAULT_MODEL, dimensions: number = 1024) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    this.apiKey = process.env.VOYAGE_API_KEY?.trim();
  }

  async embedText(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("VoyageEmbeddingProvider: VOYAGE_API_KEY is not set");
    }
    const start = Date.now();
    const resp = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [text],
        model: this.modelId,
        input_type: "document",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`VoyageEmbeddingProvider: request failed (${resp.status}): ${body.slice(0, 256)}`);
    }
    const data = (await resp.json()) as VoyageEmbeddingResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("VoyageEmbeddingProvider: response contained no embedding");
    }
    logEmbedding("generated", { provider: this.modelId, durationMs: Date.now() - start, dimensions: embedding.length });
    return embedding;
  }

  /** Embeds many texts using Voyage's batch endpoint, chunked to BATCH_CHUNK_SIZE inputs per
   *  call (e.g. 100 assets -> 1 batch call; 1,000 assets -> 10 batch calls), instead of one
   *  HTTP round-trip per asset. Order of the returned array matches `texts`. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("VoyageEmbeddingProvider: VOYAGE_API_KEY is not set");
    }
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);
    for (let offset = 0; offset < texts.length; offset += BATCH_CHUNK_SIZE) {
      const chunk = texts.slice(offset, offset + BATCH_CHUNK_SIZE);
      const start = Date.now();
      const resp = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: chunk,
          model: this.modelId,
          input_type: "document",
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`VoyageEmbeddingProvider: batch request failed (${resp.status}): ${body.slice(0, 256)}`);
      }
      const data = (await resp.json()) as VoyageEmbeddingResponse;
      const entries = data.data ?? [];
      if (entries.length !== chunk.length) {
        throw new Error(
          `VoyageEmbeddingProvider: batch response size mismatch (expected ${chunk.length}, got ${entries.length})`
        );
      }
      for (let i = 0; i < entries.length; i++) {
        const idx = entries[i].index ?? i;
        results[offset + idx] = entries[i].embedding;
      }
      logEmbedding("generated", {
        provider: this.modelId,
        batch: true,
        batchSize: chunk.length,
        durationMs: Date.now() - start,
      });
    }
    return results;
  }

  // embedImage intentionally not implemented — image embeddings are out of scope for stage 3.
}
