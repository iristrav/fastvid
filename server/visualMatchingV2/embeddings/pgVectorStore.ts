/** Visual Matching Engine V2 — PgVector-backed VectorStore implementation (stage 3).
 *
 *  Architecture note: this project's primary database is MySQL (see server/db.ts) — there
 *  is no Postgres instance in the active stack today. PgVector requires Postgres + the
 *  `vector` extension, so this implementation talks to a *separate*, independently
 *  configured Postgres connection (POSTGRES_VECTOR_URL), entirely decoupled from the
 *  MySQL `getDb()` used everywhere else. It is inert until that env var is set AND a
 *  caller actually invokes it — neither happens yet (no caller exists outside this
 *  module's own export, and the active pipeline never reaches it). All vector queries
 *  run exclusively through the VectorStore interface (types.ts); the Embedding Search
 *  Engine never imports `pg` or pgvector syntax directly, so swapping this for e.g.
 *  Pinecone/Qdrant/pgvector-on-a-different-host later is a one-file change. */

import type { Pool } from "pg";
import type { VectorSearchHit, VectorStore } from "./types";

let pool: Pool | null = null;

async function getPool(): Promise<Pool | null> {
  if (pool) return pool;
  const url = process.env.POSTGRES_VECTOR_URL?.trim();
  if (!url) return null;
  const { Pool: PgPool } = await import("pg");
  pool = new PgPool({ connectionString: url });
  return pool;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export class PgVectorStore implements VectorStore {
  constructor(private tableName: string = "visual_matching_v2_vectors") {}

  /** Creates the backing table + pgvector extension if missing. Safe to call repeatedly;
   *  no-ops if POSTGRES_VECTOR_URL isn't configured. Not called automatically by stage 3 —
   *  callers run it explicitly once a Postgres instance is provisioned. */
  async ensureSchema(dimensions: number): Promise<void> {
    const db = await getPool();
    if (!db) return;
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        embedding vector(${dimensions}) NOT NULL,
        metadata JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    );
  }

  async upsert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    const db = await getPool();
    if (!db) throw new Error("PgVectorStore: POSTGRES_VECTOR_URL is not set");
    await db.query(
      `INSERT INTO ${this.tableName} (id, embedding, metadata, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now()`,
      [id, toVectorLiteral(vector), metadata ? JSON.stringify(metadata) : null]
    );
  }

  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchHit[]> {
    const db = await getPool();
    if (!db) throw new Error("PgVectorStore: POSTGRES_VECTOR_URL is not set");
    const filterClause = filter && Object.keys(filter).length > 0 ? "WHERE metadata @> $3" : "";
    const params: unknown[] = [toVectorLiteral(vector), topK];
    if (filterClause) params.push(JSON.stringify(filter));
    const result = await db.query(
      `SELECT id, metadata, 1 - (embedding <=> $1) AS similarity
       FROM ${this.tableName}
       ${filterClause}
       ORDER BY embedding <=> $1
       LIMIT $2`,
      params
    );
    return result.rows.map((row: { id: string; similarity: number; metadata: Record<string, unknown> | null }) => ({
      id: row.id,
      similarity: row.similarity,
      metadata: row.metadata ?? undefined,
    }));
  }

  async delete(id: string): Promise<void> {
    const db = await getPool();
    if (!db) throw new Error("PgVectorStore: POSTGRES_VECTOR_URL is not set");
    await db.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
  }
}
