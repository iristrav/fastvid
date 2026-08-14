/**
 * F3-26: visual search memory — the "learning loop" for web-wide visual sourcing.
 *
 * Remembers which (entity, query, source) combinations previously found usable footage, so a
 * future beat about the same entity/topic can prefer a proven query+source instead of
 * rediscovering it from scratch. This does not decide *whether* to search the web — it only
 * remembers what worked, for callers (curatedMediaSourcing.ts / videoPipeline.ts web-sourcing
 * call sites) to consult before building a new query.
 *
 * Entity classification reuses semanticVisualMatching.ts's existing per-beat entity extraction
 * (SemanticEntityList) — no new LLM call.
 */

import { createHash } from "crypto";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { visualSearchMemory, type VisualSearchMemoryRow } from "../drizzle/schema";
import type { SemanticEntityList } from "./semanticVisualMatching";

export type VisualEntityType = "person" | "organization" | "place" | "event" | "topic";

export type ClassifiedEntity = {
  type: VisualEntityType;
  value: string;
};

/**
 * Maps the entities semanticVisualMatching.ts already extracts per beat onto the
 * person/organization/place/event/topic categories F3-26 asks for. Zero new LLM calls — this is
 * a pure remap of fields analyzeBeatSemantics() already populates.
 */
export function classifyBeatEntities(entities: SemanticEntityList, topicDomain?: string): ClassifiedEntity[] {
  const out: ClassifiedEntity[] = [];
  const seen = new Set<string>();
  const push = (type: VisualEntityType, value: string) => {
    const v = value.trim();
    if (!v) return;
    const key = `${type}:${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, value: v });
  };
  for (const p of entities.persons ?? []) push("person", p);
  for (const c of entities.companies ?? []) push("organization", c);
  for (const l of entities.locations ?? []) push("place", l);
  for (const e of entities.events ?? []) push("event", e);
  if (out.length === 0 && topicDomain?.trim()) push("topic", topicDomain);
  return out;
}

function dedupeKeyHash(entity: string, source: string, query: string): string {
  const norm = (s: string) => s.trim().toLowerCase();
  return createHash("sha256").update(`${norm(entity)}|${norm(source)}|${norm(query)}`).digest("hex");
}

export type RecordVisualSearchMemoryInput = {
  entity: string;
  entityType: VisualEntityType;
  topic?: string;
  query: string;
  source: string;
  sourceUrl?: string;
  assetId?: number;
  success: boolean;
  qualityScore?: number;
};

/**
 * Records (or reinforces) that this entity/query/source combination was tried. Best-effort —
 * never throws, never blocks the pipeline. Repeated hits for the same (entity, source, query)
 * increment usageCount and bump lastUsedAt instead of inserting a duplicate row.
 */
export async function recordVisualSearchMemory(input: RecordVisualSearchMemoryInput): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const entity = input.entity.trim().slice(0, 256);
    const query = input.query.trim().slice(0, 512);
    const source = input.source.trim().slice(0, 64);
    if (!entity || !query || !source) return;
    const hash = dedupeKeyHash(entity, source, query);
    await db
      .insert(visualSearchMemory)
      .values({
        entity,
        entityType: input.entityType,
        topic: input.topic?.trim().slice(0, 256) || undefined,
        query,
        source,
        sourceUrl: input.sourceUrl,
        assetId: input.assetId,
        success: input.success ? 1 : 0,
        qualityScore: input.qualityScore,
        usageCount: 1,
        dedupeKeyHash: hash,
      })
      .onDuplicateKeyUpdate({
        set: {
          usageCount: sql`${visualSearchMemory.usageCount} + 1`,
          lastUsedAt: new Date(),
          // A later success should be reflected even if the first attempt failed (and vice versa
          // is intentionally NOT done — never downgrade a proven-working combination just
          // because one later attempt happened to fail).
          ...(input.success ? { success: 1 } : {}),
          ...(input.assetId ? { assetId: input.assetId } : {}),
          ...(input.qualityScore != null ? { qualityScore: input.qualityScore } : {}),
        },
      });
  } catch (err) {
    console.warn("[VisualSearchMemory] record failed:", (err as Error).message?.slice(0, 120));
  }
}

/**
 * Prior successful queries/sources for this entity, most-used first — so a future beat about
 * the same entity can try a proven query+source before inventing a new one.
 */
export async function getVisualSearchMemoryForEntity(entity: string, limit = 10): Promise<VisualSearchMemoryRow[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const normalized = entity.trim();
    if (!normalized) return [];
    return await db
      .select()
      .from(visualSearchMemory)
      .where(eq(visualSearchMemory.entity, normalized))
      .orderBy(desc(visualSearchMemory.usageCount), desc(visualSearchMemory.lastUsedAt))
      .limit(limit);
  } catch (err) {
    console.warn("[VisualSearchMemory] lookup failed:", (err as Error).message?.slice(0, 120));
    return [];
  }
}
