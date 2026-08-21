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
import { and, desc, eq, sql } from "drizzle-orm";
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

/**
 * RONDE 28: the one spelling an entity is stored and looked up under.
 *
 * dedupeKeyHash has always lowercased, so two spellings of the same name collapsed into one ROW —
 * but getVisualSearchMemoryForEntity matched on the raw column, so "Adolf Hitler" could not find
 * a row written as "adolf hitler". Write and read now agree. The handful of rows written before
 * this are effectively invisible to lookups until they are hit again, which is acceptable at the
 * volume involved (render 528 wrote seven).
 */
export function canonicalEntityKey(entity: string): string {
  return entity.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 256);
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
    const entity = canonicalEntityKey(input.entity);
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

/** Provider name out of a contentKey like "internet_archive:white-lives-matter-montana". */
export function providerFromContentKey(contentKey: string): string {
  const head = contentKey.split(":")[0]?.trim().toLowerCase() ?? "";
  // "stock", "still", "curated" and "file" are content FAMILIES, not places you can search again.
  return head && !["stock", "still", "curated", "file", "unknown", ""].includes(head) ? head : "";
}

export type AdoptedClipSource = {
  /** The video's subject — the person it is about, or its title when there is no person. */
  subject: string;
  subjectType: VisualEntityType;
  /** The query that actually produced this clip. Not the clip's title. */
  query: string;
  /** contentKey, e.g. "wikimedia:File_Foo.jpg" — the provider is taken from the head. */
  contentKey: string;
  /** Vision-gate score out of 10, when the gate produced one. */
  score10?: number | null;
};

/**
 * RONDE 28: remember every clip that WON a beat, not only the few that reach the archive.
 *
 * Before this, the only writer was archiveIngestion — so a source was remembered only if the clip
 * also happened to be archive-eligible and survived ingestion. Render 528 put 18 clips in the
 * finished video and made 10 ingestion attempts, of which 2 were admitted. The other 16 winners
 * taught the system nothing: which provider and which query found them was thrown away the moment
 * the render ended, and the next video on the same subject started from zero all over again.
 *
 * Fire-and-forget by design. This runs at the adopt-clip acceptance point, inside the dedup lock,
 * on the hot path — it must never be able to slow a render down or fail one.
 */
export function recordAdoptedClipSource(input: AdoptedClipSource): void {
  const source = providerFromContentKey(input.contentKey);
  const subject = input.subject?.trim();
  const query = input.query?.trim();
  // No provider means a locally-produced clip (a still we rendered, an AI frame). There is no
  // "where to look next time" to record, so silence is the honest answer.
  if (!source || !subject || !query) return;
  void recordVisualSearchMemory({
    entity: subject,
    entityType: input.subjectType,
    query,
    source,
    success: true,
    qualityScore:
      input.score10 != null && isFinite(input.score10)
        ? Math.max(0, Math.min(100, Math.round(input.score10 * 10)))
        : undefined,
  });
}

/**
 * RONDE 28b: remember where looking produced NOTHING, so a later render can stop looking there.
 *
 * Knowing a dead end is half the value of this memory. Every render re-searched Pexels and Pixabay
 * for "hitler" and got nothing usable, every time, because nothing recorded that it had already
 * been tried and had already failed.
 *
 * Attribution is deliberately conservative. Misses are recorded only for providers that adopted
 * ZERO clips this render — for those, no query of theirs produced a winner, which is a fact. For a
 * provider that did contribute, some of its queries still missed, but the metrics cannot say
 * which, so those are left alone rather than guessed at. Recording a working query as dead would
 * be far more damaging than recording nothing.
 *
 * recordVisualSearchMemory never downgrades an existing success, so a miss can only ever ADD a
 * dead end — it cannot erase a proven one.
 */
export function recordSearchMisses(input: {
  subject: string;
  subjectType: VisualEntityType;
  /** `${provider}|${query}` — the sourcing cache's own key for "we ran this search". */
  searchedKeys: Iterable<string>;
  /** provider → clips adopted from it this render. */
  adoptedByProvider: Map<string, number>;
}): void {
  const subject = input.subject?.trim();
  if (!subject) return;
  let misses = 0;
  for (const key of input.searchedKeys) {
    const sep = key.indexOf("|");
    if (sep <= 0) continue;
    const source = key.slice(0, sep).trim().toLowerCase();
    const query = key.slice(sep + 1).trim();
    if (!source || !query) continue;
    if ((input.adoptedByProvider.get(source) ?? 0) > 0) continue;
    misses++;
    void recordVisualSearchMemory({
      entity: subject,
      entityType: input.subjectType,
      query,
      source,
      success: false,
    });
  }
  if (misses > 0) {
    console.log(
      `[SearchMemory] "${canonicalEntityKey(subject)}": recorded ${misses} dead end(s) — ` +
        `sources that returned nothing usable this render`
    );
  }
}

/**
 * Sources that have already been tried for this entity and produced nothing usable.
 *
 * Returned as a Set of `${source}|${query}` so a caller can drop or deprioritise a query it
 * already knows is a dead end. Kept separate from the proven list rather than merged into it:
 * these two answer different questions and mixing them invites using one as the other.
 */
export async function getSearchMemoryDeadEnds(entity: string, limit = 50): Promise<Set<string>> {
  try {
    const db = await getDb();
    if (!db) return new Set();
    const normalized = canonicalEntityKey(entity);
    if (!normalized) return new Set();
    const rows = await db
      .select()
      .from(visualSearchMemory)
      .where(and(eq(visualSearchMemory.entity, normalized), eq(visualSearchMemory.success, 0)))
      .orderBy(desc(visualSearchMemory.usageCount), desc(visualSearchMemory.lastUsedAt))
      .limit(limit);
    return new Set(rows.map((r) => `${r.source}|${r.query}`));
  } catch (err) {
    console.warn("[SearchMemory] dead-end lookup failed:", (err as Error).message?.slice(0, 120));
    return new Set();
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
    const normalized = canonicalEntityKey(entity);
    if (!normalized) return [];
    const rows = await db
      .select()
      .from(visualSearchMemory)
      .where(and(eq(visualSearchMemory.entity, normalized), eq(visualSearchMemory.success, 1)))
      .orderBy(desc(visualSearchMemory.usageCount), desc(visualSearchMemory.lastUsedAt))
      .limit(limit);
    if (rows.length > 0) {
      // Without this you cannot tell a working memory from an empty table — render 528's log has
      // not one line about search memory, which is exactly why its emptiness went unnoticed.
      console.log(
        `[SearchMemory] "${normalized}": ${rows.length} proven source(s) — ` +
          rows.slice(0, 3).map((r) => `${r.source}("${r.query.slice(0, 40)}")×${r.usageCount}`).join(", ")
      );
    }
    return rows;
  } catch (err) {
    console.warn("[VisualSearchMemory] lookup failed:", (err as Error).message?.slice(0, 120));
    return [];
  }
}
