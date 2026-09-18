/**
 * THE LADDER IS WRITTEN DOWN — and the copies of it cannot drift apart.
 *
 * ── What the audit found ────────────────────────────────────────────────────────────────────
 *
 * FastVid's sourcing order — YouTube, its own archive, the open sources, licensed stock — is real
 * policy, and it existed only as the shape of about thirty beat-resolution functions calling
 * providers across 94 direct call sites:
 *
 *     fetchPexelsClips                        11 call sites, 11 enclosing functions
 *     fetchPixabayClips                       10
 *     fetchCuratedArchiveBeatClipWithLineage  13
 *     fetchWikimediaImages                     8
 *     fetchInternetArchiveClips                7
 *     fetchNasaVideoClips / fetchOpenverseImages / fetchSerpAPIImages   6 each
 *     … and so on down to NARA and GDELT at one each
 *     fetchYouTubeCCClips                      1   (RONDE 260B)
 *
 * Thirty functions each holding a copy of the policy is thirty chances for one to hold a different
 * copy, and no way to read the policy without reading all thirty.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * The table, and its agreement with the two places the order is ALSO expressed: the ranking bonus
 * in `retrievalFunnel` and the providers the search gate actually admits. A new provider added to
 * one and not the others is the failure mode — `youtube_cc` was missing from the bonus table for
 * three rounds and defaulted silently into the stock tier, which is what kept it to one beat of
 * nineteen in render 577.
 *
 * ── What it deliberately does not claim ─────────────────────────────────────────────────────
 *
 * That the pipeline OBEYS the ladder at runtime. It cannot: the order lives in thirty callers and
 * this module routes nothing. `tierMayRun` is the rule those callers will be held to once they are
 * collapsed into one orchestrator; here it is tested as the rule, not as the practice.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  PROVIDER_TIER,
  SOURCING_TIERS,
  formatTierAttempt,
  providerTier,
  providersInTier,
  tierMayRun,
  tierNumber,
  type SourcingTier,
} from "./sourcingTiers";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
const POOL = readFileSync(join(__dirname, "scenePool.ts"), "utf8");

/* ═══════════ 1 — the ladder itself ═══════════ */

describe("§2 — four tiers, in the order the brief names", () => {
  it("YouTube is tier 1 and stock is tier 4", () => {
    expect(tierNumber("YOUTUBE")).toBe(1);
    expect(tierNumber("OWN_ARCHIVE")).toBe(2);
    expect(tierNumber("OPEN_SOURCES")).toBe(3);
    expect(tierNumber("STOCK")).toBe(4);
  });

  it("every tier has at least one provider — none is an empty promise", () => {
    for (const tier of SOURCING_TIERS) {
      expect(providersInTier(tier), `${tier} has no providers`).not.toEqual([]);
    }
  });

  it("the own archive is tier 2, for every subject and not only historical ones", () => {
    /**
     * §3 — the archive is not a history feature. Nothing in this table can make it one, and that
     * is the point: a tier is a position in the ladder, not a topic.
     */
    expect(providerTier("archive")).toBe("OWN_ARCHIVE");
    expect(providerTier("curated")).toBe("OWN_ARCHIVE");
  });

  it("an unknown provider is null, never a default tier", () => {
    /**
     * A silent default is how `youtube_cc` was ranked with Pexels: a missing row reading as a
     * deliberate placement. Null forces the next test to notice instead.
     */
    expect(providerTier("something_new")).toBeNull();
  });
});

/* ═══════════ 2 — the rule the orchestrator will enforce ═══════════ */

describe("§13 — a tier may run once the tiers above it have been tried", () => {
  const set = (...t: SourcingTier[]): Set<SourcingTier> => new Set(t);

  it("stock is refused when nothing above it has been attempted", () => {
    const verdict = tierMayRun("pexels", set());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.skipped).toEqual(["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES"]);
  });

  it("stock is allowed once all three tiers above it have been attempted", () => {
    expect(tierMayRun("pexels", set("YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES")).ok).toBe(true);
  });

  it("a tier the caller has DECLINED counts as handled — §13's exception", () => {
    /**
     * "Tenzij de centrale orchestrator aantoonbaar beslist dat een tier niet beschikbaar is."
     * A decline is a decision and is passed in; an omission is not, and is refused above.
     */
    const verdict = tierMayRun("pexels", set("OPEN_SOURCES"), set("YOUTUBE", "OWN_ARCHIVE"));
    expect(verdict.ok).toBe(true);
  });

  it("a declined tier still has to be named — silence is not a decline", () => {
    const verdict = tierMayRun("pexels", set("OPEN_SOURCES"), set("YOUTUBE"));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.skipped).toEqual(["OWN_ARCHIVE"]);
  });

  it("going back UP the ladder is always allowed", () => {
    /** Asking the archive again after stock is not skipping a tier; it is returning to one. */
    expect(tierMayRun("internet_archive", set("YOUTUBE", "OWN_ARCHIVE", "STOCK")).ok).toBe(true);
    expect(tierMayRun("youtube_cc", set()).ok).toBe(true);
  });

  it("the same tier twice is allowed", () => {
    expect(tierMayRun("wikimedia", set("YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES")).ok).toBe(true);
  });

  it("an untiered provider is never refused by a rule that does not know it", () => {
    expect(tierMayRun("something_new", new Set()).ok).toBe(true);
  });
});

/* ═══════════ 3 — the copies of the order cannot drift ═══════════ */

describe("§22 — every provider the code searches has a tier", () => {
  /** Every provider string the search gate is actually called with, across both modules. */
  const gatedProviders = (): string[] => {
    const found = new Set<string>();
    for (const src of [PIPELINE, POOL]) {
      for (const re of [
        /searchGateDecision\(\s*"([a-z_]+)"/g,
        /admitProviderQuery\(\s*"([a-z_]+)"/g,
        /cachedProviderSearch\(\s*[\w.]+,\s*"([a-z_]+)"/g,
      ]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) found.add(m[1]);
      }
    }
    return [...found].sort();
  };

  it("the scan finds providers — it has not gone blind", () => {
    expect(gatedProviders().length).toBeGreaterThanOrEqual(12);
  });

  it("every provider that reaches the search gate is on the ladder", () => {
    /**
     * The test §22 asks for, and the one that fails the day a provider is added to the pipeline
     * and not to the table — which is the exact shape of the `youtube_cc` ranking bug.
     */
    const untiered = gatedProviders().filter((p) => providerTier(p) === null);
    expect(untiered, "a provider is searched and belongs to no tier").toEqual([]);
  });

  it("the ranking bonus agrees with the ladder — no source outranks a better tier", () => {
    /**
     * `EXTERNAL_SOURCE_TIER_BONUS` expresses the same order as a number. The two are allowed to
     * disagree about the spacing between sources; they may not disagree about which comes first,
     * because then a render's ranking and its routing would be pulling in opposite directions.
     */
    const bonuses = new Map<string, number>();
    const re = /^\s{2}([a-z_]+):\s*(0(?:\.\d+)?),?$/gm;
    const table = FUNNEL.slice(
      FUNNEL.indexOf("const EXTERNAL_SOURCE_TIER_BONUS"),
      FUNNEL.indexOf("};", FUNNEL.indexOf("const EXTERNAL_SOURCE_TIER_BONUS"))
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(table))) bonuses.set(m[1], Number(m[2]));
    expect(bonuses.size, "the bonus table could not be read").toBeGreaterThanOrEqual(6);

    for (const [a, aBonus] of bonuses) {
      for (const [b, bBonus] of bonuses) {
        const ta = providerTier(a);
        const tb = providerTier(b);
        if (!ta || !tb) continue;
        if (tierNumber(ta) >= tierNumber(tb)) continue;
        expect(
          aBonus,
          `${a} is tier ${tierNumber(ta)} and ${b} is tier ${tierNumber(tb)}, ` +
            `but ${a} ranks ${aBonus} against ${b}'s ${bBonus}`
        ).toBeGreaterThanOrEqual(bBonus);
      }
    }
  });

  it("stock carries no ranking bonus, which is what being last means", () => {
    for (const provider of providersInTier("STOCK")) {
      const at = FUNNEL.indexOf(`\n  ${provider}: `);
      if (at < 0) continue; // not every stock source is in the ranking table
      const value = /:\s*([\d.]+)/.exec(FUNNEL.slice(at, at + 40))?.[1];
      expect(Number(value), `${provider} has a tier bonus`).toBe(0);
    }
  });
});

/* ═══════════ 4 — the line a render log can be read with ═══════════ */

describe("§10 — the attempt says which tier it was and whether the order held", () => {
  it("an in-order attempt names its tier", () => {
    const line = formatTierAttempt(1, 2, "internet_archive", { ok: true });
    expect(line).toContain("s1b2");
    expect(line).toContain("provider=internet_archive");
    expect(line).toContain("tier=3:OPEN_SOURCES");
    expect(line).toContain("order=OK");
  });

  it("an out-of-order attempt names what it skipped", () => {
    const line = formatTierAttempt(0, 0, "pexels", tierMayRun("pexels", new Set()));
    expect(line).toContain("tier=4:STOCK");
    expect(line).toContain("order=OUT_OF_ORDER");
    expect(line).toContain("1:YOUTUBE");
    expect(line).toContain("2:OWN_ARCHIVE");
    expect(line).toContain("3:OPEN_SOURCES");
  });

  it("an untiered provider says so rather than claiming a tier", () => {
    expect(formatTierAttempt(0, 0, "something_new", { ok: true })).toContain("tier=UNTIERED");
  });
});

/* ═══════════ 5 — nothing about this round changed the routes ═══════════ */

describe("§25 — this module routes nothing", () => {
  it("it calls no provider and starts no search", () => {
    const src = readFileSync(join(__dirname, "sourcingTiers.ts"), "utf8");
    /** Only the code, not the prose: the doc comments name providers on purpose. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of ["fetch(", "fetchPexelsClips", "fetchYouTubeCCClips", "await "]) {
      expect(code, `sourcingTiers.ts contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("RONDE 260B's single YouTube door is untouched", () => {
    const hosts: string[] = [];
    const re = /fetchYouTubeCCClips\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(PIPELINE))) {
      const lineStart = PIPELINE.lastIndexOf("\n", m.index) + 1;
      const line = PIPELINE.slice(lineStart, PIPELINE.indexOf("\n", m.index));
      if (line.includes("export async function")) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      hosts.push(line.trim().slice(0, 40));
    }
    expect(hosts).toHaveLength(1);
  });
});
