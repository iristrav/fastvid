/**
 * THE LADDER IS WALKED, NOT JUST WRITTEN.
 *
 * ── What the previous round proved, and what it could not ───────────────────────────────────
 *
 * `sourcingTiers.ts` wrote the policy down and `tierMayRun` was tested as a rule. The runtime
 * still did not obey it: the order lived in about thirty beat-resolution functions, across 94
 * provider call sites, each with its own copy.
 *
 * ── Where the enforcement went ──────────────────────────────────────────────────────────────
 *
 * Into the one door every provider search already passes. `searchGateDecision` admits sixteen
 * external providers — thirteen through `cachedProviderSearch`, three through `admitProviderQuery`
 * — and now asks `admitProviderForTier` whether the tier may run yet. A rule asked there is asked
 * of every route at once, including the thirty that were never rewritten and any written later.
 *
 *     resolveBeatClip
 *       → runCentralVisualSourcing        opens the ladder for this beat
 *         → the existing strategies       still decide WHAT to search for
 *           → searchGateDecision          asks whether that TIER may run
 *             → provider
 *
 * ── What is tested here, and how ────────────────────────────────────────────────────────────
 *
 * The orchestrator against its real exported functions, with no provider anywhere near it: the
 * ladder is a decision about order, and a decision can be driven directly. The wiring — that the
 * gate consults it and that `resolveBeatClip` opens it — is checked against the source, because
 * that is a claim about every path rather than about the one a test happens to run.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  admitProviderForTier,
  currentBeatLadder,
  declineTier,
  formatLadder,
  noteTierAttempted,
  runCentralVisualSourcing,
} from "./centralVisualSourcing";
import {
  emptyQueryContext,
  searchGateDecision,
  withSearchProvenance,
} from "./searchQueryContract";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const CONTRACT = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const onBeat = <T>(run: () => Promise<T>, declined: Parameters<typeof runCentralVisualSourcing>[0]["declined"] = []) =>
  runCentralVisualSourcing({ renderId: "t", sceneIndex: 0, beatIndex: 0, declined }, run);

/* ═══════════ 1 — the order is enforced at runtime ═══════════ */

describe("§7 — no tier may be skipped", () => {
  it("stock is refused when nothing above it has run", async () => {
    await onBeat(async () => {
      const verdict = admitProviderForTier("pexels");
      expect(verdict.admitted).toBe(false);
      if (verdict.admitted) return;
      expect(verdict.skipped).toEqual(["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES"]);
    });
  });

  it("the ladder is walked in order and every tier is admitted in turn", async () => {
    await onBeat(async () => {
      expect(admitProviderForTier("youtube_cc").admitted).toBe(true);
      expect(admitProviderForTier("internet_archive").admitted).toBe(false); // tier 2 skipped
      noteTierAttempted("OWN_ARCHIVE", "curated");
      expect(admitProviderForTier("internet_archive").admitted).toBe(true);
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });

  it("an admitted search marks its tier attempted — nobody has to announce it", async () => {
    await onBeat(async () => {
      admitProviderForTier("youtube_cc");
      expect(currentBeatLadder()?.attempted.has("YOUTUBE")).toBe(true);
      expect(currentBeatLadder()?.attempted.has("OPEN_SOURCES")).toBe(false);
    });
  });

  it("a refused search does NOT mark its tier attempted", async () => {
    /** Otherwise one refused stock call would unlock every later one. */
    await onBeat(async () => {
      admitProviderForTier("pexels");
      expect(currentBeatLadder()?.attempted.has("STOCK")).toBe(false);
    });
  });
});

/* ═══════════ 2 — declined is not the same as not called ═══════════ */

describe("§6 — a decline is a decision, an omission is not", () => {
  it("a declined tier lets the tiers below it run", async () => {
    await onBeat(
      async () => {
        expect(admitProviderForTier("pexels").admitted).toBe(true);
      },
      [
        { tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" },
        { tier: "OWN_ARCHIVE", reason: "ARCHIVE_EMPTY" },
        { tier: "OPEN_SOURCES", reason: "ARCHIVAL_DISABLED" },
      ]
    );
  });

  it("a tier that is merely unasked still blocks the ones below", async () => {
    await onBeat(
      async () => {
        const verdict = admitProviderForTier("pexels");
        expect(verdict.admitted).toBe(false);
        if (verdict.admitted) return;
        expect(verdict.skipped).toEqual(["OWN_ARCHIVE"]);
      },
      [
        { tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" },
        { tier: "OPEN_SOURCES", reason: "ARCHIVAL_DISABLED" },
      ]
    );
  });

  it("a decline made during the beat counts from that moment", async () => {
    await onBeat(async () => {
      expect(admitProviderForTier("pexels").admitted).toBe(false);
      declineTier("YOUTUBE", "NO_YOUTUBE_CAPABILITY");
      declineTier("OWN_ARCHIVE", "ARCHIVE_EMPTY");
      declineTier("OPEN_SOURCES", "ARCHIVAL_DISABLED");
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
  });

  it("the three states stay three states in the line a person reads", async () => {
    await onBeat(
      async () => {
        admitProviderForTier("youtube_cc");
        const line = formatLadder(currentBeatLadder()!);
        expect(line).toContain("1=ATTEMPTED");
        expect(line).toContain("2=DECLINED(ARCHIVE_EMPTY)");
        expect(line).toContain("3=NOT_REACHED");
        expect(line).toContain("4=NOT_REACHED");
      },
      [{ tier: "OWN_ARCHIVE", reason: "ARCHIVE_EMPTY" }]
    );
  });
});

/* ═══════════ 3 — the scope, and what happens outside it ═══════════ */

describe("§2 — outside a beat there is no order to enforce", () => {
  it("a provider outside the orchestrator is always admitted", () => {
    expect(currentBeatLadder()).toBeUndefined();
    expect(admitProviderForTier("pexels").admitted).toBe(true);
  });

  it("each beat gets its own ladder — one beat's archive does not unlock another's stock", async () => {
    await onBeat(async () => {
      noteTierAttempted("OWN_ARCHIVE", "curated");
      admitProviderForTier("youtube_cc");
      admitProviderForTier("internet_archive");
      expect(admitProviderForTier("pexels").admitted).toBe(true);
    });
    await onBeat(async () => {
      expect(admitProviderForTier("pexels").admitted).toBe(false);
    });
  });

  it("the ladder is closed even when the beat throws", async () => {
    await expect(
      onBeat(async () => {
        admitProviderForTier("youtube_cc");
        throw new Error("beat failed");
      })
    ).rejects.toThrow("beat failed");
    expect(currentBeatLadder(), "the scope leaked past the beat").toBeUndefined();
  });

  /**
   * THE RULE THIS ROUND TIGHTENED.
   *
   * It used to read "an untiered provider is never refused by a rule that does not know it", and
   * admitted `something_new` everywhere. The integrity audit called that what it is: a silent
   * bypass. A provider name `sourcingTiers` has never heard of is a sourcing route nobody has
   * placed, and admitting it inside a beat means the tier table is no longer the whole truth.
   *
   * Outside a beat the old answer still holds — there is no order to enforce — so this now asserts
   * both halves rather than one.
   */
  it("an unplaced provider is refused inside a beat and admitted outside one", async () => {
    expect(admitProviderForTier("something_new").admitted).toBe(true);
    await onBeat(async () => {
      const verdict = admitProviderForTier("something_new");
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toBe("TIER_UNKNOWN_PROVIDER");
    });
  });
});

/* ═══════════ 4 — the wiring, checked against the source ═══════════ */

describe("§24 — the orchestrator is production-reachable, not a library", () => {
  it("resolveBeatClip runs everything inside the ladder", () => {
    const at = PIPELINE.indexOf("async function resolveBeatClip(");
    expect(at, "resolveBeatClip moved").toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("runCentralVisualSourcing(");
    /** Both branches inside the scope, not one of them. */
    expect(body.indexOf("runCentralVisualSourcing(")).toBeLessThan(body.indexOf("beatPrimaryFetch("));
    expect(body.indexOf("runCentralVisualSourcing(")).toBeLessThan(
      body.indexOf("resolveBeatClipForBeat(")
    );
  });

  it("the gate actually REFUSES an out-of-order provider, not merely consults the ladder", async () => {
    /**
     * A mutation that neutered the refusal — `if (false && !tierVerdict.admitted)` — survived the
     * first version of this file, because the assertion below it only read the source and the call
     * was still there. This runs the real gate twice with the same query: once outside a beat,
     * where there is no order to enforce, and once inside one where stock would skip three tiers.
     * The difference between the two answers is the enforcement.
     */
    const QUERY = "los angeles county courthouse exterior";
    const ctx = emptyQueryContext(QUERY);

    const outside = withSearchProvenance(ctx, () =>
      searchGateDecision("pexels", QUERY, "test:outside-a-beat")
    );
    expect(outside.admitted, "the query itself is refused, so this proves nothing").toBe(true);

    const inside = await onBeat(async () =>
      withSearchProvenance(ctx, () => searchGateDecision("pexels", QUERY, "test:inside-a-beat"))
    );
    expect(inside.admitted, "stock was admitted with three tiers unasked").toBe(false);
  });

  it("the gate admits the same provider once the ladder allows it", async () => {
    const QUERY = "los angeles county courthouse exterior";
    const ctx = emptyQueryContext(QUERY);
    const admitted = await onBeat(
      async () => withSearchProvenance(ctx, () => searchGateDecision("pexels", QUERY, "test:in-order")),
      [
        { tier: "YOUTUBE", reason: "NO_YOUTUBE_CAPABILITY" },
        { tier: "OWN_ARCHIVE", reason: "ARCHIVE_EMPTY" },
        { tier: "OPEN_SOURCES", reason: "ARCHIVAL_DISABLED" },
      ]
    );
    expect(admitted.admitted).toBe(true);
  });

  it("the search gate asks the ladder, after the query contract and before the provider", () => {
    const at = CONTRACT.indexOf("export function searchGateDecision(");
    const body = CONTRACT.slice(at, CONTRACT.indexOf("\n}\n", at));
    expect(body).toContain("admitProviderForTier(provider)");
    /**
     * The refusal REASON comes from the verdict, not from a literal written here. The gate now has
     * two of them to report — an out-of-order tier and an unplaced provider — and a hardcoded
     * string would have printed the first for both.
     */
    expect(body).toContain("tierVerdict.reason");
    expect(body).not.toContain('"TIER_OUT_OF_ORDER"');
    /** After the validator: a malformed query must not be able to mark a tier attempted. */
    expect(body.indexOf("if (!verdict.ok)")).toBeLessThan(body.indexOf("admitProviderForTier"));
    expect(body.indexOf("admitProviderForTier")).toBeLessThan(
      body.indexOf('searchGateAudit.record("queriesSent"')
    );
  });

  it("the own archive records tier 2 itself, because it passes no search gate", () => {
    const at = PIPELINE.indexOf("async function fetchCuratedArchiveBeatClipWithLineage(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain('noteTierAttempted("OWN_ARCHIVE"');
  });

  it("the declines handed in are facts the code has, not guesses", () => {
    const at = PIPELINE.indexOf("function beatSourcingDeclines(");
    expect(at, "beatSourcingDeclines moved").toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    for (const known of [
      "youtubeSourcingEnabled()",
      "youtubeCcReady()",
      "maxEntityYoutubePerVideo",
      "PEXELS_API_KEY",
    ]) {
      expect(body, known).toContain(known);
    }
  });
});

/* ═══════════ 5 — nothing else was loosened ═══════════ */

describe("§23 — the earlier rounds are intact", () => {
  it("this module searches nothing and adopts nothing", () => {
    const src = readFileSync(join(__dirname, "centralVisualSourcing.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["fetch(", "adoptClip", "fetchPexelsClips", "fetchYouTubeCCClips"]) {
      expect(code, `centralVisualSourcing.ts contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the single YouTube door still stands", () => {
    const calls = [...PIPELINE.matchAll(/fetchYouTubeCCClips\(/g)].filter((m) => {
      const ls = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(ls, PIPELINE.indexOf("\n", m.index));
      return !line.includes("export async function") && !/^\s*(\*|\/\/)/.test(line);
    });
    expect(calls).toHaveLength(1);
  });

  it("the YouTube reserve and one-turn register are untouched", () => {
    expect(PIPELINE).toContain("reserveYoutubeTurn(scope);");
    expect(PIPELINE).toContain("export function claimYoutubeTurn(");
    expect(PIPELINE).toContain("export function endYoutubeTurnForBeat(");
  });

  it("strictQueries is still honoured on both stock providers", () => {
    expect(PIPELINE).toContain("strictQueries ? [query] : [query, ...(extraQueries ?? [])]");
    expect(PIPELINE).toContain("strictQueries ? q : simplifyStockSearchWord(q, q, true)");
  });

  it("capabilities are still independent of video length", () => {
    expect(PIPELINE).toContain("const LENGTH_INDEPENDENT_CAPABILITIES = {");
  });
});
