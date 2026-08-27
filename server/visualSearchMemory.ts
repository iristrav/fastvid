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

// ─── RONDE 86: bounded, batched persistence ──────────────────────────────────
//
// recordVisualSearchMemory above is one round trip per call, and both writers below used to fire
// it as `void recordVisualSearchMemory(...)` in a loop. Render 536 recorded 248 dead ends that
// way: 248 un-awaited inserts released into the event loop at once, against a mysql2 pool with
// connectionLimit = MAX_CONCURRENT_JOBS + 10 and queueLimit = 100. It logged 113 "Queue limit
// reached" errors, and that was ONE render — a second concurrent render doubles the burst while
// the pool stays the same size.
//
// Nothing about what is remembered changes here. The same rows are written with the same upsert
// semantics; they are just de-duplicated in memory first, batched into multi-row statements, and
// drained through a small fixed number of connections instead of all at once.

/** How many upserts may be in flight against the pool at any moment, across all renders. */
function searchMemoryConcurrency(): number {
  const raw = process.env.SEARCH_MEMORY_DB_CONCURRENCY?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 16) return n;
  }
  return 2;
}

/** Rows per multi-row INSERT … ON DUPLICATE KEY UPDATE. */
function searchMemoryBatchSize(): number {
  const raw = process.env.SEARCH_MEMORY_BATCH_SIZE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 500) return n;
  }
  return 50;
}

/**
 * Ceiling on the pending queue.
 *
 * A backlog this long already means the DB is not keeping up, and holding more of it in memory
 * helps nobody — search memory is an optimisation, and dropping the tail of a burst costs one
 * render a few dead-end hints while an unbounded queue costs the process its heap.
 */
const SEARCH_MEMORY_QUEUE_MAX = 5_000;

type PendingWrite = RecordVisualSearchMemoryInput & { hash: string };

const pendingWrites: PendingWrite[] = [];
/** dedupeKeyHash values already queued or written this process — the in-memory dedup. */
const queuedHashes = new Set<string>();
let draining: Promise<void> | null = null;
let droppedForBackpressure = 0;

/** Test/shutdown hook — resolves once everything queued so far has been written. */
export async function flushVisualSearchMemory(): Promise<void> {
  await (draining ?? Promise.resolve());
  // A drain started while the previous one was finishing has its own promise.
  if (pendingWrites.length > 0) await (draining ?? Promise.resolve());
}

/** Test hook — forgets the dedup set and any queued work. Never called by the pipeline. */
export function resetVisualSearchMemoryQueue(): void {
  pendingWrites.length = 0;
  queuedHashes.clear();
  droppedForBackpressure = 0;
}

/** How many writes are waiting, and how many were dropped because the queue was full. */
export function visualSearchMemoryQueueStats(): { pending: number; dropped: number; deduped: number } {
  return { pending: pendingWrites.length, dropped: droppedForBackpressure, deduped: queuedHashes.size };
}

/**
 * Queues one memory row instead of writing it immediately.
 *
 * Returns true when the row was accepted (it is new and there was room), false when it was a
 * duplicate of something already queued or the queue was full. Never throws and never awaits the
 * database — the caller is on the render's hot path.
 */
export function enqueueVisualSearchMemory(input: RecordVisualSearchMemoryInput): boolean {
  const entity = canonicalEntityKey(input.entity ?? "");
  const query = (input.query ?? "").trim().slice(0, 512);
  const source = (input.source ?? "").trim().slice(0, 64);
  if (!entity || !query || !source) return false;
  const hash = dedupeKeyHash(entity, source, query);
  // The same (entity, source, query) collapses into one row in the database regardless, so
  // sending it twice is pure pool pressure for no additional information. Render 536's 248 dead
  // ends contained repeats across scenes for exactly this reason.
  if (queuedHashes.has(hash)) return false;
  if (pendingWrites.length >= SEARCH_MEMORY_QUEUE_MAX) {
    droppedForBackpressure += 1;
    return false;
  }
  queuedHashes.add(hash);
  pendingWrites.push({ ...input, entity, query, source, hash });
  startDrain();
  return true;
}

function startDrain(): void {
  if (draining) return;
  draining = drainSearchMemoryQueue().finally(() => {
    draining = null;
    // Anything queued while the last batch was in flight gets its own pass.
    if (pendingWrites.length > 0) startDrain();
  });
}

async function drainSearchMemoryQueue(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) {
      // No database in this environment (tests, local runs without DATABASE_URL). Drop the queue
      // rather than growing it forever waiting for a connection that is never coming.
      pendingWrites.length = 0;
      return;
    }
    const concurrency = searchMemoryConcurrency();
    const batchSize = searchMemoryBatchSize();
    while (pendingWrites.length > 0) {
      const wave: Array<Promise<void>> = [];
      for (let i = 0; i < concurrency && pendingWrites.length > 0; i++) {
        const batch = pendingWrites.splice(0, batchSize);
        wave.push(writeSearchMemoryBatch(db, batch));
      }
      // Bounded by construction: at most `concurrency` statements are outstanding, so the pool
      // never sees more than that from this module no matter how many renders are running.
      await Promise.all(wave);
    }
  } catch (err) {
    console.warn("[SearchMemory] drain failed:", (err as Error).message?.slice(0, 120));
  }
}

type SearchMemoryDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function writeSearchMemoryBatch(db: SearchMemoryDb, batch: PendingWrite[]): Promise<void> {
  if (batch.length === 0) return;
  // Rows whose upsert has extra per-row fields (a success verdict, an asset id, a score) cannot
  // share one statement's SET clause, so they go one at a time — there are only ever a handful of
  // those. The dead-end rows, which are the burst, all share the same SET and batch cleanly.
  const plain = batch.filter((r) => !r.success && r.assetId == null && r.qualityScore == null);
  const individual = batch.filter((r) => !plain.includes(r));
  try {
    if (plain.length > 0) {
      await db
        .insert(visualSearchMemory)
        .values(
          plain.map((r) => ({
            entity: r.entity,
            entityType: r.entityType,
            topic: r.topic?.trim().slice(0, 256) || undefined,
            query: r.query,
            source: r.source,
            sourceUrl: r.sourceUrl,
            success: 0,
            usageCount: 1,
            dedupeKeyHash: r.hash,
          }))
        )
        .onDuplicateKeyUpdate({
          set: {
            usageCount: sql`${visualSearchMemory.usageCount} + 1`,
            lastUsedAt: new Date(),
            // Deliberately no `success` here: a miss must never downgrade a proven-working
            // combination, which is the same rule recordVisualSearchMemory has always applied.
          },
        });
    }
  } catch (err) {
    console.warn("[SearchMemory] batch insert failed:", (err as Error).message?.slice(0, 120));
  }
  for (const row of individual) {
    await recordVisualSearchMemory(row);
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
  // RONDE 86: queued rather than fired. Same row, same upsert — it now shares the module's
  // bounded writer with the dead-end burst instead of racing it for pool connections.
  enqueueVisualSearchMemory({
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
  /**
   * RONDE 100B — provider → candidates the provider actually returned this render.
   *
   * A query that came back with results is not a dead end, whatever happened afterwards. The
   * production render made the distinction unavoidable: Internet Archive ran 13 searches and
   * returned 311 candidates, then every download was cancelled by the enclosing scene budget, so
   * it adopted nothing — and all 13 queries were written down as "this source has nothing".
   * Twenty-two of twenty-two sources were condemned that way in one render, none of them for
   * anything they did wrong. The next render on the same subject then starts with them disabled.
   *
   * Attribution stays per-provider because that is the granularity the metrics have. It is the
   * conservative direction, and the same one this function already chose elsewhere: recording a
   * working query as dead costs far more than recording nothing.
   */
  resultsByProvider?: Map<string, number>;
  /** provider → true when at least one of its calls was cancelled by an enclosing budget. */
  budgetCancelledProviders?: ReadonlySet<string>;
}): void {
  const subject = input.subject?.trim();
  if (!subject) return;
  let misses = 0;
  let queued = 0;
  let spared = 0;
  for (const key of input.searchedKeys) {
    const sep = key.indexOf("|");
    if (sep <= 0) continue;
    const source = key.slice(0, sep).trim().toLowerCase();
    const query = key.slice(sep + 1).trim();
    if (!source || !query) continue;
    if ((input.adoptedByProvider.get(source) ?? 0) > 0) continue;
    // The provider answered, or FastVid cut it off. Neither is evidence about the query.
    if ((input.resultsByProvider?.get(source) ?? 0) > 0) { spared++; continue; }
    if (input.budgetCancelledProviders?.has(source)) { spared++; continue; }
    misses++;
    // RONDE 86: this loop is the burst. It used to release one un-awaited insert per iteration —
    // 248 of them on render 536, against a pool whose queueLimit is 100, which is where that
    // render's 113 "Queue limit reached" errors came from. The rows are identical; only the way
    // they reach the database changed.
    if (enqueueVisualSearchMemory({
      entity: subject,
      entityType: input.subjectType,
      query,
      source,
      success: false,
    })) {
      queued++;
    }
  }
  if (misses > 0 || spared > 0) {
    const stats = visualSearchMemoryQueueStats();
    console.log(
      `[SearchMemory] "${canonicalEntityKey(subject)}": recorded ${queued} of ${misses} dead end(s) — ` +
        `sources that returned nothing usable this render` +
        (queued < misses ? ` (${misses - queued} already known this process)` : "") +
        (spared > 0 ? ` [${spared} spared: answered or cancelled by budget]` : "") +
        (stats.dropped > 0 ? ` [${stats.dropped} dropped for backpressure]` : "")
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
export async function getSearchMemoryDeadEnds(entity: string, limit = 200): Promise<Set<string>> {
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

/** How many distinct sources must have failed on a query before the QUERY is blamed. */
const DEAD_QUERY_MIN_SOURCES = 2;

/**
 * Queries that came up empty on SEVERAL DIFFERENT sources for this entity.
 *
 * The distinction matters. A dead end is recorded per (source, query), and one source failing
 * says something about that source — Pexels has no Führerbunker footage and never will, but
 * Wikimedia might. When the SAME query fails across two or more independent sources, the query
 * itself is the problem, and that is a conclusion worth carrying to the next render.
 *
 * Used to REORDER, never to remove: a query demoted here is still run if the earlier ones do not
 * fill the beat. Dropping it outright would let two unlucky renders permanently blind a subject.
 */
export async function getDeadEndQueries(
  entity: string,
  minSources = DEAD_QUERY_MIN_SOURCES
): Promise<Set<string>> {
  const deadEnds = await getSearchMemoryDeadEnds(entity);
  const sourcesPerQuery = new Map<string, Set<string>>();
  for (const key of deadEnds) {
    const sep = key.indexOf("|");
    if (sep <= 0) continue;
    const source = key.slice(0, sep);
    const query = key.slice(sep + 1);
    if (!query) continue;
    (sourcesPerQuery.get(query) ?? sourcesPerQuery.set(query, new Set()).get(query)!).add(source);
  }
  const dead = new Set<string>();
  for (const [query, sources] of sourcesPerQuery) {
    if (sources.size >= minSources) dead.add(query);
  }
  return dead;
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
