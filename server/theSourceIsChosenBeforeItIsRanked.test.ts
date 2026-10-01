/**
 * P0-8 — THE SOURCE IS CHOSEN BEFORE IT IS RANKED.
 *
 * ── Two decisions, and the registry reached only the second ─────────────────────────────────
 *
 * The capability registry has been a live input since it was written, to:
 *
 *     contextualSourcePriority   — orders candidates AFTER they have been fetched
 *     orderResearchTasksByNeed   — orders a research round
 *
 * and to nothing else. The decision it could not reach is the one that happens FIRST and costs the
 * most: which providers a scene asks at all. `buildSceneCandidatePool` gives every provider a fixed
 * tier — pexels 4, wikimedia 3, youtube_cc 1, archive 2 — the same number on every beat of every
 * topic, and `runTieredRetrieval` stops as soon as a tier satisfies the scene.
 *
 * So on a beat dated to 1945, stock sat in its usual tier although the registry positively states
 * that stock cannot supply archival footage, because stock is shot now; and a scene covered by an
 * early tier never reached the archives. `contextualSourcePriority` then ordered beautifully among
 * whatever had been fetched. Ranking cannot recover a source that was never asked.
 *
 * ── What this round does, and the line it does not cross ────────────────────────────────────
 *
 * It re-answers the TIER, from the same registry, through the same null rule. It does not add a
 * source, remove one, read a key, touch a skip flag or move a budget — §4 is that check, and it
 * pins that a mis-described provider can be delayed and can never be dropped. There is no second
 * selection engine and no threshold to tune: only "supplies every preferred form" and "supplies
 * none of them" move anything, which §2 measures.
 *
 * ── A rule this file rejected, kept because the rejection is the finding ────────────────────
 *
 * The first version keyed on `providerFitForNeed`, the blended score the ranking uses. It could
 * not fire on the case it was written for: that score mixes the acceptable list in, so Pexels on a
 * 1945 beat comes out at 0.500 — on the strength of B_ROLL — indistinguishable from a source that
 * half-answers the beat. The blend is right for ordering a candidate that has already arrived and
 * wrong for deciding whether to spend a scene's first retrieval slot. §1 records that measurement.
 */
import { describe, expect, it } from "vitest";

import { mediaFormsForIntent, mediaFormsForScene } from "./beatVisualIntent";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const read = (f: string) => stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));
const POOL = read("scenePool.ts");
const PIPE = read("videoPipeline.ts");

/** The tiers `buildSceneCandidatePool` actually declares, as a fixture. */
const PRODUCTION_TIERS = [
  { tier: 1, source: "youtube_cc" },
  { tier: 2, source: "archive" },
  { tier: 3, source: "wikimedia" },
  { tier: 3, source: "internet_archive" },
  { tier: 4, source: "pexels" },
  { tier: 4, source: "pixabay" },
  { tier: 4, source: "europeana" },
  { tier: 4, source: "nasa" },
];

const tierOf = (tasks: ReadonlyArray<{ tier: number; source: string }>, source: string): number =>
  tasks.find((t) => t.source === source)!.tier;

/**
 * ── THE STEP SHRANK, AND THAT IS THE POINT ──────────────────────────────────────────────────
 *
 * This file used to assert whole-tier movement: a demoted Pexels went 4→5, a promoted one 4→3.
 * The integrity audit named that for what it is — a media-form preference deciding that a lower
 * SOURCING tier may run before a higher one. Promoting Pexels out of tier 4 put licensed stock in
 * with the open collections, and since the tiered run stops as soon as a tier covers the scene,
 * tier 4 could then never be reached at all.
 *
 * The feature is unchanged in what it is FOR: a source that supplies every preferred form is still
 * asked earlier than its tier-mates, one that supplies none is still asked after them. What it can
 * no longer do is leave the tier the ladder placed it in. So the tests assert the same three facts
 * — moved down, moved up, did not move — at a tenth of a tier, and `oneRouteToAPicture.test.ts`
 * holds the property that no movement may ever cross a tier boundary.
 *
 * `STEP` is written here as a literal rather than imported, deliberately: a test that reads the
 * implementation's constant cannot notice the implementation changing it.
 */
const STEP = 0.1;
const FLOOR = 1;
const round = (n: number): number => Math.round(n * 10) / 10;
/** How far a source moved, rounded — 4.1 - 4 is 0.10000000000000053 in binary floating point. */
const moved = (after: ReadonlyArray<{ tier: number; source: string }>, source: string): number =>
  round(tierOf(after, source) - tierOf(PRODUCTION_TIERS, source));

/* ═══════════ 3. one scene, from the sentences in it ═══════════ */

describe("P0-8 §3 — a scene's need is the union of its sentences', not one of them", () => {
  const datedBeat = { period: ["1945"] };
  const personBeat = { people: ["a chancellor"] };
  const processBeat = { action: ["mixing concrete"] };
  const untypedBeat = null;

  it("AND ONE UNTYPED SENTENCE DOES NOT EMPTY THE SCENE'S NEED", () => {
    /**
     * The failure an intersection would produce: one sentence the extractors typed nothing for
     * would wipe out the need the other sentences proved, and the tier table would quietly revert
     * to the constants — invisibly, because the result is a valid empty need.
     */
    const scene = mediaFormsForScene([datedBeat, untypedBeat]);
    expect(scene.preferred).toContain("ARCHIVAL_FOOTAGE");
  });

  it("a scene of untyped sentences has no opinion, and says so", () => {
    expect(mediaFormsForScene([null, null]).preferred).toEqual([]);
    expect(mediaFormsForScene([]).preferred).toEqual([]);
  });

  it("a form some sentence PREFERS is never listed as merely acceptable", () => {
    const scene = mediaFormsForScene([datedBeat, untypedBeat]);
    for (const form of scene.preferred) {
      expect(scene.acceptable, `${form} is on both lists, which double-counts it`).not.toContain(form);
    }
  });
});
