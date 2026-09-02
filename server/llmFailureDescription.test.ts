/**
 * A RECURRING 400 THAT NOBODY COULD DIAGNOSE.
 *
 * ── What render 562 logged ──────────────────────────────────────────────────────────────────
 *
 *     [Editorial] s1 reorder skipped: LLM invoke failed (groq, model=openai/gpt-oss-20b):
 *                 400 Bad Request – {error:{
 *     [Editorial] s2 storyboard LLM failed: … 400 Bad Request – {error:{
 *     [SemanticVisual] LLM analysis failed: … 400 Bad Request – {error:{message:"Failed to
 *
 * Three planning passes failed in one render and the reason is unreadable in all three. The
 * callers cut the message at 80 characters, and 80 characters of an LLM error buys the provider
 * name, the model id, the status and the opening brace. The part after `message:` — the only part
 * that says what went wrong — never fits.
 *
 * `(err as Error).message?.slice(0, N)` appears at 66 call sites, so this is not one unlucky log
 * line; it is the shape of every LLM failure this codebase reports.
 *
 * ── Why the fix is not a bigger number ──────────────────────────────────────────────────────
 *
 * The body can be kilobytes of echoed request. The budget was never the problem — what it was
 * SPENT on was. This keeps the two fields a reader needs (which provider, what status) and gives
 * the rest of the budget to the provider's own explanation instead of the JSON scaffolding.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { describeLlmFailure } from "./_core/llm";

/* ═══════════════════════ the production line ═══════════════════════ */

describe("the reason survives", () => {
  /** Render 562's own failure, with the body the log truncated away. */
  const REAL = new Error(
    'LLM invoke failed (groq, model=openai/gpt-oss-20b): 400 Bad Request – ' +
      '{error:{message:"Failed to generate JSON. Please adjust your prompt.",' +
      'type:"invalid_request_error",code:"json_validate_failed"}}'
  );

  it("says what actually went wrong", () => {
    const out = describeLlmFailure(REAL);
    expect(out, "the provider's own explanation is still missing").toContain(
      "Failed to generate JSON"
    );
  });

  it("keeps the provider and the status a reader needs", () => {
    const out = describeLlmFailure(REAL);
    expect(out).toContain("groq");
    expect(out).toContain("400");
  });

  /** The old behaviour, for contrast: 80 characters bought nothing but scaffolding. */
  it("the old truncation really did lose it", () => {
    const old = REAL.message.slice(0, 80);
    expect(old, "this test is no longer demonstrating the defect").not.toContain(
      "Failed to generate JSON"
    );
    expect(old).toContain("{error:{");
  });

  it("stays inside its budget", () => {
    const long = new Error(
      `LLM invoke failed (openai, model=gpt-4o): 400 Bad Request – {error:{message:"${"x".repeat(4000)}"}}`
    );
    expect(describeLlmFailure(long).length).toBeLessThanOrEqual(161);
    expect(describeLlmFailure(long, 60).length).toBeLessThanOrEqual(61);
  });

  /**
   * THE CASE THAT PROVES THE EXTRACTION, not just a roomier budget.
   *
   * A first version of this test used only the short body above, where the reason happens to fall
   * inside the first 160 characters — so a plain `slice(0, 160)` passed it, and the helper could
   * have been replaced by one without failing anything. Providers echo the offending request
   * ahead of their explanation, which is exactly when a slice keeps losing it.
   */
  it("finds the reason even when the body buries it", () => {
    const buried = new Error(
      "LLM invoke failed (groq, model=openai/gpt-oss-20b): 400 Bad Request – " +
        `{error:{param:"messages",failed_generation:"${"echoed request ".repeat(40)}",` +
        'message:"Failed to generate JSON. Please adjust your prompt.",code:"json_validate_failed"}}'
    );
    const out = describeLlmFailure(buried);
    expect(
      buried.message.slice(0, 160),
      "this test no longer demonstrates anything a slice cannot do"
    ).not.toContain("Failed to generate JSON");
    expect(out, "the reason is still lost when the provider echoes the request first").toContain(
      "Failed to generate JSON"
    );
    expect(out, "the echoed request was carried into the log").not.toContain("echoed request");
  });
});

/* ═══════════════════════ every other shape still reads ═══════════════════════ */

describe("it never makes an error less readable than before", () => {
  /** A plain message has no body to extract — it must come back intact. */
  it("passes a non-provider error through", () => {
    expect(describeLlmFailure(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("handles an empty or missing error without throwing", () => {
    expect(() => describeLlmFailure(undefined)).not.toThrow();
    expect(describeLlmFailure(undefined)).toBe("unknown error");
    expect(describeLlmFailure(new Error(""))).toBe("unknown error");
  });

  /** The quota message RONDE 117 relies on must survive — it is read by an operator. */
  it("keeps a quota explanation", () => {
    const quota = new Error(
      "LLM invoke failed (groq, model=openai/gpt-oss-120b): 429 Too Many Requests – " +
        '{error:{message:"Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199683"}}'
    );
    const out = describeLlmFailure(quota);
    expect(out).toContain("tokens per day");
    expect(out).toContain("429");
  });

  /** A body with no `message` field still yields something better than a brace. */
  it("falls back to the body when there is no message field", () => {
    const out = describeLlmFailure(
      new Error("LLM invoke failed (gemini, model=x): 403 Forbidden – PERMISSION_DENIED")
    );
    expect(out).toContain("gemini");
    expect(out).toMatch(/PERMISSION_DENIED|Forbidden/);
  });
});

/* ═══════════════════════ the callers that lost it now use it ═══════════════════════ */

describe("the three passes that failed in render 562", () => {
  const cases: Array<[string, string]> = [
    ["editorialReorder.ts", "reorder skipped"],
    ["editorialSequencePlanner.ts", "storyboard LLM failed"],
    ["semanticVisualMatching.ts", "LLM analysis failed"],
  ];

  it.each(cases)("%s describes its failure instead of slicing it", (file, marker) => {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const at = src.indexOf(marker);
    expect(at, `${marker} has moved`).toBeGreaterThan(-1);
    const line = src.slice(at, src.indexOf("\n", at + marker.length) + 1);
    expect(line, `${file} still cuts the reason off`).toContain("describeLlmFailure(err)");
    expect(line, `${file} still slices the raw message`).not.toMatch(/message\?\.slice\(/);
  });

  it("each of them imports it rather than keeping a local copy", () => {
    for (const [file] of cases) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, `${file} does not import the shared helper`).toMatch(
        /import \{[^}]*describeLlmFailure[^}]*\} from "\.\/_core\/llm"/
      );
    }
  });
});
