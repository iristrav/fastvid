/**
 * RONDE 263 — A SCOPE THAT OPENS AFTER ITS OWN DEADLINE DOES NOT OPEN.
 *
 * ── What the render after RONDE 260 printed, three times for one beat ───────────────────────
 *
 *     [YouTube] TURN_DECLINED scene=1 — 0s left …
 *       clock="historical archival rescue s1 b3" granted=-25s used=0s
 *
 * MINUS twenty-five seconds. Not a window running low — a window that had closed half a minute
 * before anyone opened it. `used=0s` says the same from the other side: nothing had elapsed, so
 * this was not work that ran out of time. It was work scheduled into time already spent.
 *
 * RONDE 260's clock label is what made it visible at all. The round before could prove its reserve
 * did not hold and could not say where; this was in the first three lines the label produced.
 *
 * ── The mechanism ───────────────────────────────────────────────────────────────────────────
 *
 *     deadlineAtMs = Math.min(openedAtMs + delayMs, parentDeadline)
 *
 * Correct, and it is what keeps a child inside its parent. When the parent is ALREADY past its
 * deadline that expression lands in the past: the window is negative, `transferReserveFor` returns
 * 0, the search deadline is behind the clock, and every derived number is a formality.
 *
 * And the work still ran. The abort timer is set on `delayMs`, not on the deadline — so a scope
 * with a negative window still had `delayMs` of real wall clock in which to spend the scene's
 * budget on a ladder that could not finish.
 *
 * ── Why the fix is in withSceneFetchTimeout and not at the rescue call site ─────────────────
 *
 * The rescue ladder is where it was OBSERVED, not where it is caused. All sixty-odd
 * `withSceneFetchTimeout` call sites inherit the same clamp and can open the same dead scope.
 * Fixing the one that happened to print would make the rule true in one place and absent in
 * fifty-nine, which is how most of this file's defects were acquired.
 *
 * NOTHING IS LOOSENED AND NO BUDGET MOVES. §3 checks that a scope with time left is untouched to
 * the millisecond. What changes is that a scope with none is refused instead of pretending.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  describeEnclosingScope,
  isScopeAbortError,
  remainingScopeMs,
  withSceneFetchTimeout,
} from "./videoPipeline";
import { stripComments } from "./sourceScan.test.support";

const CODE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Render 587's shape, reproduced exactly — and it takes THREE levels, which is itself the finding.
 *
 * A root scope cannot have a passed deadline with a live timer: for a root the two coincide. The
 * state only exists one level down, where `delayMs` and the clamped deadline come apart —
 *
 *     grandparent   120ms          deadline = timer = +120ms
 *     parent        asks 600_000   deadline = the grandparent's (+120ms), timer = +600_000ms
 *
 * — so past 120ms the parent is alive by its own timer and long past its deadline. Anything it
 * opens then is born expired. That is `granted=-25s`, and the rescue ladder sits exactly there:
 * last in the beat, inside a scene scope it has already outlived.
 *
 * The grandparent's own timeout fires during all of this and is expected; the inner work keeps
 * running regardless, so the child's outcome is captured rather than awaited through it.
 */
async function openedAfterTheBudgetEnded(
  label: string
): Promise<{ error: unknown; bodyRan: boolean }> {
  let error: unknown = null;
  let bodyRan = false;
  let settle!: () => void;
  const finished = new Promise<void>((r) => {
    settle = r;
  });
  void withSceneFetchTimeout(
    () =>
      withSceneFetchTimeout(
        async () => {
          try {
            await sleep(160);
            await withSceneFetchTimeout(
              async () => {
                bodyRan = true;
                return "done";
              },
              60_000,
              label
            );
          } catch (e) {
            error = e;
          } finally {
            settle();
          }
        },
        600_000,
        "the spent parent"
      ),
    120,
    "the grandparent"
  ).catch(() => {
    /** The grandparent's own timeout. Expected, and not what this file is about. */
  });
  await finished;
  return { error, bodyRan };
}

/* ═══════════ 1. the scope is refused ═══════════ */

describe("R263 §1 — no window, no work", () => {
  it("RENDER 587: a scope opened past its parent's deadline never runs its body", async () => {
    const { error, bodyRan } = await openedAfterTheBudgetEnded("historical archival rescue s1 b3");
    expect((error as Error)?.message).toMatch(/was not started/);
    expect(bodyRan, "the rescue ladder ran inside a window that had already closed").toBe(false);
  });

  it("the refusal names the scope and how late it was", async () => {
    const { error } = await openedAfterTheBudgetEnded("the late child");
    expect((error as Error)?.message).toContain("the late child");
    expect((error as Error)?.message).toMatch(/had already ended \d+s earlier/);
  });

  it("IT IS NOT SILENT — a refused scope says so once, with its label", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await openedAfterTheBudgetEnded("the late child");
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("SCOPE_EXPIRED"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('label="the late child"');
    } finally {
      warn.mockRestore();
    }
  });
});

/* ═══════════ 2. it reads as the budget, never as the provider ═══════════ */

describe("R263 §2 — a refused scope is a cancellation, not a provider failure", () => {
  it("THE BREAKERS MUST NOT COUNT IT: the error carries the scope-abort flag", async () => {
    const { error: err } = await openedAfterTheBudgetEnded("the late child");
    expect(
      isScopeAbortError(err),
      "a healthy provider would be disabled for being asked at the wrong moment"
    ).toBe(true);
  });

  it("and it uses the same flag the existing abort does, not a second one", () => {
    const fn = CODE.slice(
      CODE.indexOf("function scopeExpiredError("),
      CODE.indexOf("export function isScopeAbortError(")
    );
    expect(fn).toContain("[SCOPE_ABORT_FLAG] = true;");
    expect(CODE, "scopeAbortError was replaced rather than joined").toContain(
      "function scopeAbortError("
    );
  });
});

/* ═══════════ 3. a scope with time left is untouched ═══════════ */

describe("R263 §3 — nothing else changed", () => {
  it("an ordinary scope runs exactly as before", async () => {
    const out = await withSceneFetchTimeout(async () => "value", 30_000, "healthy");
    expect(out).toBe("value");
  });

  it("a nested scope with time left still runs and still inherits the parent's deadline", async () => {
    await withSceneFetchTimeout(
      async () => {
        const parentLeft = remainingScopeMs();
        const inner = await withSceneFetchTimeout(
          async () => remainingScopeMs(),
          600_000,
          "oversized but alive"
        );
        expect(inner).toBeLessThanOrEqual(parentLeft);
        expect(inner).toBeGreaterThan(0);
      },
      30_000,
      "alive parent"
    );
  });

  it("a scope opened at the very edge of its parent still runs", async () => {
    /** The guard is `deadline <= opened`, so any positive window at all is honoured. */
    const out = await withSceneFetchTimeout(
      () => withSceneFetchTimeout(async () => "edge", 60_000, "edge child"),
      120,
      "edge parent"
    );
    expect(out).toBe("edge");
  });

  it("outside any scope nothing is refused — there is no parent to be past", async () => {
    expect(await withSceneFetchTimeout(async () => "root", 1, "root scope")).toBe("root");
  });

  it("THE CLAMP ITSELF IS UNCHANGED — this adds a guard, it does not move a deadline", () => {
    expect(CODE).toContain("const deadlineAtMs = Math.min(openedAtMs + delayMs, parentDeadline);");
    expect(CODE).toContain("if (deadlineAtMs <= openedAtMs) {");
    const clamp = CODE.indexOf("const deadlineAtMs = Math.min(openedAtMs + delayMs, parentDeadline);");
    const guard = CODE.indexOf("if (deadlineAtMs <= openedAtMs) {");
    expect(guard, "the guard reads a deadline that has not been computed yet").toBeGreaterThan(clamp);
  });
});

/* ═══════════ 4. the rule lives in one place ═══════════ */

describe("R263 §4 — one rule, not one call site", () => {
  it("THE GUARD IS INSIDE withSceneFetchTimeout, which every scope passes through", () => {
    const fn = CODE.slice(
      CODE.indexOf("export function withSceneFetchTimeout<T>("),
      CODE.indexOf("function assertPipelineWithinBudget(")
    );
    expect(fn).toContain("if (deadlineAtMs <= openedAtMs) {");
    expect(fn).toContain("return Promise.reject(scopeExpiredError(label, overrunMs));");
  });

  it("and the rescue ladder — where it was observed — was not special-cased", () => {
    const at = CODE.indexOf("historicalRescueBudgetMs(dedup)");
    expect(at).toBeGreaterThan(-1);
    const around = CODE.slice(Math.max(0, at - 900), at + 300);
    expect(around, "a local guard would leave the other call sites exposed").not.toContain(
      "SCOPE_EXPIRED"
    );
  });

  it("a negative window can no longer reach the reserve arithmetic at all", () => {
    const fn = CODE.slice(
      CODE.indexOf("export function withSceneFetchTimeout<T>("),
      CODE.indexOf("function assertPipelineWithinBudget(")
    );
    const guard = fn.indexOf("if (deadlineAtMs <= openedAtMs) {");
    const reserve = fn.indexOf("const reserveMs = transferReserveFor(");
    expect(guard).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(-1);
    expect(guard, "granted=-25s could still produce a reserve of 0 and a dead search window")
      .toBeLessThan(reserve);
  });

  it("and describeEnclosingScope can no longer report a negative grant", async () => {
    const seen = await withSceneFetchTimeout(
      async () => describeEnclosingScope(),
      30_000,
      "reporting scope"
    );
    expect(seen).not.toContain("granted=-");
  });
});
