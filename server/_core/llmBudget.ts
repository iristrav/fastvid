/**
 * Application-side LLM daily spend cap.
 *
 * As of 2026, provider-side "hard spend limits" (OpenAI's Organization spend limit, in
 * particular) have been widely reported to no longer actually block traffic once hit — they
 * send an email/dashboard alert while requests keep succeeding and billing keeps accruing.
 * A real hard stop has to live in the calling application, not rely on the provider's own
 * dashboard setting. This is a blunt safety net against runaway/accidental overspend (a video
 * stuck in an expensive retry loop, a bug causing an LLM call storm), not a precise billing
 * system — the cost estimate below is approximate, not what the provider will actually invoice.
 *
 * Tracked in llm_spend_daily (one row per UTC day), so the cap holds across every process (web
 * + all worker replicas) and survives restarts/redeploys — unlike a plain in-memory counter,
 * which would reset on every deploy and defeat the purpose on exactly the kind of day repeated
 * deploys are happening (e.g. active debugging).
 *
 * To avoid a DB round trip on every single LLM call (some renders make 100+), the current
 * day's spend is cached in-process and refreshed from the DB periodically; each call also
 * increments the local cache immediately so same-process accuracy is exact, while cross-process
 * totals converge within REFRESH_MS. That's an intentional trade: a short window where two
 * processes could each independently see themselves as under budget is an acceptable cost for
 * not adding DB latency to the hot LLM path of a safety net, not a payment system.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { llmSpendDaily } from "../../drizzle/schema";

/** Default daily budget in USD. Override with LLM_DAILY_BUDGET_USD. */
const DEFAULT_DAILY_BUDGET_USD = 15;

function dailyBudgetUsd(): number {
  const raw = process.env.LLM_DAILY_BUDGET_USD?.trim();
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

/** Set LLM_BUDGET_ENFORCE=false to only log estimated spend without ever blocking calls. */
function budgetEnforced(): boolean {
  return process.env.LLM_BUDGET_ENFORCE !== "false";
}

// Approximate published per-1M-token pricing (USD) for the models this app actually calls
// (see server/_core/llm.ts resolveModel). Pricing drifts — this is a safety-net estimate, not
// an invoice; check against the providers' current pricing pages periodically. Unlisted/unknown
// models fall back to a deliberately pessimistic estimate so an untracked model can't silently
// bypass the budget.
const PRICING_PER_1M_TOKENS: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.50, out: 10.00 },
  "claude-haiku-4-5-20251001": { in: 1.00, out: 5.00 },
  "openai/gpt-oss-20b": { in: 0.10, out: 0.50 },
  "openai/gpt-oss-120b": { in: 0.15, out: 0.75 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { in: 0.20, out: 0.60 },
  // $0 by design: a Google AI Studio key (GEMINI_API_KEY) with no billing account linked is
  // hard-capped at the free daily/per-minute quota by Google itself (requests 429 past it,
  // never silently bills) — that's the whole point of using it. If billing is ever linked to
  // the project, update this to gemini-2.5-flash's actual paid rate so the budget tracks it.
  "gemini-2.5-flash": { in: 0, out: 0 },
  "gemini-2.5-flash-lite": { in: 0, out: 0 },
  "gemini-2.5-pro": { in: 0, out: 0 },
  // $0 by design: Cerebras's free tier (14,400 req/day, 1M tokens/day, no billing account) is
  // the same kind of hard-capped-at-quota free key as Gemini's — same reasoning as above.
  "gpt-oss-120b": { in: 0, out: 0 },
  DEFAULT_FALLBACK: { in: 3.00, out: 12.00 },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_PER_1M_TOKENS[model] ?? PRICING_PER_1M_TOKENS.DEFAULT_FALLBACK!;
  return (promptTokens / 1_000_000) * pricing.in + (completionTokens / 1_000_000) * pricing.out;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

let cache: { day: string; spentUsd: number; lastSyncedMs: number } = {
  day: todayUtc(),
  spentUsd: 0,
  lastSyncedMs: 0,
};
const REFRESH_MS = 30_000;

async function syncFromDb(): Promise<void> {
  const day = todayUtc();
  try {
    const db = await getDb();
    if (!db) return;
    const rows = await db.select().from(llmSpendDaily).where(eq(llmSpendDaily.day, day)).limit(1);
    const spentUsd = (rows[0]?.spentUsdCents ?? 0) / 100;
    // Take the max of what we already knew locally (calls recorded since the last sync haven't
    // necessarily landed in the DB's replica-visible state yet) and what the DB reports.
    cache = { day, spentUsd: Math.max(cache.day === day ? cache.spentUsd : 0, spentUsd), lastSyncedMs: Date.now() };
  } catch {
    /* best-effort — an unreachable DB shouldn't itself block LLM calls */
  }
}

/** Current estimated spend for the UTC day so far, refreshing from the DB if the cache is stale. */
export async function currentDailySpendUsd(): Promise<number> {
  const day = todayUtc();
  if (day !== cache.day || Date.now() - cache.lastSyncedMs > REFRESH_MS) {
    await syncFromDb();
  }
  return cache.day === day ? cache.spentUsd : 0;
}

/** Checked before every LLM call — see invokeLLM in llm.ts. */
export async function isLlmBudgetExceeded(): Promise<boolean> {
  if (!budgetEnforced()) return false;
  return (await currentDailySpendUsd()) >= dailyBudgetUsd();
}

export function llmDailyBudgetUsd(): number {
  return dailyBudgetUsd();
}

/** Records one call's usage. Fire-and-forget from the caller — never throws, never blocks. */
export function recordLlmUsage(model: string, promptTokens: number, completionTokens: number): void {
  const costUsd = estimateCostUsd(model, promptTokens, completionTokens);
  const day = todayUtc();
  // Immediate local increment so same-process budget checks are exact without waiting on the
  // DB round trip below.
  cache = day === cache.day
    ? { ...cache, spentUsd: cache.spentUsd + costUsd }
    : { day, spentUsd: costUsd, lastSyncedMs: 0 };

  void (async () => {
    try {
      const db = await getDb();
      if (!db) return;
      const cents = Math.max(0, Math.round(costUsd * 100));
      await db
        .insert(llmSpendDaily)
        .values({ day, spentUsdCents: cents, callCount: 1 })
        .onDuplicateKeyUpdate({
          set: {
            spentUsdCents: sql`${llmSpendDaily.spentUsdCents} + ${cents}`,
            callCount: sql`${llmSpendDaily.callCount} + 1`,
          },
        });
    } catch {
      /* best-effort — local cache above already reflects this call regardless */
    }
  })();
}
