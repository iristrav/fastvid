/**
 * VIDEO 643 (A) — THE PICTURE EDITOR'S OWN TIME.
 *
 * ── What video 643 showed ────────────────────────────────────────────────────────────────────
 *
 *     20:16:38  the last looks start: 9 sentences side by side, 34 moments
 *     20:17:20  45 s later the film goes on — 9 reviews still running (REVIEW_TIMEOUT_BEFORE_FINALIZE)
 *     20:17:31 … 20:18:51  the 9 reviews finish; s2b2's is a FIT, arriving after the film was assembled
 *
 * The last looks had one fixed 45 s window (`FINAL_LOOK_TURN_MS`, one sentence's turn) whatever they
 * held, and the reviews still running from the scenes 10 s (`FINAL_REVIEW_WINDOW_MS`). Nine sentences
 * looking at 34 moments through the same three frame extractors (`ffmpegSemaphore`) took 133 s: 35 s
 * of the film became a card "because the review timed out", one FIT was lost.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 * The final stage gets a budget of its own, apart from the scene and sentence budgets. It starts at
 * what it had (`baseMs`: the 10 s window plus the 45 s look turn, never less than before) and grows by
 * `JUDGE_MS_PER_LOOK` for every look the editor is actually given — so it follows the amount of
 * picture work, and with it the length of the video. It never grows past `ceilingMs`: a hard bound by
 * the video's length (`judgeBudgetCeilingMs`) and by the time left before the render's force-export.
 * The per-sentence (5) and per-render (120) look ceilings are untouched: they bound what can be
 * granted, this only stops a granted look being cut off by a clock that was not its own.
 */

/** Measured in 643: 34 moments judged in 133 s with 9 sentences side by side (≈ 3.9 s each), rounded up. */
export const JUDGE_MS_PER_LOOK = 5_000;
/** The ceiling's floor and roof, and how it follows the video's length. */
export const JUDGE_BUDGET_MIN_CEILING_MS = 180_000;
export const JUDGE_BUDGET_MAX_CEILING_MS = 600_000;
export const JUDGE_CEILING_MS_PER_VIDEO_SEC = 3_000;

/** Why the final stage stopped waiting for the picture editor. */
export const JUDGE_BUDGET_EXHAUSTED = "JUDGE_BUDGET_EXHAUSTED";

/**
 * The hard bound of the picture editor's own time. By length: `JUDGE_CEILING_MS_PER_VIDEO_SEC` per
 * second of narration, between 3 and 10 minutes. Never past the render's force-export moment
 * (`timeLeftMs`), and never below `baseMs` — what the stage had before this budget existed.
 */
export function judgeBudgetCeilingMs(videoSec: number, timeLeftMs: number, baseMs: number): number {
  const byLength = Math.min(
    JUDGE_BUDGET_MAX_CEILING_MS,
    Math.max(JUDGE_BUDGET_MIN_CEILING_MS, (Number.isFinite(videoSec) && videoSec > 0 ? videoSec : 0) * JUDGE_CEILING_MS_PER_VIDEO_SEC)
  );
  const left = Number.isFinite(timeLeftMs) ? Math.max(0, timeLeftMs) : Number.POSITIVE_INFINITY;
  return Math.max(baseMs, Math.min(byLength, left));
}

export type JudgeBudget = {
  readonly startedAtMs: number;
  readonly baseMs: number;
  readonly perLookMs: number;
  readonly ceilingMs: number;
  /** Looks the picture editor was given so far (each grows the budget by `perLookMs`). */
  readonly looks: number;
  grant(looks: number): void;
  /** True once `stopWhen` said so (a cancelled or superseded render): the budget is over at once. */
  stopped(): boolean;
  grantedMs(): number;
  deadlineAtMs(): number;
  leftMs(): number;
  usedMs(): number;
};

export function createJudgeBudget(opts: {
  baseMs: number;
  perLookMs?: number;
  ceilingMs: number;
  now?: () => number;
  /** Read on every turn of the wait: true (the render was cancelled or superseded) ends the budget at once. */
  stopWhen?: () => boolean;
}): JudgeBudget {
  const now = opts.now ?? Date.now;
  let stoppedAt: number | null = null;
  const stopped = () => {
    if (stoppedAt == null && opts.stopWhen?.()) stoppedAt = now();
    return stoppedAt != null;
  };
  const startedAtMs = now();
  const perLookMs = opts.perLookMs ?? JUDGE_MS_PER_LOOK;
  const ceilingMs = Math.max(opts.baseMs, opts.ceilingMs);
  let looks = 0;
  const grantedMs = () => Math.min(ceilingMs, Math.max(opts.baseMs, looks * perLookMs));
  return {
    startedAtMs,
    baseMs: opts.baseMs,
    perLookMs,
    ceilingMs,
    get looks() {
      return looks;
    },
    grant(n: number) {
      if (Number.isFinite(n) && n > 0) looks += Math.floor(n);
    },
    stopped,
    grantedMs,
    deadlineAtMs: () => (stopped() ? stoppedAt! : startedAtMs + grantedMs()),
    leftMs: () => (stopped() ? 0 : startedAtMs + grantedMs() - now()),
    usedMs: () => now() - startedAtMs,
  };
}

/**
 * Waits for `work` until it has all settled or the budget's deadline has passed. The deadline is read
 * again on every turn, so a look granted while waiting extends the wait. True when everything settled.
 */
export async function settledWithinJudgeBudget(work: Promise<unknown>[], budget: JudgeBudget): Promise<boolean> {
  if (work.length === 0) return true;
  let done = false;
  const all = Promise.allSettled(work).then(() => {
    done = true;
  });
  while (!done) {
    const left = budget.leftMs();
    if (left <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, Math.min(left, 1_000))))]);
    if (timer) clearTimeout(timer);
  }
  /** `then` handlers registered before ours (ladder `settled`, in-flight removal) run first. */
  await Promise.resolve();
  return done;
}

export function formatJudgeBudgetLine(
  budget: JudgeBudget,
  tally: { queued: number; judged: number; fit: number; mismatch: number; stop: string; unreviewed: readonly string[] }
): string {
  return (
    `[JudgeBudget] granted=${budget.grantedMs()}ms used=${budget.usedMs()}ms left=${Math.max(0, budget.leftMs())}ms ` +
    `ceiling=${budget.ceilingMs}ms queued=${tally.queued} judged=${tally.judged} FIT=${tally.fit} MISMATCH=${tally.mismatch} ` +
    `stop=${tally.stop}` +
    (tally.unreviewed.length ? ` notReviewed=[${tally.unreviewed.join(",")}]` : "")
  );
}
