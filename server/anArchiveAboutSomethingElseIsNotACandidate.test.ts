/**
 * AN ARCHIVE ABOUT SOMETHING ELSE IS NOT A CANDIDATE — AND A SPENT PARENT IS NOT AN EXPIRED CHILD.
 *
 * Two production defects from video 593 (commit a6af2d8, 13:39→14:04, refused by the export gate
 * for `10/16 beat(s) got ONLY a card`).
 *
 * ── A. THE ARCHIVE ROUTER WAS NEVER ASKED ───────────────────────────────────────────────────
 *
 * A one-minute video about Kim Kardashian in 2018 was offered clips from a WW2 archive on every
 * sentence, and the picture editor said exactly why each time:
 *
 *     s0b3  "The frames show Adolf Hitler, who is unrelated to the narration about the
 *            Kardashians."
 *     s2b0  "a historical event likely from early 20th century Europe, unrelated to the
 *            narration about a modern E! News interview with Kim Kardashian."
 *
 *     [Quality] bron ww2 leverde 7 beoordeelde kandidaten en geen enkele bruikbare (UNRELATED)
 *     [Quality] score=0/100, clips=15 [ww2=1, UNVERIFIED=10, wikimedia=4]
 *
 * The 593 log contains NO `[ArchiveRouter]` line at all. Every branch of the router prints one,
 * so it was never called: all four production call sites of `listCuratedArchiveCandidates` passed
 * `searchAllArchives: true`, which took every active archive and skipped routing entirely.
 *
 * And it would not have helped. The router had no outcome meaning "nothing here fits" — a score
 * below the floor fell through to "using anyway", and no score at all fell through to
 * `return archives`. A router whose worst case is "all of them" keeps nothing out.
 *
 * ── B. A PARENT IN ITS TRANSFER RESERVE ERASED A CHILD THAT HAD TIME ────────────────────────
 *
 *     [ProviderSearch] clock="Pexels stock scene 2 beat 3"
 *                      granted=2s used=0s transferReserve=3s
 *
 * A reserve of three seconds inside a window of two, with nothing elapsed. `transferReserveFor`
 * cannot produce that — it is `min(TRANSFER_RESERVE_MS, floor(window/2))` and answers 1s for a 2s
 * window. The 3s is `deadline - searchDeadline`, and the search deadline was inherited from a
 * parent already past its own, putting it BEFORE this scope opened.
 *
 * ── What neither fix does ───────────────────────────────────────────────────────────────────
 *
 * No gate is relaxed, no threshold moves, no budget grows by a millisecond, and no archive
 * scoring rule changes. `ARCHIVE_ROUTE_MIN_SCORE`, `scoreArchiveMetadata`,
 * `scoreArchiveAssetSample`, `TRANSFER_RESERVE_MS` and `transferReserveFor` are untouched.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { scoreArchiveMetadata } from "./curatedMediaSourcing";
import {
  TRANSFER_RESERVE_MS,
  remainingSearchMs,
  transferReserveFor,
  withSceneFetchTimeout,
} from "./videoPipeline";

const SOURCING = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The archive render 593 actually had, and the beat it was actually asked about. */
const WW2_ARCHIVE = {
  name: "ww2",
  description: "Second World War archival footage, 1939-1945",
  nicheTags: ["world war ii", "wwii", "hitler", "berlin", "military", "1945"],
};
const KARDASHIAN_TAGS = ["kim kardashian", "kardashian", "2018", "celebrity", "rumors"];

/* ═══════════════════ A. relevance is judged, and can say no ═══════════════════ */

describe("the archive scorer already knew — nothing was reading it", () => {
  it("A WW2 ARCHIVE SCORES ZERO FOR A KARDASHIANS BEAT", () => {
    /**
     * The scoring rule is unchanged; this pins what it has always said. Every branch of
     * `scoreArchiveMetadata` looks for overlap between the beat's tags and the archive's name,
     * description or niche tags. A 2018 celebrity beat overlaps none of a WW2 archive's.
     */
    expect(scoreArchiveMetadata(WW2_ARCHIVE, KARDASHIAN_TAGS, [])).toBe(0);
  });

  it("and a matching archive still scores, so routing is a selection and not a ban", () => {
    const celebrityArchive = {
      name: "celebrity press",
      description: "Red carpet and celebrity press footage",
      nicheTags: ["celebrity", "red carpet", "press"],
    };
    expect(scoreArchiveMetadata(celebrityArchive, KARDASHIAN_TAGS, [])).toBeGreaterThan(0);
    /** And the WW2 archive still scores for the beats it is actually for. */
    expect(scoreArchiveMetadata(WW2_ARCHIVE, ["hitler", "berlin", "1945"], [])).toBeGreaterThan(0);
  });

  it("a beat with no tags at all scores 1 — no information, never a refusal", () => {
    /**
     * The honesty rule this codebase keeps: missing information is not evidence against. A beat
     * that proves nothing cannot be used to rule an archive out, and the router's no-tag branch
     * keeps every archive for exactly that reason.
     */
    expect(scoreArchiveMetadata(WW2_ARCHIVE, [], [])).toBe(1);
  });
});

describe("the router now has the outcome it was missing", () => {
  const router = SOURCING.slice(
    SOURCING.indexOf("export async function resolveArchivesForVisualQuery"),
    SOURCING.indexOf("/** Everything scoreCuratedAsset derives purely from beatText")
  );

  it("NO_RELEVANT_ARCHIVE IS A REAL OUTCOME, and it returns nothing", () => {
    expect(router).toContain("NO_RELEVANT_ARCHIVE");
    const at = router.indexOf("NO_RELEVANT_ARCHIVE");
    expect(router.slice(at), "the no-match branch no longer ends in an empty list").toContain(
      "return [];"
    );
  });

  it("THE 'ALL ARCHIVES' FALLBACK IS GONE FROM THE NO-MATCH PATH", () => {
    /**
     * The exact line render 593 needed and did not have. `return archives` survives in exactly
     * one place — the branch where there are no tags to judge with — and that branch says so.
     */
    const returnsAll = [...router.matchAll(/return archives;/g)];
    expect(returnsAll).toHaveLength(1);
    const before = router.slice(0, returnsAll[0]!.index!);
    expect(before, "the surviving `return archives` is not the no-tags branch").toContain(
      "relevance cannot be judged"
    );
  });

  it("the single-archive shortcut that skipped judgement entirely is gone", () => {
    /** `if (archives.length <= 1) return archives;` let one archive through unasked. */
    expect(router).not.toContain("archives.length <= 1");
    expect(router).toContain("archives.length === 0");
  });

  it("THE SCORING AND ITS FLOOR ARE UNTOUCHED", () => {
    expect(SOURCING).toContain("const ARCHIVE_ROUTE_MIN_SCORE = 8;");
    expect(router).toContain("r.score >= ARCHIVE_ROUTE_MIN_SCORE");
    expect(router).toContain("ranked[0].score > 0");
    expect(router).toContain("weak tag overlap, using anyway");
  });
});

describe("the per-beat route reads the router — the half that was missing", () => {
  it("THE BYPASS IS GONE: searchAllArchives no longer skips relevance", () => {
    /**
     * This is the line that made render 593 possible:
     *
     *     const archives = searchAllArchives
     *       ? (await getAllMediaArchives()).filter((a) => a.isActive === 1)
     *       : await resolveArchivesForVisualQuery(queryTags, topicAnchors);
     */
    expect(
      SOURCING,
      "the candidate lister can take every archive without asking the router again"
    ).not.toContain("const archives = searchAllArchives");
    const at = SOURCING.indexOf("export async function listCuratedArchiveCandidates");
    const body = SOURCING.slice(at, SOURCING.indexOf("\n}", SOURCING.indexOf("return applyCrossVideoVarietyDegrade", at)));
    expect(body).toContain("await resolveArchivesForVisualQuery(queryTags, topicAnchors, {");
    expect(body).toContain("allRelevant: searchAllArchives");
  });

  it("the flag keeps a real meaning INSIDE relevance, rather than becoming dead", () => {
    const router = SOURCING.slice(SOURCING.indexOf("export async function resolveArchivesForVisualQuery"));
    expect(router).toContain("allRelevant");
    expect(router).toContain("allRelevant ? relevant : relevant.slice(0, 1)");
  });

  it("ROUTING DOES NOT RE-READ THE ARCHIVE PER BEAT", () => {
    /**
     * Routing now runs on the per-beat path, and its asset sampling is a full SELECT per archive.
     * Asking it once per sentence would add a scan per beat — and the budget is the thing 593 ran
     * out of. It goes through the render's own cache, the same one the candidate scan fills.
     */
    const rank = SOURCING.slice(
      SOURCING.indexOf("export async function rankArchivesForVisualQuery"),
      SOURCING.indexOf("const ARCHIVE_ROUTE_MIN_SCORE")
    );
    expect(rank).toContain("loadArchiveAssetsForSearch(archive.id, opts?.assetsCache)");
    expect(rank, "routing reads the archive directly again").not.toContain(
      "await getMediaArchiveAssets(archive.id)"
    );
  });

  it("the coverage estimator still reports over every relevant archive", () => {
    const coverage = readFileSync(join(__dirname, "archiveCoverage.ts"), "utf8");
    expect(coverage).toContain("allRelevant: true");
  });

  it("noUniversalFallback semantics are untouched", () => {
    expect(SOURCING).toContain("const blockUniversalFallback =");
    expect(SOURCING).toContain("metadataBlocks && (noUniversalFallback || geoRequired.length > 0)");
  });
});

/* ═══════════════════ B. the scope that had time and could not use it ═══════════════════ */

describe("transferReserveFor was never the culprit, and stays as it is", () => {
  it("it is already bounded by half the window", () => {
    expect(transferReserveFor(2_000)).toBe(1_000);
    expect(transferReserveFor(2_000)).toBeLessThan(2_000);
    expect(transferReserveFor(10 * 60_000)).toBe(TRANSFER_RESERVE_MS);
  });

  it("THE RESERVE NEVER EXCEEDS THE WINDOW, across a swept range", () => {
    for (const windowMs of [1, 50, 500, 1_000, 2_000, 5_000, 12_000, 24_000, 60_000, 600_000]) {
      expect(transferReserveFor(windowMs), `window=${windowMs}`).toBeLessThan(windowMs);
    }
  });

  it("a zero or nonsensical window reserves nothing", () => {
    expect(transferReserveFor(0)).toBe(0);
    expect(transferReserveFor(-5)).toBe(0);
    expect(transferReserveFor(Number.NaN)).toBe(0);
  });
});

describe("`transferReserve=3s` inside `granted=2s` is RONDE 259 WORKING, not a defect", () => {
  /**
   * ── The investigation that ended here, recorded so it is not repeated ───────────────────────
   *
   * The production line looks like broken arithmetic:
   *
   *     clock="Pexels stock scene 2 beat 3" granted=2s used=0s transferReserve=3s
   *
   * It is not. `describeEnclosingScope` prints `deadlineAtMs - searchDeadlineAtMs`, and the
   * search deadline was INHERITED from a parent already past its own. RONDE 259 built that on
   * purpose and its own test says why — "the child reopened the search window its parent had
   * closed … a nested scope reopening the window its parent had closed" — and
   * `theSearchThatSpentTheDownloadsBudget` fails the moment the inheritance is relaxed.
   *
   * So a scope refusing to search here is the rule holding: its parent had already promised that
   * time to finishing a transfer. Changing it would hand the child fresh search time carved out
   * of a download that is already in flight, which is the exact leak RONDE 259 closed.
   *
   * The real finding is upstream and belongs to the archive routing above: scene 2's parent was
   * in its transfer reserve by the time beat 3 opened because the render had spent 18 of its 25
   * minutes sourcing — much of it on an archive about a different subject.
   */
  it("THE INHERITANCE IS DELIBERATE AND STAYS", () => {
    const src = PIPELINE.slice(PIPELINE.indexOf("export function withSceneFetchTimeout"));
    expect(src).toContain("searchDeadlineAtMs: Math.min(deadlineAtMs - reserveMs, parentSearchDeadline),");
    expect(src).toContain("const reserveMs = transferReserveFor(deadlineAtMs - openedAtMs);");
  });

  it("a child opened late still cannot search into its parent's reserve", async () => {
    /** The same claim `theSearchThatSpentTheDownloadsBudget` makes, asserted here too so this
     *  file cannot be read as licence to relax it. */
    await withSceneFetchTimeout(
      async () => {
        await new Promise((r) => setTimeout(r, 700));
        expect(remainingSearchMs(), "the parent's own search window is over").toBe(0);
        await withSceneFetchTimeout(
          async () => {
            expect(
              remainingSearchMs(),
              "the child reopened the search window its parent had closed"
            ).toBe(0);
          },
          5_000,
          "late child"
        );
      },
      1_000,
      "late-child parent"
    );
  });

  it("A SCOPE OPENED AFTER ITS PARENT'S DEADLINE IS STILL REFUSED — RONDE 263 intact", async () => {
    await expect(
      withSceneFetchTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 160));
          return withSceneFetchTimeout(async () => "should never run", 5_000, "after the end");
        },
        120,
        "parent whose budget ends first"
      )
    ).rejects.toThrow();
  });

  it("and the parent's DEADLINE still binds the child's window", () => {
    const src = PIPELINE.slice(PIPELINE.indexOf("export function withSceneFetchTimeout"));
    expect(src).toContain("const deadlineAtMs = Math.min(openedAtMs + delayMs, parentDeadline);");
    expect(src).toContain("if (deadlineAtMs <= openedAtMs) {");
    expect(src).toContain("SCOPE_EXPIRED");
  });
});

/* ═══════════════════ nothing protected moved ═══════════════════ */

describe("the invariants this round may not have touched", () => {
  it("the subject anchor of 14b7cc2 is intact", () => {
    const plan = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");
    expect(plan).toContain("export function ensureSubjectAnchor");
    expect(plan).toContain("export function subjectAnchorForBeat");
    expect((plan.match(/anchorTierQueries\(/g) ?? []).length).toBe(5);
  });

  it("the gates, the reprieve and the evidence rule are unchanged", () => {
    expect(readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8")).toContain(
      'return process.env.SEARCH_GATE_STRICT !== "false";'
    );
    expect(readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8")).toContain(
      'return process.env.ENFORCE_FUNNEL_ADOPTION !== "false";'
    );
    const mismatch = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");
    expect(mismatch.slice(mismatch.indexOf("export function reprieveAllowedFor"))).toContain(
      "return false;"
    );
  });

  it("the per-beat look ceiling and its budget are unchanged", () => {
    const relevance = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(relevance).toContain("return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_JUDGEMENTS_PER_BEAT + 1;");
    expect(relevance).toContain("BEAT_LOOK_CEILING");
  });

  it("the download cap of abbc97f is intact", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(funnel).toContain("export function shortlistCapForSource");
    expect(funnel).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
    expect(PIPELINE).toContain("poolCandidates = capCandidatesPerSource(poolCandidates, before);");
  });
});
