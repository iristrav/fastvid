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

import {
  describeTierChanges,
  providerFitForNeed,
  providerSuppliesForm,
  tierTasksByNeed,
} from "./providerCapability";
import { mediaFormsForIntent, mediaFormsForScene } from "./beatVisualIntent";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const read = (f: string) => stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));
const POOL = read("scenePool.ts");
const CAPS = read("providerCapability.ts");
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

/* ═══════════ 1. a dated beat no longer asks stock at the same moment ═══════════ */

describe("P0-8 §1 — the need reaches the fetch, not only the ranking", () => {
  /** A beat that proved a period and an event: the 1945 bunker shape, typed by the extractors. */
  const dated = mediaFormsForIntent({ period: ["1945"], event: ["the fall of the bunker"] });

  it("STOCK IS ASKED LATER ON A DATED BEAT — it cannot supply what the beat needs", () => {
    /**
     * Not an opinion about Pexels: the registry states that stock supplies none of the forms this
     * beat PREFERS, and supplying none of them is the only condition that demotes.
     *
     * This is also the measurement that rejected the first version of the rule. The blended
     * `providerFitForNeed` scores pexels 0.500 here — on the strength of B_ROLL being acceptable —
     * so a rule keyed on it could never have fired on the case it was written for.
     */
    for (const form of dated.preferred) {
      expect(providerSuppliesForm("pexels", form), `stock claims to supply ${form}`).toBe(false);
    }
    expect(providerFitForNeed("pexels", dated)).toBeGreaterThan(0);
    const after = tierTasksByNeed(PRODUCTION_TIERS, dated);
    expect(tierOf(after, "pexels")).toBeGreaterThan(tierOf(PRODUCTION_TIERS, "pexels"));
    expect(tierOf(after, "pixabay")).toBeGreaterThan(tierOf(PRODUCTION_TIERS, "pixabay"));
  });

  it("AND IT IS STILL ASKED — the movement is one tier, never a removal", () => {
    const after = tierTasksByNeed(PRODUCTION_TIERS, dated);
    expect(after.map((t) => t.source).sort()).toEqual(PRODUCTION_TIERS.map((t) => t.source).sort());
    expect(tierOf(after, "pexels") - tierOf(PRODUCTION_TIERS, "pexels")).toBe(1);
  });

  it("A BEAT THAT WANTS A PROCESS PROMOTES THE SAME STOCK THIS ONE DEMOTED", () => {
    /**
     * Topic-agnostic, and this is the check that says so: nothing in `tierTasksByNeed` names a
     * provider, a subject or a decade. The same function that pushes pexels DOWN on a 1945 beat
     * pulls it UP the moment the beat asks for something stock actually declares.
     *
     * A beat whose extractors typed only an action needs PROCESS, and the registry lists PROCESS
     * for both stock libraries.
     */
    const process = mediaFormsForIntent({ action: ["mixing concrete"] });
    expect(process.preferred).toEqual(["PROCESS"]);
    const after = tierTasksByNeed(PRODUCTION_TIERS, process);
    expect(tierOf(after, "pexels")).toBe(tierOf(PRODUCTION_TIERS, "pexels") - 1);
  });

  it("and a NAMED person demotes stock, which is what the registry actually claims", () => {
    /**
     * This fixture was written the other way round and the registry corrected it, so it is kept as
     * the finding rather than dropped. `mediaFormsForIntent` pushes PERSON only for entities the
     * extractors PROVED — a named individual — and neither stock library lists PERSON or LOCATION,
     * which is a deliberate statement: a stock library cannot supply a picture of a specific named
     * person. Demoting it there is the registry being believed, not a bug.
     */
    const named = mediaFormsForIntent({ people: ["a chief executive"], objects: ["a laptop"] });
    expect(providerSuppliesForm("pexels", "PERSON")).toBe(false);
    expect(tierOf(tierTasksByNeed(PRODUCTION_TIERS, named), "pexels")).toBe(
      tierOf(PRODUCTION_TIERS, "pexels") + 1
    );
  });

  it("AND A PERFECT FIT IS ASKED EARLIER", () => {
    const need = { preferred: ["ARCHIVAL_FOOTAGE"], acceptable: [] } as const;
    const perfect = PRODUCTION_TIERS.filter((t) =>
      need.preferred.every((f) => providerSuppliesForm(t.source, f) === true)
    );
    expect(perfect.length, "no source in the pool scores a perfect fit on any need").toBeGreaterThan(0);
    const after = tierTasksByNeed(PRODUCTION_TIERS, need);
    for (const t of perfect) {
      expect(tierOf(after, t.source)).toBe(Math.max(1, t.tier - 1));
    }
  });
});

/* ═══════════ 2. only the two ends of the scale move anything ═══════════ */

describe("P0-8 §2 — no threshold to argue about", () => {
  const need = { preferred: ["ARCHIVAL_FOOTAGE", "NEWS"], acceptable: ["B_ROLL"] } as const;

  it("EVERY SOURCE THAT MOVED SUPPLIED ALL OF THE PREFERRED FORMS, OR NONE OF THEM", () => {
    const after = tierTasksByNeed(PRODUCTION_TIERS, need);
    for (const before of PRODUCTION_TIERS) {
      const now = tierOf(after, before.source);
      if (now === before.tier) continue;
      const supplies = need.preferred.map((f) => providerSuppliesForm(before.source, f));
      const all = supplies.every((s) => s === true);
      const none = supplies.every((s) => s === false);
      expect(
        all || none,
        `${before.source} moved on a partial answer (${supplies.join(",")}) — that is a threshold, and there is not supposed to be one`
      ).toBe(true);
      /** And the direction follows from which end it was, never from the provider's name. */
      expect(now).toBe(all ? Math.max(1, before.tier - 1) : before.tier + 1);
    }
  });

  it("an unknown provider keeps the tier its author gave it — null is never a `no`", () => {
    const tasks = [{ tier: 2, source: "a_source_nobody_has_characterised" }];
    expect(providerSuppliesForm(tasks[0]!.source, need.preferred[0]!)).toBeNull();
    expect(tierTasksByNeed(tasks, need)).toEqual(tasks);
  });

  it("a beat that proved nothing changes nothing at all", () => {
    const nothing = mediaFormsForIntent(null);
    expect(nothing.preferred).toEqual([]);
    expect(tierTasksByNeed(PRODUCTION_TIERS, nothing)).toEqual([...PRODUCTION_TIERS]);
    expect(tierTasksByNeed(PRODUCTION_TIERS, undefined)).toEqual([...PRODUCTION_TIERS]);
  });

  it("TIER 1 IS THE FLOOR — a promotion never invents a tier of its own", () => {
    const need2 = { preferred: ["ARCHIVAL_FOOTAGE"], acceptable: [] } as const;
    for (const t of tierTasksByNeed(PRODUCTION_TIERS, need2)) {
      expect(t.tier, `${t.source} was promoted above the first declared tier`).toBeGreaterThanOrEqual(1);
    }
  });

  it("and the function is pure — the caller's own array is not rewritten under it", () => {
    const tasks = PRODUCTION_TIERS.map((t) => ({ ...t }));
    const snapshot = JSON.stringify(tasks);
    tierTasksByNeed(tasks, need);
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});

/* ═══════════ 3. one scene, from the sentences in it ═══════════ */

describe("P0-8 §3 — a scene's need is the union of its sentences', not one of them", () => {
  const datedBeat = { period: ["1945"] };
  const personBeat = { people: ["a chancellor"] };
  const processBeat = { action: ["mixing concrete"] };
  const untypedBeat = null;

  it("A SOURCE IS ONLY DEMOTED WHEN IT CAN SERVE NO SENTENCE IN THE SCENE", () => {
    /**
     * One sentence stock cannot serve (1945) and one it can (a process). The union makes that a
     * PARTIAL answer, which moves nothing — a source that is right for a sentence in this scene is
     * not pushed down the queue because another sentence has no use for it.
     */
    const scene = mediaFormsForScene([datedBeat, processBeat]);
    expect(scene.preferred).toContain("ARCHIVAL_FOOTAGE");
    expect(scene.preferred).toContain("PROCESS");
    expect(providerSuppliesForm("pexels", "PROCESS")).toBe(true);
    expect(providerSuppliesForm("pexels", "ARCHIVAL_FOOTAGE")).toBe(false);
    expect(tierOf(tierTasksByNeed(PRODUCTION_TIERS, scene), "pexels")).toBe(
      tierOf(PRODUCTION_TIERS, "pexels")
    );
  });

  it("and a scene where NO sentence can be served still demotes, once", () => {
    const scene = mediaFormsForScene([datedBeat, personBeat]);
    expect(tierOf(tierTasksByNeed(PRODUCTION_TIERS, scene), "pexels")).toBe(
      tierOf(PRODUCTION_TIERS, "pexels") + 1
    );
  });

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

/* ═══════════ 4. nothing about which providers exist changed ═══════════ */

describe("P0-8 §4 — order, and only order", () => {
  it("THE RE-TIERING IS APPLIED TO THE REAL TASK LIST, BEFORE THE RUN", () => {
    expect(POOL).toContain("const tieredTasks = tierTasksByNeed(tasks, req.mediaFormNeed);");
    expect(POOL).toContain("tasks: tieredTasks,");
    const at = POOL.indexOf("const tieredTasks = tierTasksByNeed");
    const run = POOL.indexOf("runTieredRetrieval({");
    expect(at, "the tiers are re-answered after the round has already started").toBeLessThan(run);
  });

  it("and the pipeline supplies a REAL need, built from the scene's own beats", () => {
    expect(PIPE).toContain("mediaFormNeed: mediaFormsForScene(");
    expect(PIPE).toContain("beats.map((b) => beatVisualIntent(dedup.beatIntent, scene.index, b.index))");
  });

  it("NO SOURCE CAN BE DROPPED — the output holds exactly the input's sources", () => {
    /**
     * The one property that makes a mis-typed registry entry survivable. Checked over every need
     * any beat can produce rather than on one fixture, because "it cannot drop a source" is a
     * claim about all of them.
     */
    const NEEDS = [
      mediaFormsForIntent({ period: ["1945"] }),
      mediaFormsForIntent({ people: ["someone"] }),
      mediaFormsForIntent({ location: ["Berlin"], objects: ["a map"] }),
      mediaFormsForIntent({ event: ["a summit"] }),
      mediaFormsForIntent({ action: ["walking"] }),
      mediaFormsForIntent(null),
    ];
    for (const need of NEEDS) {
      const after = tierTasksByNeed(PRODUCTION_TIERS, need);
      expect(after.length).toBe(PRODUCTION_TIERS.length);
      expect(after.map((t) => t.source).sort()).toEqual(PRODUCTION_TIERS.map((t) => t.source).sort());
    }
  });

  it("the function cannot skip, refuse or filter — it has no such expression in it", () => {
    const fn = CAPS.slice(
      CAPS.indexOf("export function tierTasksByNeed"),
      CAPS.indexOf("export function describeTierChanges")
    );
    expect(fn, "the tier router acquired a filter").not.toContain(".filter(");
    expect(fn, "the tier router acquired a skip").not.toMatch(/\bskip/i);
    /** It maps one task to one task. That shape is what makes the property above hold. */
    expect(fn).toContain("tasks.map((task)");
  });

  it("NO BUDGET, CAP OR KEY IS READ HERE", () => {
    const fn = CAPS.slice(
      CAPS.indexOf("export function tierTasksByNeed"),
      CAPS.indexOf("export function describeTierChanges")
    );
    for (const forbidden of ["process.env", "ApiKey", "budget", "Budget", "maxTotal"]) {
      expect(fn, `the tier router reads ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ═══════════ 5. and it says what it did ═══════════ */

describe("P0-8 §5 — a re-ordering nobody can see is a re-ordering nobody can audit", () => {
  it("EVERY MOVED SOURCE IS NAMED, WITH WHERE IT WENT", () => {
    const dated = mediaFormsForIntent({ period: ["1945"] });
    const line = describeTierChanges(PRODUCTION_TIERS, tierTasksByNeed(PRODUCTION_TIERS, dated));
    expect(line).toContain("pexels 4→5");
    expect(line).toContain("pixabay 4→5");
  });

  it("and a scene where nothing moved prints nothing", () => {
    expect(describeTierChanges(PRODUCTION_TIERS, [...PRODUCTION_TIERS])).toBe("");
  });

  it("the pool logs it — a decision made silently is one nobody can check", () => {
    expect(POOL).toContain("describeTierChanges(tasks, tieredTasks)");
  });
});
