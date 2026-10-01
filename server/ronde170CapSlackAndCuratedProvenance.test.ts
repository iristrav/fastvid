/**
 * RONDE 170 — render 555 paid for six downloads a beat and used three, and lost the provenance of
 * thirteen real pictures on the way in.
 *
 * Two findings, both from the same log, both measured rather than argued.
 *
 * ── #1: the caps were shrinking the shortlist below the budget ───────────────────────────────
 *
 *     beat=s2b0 afterMetadata=15 afterSourceCap=3 downloadBudget=6 downloaded=0
 *               cutBySourceCap=8 cutByBudget=0   verdict=LOST_BEFORE_VISION
 *     beat=s2b1 afterSourceCap=3 downloadBudget=6 cutBySourceCap=5 cutByBudget=0
 *     beat=s2b3 afterSourceCap=5 downloadBudget=6 cutBySourceCap=7 cutByBudget=0
 *     TOTAL     cutBySourceCap=106 cutByBudget=6
 *               beatsWithCapBinding=13 medianCapGap=0.00 capGapMax=0.01
 *
 * On three of the four beats the render printed in full, the shortlist came out SMALLER than the
 * download budget while the per-source cap was turning candidates away. s2b0 is the clearest:
 * ninety-three candidates found, three shortlisted, eight refused by the cap, and three of six
 * paid-for slots left empty — after which the beat downloaded nothing and scored
 * LOST_BEFORE_VISION.
 *
 * Across the render the cap cut 106 and the budget cut 6, and on the thirteen beats where the cap
 * actually bound, the median score gap between what it kept and what it refused was 0.00. RONDE
 * 164 and 165 both declined to act on ONE such beat. Thirteen is the evidence they asked for.
 *
 * The answer is not a bigger cap — RONDE 157 raised it to 4 and measured the archive eating slots
 * the other providers needed. The caps are a DIVERSITY rule and they keep deciding the whole
 * shortlist whenever there are candidates enough to fill the budget. What they were also doing was
 * leaving slots empty when no other source had anything to put in them, and an empty slot serves
 * no diversity: nothing is being kept out of it.
 *
 * ── #2: the funnel's curated branch opened no lineage at all ─────────────────────────────────
 *
 *     [Quality] Video 555: score=14/100, clips=16 [UNVERIFIED=14, loc=1, nasa=1]
 *     [Quality] Video 555: 14 clip(s) met niet-bewezen bron (UNVERIFIED).
 *     [Quality] Video 555: 1 kleur-fallback beat(s)
 *
 * Fourteen of sixteen delivered clips could not say where they came from, on a render with exactly
 * ONE colour card — so thirteen were real pictures whose provenance was lost.
 *
 * `prepareCuratedArchiveClip` lives in curatedMediaSourcing, which contains no reference to
 * `lineage`. Every other download route opens a record at the one moment the provider, the asset
 * id and the destination path are all in hand. The funnel's curated branch called that function
 * directly and did neither, so its clips reached `recordClipAdopt` as files the ledger had never
 * seen — and that function's hole-filling branch opens a record with NO provider on purpose,
 * because RONDE 87's rule is that a route label is not a provider. Correct behaviour on a record
 * that should never have been needed.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { createArchiveSourcingAudit } from "./archiveSourcingAudit";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 170 #2 — the funnel's curated clips carry their provenance", () => {

  /**
   * THE WRITER MOVED, THE RULE DID NOT.
   *
   * `ensureCuratedAssetLineageOn` now lives in `visualSourceLineage.ts`, beside the ledger it
   * writes into, because the replay engine has to call THE SAME writer and cannot import a
   * 41,000-line pipeline to reach it. `videoPipeline` re-exports it, so every caller is unchanged
   * and the invariants below are unchanged too — they are simply read at the writer's new address.
   */
  const LEDGER = readFileSync(join(__dirname, "visualSourceLineage.ts"), "utf8");

  it("the ledger-only entry point exists because the funnel has no VisualDedupState", () => {
    expect(LEDGER).toContain("export function ensureCuratedAssetLineageOn(");
    expect(LEDGER).toContain("ledger: VisualSourceLedger,");
    expect(PIPE).toContain(
      "return ensureCuratedAssetLineageOn(dedup.sourcingCache.lineage, picked, sceneIndex, beatIndex);"
    );
  });

  /** And it is still reachable under its old name, or every existing call site would have broken. */
  it("videoPipeline still exports it", () => {
    expect(PIPE).toContain("export { ensureCuratedAssetLineageOn };");
  });

  it("the provider is the archive the row names, never a route label", () => {
    // RONDE 87's rule, unchanged: `own_archive` only when the row itself carries no archive name.
    const idx = LEDGER.indexOf("export function ensureCuratedAssetLineageOn(");
    const block = LEDGER.slice(idx, idx + 1600);
    expect(block).toContain('provider: picked.archiveName?.trim() || "own_archive"');
    expect(block).toContain("archiveAssetId: picked.asset.id");
  });
});
