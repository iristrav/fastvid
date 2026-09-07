/**
 * RONDE 120 — A NUMBER NOBODY WRITES IS NOT A MEASUREMENT.
 *
 * ── Three wrong diagnoses in four rounds, all the same shape ────────────────────────────────
 *
 *   `failureReasons other=17`  RONDE 115 — the YouTube cascade filed one generic reason, so
 *                              seventeen different failures printed as one bucket.
 *   `ranked=0`                 RONDE 119 — I read it as "the shortlist admits whatever arrives
 *                              first". `noteRanked` had never been called. The zero measured
 *                              nothing, and the diagnosis built on it was wrong.
 *   `cinematicDropped=false`   this round — see below.
 *
 * Every one of them cost a round. The pattern is always the same: a counter is written, exported,
 * documented, and never called, and then somebody reasons from its zero.
 *
 * ── What this file enforces ─────────────────────────────────────────────────────────────────
 *
 * Two things, mechanically, so the fourth instance fails here instead of in a report:
 *
 *   1. every measurement writer in the funnel modules has at least one PRODUCTION caller;
 *   2. the set of lineage stages that production never writes is EXACTLY the set recorded
 *      below — so a new one fails, and fixing one fails until the list is updated.
 *
 * The census follows `import { x as y }` aliases. Without that it reports `noteEligible` as
 * uncalled, because `videoPipeline` imports it as `noteBeatShortlistEligible` — a census that
 * produces its own false diagnosis would be the joke writing itself.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SERVER = __dirname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const ALL = tsFiles(SERVER);
const PRODUCTION = ALL.filter((f) => !f.includes(".test."));
const SOURCE = new Map(ALL.map((f) => [f, fs.readFileSync(f, "utf8")]));

/** Every local identifier in `file` that refers to `exported` — `as` aliases included. */
function localNamesFor(file: string, exported: string): Set<string> {
  const names = new Set<string>();
  for (const m of SOURCE.get(file)!.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs)) {
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (orig === exported) names.add(alias ?? orig);
    }
  }
  return names;
}

function callsTo(file: string, name: string): number {
  const re = new RegExp(String.raw`(?<![.\w])${name}\s*\(`, "g");
  return (SOURCE.get(file)!.match(re) ?? []).length;
}

/* ═══════════════ 1. every writer has a production caller ═══════════════ */

/** The modules whose counters this project's reports are read from. */
const MEASUREMENT_MODULES = [
  "beatShortlist.ts",
  "beatOutcomeAudit.ts",
  "clipAdoptAudit.ts",
  "clipRejectAudit.ts",
  "visualSourceLineage.ts",
  "beatVisualRelevance.ts",
];

function writersIn(moduleFile: string): string[] {
  const src = SOURCE.get(moduleFile) ?? "";
  return [...src.matchAll(/export function (note[A-Za-z0-9_]*|record[A-Za-z0-9_]*|mark[A-Za-z0-9_]*)\s*\(/g)]
    .map((m) => m[1]!);
}

function productionCallers(moduleFile: string, name: string): string[] {
  const callers: string[] = [];
  for (const f of PRODUCTION) {
    const names = f === moduleFile ? new Set([name]) : localNamesFor(f, name);
    let n = 0;
    for (const local of names) n += callsTo(f, local);
    if (f === moduleFile) n -= 1; // its own declaration
    if (n > 0) callers.push(path.basename(f));
  }
  return callers;
}

describe("every measurement writer is actually called by production", () => {
  for (const mod of MEASUREMENT_MODULES) {
    const file = path.join(SERVER, mod);
    for (const writer of writersIn(file)) {
      it(`${mod}: ${writer} has a production caller`, () => {
        const callers = productionCallers(file, writer);
        expect(
          callers,
          `${writer} is exported and documented as a measurement, and nothing in production ` +
            `calls it. Its counter will read zero in every render, and somebody will read that ` +
            `zero as a fact about the pipeline — three rounds have already been lost that way. ` +
            `Give it a caller, or delete it.`
        ).not.toEqual([]);
      });
    }
  }

  it("the census follows import aliases, or it lies about its own subject", () => {
    /** `videoPipeline` imports `noteEligible as noteBeatShortlistEligible`. */
    const vp = path.join(SERVER, "videoPipeline.ts");
    expect(localNamesFor(vp, "noteEligible")).toContain("noteBeatShortlistEligible");
    expect(productionCallers(path.join(SERVER, "beatShortlist.ts"), "noteEligible")).not.toEqual([]);
  });
});

/* ═══════════════ 2. the lineage stages production never writes ═══════════════ */

function lineageStages(): string[] {
  const src = SOURCE.get(path.join(SERVER, "visualSourceLineage.ts"))!;
  const block = src.slice(src.indexOf("export const LINEAGE_STAGES"));
  return [...block.slice(0, block.indexOf("] as const;")).matchAll(/^\s*"([A-Z_]+)",/gm)].map((m) => m[1]!);
}

/** A stage is WRITTEN where its literal is handed to a recorder or sits in a `stage:` field. */
function stageIsWritten(stage: string): boolean {
  for (const f of PRODUCTION) {
    const src = SOURCE.get(f)!;
    for (const m of src.matchAll(new RegExp(String.raw`"${stage}"`, "g"))) {
      const before = src.slice(Math.max(0, m.index! - 160), m.index!);
      if (before.includes("recordEvent") || before.includes("stage:")) return true;
    }
  }
  return false;
}

/**
 * The stages no production code writes, as measured today.
 *
 * ── RONDE 121 shrank this list from three to one ────────────────────────────────────────────
 *
 * `CINEMATIC_SELECTED` and `CINEMATIC_DROPPED` now have a writer: the planner announces each
 * beat's ending through an injected sink and `videoPipeline` files the stage, where the ledger is
 * in scope. `hasTerminalOutcome` already treated CINEMATIC_DROPPED as an ending — the rule had
 * been written and was waiting for a caller that never came — so a planner-dropped clip now
 * leaves the audit explained instead of unexplained.
 *
 * `DELIVERED` remains. It belongs to the render side, not the planner, and nothing writes it.
 *
 * What follows describes the defect as it was found, and is kept because the list may only shrink. `lifecyclesOf` reports
 * `cinematicSelected`, `cinematicDropped` and `delivered` for every asset of every render, and
 * all three are permanently false — while render 572 dropped six beats at exactly that step and
 * said so on the console:
 *
 *     [CinematicPipeline] dropped s1b0: adopted clip has no rehydratable identity
 *     [CinematicDrop] scene=1 beat=0 ... reason=NOT_REHYDRATABLE
 *
 * The ledger's own note claims otherwise — "They are written from `videoPipeline`, where the
 * planner's result and the ledger are in scope" — and that never happened. A clip dropped by the
 * planner therefore reaches the audit with no cinematic ending at all, which is one plausible
 * source of the `unexplained` assets nobody has been able to name.
 *
 * The list is an exact equality on purpose: a fourth stage joining it fails here, and repairing
 * one of these fails here too until the list is shortened. It may only ever shrink.
 */
const STAGES_WITH_NO_PRODUCTION_WRITER = ["DELIVERED"];

describe("the lineage stages production actually writes", () => {
  it("is exactly the vocabulary minus the three known gaps", () => {
    const unwritten = lineageStages().filter((s) => !stageIsWritten(s));
    expect(unwritten.sort()).toEqual([...STAGES_WITH_NO_PRODUCTION_WRITER].sort());
  });

  it("the stages the reports lean on hardest are written", () => {
    for (const stage of ["ADOPTED", "DOWNLOAD_SUCCEEDED", "DOWNLOAD_FAILED", "REMOVED", "FINAL_VIDEO"]) {
      expect(stageIsWritten(stage), `${stage} has no production writer`).toBe(true);
    }
  });

  it("names the reader that goes false because of the gap", () => {
    /** So the next reader of `cinematicDropped=false` finds this test before trusting it. */
    const src = SOURCE.get(path.join(SERVER, "visualSourceLineage.ts"))!;
    expect(src).toContain('cinematicDropped');
    expect(src).toContain('cinematicSelected: has("CINEMATIC_SELECTED")');
  });
});
