/**
 * THE ROUTE CENSUS — which REAL_FUNNEL adoptions can prove where their picture came from.
 *
 * ── What render 570 forced ──────────────────────────────────────────────────────────────────
 *
 * Seven curated archive clips were APPROVED by the picture editor and refused anyway, for
 * `eligible=false`. `markEligible` returns false when the lineage ledger has never seen the file —
 * correctly, since an asset with no provenance must not acquire one at the vision gate. So the
 * question is not "why did eligibility fail" but "which route pushed a REAL_FUNNEL clip the ledger
 * had never heard of".
 *
 * ── The finding, from the code rather than from a log ───────────────────────────────────────
 *
 * `adoptArchiveBeatClip` adopts on more than one path. Its ranked queue opens a record and marks it
 * eligible on the spot:
 *
 *     const candidateLineage = ensureCuratedAssetLineage(dedup, picked, scene.index, beat.index);
 *     funnel.markLineageEligible(candidateLineage.lineageId, "curated_ranked_queue");
 *
 * But its FIRST adoption attempt is 160 lines earlier, before any of that exists:
 *
 *     if (await tryClip(initialClip, holdSec, { source: "archive" })) return true;
 *
 * `source: "archive"` is REAL_FUNNEL. A clip arriving through that parameter is adopted as a
 * verified own visual with no record opened for it anywhere in the function — and `route=archive`
 * is exactly the label render 570's seven refusals carry.
 *
 * ── Why a test and not only a fix ───────────────────────────────────────────────────────────
 *
 * This is the seam this codebase keeps rediscovering: a rule every route must remember, remembered
 * by most. Fixing one path leaves the next one free to repeat it. The census is the durable half.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { adoptionPolicyFor } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const bodyOf = (name: string): string => {
  const at = PIPE.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const next = PIPE.slice(at + 20).search(/\n(?:export )?(?:async )?function /);
  return PIPE.slice(at, next === -1 ? undefined : at + 20 + next);
};

/** The ways a route can give the ledger something to resolve. */
const OPENS_A_RECORD = [
  "ensureCuratedAssetLineage",
  "ensureCuratedAssetLineageOn",
  "tagPathWithProviderAsset",
  "createLineage",
  "bindPath",
];

describe("the census", () => {
  const body = bodyOf("adoptArchiveBeatClip");

  it("adoptArchiveBeatClip does open a record on its ranked queue", () => {
    expect(body).toContain("ensureCuratedAssetLineage(dedup, picked");
    expect(body).toContain("markLineageEligible(candidateLineage.lineageId");
  });

  /**
   * THE GAP, PINNED AS A MEASUREMENT.
   *
   * The initialClip attempt adopts under a REAL_FUNNEL label. Whether it can prove that claim is
   * decided by whether a record exists by then — and until it does, this test records the fact
   * rather than asserting the wish. A measurement that can correct its author is worth more than
   * an expectation that cannot.
   */
  it("its initialClip attempt adopts as REAL_FUNNEL before any record is opened", () => {
    const attempt = body.indexOf('tryClip(initialClip, holdSec, { source: "archive" })');
    const firstRecord = Math.min(
      ...OPENS_A_RECORD.map((fn) => {
        const at = body.indexOf(fn);
        return at === -1 ? Number.POSITIVE_INFINITY : at;
      })
    );
    expect(attempt, "the initialClip attempt moved or was renamed").toBeGreaterThan(-1);
    expect(adoptionPolicyFor("archive").category).toBe("REAL_FUNNEL");
    expect(
      attempt,
      "if this now fails, the gap is closed and this expectation should be inverted"
    ).toBeLessThan(firstRecord);
  });
});

/**
 * THE INVARIANT THE CENSUS EXISTS FOR.
 *
 * Not "these particular functions are fine" — that ages badly — but: a route that adopts under a
 * REAL_FUNNEL label must have given the ledger something to resolve first. The list of such labels
 * comes from the policy table, so a new REAL_FUNNEL route is covered the day it is declared.
 */
describe("no REAL_FUNNEL adoption may be anonymous", () => {
  /** Every literal adoption intent in the pipeline, with the policy that governs it. */
  const intents = [...PIPE.matchAll(/withAdoptionIntent\("([a-z_]+)"/g)].map((m) => m[1]!);

  it("every literal adoption intent is a declared route", () => {
    const undeclared = [...new Set(intents)].filter(
      (i) => adoptionPolicyFor(i).category === "UNDECLARED"
    );
    expect(undeclared, "an undeclared intent adopts anonymously").toEqual([]);
  });

  /**
   * The REAL_FUNNEL intents are the ones that claim a verified own visual, and each has to be
   * reachable only where provenance exists. Listed explicitly so adding one is a deliberate act.
   */
  it("the REAL_FUNNEL intents used in the pipeline are known", () => {
    const realFunnel = [...new Set(intents)]
      .filter((i) => adoptionPolicyFor(i).category === "REAL_FUNNEL")
      .sort();
    expect(realFunnel).toEqual([
      "archive_topic",
      "beat_fetch",
      "europeana",
      "internet_archive",
      "pexels",
      "research_refetch",
      "script_image",
      "stock",
      "wikimedia",
    ]);
  });

  /**
   * And the single central guard is still the only thing that decides. A route cannot pass by
   * asking a different question somewhere else — there is one reader of eligibility, and this
   * counts its call sites.
   */
  it("eligibility has exactly one reader in the adoption path", () => {
    /**
     * Code only. The second occurrence in this file is prose — the overlay's own note on why
     * `linkDerivedPath` has to carry the chain — and a doc comment discussing the reader is not a
     * second reader. Counting it as one would make this test fire on an explanation.
     */
    const readers = PIPE.split("\n")
      .filter((l) => l.includes("isEligible(") && !/^\s*(\*|\/\/|\/\*)/.test(l)).length;
    expect(readers, "a second eligibility reader would let a route answer its own question").toBe(1);
  });
});
