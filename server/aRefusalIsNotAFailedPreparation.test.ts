/**
 * RONDE 253 — A REFUSAL IS NOT A FAILED PREPARATION.
 *
 * ── The invariant render 585 broke ──────────────────────────────────────────────────────────
 *
 *     [PreparationInvariant] OUTCOMES_EXCEED_STARTS
 *
 * More preparations ended than ever began. `formatPreparationCache` calls that "a counter bug
 * rather than a performance problem" in its own comment, and it was right.
 *
 * There is exactly one way to reach it. `runPreparation` charges the per-beat preparation budget
 * BELOW the two cache checks, deliberately, so a free cache hit is not charged. When that budget
 * is spent the function returns before any work starts — and incremented `failed`:
 *
 *     if (!chargeAmbientBudget("preparations")) {
 *       scope.counters.failed += 1;        // ← an outcome
 *       return { status: "FAILED", … };    //   of a start that never happened
 *     }
 *
 * `started` is incremented four lines further down. So every beat that hit its preparation ceiling
 * filed one outcome against zero starts, and enough of them made `succeeded + failed > started`.
 *
 * ── Why a new counter and not a smaller one ─────────────────────────────────────────────────
 *
 * The cheap repair — stop counting it — would hide the refusals, and the refusals are the more
 * interesting number: a beat stopped by its own ceiling is a different render from a beat whose
 * downloads failed, and the budget exists precisely so that difference is visible. The other cheap
 * repair — increment `started` too — would claim work that never ran.
 *
 * So the disposition gets its own name. `requested` now accounts for completely:
 *
 *     requested = reused + skippedDuplicate + refusedBudget + started
 *
 * which is a stronger statement than the two invariants that were there before, and it is checked.
 *
 * NOTHING HERE MOVES THE BUDGET. `MAX_BEAT_PREPARATIONS` is the number it was, the charge is in
 * the same place, and a refusal still refuses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  formatPreparationCache,
  preparationCounters,
  resetPreparationScope,
  runPreparation,
} from "./preparationCache";
import {
  BUDGETS,
  createRetrievalBudgetState,
  setBudgetResolver,
  type RetrievalBudgetState,
} from "./retrievalBudget";
import { withQueryScope } from "./searchQueryContract";

let workDir: string;
let budget: RetrievalBudgetState;

beforeEach(() => {
  workDir = path.join(os.tmpdir(), `r253-prep-${Math.random().toString(36).slice(2)}`);
  resetPreparationScope(workDir);
  budget = createRetrievalBudgetState();
  setBudgetResolver(() => budget);
});

afterEach(() => {
  setBudgetResolver(null);
  resetPreparationScope(workDir);
});

/** A preparation that never produces a file, so nothing is written and nothing is cached. */
const failing = () => Promise.reject(new Error("provider said no"));

/** Ask once per distinct key, inside one beat's scope, until the ceiling refuses. */
async function askUntilRefused(times: number): Promise<string[]> {
  const statuses: string[] = [];
  for (let i = 0; i < times; i++) {
    await withQueryScope({ sceneIndex: 0, beatIndex: 0 }, async () => {
      const out = await runPreparation(workDir, `asset:${i}|3`, failing);
      statuses.push(out.status);
    });
  }
  return statuses;
}

describe("1. the invariant render 585 broke", () => {
  it("a beat that exhausts its preparation ceiling files no outcome without a start", async () => {
    const over = BUDGETS.preparations() + 5;
    await askUntilRefused(over);
    const c = preparationCounters(workDir);
    expect(
      c.succeeded + c.failed,
      `render 585 printed OUTCOMES_EXCEED_STARTS: ${JSON.stringify(c)}`
    ).toBeLessThanOrEqual(c.started);
  });

  it("and the render no longer reports the invariant", async () => {
    await askUntilRefused(BUDGETS.preparations() + 5);
    expect(formatPreparationCache(workDir).filter((l) => l.includes("OUTCOMES_EXCEED_STARTS"))).toEqual(
      []
    );
  });
});

describe("2. the refusals are still counted, and named", () => {
  it("every ask past the ceiling is recorded as a refusal", async () => {
    const limit = BUDGETS.preparations();
    await askUntilRefused(limit + 5);
    expect(preparationCounters(workDir).refusedBudget).toBe(5);
  });

  it("the refusals are printed, not absorbed into the failure count", async () => {
    await askUntilRefused(BUDGETS.preparations() + 3);
    const line = formatPreparationCache(workDir).find((l) => l.startsWith("[Preparation] requested="))!;
    expect(line).toContain("refusedBudget=3");
  });

  it("a refusal is still a refusal — the caller is told no", async () => {
    const statuses = await askUntilRefused(BUDGETS.preparations() + 2);
    expect(statuses.slice(-2)).toEqual(["FAILED", "FAILED"]);
  });

  it("and the reason still says the beat stopped rather than ran out of candidates", async () => {
    const limit = BUDGETS.preparations();
    for (let i = 0; i < limit; i++) {
      await withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () =>
        runPreparation(workDir, `asset:${i}|3`, failing)
      );
    }
    const refused = await withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () =>
      runPreparation(workDir, "asset:last|3", failing)
    );
    expect(refused.status).toBe("FAILED");
    expect(
      refused.status === "FAILED" ? refused.error.message : ""
    ).toContain("it did not run out of candidates");
  });
});

describe("3. a real preparation failure is still a failure", () => {
  /** The distinction only means something if the other side of it still works. */
  it("a provider error inside the budget counts as failed, not refused", async () => {
    await withQueryScope({ sceneIndex: 1, beatIndex: 0 }, () =>
      runPreparation(workDir, "asset:real|3", failing)
    );
    const c = preparationCounters(workDir);
    expect(c.started).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.refusedBudget).toBe(0);
  });
});

describe("4. every request has exactly one disposition", () => {
  /**
   * The statement the two old invariants could not make. A request is served from cache, awaited on
   * an in-flight one, refused by the ceiling, or started — and nothing else.
   */
  it("requested equals reused + skippedDuplicate + refusedBudget + started", async () => {
    await askUntilRefused(BUDGETS.preparations() + 4);
    const c = preparationCounters(workDir);
    expect(c.requested).toBe(c.reused + c.skippedDuplicate + c.refusedBudget + c.started);
  });

  it("and the render checks it rather than leaving it to be noticed", async () => {
    await askUntilRefused(BUDGETS.preparations() + 4);
    expect(
      formatPreparationCache(workDir).filter((l) => l.includes("REQUESTS_UNACCOUNTED"))
    ).toEqual([]);
  });
});

describe("5. nothing was loosened to achieve this", () => {
  it("the per-beat preparation ceiling is unchanged", () => {
    expect(BUDGETS.preparations()).toBe(10);
  });

  it("both original invariants are still reported", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(path.join(__dirname, "preparationCache.ts"), "utf8");
    expect(src).toContain("STARTED_EXCEEDS_REQUESTED");
    expect(src).toContain("OUTCOMES_EXCEED_STARTS");
  });

  it("and the budget is still charged below the cache checks, where a free hit costs nothing", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const src = readFileSync(path.join(__dirname, "preparationCache.ts"), "utf8");
    const reused = src.indexOf('scope.counters.reused += 1;');
    const charge = src.indexOf('chargeAmbientBudget("preparations")');
    expect(reused).toBeGreaterThan(-1);
    expect(charge, "a cache hit must not be charged").toBeGreaterThan(reused);
  });
});
