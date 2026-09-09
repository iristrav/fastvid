/**
 * RONDE 216 — THREE KINDS OF WORK RENDER 575 PAID FOR AND COULD NEVER USE.
 *
 * The render ran 4127 seconds, was stopped by the watchdog, and delivered nothing for scene 0.
 * RONDE 215 fixed the reason the scene ended EMPTY. This is where its time went.
 *
 * ── §1 — a pair of quote marks around nothing ───────────────────────────────────────────────
 *
 *     [SearchQueryAudit] render=575 provider=gdelt_tv route=fetchGdeltTvNewsClips
 *                        query="" status=ALLOWED                                  ×48
 *
 * `buildGdeltTvQueries` opens with `const quoted = \`"${personName}"\``, so a beat with no person
 * produced a phrase search for the empty string — 48 times, to a live provider. The route exists
 * to find broadcast footage OF A PERSON; with no person the honest number of queries is zero.
 *
 * ── §2 — 356 requests issued into an already-cancelled scene ────────────────────────────────
 *
 *     356×  "cancelled by the enclosing scene budget before its own timeout —
 *            the request itself did not time out"
 *
 *       9×  Internet Archive search failed for title:(General George) AND mediatype:movies
 *       9×  Internet Archive search failed for collection:tvnews AND General George
 *       9×  Internet Archive search failed for "subject:"General George""
 *
 * Twenty-seven attempts at three queries, every one cancelled by the SAME exhausted budget that
 * had already cancelled the previous one. `signal.aborted` means the scope has already given up:
 * everything started after that point is dead on arrival, and the render still paid to build the
 * query, run the audit, open the request and construct the error.
 *
 * No budget is raised and no timeout is lengthened here. Nothing that could still have succeeded
 * is skipped — only work whose outcome was settled before it started.
 *
 * ── §3 — a table that invented a word the script never said ─────────────────────────────────
 *
 *     query="germany" status=BLOCKED blockedTerms=["germany"] reason=UNVERIFIED_TERM     ×104
 *     terms=[…,"Berlin","German"]
 *
 * The script says "German"; a hardcoded anchor table emits "Germany". The gate refused all 104 and
 * was right to. The tempting wrong fix was a looser stemmer so "German" would prove "germany" —
 * that opens the gate instead of fixing the builder, and would let "arm" prove "army". The gate is
 * untouched; the builder now applies the gate's own measure before spending a request.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { termProvableFrom, validateSearchQuery } from "./searchQueryContract";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ 1. the empty GDELT query ═══════════ */

describe("R216 §1 — a search that names nobody is not built", () => {
  const builder = PIPE.slice(
    PIPE.indexOf("function buildGdeltTvQueries("),
    PIPE.indexOf("function parseGdeltArchivePreviewUrl(")
  );

  it("THE 48 EMPTY QUERIES: no person means no queries", () => {
    expect(builder).toContain('const person = (personName ?? "").trim();');
    expect(builder).toContain("if (!person) return [];");
  });

  it("and the guard stands before the quoting, not after it", () => {
    const guard = builder.indexOf("if (!person) return [];");
    const quote = builder.indexOf("const quoted =");
    expect(guard).toBeGreaterThan(0);
    expect(quote).toBeGreaterThan(0);
    expect(guard, "the empty string is quoted before anything checks it").toBeLessThan(quote);
  });

  it("the whole builder now works from the trimmed name, so a blank cannot leak past", () => {
    expect(builder, "an untrimmed personName is still interpolated").not.toContain(
      "`\"${personName}\"`"
    );
    expect(builder).toContain("scriptEventSearchQueries(clean, [person])");
  });

  it("THE GATE ALREADY REFUSED A BARE EMPTY QUERY — this stops it being built", () => {
    // Proof the fix belongs in the builder: the validator's answer was never the problem.
    expect((validateSearchQuery("") as any).reason).toBe("EMPTY_QUERY");
    expect((validateSearchQuery('""') as any).ok).toBe(false);
  });
});

/* ═══════════ 2. no search into a spent budget ═══════════ */

describe("R216 §2 — a cancelled scene stops issuing requests", () => {
  const fn = PIPE.slice(
    PIPE.indexOf("export async function cachedProviderSearch<T>("),
    PIPE.indexOf("export function getCachedProviderAsset(")
  );

  it("THE CHECK IS IN THE ONE PLACE EVERY PROVIDER SEARCH PASSES", () => {
    expect(fn).toContain("sceneFetchScopeStorage.getStore()");
    expect(fn).toContain("sceneScope?.controller.signal.aborted");
  });

  it("it declines BEFORE the search runs, which is the whole point", () => {
    const check = fn.indexOf("if (sceneScope?.controller.signal.aborted)");
    const call = fn.indexOf("payload = await search();");
    expect(check).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(0);
    expect(check).toBeLessThan(call);
  });

  it("A CUT-OFF PROVIDER IS STILL RECORDED AS CUT OFF, never as 'nothing found'", () => {
    /**
     * RONDE 100B's distinction has to survive: the search memory must not read a cancellation as
     * "this source has nothing". The early return records the same fact the catch below does.
     */
    const at = fn.indexOf("if (sceneScope?.controller.signal.aborted)");
    expect(fn.slice(at, at + 700)).toContain("budgetCancelledProviders.add(");
    expect(fn, "the catch stopped recording it").toContain(
      "if (isScopeAbortError(err)) activeCache.budgetCancelledProviders.add("
    );
  });

  it("IT IS NOT SILENT — but it says so once per scope, not once per refusal", () => {
    expect(fn).toContain("scene budget already spent");
    expect(fn).toContain("sceneScope.budgetSpentReported = true;");
    const at = fn.indexOf("console.warn");
    expect(fn.slice(Math.max(0, at - 200), at)).toContain("if (!sceneScope.budgetSpentReported)");
  });

  it("NO BUDGET IS RAISED — the round changes what is spent, not what is allowed", () => {
    const budget = fs.readFileSync(path.join(__dirname, "sceneSearchBudget.ts"), "utf8");
    expect(budget).toContain("export const SCENE_SEARCH_MIN_MS = 60_000;");
    expect(budget).toContain("export const SCENE_SEARCH_MAX_FACTOR = 2.5;");
    expect(budget).toContain("export const SCENE_SEARCH_MS_PER_EXTRA_BEAT = 12_000;");
  });

  it("a scope that has NOT been cancelled is untouched", () => {
    // The guard is conditional on `aborted`; nothing else gates the normal path.
    const at = fn.indexOf("if (sceneScope?.controller.signal.aborted)");
    const block = fn.slice(at, fn.indexOf("const activeCache =", at));
    expect(block).toContain("return [] as unknown as T;");
    expect(block, "the normal path was made conditional too").not.toContain("payload");
  });
});

/* ═══════════ 3. the anchor table stops inventing terms ═══════════ */

describe("R216 §3 — an anchor the source cannot support is not built", () => {
  it("THE RENDER-575 CASE: a script saying 'German' does not prove 'Germany'", () => {
    const script = "The German high command had already left Berlin.";
    expect(termProvableFrom("Germany", script), "the builder still invents it").toBe(false);
    expect(termProvableFrom("Berlin", script)).toBe(true);
  });

  it("AND THE GATE AGREES — builder and gate reach the same answer", () => {
    /**
     * The whole justification for filtering in the builder: it must decline exactly what the gate
     * would refuse. `evidence` is the beat's own words, which is the ground truth both consult.
     */
    const script = "The German high command had already left Berlin.";
    const ctx = {
      persons: [], places: [], countries: [], events: [],
      actions: [], objects: [], time: [], years: [],
      evidence: script,
    } as never;
    expect((validateSearchQuery("germany", ctx) as any).ok, "the gate now allows it").toBe(false);
    expect((validateSearchQuery("Berlin", ctx) as any).ok, "the gate now refuses Berlin").toBe(true);
    // The builder reaches both answers on its own, without a context object.
    expect(termProvableFrom("germany", script)).toBe(false);
    expect(termProvableFrom("Berlin", script)).toBe(true);
  });

  it("a term the script DID say survives, in any inflection the stemmer knows", () => {
    expect(termProvableFrom("canal", "The canals froze over that winter.")).toBe(true);
    expect(termProvableFrom("bridges", "The bridge was blown at dawn.")).toBe(true);
  });

  it("PRODUCTION WORDS RIDE ALONG, exactly as the gate lets them", () => {
    expect(termProvableFrom("Berlin archival footage", "They entered Berlin in April.")).toBe(true);
  });

  it("an anchor of nothing but production words proves nothing", () => {
    expect(termProvableFrom("archival footage", "They entered Berlin in April.")).toBe(false);
    expect(termProvableFrom("", "They entered Berlin in April.")).toBe(false);
  });

  it("a term with an unsupported word beside a supported one is refused whole", () => {
    // The gate blocks a query on ANY unproven content word; this must match it.
    expect(termProvableFrom("Berlin Germany", "They entered Berlin in April.")).toBe(false);
  });

  it("no source text proves nothing at all", () => {
    expect(termProvableFrom("Berlin", "")).toBe(false);
  });

  it("THE STEMMER WAS NOT LOOSENED — 'arm' must never prove 'army'", () => {
    expect(termProvableFrom("army", "He raised his arm.")).toBe(false);
  });

  it("the anchor tables are filtered through it, and an empty result is not a topic", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("function extractVideoTopicAnchorsWithKey("),
      PIPE.indexOf("const DUTCH_STOCK_WORD_MAP")
    );
    expect(fn).toContain("termProvableFrom(a, source)");
    expect(fn).toContain('return { anchors: [], topicKey: "none" };');
    // Every return of anchors is now behind a length check, so "none" is reachable.
    expect((fn.match(/if \(anchors\.length\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
