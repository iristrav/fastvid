/**
 * ONE PRODUCTION RENDER PER VIDEO.
 *
 * ── What had no guard at all ────────────────────────────────────────────────────────────────
 *
 * `runVideoPipeline` has exactly one caller and nothing between the request and the twenty-one
 * minutes of work checked whether that video was already being rendered. Video 574's stored record
 * carried a report from `rmtspxhka-1` beside numbers from `rmtsu22cb-1` — two runs of the same
 * video, and two rounds of analysis reasoned about the difference between them before anyone
 * noticed they were different runs.
 *
 * ── Why this is a table and not a variable ──────────────────────────────────────────────────
 *
 * A module-level boolean protects one process against itself and nothing else. FastVid can run
 * more than one worker, a Railway deploy overlaps two instances, and a restart forgets. The only
 * arbiter two workers both accept is the database.
 *
 * ── Where the atomicity comes from, precisely ───────────────────────────────────────────────
 *
 * Not from this file. `render_locks.videoId` is UNIQUE and a row exists only while a lock is held,
 * so `acquire` is an INSERT the key either admits or refuses — the database decides the race, and
 * no ordering of reads in this module can change that. Taking over an expired lease is a
 * conditional UPDATE naming the expiry the caller saw, which exactly one racer can match.
 *
 * Release is `DELETE WHERE videoId AND productionRenderId`: a render that wakes past its own lease
 * cannot delete the lock its successor now holds.
 *
 * ── The store is injected, and that is not a hedge ──────────────────────────────────────────
 *
 * The two operations this needs — "insert unless the key is taken" and "update only if the row
 * still looks like this" — are the whole contract. Naming them lets the sequencing be tested
 * without a database, and lets the SQL be read on its own. What a test here CANNOT prove is that
 * MySQL enforces the key; that is a property of the schema, stated in the migration, and it is the
 * one claim this file makes without exercising it.
 */

/** Why an acquire did not produce a lock. */
export type RenderLockRefusal = "RENDER_ALREADY_RUNNING";

export type RenderLockHeld = {
  videoId: number;
  productionRenderId: string;
  expiresAt: Date;
  /** True when this lock was taken over from a lease nobody released. */
  recoveredStale: boolean;
};

export type RenderLockOutcome =
  | { acquired: true; lock: RenderLockHeld }
  | {
      acquired: false;
      reason: RenderLockRefusal;
      videoId: number;
      /** The render that holds it, so a refusal names its winner rather than just saying no. */
      existingRenderId: string;
      requestedRenderId: string;
      expiresAt: Date | null;
    };

/** One row of `render_locks`, in the shape this module reads. */
export type RenderLockRow = {
  videoId: number;
  productionRenderId: string;
  expiresAt: Date;
};

/**
 * The three database operations, named so the SQL can be read on its own.
 *
 * `insertIfAbsent` and `takeOverIfExpired` MUST be atomic against a concurrent caller — that is
 * the entire mechanism, and a store that satisfies the types without satisfying that is a lock
 * that does not lock. See `dbRenderLockStore` for the production implementation.
 */
export type RenderLockStore = {
  /** INSERT. `false` means the unique key refused it — somebody else holds the lock. */
  insertIfAbsent(row: RenderLockRow & { holderLabel?: string }): Promise<boolean>;
  /** The current holder, or null. Only ever used to REPORT a refusal, never to decide one. */
  read(videoId: number): Promise<RenderLockRow | null>;
  /**
   * UPDATE ... WHERE videoId = ? AND expiresAt <= ?. `true` only when this call changed the row,
   * so two workers seeing the same expired lease produce exactly one winner.
   */
  takeOverIfExpired(
    row: RenderLockRow & { holderLabel?: string },
    seenExpiry: Date
  ): Promise<boolean>;
  /** DELETE ... WHERE videoId = ? AND productionRenderId = ?. Only the holder may release. */
  releaseOwn(videoId: number, productionRenderId: string): Promise<boolean>;
  /** UPDATE the expiry, holder-scoped. Keeps a live render's lease from being taken over. */
  extendOwn(videoId: number, productionRenderId: string, expiresAt: Date): Promise<boolean>;
};

/**
 * How long a lock survives without being extended.
 *
 * Derived from what a render actually takes rather than picked: renders 573 and 574 ran 21.5 and
 * 17 minutes, and `inProcessCinematicRenderBudgetMs` already bounds the cinematic pass at 20. Forty
 * minutes is comfortably past a healthy render and short enough that a crashed worker does not cost
 * an operator an hour. The pipeline extends it while it is alive, so the number bounds SILENCE, not
 * work: a render that is still running keeps its lock however long it takes.
 */
export const RENDER_LOCK_LEASE_MS = 40 * 60_000;

/** How often a live render should push its lease out. Comfortably inside the lease. */
export const RENDER_LOCK_HEARTBEAT_MS = 5 * 60_000;

/**
 * Take the lock for this video, or say who has it.
 *
 * The order is deliberate and is the whole design: INSERT first, and only look at the existing row
 * when the key refuses. Reading first and then deciding would be a check-then-act race — two
 * workers would both read "free" and both insert, and one of them would get an error it had no
 * plan for.
 */
export async function acquireRenderLock(
  store: RenderLockStore,
  params: {
    videoId: number;
    productionRenderId: string;
    holderLabel?: string;
    leaseMs?: number;
    now?: Date;
  }
): Promise<RenderLockOutcome> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (params.leaseMs ?? RENDER_LOCK_LEASE_MS));
  const row: RenderLockRow & { holderLabel?: string } = {
    videoId: params.videoId,
    productionRenderId: params.productionRenderId,
    expiresAt,
    ...(params.holderLabel ? { holderLabel: params.holderLabel } : {}),
  };

  if (await store.insertIfAbsent(row)) {
    return {
      acquired: true,
      lock: { videoId: params.videoId, productionRenderId: params.productionRenderId, expiresAt, recoveredStale: false },
    };
  }

  const existing = await store.read(params.videoId);
  if (!existing) {
    /**
     * The holder released between the failed insert and this read. One more attempt, and if the
     * key refuses again somebody else won it — which is a refusal, not a retry loop.
     */
    if (await store.insertIfAbsent(row)) {
      return {
        acquired: true,
        lock: { videoId: params.videoId, productionRenderId: params.productionRenderId, expiresAt, recoveredStale: false },
      };
    }
    const nowHeld = await store.read(params.videoId);
    return {
      acquired: false,
      reason: "RENDER_ALREADY_RUNNING",
      videoId: params.videoId,
      existingRenderId: nowHeld?.productionRenderId ?? "unknown",
      requestedRenderId: params.productionRenderId,
      expiresAt: nowHeld?.expiresAt ?? null,
    };
  }

  /**
   * A lease nobody released. The takeover is conditional on the expiry this caller SAW, so two
   * workers looking at the same dead lock produce one winner and one refusal — never two winners.
   */
  if (existing.expiresAt.getTime() <= now.getTime()) {
    if (await store.takeOverIfExpired(row, existing.expiresAt)) {
      return {
        acquired: true,
        lock: { videoId: params.videoId, productionRenderId: params.productionRenderId, expiresAt, recoveredStale: true },
      };
    }
  }

  return {
    acquired: false,
    reason: "RENDER_ALREADY_RUNNING",
    videoId: params.videoId,
    existingRenderId: existing.productionRenderId,
    requestedRenderId: params.productionRenderId,
    expiresAt: existing.expiresAt,
  };
}

/**
 * Give the lock back. Safe to call on every ending — success, failure, refusal, cancellation.
 *
 * Holder-scoped, so a render that overran its lease and woke up to find a successor running cannot
 * take that successor's lock away on its way out. Returns whether THIS render's lock was the one
 * removed, which is the only honest answer to "did I still hold it".
 */
export async function releaseRenderLock(
  store: RenderLockStore,
  videoId: number,
  productionRenderId: string
): Promise<boolean> {
  return store.releaseOwn(videoId, productionRenderId);
}

/** Push this render's lease out. Holder-scoped for the same reason release is. */
export async function extendRenderLock(
  store: RenderLockStore,
  videoId: number,
  productionRenderId: string,
  opts?: { leaseMs?: number; now?: Date }
): Promise<boolean> {
  const now = opts?.now ?? new Date();
  return store.extendOwn(
    videoId,
    productionRenderId,
    new Date(now.getTime() + (opts?.leaseMs ?? RENDER_LOCK_LEASE_MS))
  );
}

/* ═══════════════════════ the lines a render leaves behind ═══════════════════════ */

/** Greppable, and it names both renders — a refusal that does not is a refusal nobody can trace. */
export function formatRenderLock(outcome: RenderLockOutcome): string {
  if (outcome.acquired) {
    return (
      `[RenderLock] video=${outcome.lock.videoId} render=${outcome.lock.productionRenderId} ` +
      `ACQUIRED expires=${outcome.lock.expiresAt.toISOString()}` +
      (outcome.lock.recoveredStale ? " STALE_LOCK_RECOVERED" : "")
    );
  }
  return (
    `[RenderLock] video=${outcome.videoId} RENDER_ALREADY_RUNNING ` +
    `holder=${outcome.existingRenderId} requested=${outcome.requestedRenderId} ` +
    `holderExpires=${outcome.expiresAt?.toISOString() ?? "unknown"}`
  );
}

export function formatRenderLockRelease(
  videoId: number,
  productionRenderId: string,
  removed: boolean
): string {
  return (
    `[RenderLock] video=${videoId} render=${productionRenderId} ` +
    (removed ? "RELEASED" : "RELEASE_NOOP — the lease had already been taken over")
  );
}
