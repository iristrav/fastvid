/**
 * Durable store for beat-image relevance verdicts.
 *
 * RONDE 104 — a verdict outlives the render that paid for it.
 *
 * The gate's memory (`BeatImageGateState.seen`) is render-scoped, and that is deliberate: two
 * concurrent renders must not read each other's verdicts or spend each other's budget. But it
 * also means the SAME question gets asked again from scratch every time — a re-render of the same
 * script, a retry after a failed export, a second video that quotes the same beat and reaches for
 * the same archive asset. Each of those pays the vision model again for an answer it already has.
 *
 * That matters more after RONDE 103 than it did before. CLIP no longer refuses anything, so many
 * more candidates reach the model, and the render-wide ceiling
 * (MAX_BEAT_IMAGE_JUDGEMENTS, default 60) is the thing that runs out. Every judgement served from
 * the database is one the render does not have to spend on a question it has answered before.
 *
 * This is the same storage contract RONDE 4 used for the text embedding index and RONDE 99 for
 * the CLIP index, for the same reason: the render worker runs with multiple replicas, Railway
 * does not allow volumes on multi-replica services, and MySQL is the only shared disk there is.
 *
 * ── What is and is not cached ────────────────────────────────────────────────────────────────
 *
 * The key is `contentKey|beatIdentity` — the exact pair RONDE 103 established as the unit a
 * verdict belongs to. beatIdentity is a hash of everything the prompt is built from, so a hit
 * means the model would be shown the same picture and asked the same question. Nothing else is
 * safe to reuse, and nothing less is worth storing.
 *
 * `unknown` is NEVER stored. It is not an answer — it means the gate could not get one (an
 * outage, a spent budget, an unreadable frame). Persisting it would turn a five-minute provider
 * hiccup into a permanent "we looked and learned nothing" for that pair, and the next render
 * would inherit the silence instead of asking again.
 *
 * ── Degrading ────────────────────────────────────────────────────────────────────────────────
 *
 * No database (local dev, tests, a misconfigured deploy) means every function here is a no-op and
 * the gate behaves exactly as it did before this file existed. A store that cannot answer must
 * never be able to change a verdict.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export type StoredVerdict = {
  /** `contentKey|beatIdentity` — see beatVisualRelevance.beatIdentityKey. */
  key: string;
  verdict: "fits" | "does_not_fit";
  depicts: string;
  reason: string;
};

/**
 * How long a stored verdict is trusted.
 *
 * A verdict is about a picture and a sentence, neither of which changes — so in principle it
 * never expires. In practice the model behind it does: a better model gives better answers, and
 * a cache with no horizon would keep serving the old one indefinitely. Ninety days is long enough
 * that a re-render costs nothing and short enough that a model upgrade reaches the whole archive
 * within a quarter.
 */
const VERDICT_TTL_DAYS = 90;

/** Bounded in-process read cache, so a beat that asks twice does not hit MySQL twice. */
const CACHE_MAX_ENTRIES = 5000;
const cache = new Map<string, StoredVerdict | null>();

let tableEnsured = false;
let tableUnavailable = false;

export function verdictStoreDisabled(): boolean {
  return process.env.BEAT_VERDICT_STORE_DISABLED === "1";
}

async function ensureTable(): Promise<boolean> {
  if (verdictStoreDisabled() || tableUnavailable) return false;
  const db = await getDb();
  if (!db) return false;
  if (tableEnsured) return true;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fastvid_beat_relevance_verdicts (
        verdict_key VARCHAR(191) PRIMARY KEY,
        verdict VARCHAR(16) NOT NULL,
        depicts VARCHAR(512),
        reason VARCHAR(512),
        model VARCHAR(64),
        hits INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    tableEnsured = true;
    return true;
  } catch (err) {
    tableUnavailable = true;
    console.warn("[VerdictStore] table unavailable:", (err as Error).message?.slice(0, 120));
    return false;
  }
}

/** Synchronous read from the in-process cache. Null means "not cached", not "no verdict". */
export function cachedVerdict(key: string): StoredVerdict | null | undefined {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key)!;
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function remember(key: string, v: StoredVerdict | null): void {
  cache.delete(key);
  cache.set(key, v);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Look one verdict up. Returns null when the store has no answer — which is the same thing the
 * caller does when there is no database at all, so a missing store is indistinguishable from a
 * cache miss and can never change a decision.
 */
export async function lookupVerdict(key: string): Promise<StoredVerdict | null> {
  const hit = cachedVerdict(key);
  if (hit !== undefined) return hit;
  if (!(await ensureTable())) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = (await db.execute(sql`
      SELECT verdict_key AS verdictKey, verdict, depicts, reason
      FROM fastvid_beat_relevance_verdicts
      WHERE verdict_key = ${key}
        AND updated_at > DATE_SUB(NOW(), INTERVAL ${VERDICT_TTL_DAYS} DAY)
      LIMIT 1
    `)) as unknown as Array<Array<Record<string, unknown>>>;
    const row = rows?.[0]?.[0];
    if (!row) {
      remember(key, null);
      return null;
    }
    const stored: StoredVerdict = {
      key,
      verdict: String(row.verdict) === "does_not_fit" ? "does_not_fit" : "fits",
      depicts: String(row.depicts ?? ""),
      reason: String(row.reason ?? ""),
    };
    remember(key, stored);
    return stored;
  } catch (err) {
    console.warn("[VerdictStore] lookup failed:", (err as Error).message?.slice(0, 120));
    return null;
  }
}

/**
 * Store one verdict. Only a real answer is stored — see the note on `unknown` at the top.
 *
 * Best-effort by design: a write that fails is logged and forgotten. The render already has its
 * answer; failing to persist it costs a future render one call, and must never cost this one
 * anything.
 */
export async function persistVerdict(
  key: string,
  verdict: "fits" | "does_not_fit",
  depicts: string,
  reason: string,
  model?: string
): Promise<boolean> {
  remember(key, { key, verdict, depicts, reason });
  if (!(await ensureTable())) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    await db.execute(sql`
      INSERT INTO fastvid_beat_relevance_verdicts
        (verdict_key, verdict, depicts, reason, model, hits)
      VALUES (${key}, ${verdict}, ${depicts.slice(0, 500)}, ${reason.slice(0, 500)}, ${model ?? ""}, 0)
      ON DUPLICATE KEY UPDATE
        verdict = VALUES(verdict),
        depicts = VALUES(depicts),
        reason = VALUES(reason),
        model = VALUES(model),
        hits = hits + 1
    `);
    return true;
  } catch (err) {
    console.warn("[VerdictStore] persist failed:", (err as Error).message?.slice(0, 120));
    return false;
  }
}

/** Test seam — drops the in-process cache and the table-probe state. */
export function __resetVerdictStoreForTests(): void {
  cache.clear();
  tableEnsured = false;
  tableUnavailable = false;
}
