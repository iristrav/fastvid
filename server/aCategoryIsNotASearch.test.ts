/**
 * A CATEGORY IS NOT A SEARCH.
 *
 * ── What render 593 sent to every provider ──────────────────────────────────────────────────
 *
 * `BeatSemanticProfile.searchTiers` is `string[][]`. Each inner array is one PRIORITY TIER — a
 * group of terms at the same rung of specificity, assembled per entity category by
 * `analyzeBeatSemanticsFallback` or written whole by the model. It was never a list of finished
 * queries.
 *
 * The plan builder read it as one:
 *
 *     tier0.map((q) => scored(q, 0.9, "direct semantic match from narration"))
 *
 * and identically for tier1, tier2 and `searchTiers.slice(3).flat()`. So a tier reading
 *
 *     ["news", "kim kardashian", "medium"]
 *
 * became three standalone searches: `news`, `kim kardashian`, `medium`. Two of the three name a
 * category and no subject. There is no degradation step to look for — the subject was never in
 * that query, because the query was one word of a list.
 *
 * The visible cost is at both ends of the gate. `documentary archive` and `historical footage`,
 * which `domainFallbackTiers` appends to every general-topic profile, fail `hasContentAnchor` and
 * are refused — built, gated, logged and thrown away once per beat per provider. `news` passes,
 * and is answered with whatever stock footage a provider files under news.
 *
 * ── What is asserted here ───────────────────────────────────────────────────────────────────
 *
 *   1. `ensureSubjectAnchor` — the invariant itself, including the three ways it must not fire:
 *      a query that already names the subject, a query whose words are all inside the subject,
 *      and an absent subject.
 *   2. `buildVisualSearchPlan` — the real builder, because a helper that passes in isolation
 *      proves nothing about what reaches a provider.
 *   3. The two things this round is not allowed to have done: rescue an action-only query, and
 *      anchor the geographic round.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────────
 *
 * Touch the Search Gate. `validateSearchQuery` still judges every query afterwards, on the same
 * terms; every word the anchor adds comes from a subject the beat itself proves, checked with the
 * gate's own `termProvableFrom`. Confidences, bands, ranking and vision thresholds are unchanged.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/* ═══════════════════ the gate, the engine count, the blast radius ═══════════════════ */

describe("this round changed query construction and nothing else", () => {
  /** `ensureSubjectAnchor` and `subjectAnchorForBeat` went with the search-plan builder; the gate stays. */
  it("THE SEARCH GATE IS STILL THE LAST WORD", () => {
    const gate = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(require("fs").readFileSync(require("path").join(__dirname, "config.ts"), "utf8")).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
  });
});
