/**
 * RONDE 183 — the architecture audit, as assertions instead of a paragraph.
 *
 * ── The one failure mode this series keeps finding ───────────────────────────────────────────
 *
 * Not a crash, not a wrong number: code that exists, is tested, and is never called. R174 found
 * `youtubePoolCandidates` unreachable. R176 found the pool never given a YouTube search. R177 found
 * the motion-graphics planner fed empty inputs. R180 found the ranking engine and the duplicate
 * penalty both switched off by one missing argument. R183 found `transitionUnsupportedReason`
 * uncalled, so a transition this renderer cannot execute fell back to a hard cut and the log said
 * only that it was unsupported, never why.
 *
 * Every one of those was invisible because the code around it handled the empty case gracefully.
 * A unit test cannot catch it; only a REACHABILITY question can, and this file asks that question
 * of the whole cinematic chain, once, in a form that fails on the day a link is unplugged again.
 *
 * ── And the second rule: one implementation each ─────────────────────────────────────────────
 *
 * §28's "geen tweede X" is checked here too, by counting definitions rather than trusting a
 * convention. A second renderer or a second ranking engine is exactly the kind of thing that gets
 * added in good faith and then quietly disagrees with the first one.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** Every production source file — tests excluded, because a test caller is not a caller. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  for (const root of ["server", "shared", "client/src"]) if (fs.existsSync(root)) walk(root);
  return out;
}

const SOURCES = productionSources();
const TEXT = new Map(SOURCES.map((f) => [f, fs.readFileSync(f, "utf8")]));

/** Files that CALL `name`, not counting the file that defines it. */
function callersOf(name: string): string[] {
  const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`);
  const defRe = new RegExp(`function ${name}\\s*[(<]`);
  const out: string[] = [];
  for (const [file, src] of TEXT) {
    if (!re.test(src)) continue;
    /** A file may both define and use it; strip the declaration before deciding. */
    const withoutDecl = src.replace(new RegExp(`(export\\s+)?(async\\s+)?function ${name}\\s*[(<]`, "g"), " ");
    if (re.test(withoutDecl)) out.push(file);
    else if (!defRe.test(src)) out.push(file);
  }
  return out;
}

/* ═══════════════════════ the chain is connected end to end ═══════════════════════ */

/**
 * Each entry is a link that a previous round found unplugged, or plugged in during this one. The
 * list is the audit: if any of these has no production caller, a feature is inert again.
 */
const MUST_BE_REACHED: ReadonlyArray<[string, string]> = [
  ["buildCinematicSceneInputs", "production beats become engine inputs"],
  ["runCinematicPipeline", "the Director/EDL route runs"],
  ["translateEdl", "the EDL becomes a ProjectTimeline"],
  ["intentFrom", "the planners and the ranking get a beat's intent"],
  ["beatNamedEntitiesByKind", "R177 — brands, companies and objects reach the intent"],
  ["graphicIsRenderable", "the renderer's own predicate decides what is drawable"],
  ["rendererGraphicType", "a planned graphic is translated to a component name"],
  ["formatCinematicGraphics", "R178 — planned/rendered/skipped reaches the render log"],
  ["buildSceneCandidatePool", "the pool is built during a render"],
  ["selectCandidatesFromPool", "the pool's winner is chosen"],
  ["rankedPool", "R160 FASE 7 — the thirteen-signal engine can run"],
  ["penaliseDuplicates", "R170 — a repeat is penalised"],
  ["newLedger", "R180 — the render has a usage ledger to penalise against"],
  ["recordUse", "R180 — an adoption is written to that ledger"],
  ["youtubePoolCandidates", "R169 — a YouTube row becomes a pool candidate"],
  ["searchYoutubeVideoCandidates", "R177 — the pool can ask YouTube"],
  ["downloadYouTubeCCClip", "R179 — a YouTube winner can be fetched"],
  ["planCinematicAudio", "R166 — music and ambience are planned"],
  ["classifyAttentionMoment", "R166 — attention moments are classified"],
  ["lookUnsupportedReason", "R160 — an unsupported look is reported"],
  ["transitionUnsupportedReason", "R183 — an unsupported transition says WHY"],
  ["newRenderId", "R172 — a render has a correlation id"],
  ["formatFallback", "R176 — a fallback names why, from and to"],
  ["formatSelection", "R202 — [Selection] says which asset won this beat, and what it beat"],
];

describe("R183 — every link in the cinematic chain has a production caller", () => {
  for (const [name, why] of MUST_BE_REACHED) {
    it(`${name} — ${why}`, () => {
      const callers = callersOf(name);
      expect(
        callers.length,
        `${name} has no production caller: ${why}. This is the failure mode this series keeps ` +
          `finding — code that exists, is tested, and is never run.`
      ).toBeGreaterThan(0);
    });
  }
});

/* ═══════════════════════ one implementation each ═══════════════════════ */

/**
 * §28 — no second renderer, no second ranking engine, no second cache, no second Director.
 *
 * Counted rather than assumed. A second implementation is the kind of thing that gets added in good
 * faith and then quietly disagrees with the first one, and the disagreement shows up as two
 * different answers to one question about one asset.
 */
const SINGLE_OWNER: readonly string[] = [
  "renderTimeline",
  "translateEdl",
  "buildSceneCandidatePool",
  "selectCandidatesFromPool",
  "searchYoutubeVideoCandidates",
  "downloadYouTubeCCClip",
  "intentFrom",
  "timelineDigest",
  "buildTransitionGraph",
  "graphicIsRenderable",
];

describe("R183 — §28: exactly one implementation of each", () => {
  for (const name of SINGLE_OWNER) {
    it(`only one ${name}`, () => {
      const re = new RegExp(`export (async )?function ${name}\\s*[(<]`);
      const defs = [...TEXT].filter(([, src]) => re.test(src)).map(([f]) => f);
      expect(defs, `${defs.length} definitions:\n${defs.join("\n")}`).toHaveLength(1);
    });
  }
});

/* ═══════════════════════ what is still unreached, named honestly ═══════════════════════ */

/**
 * ── Why a KNOWN-unreached list is better than deleting them ─────────────────────────────────
 *
 * These four have no production caller today, and this test says so out loud rather than letting
 * them look connected. It is deliberately written to fail in BOTH directions:
 *
 *   · if one gains a caller, this test fails and the entry moves up to MUST_BE_REACHED — so a
 *     wiring change cannot land without the audit being updated;
 *   · if one is deleted, the lookup fails and somebody has to decide that on purpose.
 *
 * A comment claiming the same thing would rot the first time anybody wired one up.
 */
const KNOWN_UNREACHED: ReadonlyArray<[string, string]> = [
  /**
   * RONDE 202 — the three that remain, each with WHY it is not called.
   *
   * "Unreached" is not one thing. `formatRoute` and `assertRenderableTimeline` have working
   * equivalents that ARE called — `formatRenderRoute` and `validateTimeline` — so wiring them would
   * put a second answer to one question into the log. `validateEffect` and `yExpressionFor` are
   * superseded outright. Recording the reason is what stops a future round from "fixing" a
   * duplicate into existence.
   */
  ["replacementSideEffects", "smart replacement's side-effect hook — the editor route does its own"],
  ["validateEffect", "per-effect validation; the renderer reports unsupported effects instead"],
  ["yExpressionFor", "a caption y-position helper superseded by captionLayout's boxes"],
  ["formatRoute", "REDUNDANT — formatRenderRoute answers the same question and is called"],
  ["assertRenderableTimeline", "REDUNDANT — validateTimeline is the called equivalent"],
];

describe("R183 — the functions that are still not called, listed rather than hidden", () => {
  for (const [name, note] of KNOWN_UNREACHED) {
    it(`${name} is still unreached (${note})`, () => {
      const defined = [...TEXT].some(([, src]) => new RegExp(`function ${name}\\s*[(<]`).test(src));
      expect(defined, `${name} no longer exists — remove it from this list on purpose`).toBe(true);
      expect(
        callersOf(name),
        `${name} now HAS a production caller — move it to MUST_BE_REACHED`
      ).toEqual([]);
    });
  }
});
