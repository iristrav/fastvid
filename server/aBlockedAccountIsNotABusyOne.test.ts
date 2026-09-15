/**
 * "NO CAPACITY" WAS PRINTED 228 TIMES WHILE THE ACCOUNT WAS BLOCKED, NOT BUSY.
 *
 * ── What render 580 reported ────────────────────────────────────────────────────────────────
 *
 *     [BeatImageGate] no verdict: 219x gate could not ask: No vision-capable provider is
 *                     available | 7x provider unavailable (no capacity): ... (gemini 403)
 *
 * ── What Google actually said ───────────────────────────────────────────────────────────────
 *
 *     403 { "message": "Your project has been denied access. Please contact support.",
 *           "status": "PERMISSION_DENIED" }
 *
 * Those are different problems with opposite remedies. "No capacity" is a limit that resets while
 * you wait; a denied project never resets, and waiting costs renders. Three weeks of logs read as
 * "the provider is busy" because of one word.
 *
 * ── What this round does NOT change ─────────────────────────────────────────────────────────
 *
 * `isProviderCapacityFailure` bundles 402/403/404/413/429 on purpose: for ROUTING they are one
 * fact — no model looked at anything — and the counter built on it, `judgementsProviderUnavailable`,
 * is correct. Routing, cooldowns, retries and counters are all untouched. Only the sentence an
 * operator reads changes, from a guess to the provider's own answer.
 *
 * This is the same repair RONDE 119 made when a Groq token budget was being blamed for an image
 * call Groq was never a candidate for: the wrong signpost, pointing at the wrong page.
 */
import { describe, expect, it } from "vitest";
import {
  LlmProviderUnavailableError,
  describeProviderUnavailability,
  isProviderCapacityFailure,
} from "./_core/llm";

/** The shape the chain attaches to a single provider's HTTP failure. */
const httpErr = (status: number, body = ""): Error => {
  const e = new Error(`provider failed ${status}`) as Error & { llmStatus: number; llmBody: string };
  e.llmStatus = status;
  e.llmBody = body;
  return e;
};

describe("1. the denial is named as a denial", () => {
  /** THE CASE FROM THE LOG. */
  it("a 403 says the key or project is refused, and says it is not a quota", () => {
    const why = describeProviderUnavailability(
      httpErr(403, '{"status":"PERMISSION_DENIED","message":"Your project has been denied access."}')
    );
    expect(why).toContain("access denied");
    expect(why).toContain("not a quota");
  });

  /** The word that sent every reader to the wrong page. */
  it("and it no longer calls that 'no capacity'", () => {
    expect(describeProviderUnavailability(httpErr(403))).not.toContain("capacity");
  });

  it("a real quota still reads as a quota", () => {
    expect(describeProviderUnavailability(httpErr(429))).toContain("rate limit");
    expect(describeProviderUnavailability(httpErr(402))).toContain("billing");
  });

  it("a model the account cannot reach says so", () => {
    expect(describeProviderUnavailability(httpErr(404))).toContain("not available to this account");
  });

  it("an oversized request says so", () => {
    expect(describeProviderUnavailability(httpErr(413))).toContain("larger than the tier");
  });

  /** An unrecognised refusal reports its number rather than inventing a story about it. */
  it("an unknown status is quoted, not guessed at", () => {
    expect(describeProviderUnavailability(httpErr(451))).toBe("provider refused with HTTP 451");
  });

  /** The pre-flight case: the chain was empty, so no socket was opened and there is no status. */
  it("nothing contacted says nothing was contacted", () => {
    expect(describeProviderUnavailability(new Error("chain was empty")))
      .toBe("no provider could be reached");
  });
});

describe("2. a chain reports its worst news, not its first", () => {
  const chain = (...statuses: number[]) =>
    new LlmProviderUnavailableError(
      "no provider had capacity",
      statuses.map((status) => ({ provider: "gemini" as const, status, detail: "" }))
    );

  /**
   * THE ORDERING IS THE MESSAGE. Render 580's chain carried both a spent OpenAI quota and Gemini's
   * denial. A quota clears on its own; a denied project does not. Reporting the rate limit would
   * be true and useless — it describes the half of the problem that fixes itself.
   */
  it("a denial beside a rate limit is reported as the denial", () => {
    expect(describeProviderUnavailability(chain(429, 403))).toContain("access denied");
  });

  it("in either order", () => {
    expect(describeProviderUnavailability(chain(403, 429))).toContain("access denied");
  });

  it("and billing outranks a rate limit for the same reason", () => {
    expect(describeProviderUnavailability(chain(429, 402))).toContain("billing");
  });

  it("a chain of only rate limits is a rate limit", () => {
    expect(describeProviderUnavailability(chain(429, 429))).toContain("rate limit");
  });
});

describe("3. routing is untouched", () => {
  /**
   * The predicate the router consults must keep answering the one question it exists for: did any
   * model look at anything. Narrowing it here to make the wording tidier would change which
   * provider gets tried next — a behaviour change smuggled in behind a log line, which is the
   * exact move this codebase keeps having to undo.
   */
  it("every one of these is still a capacity failure for routing purposes", () => {
    for (const status of [403, 404, 429]) {
      expect(isProviderCapacityFailure(status, ""), `HTTP ${status}`).toBe(true);
    }
  });

  /**
   * 402 is the one that needs its body read — a bare 402 is NOT a capacity failure, only one whose
   * body names the quota or billing. Asserted as it really is rather than as it reads: the first
   * version of this test claimed a bare 402 qualified, and it does not.
   */
  it("402 still depends on its body, exactly as before", () => {
    expect(isProviderCapacityFailure(402, "")).toBe(false);
    expect(isProviderCapacityFailure(402, '{"code":"insufficient_quota"}')).toBe(true);
  });

  it("and the genuine failures are still genuine failures", () => {
    for (const status of [400, 500, 503]) {
      expect(isProviderCapacityFailure(status, ""), `HTTP ${status}`).toBe(false);
    }
  });
});

describe("4. the gate writes the cause into both of its lines", () => {
  const GATE = (): string =>
    require("fs").readFileSync(require("path").join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

  /** The reason a beat records, and the reason the render's summary line carries. */
  it("both the declined verdict and the ask-impossible note carry it", () => {
    const src = GATE();
    const at = src.indexOf("if (isLlmProviderUnavailable(err)) {");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 1600);
    expect(block).toContain("describeProviderUnavailability(err)");
    expect(block).toContain("noteAskImpossible(state, `no provider served the call — ${why}`)");
    expect(block).toContain("provider unavailable (${why})");
  });

  /** The counter is the thing that was already right; it must not move. */
  it("and the counter it sits beside is unchanged", () => {
    const src = GATE();
    const at = src.indexOf("if (isLlmProviderUnavailable(err)) {");
    const block = src.slice(at, at + 1600);
    expect(block).toContain("state.judgementAttempts--");
    expect(block).toContain("state.judgementsProviderUnavailable++");
  });
});
