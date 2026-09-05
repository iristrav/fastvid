/**
 * RONDE 90 PHASE 2 — 35 ADOPTION ROUTES, 2 ELIGIBILITY REGISTRATIONS.
 *
 * ── The audit ───────────────────────────────────────────────────────────────────────────────
 *
 *     recordClipAdopt call sites in videoPipeline.ts   35
 *     noteBeatEligible call sites                       2
 *     vision gate call sites                           22
 *
 * A rule 35 routes must satisfy, registered by 2. That ratio is render 568's entire funnel:
 *
 *     [VisualFunnel] wikimedia   retrieved=400  eligible=0 adopted=2  finalVideo=1
 *     [VisualFunnel] UNVERIFIED  retrieved=0    eligible=0 adopted=23 finalVideo=17
 *     [VisualFunnel] TOTAL       retrieved=3995 eligible=4
 *
 * Four eligible out of 3995 was never a retrieval collapse. It is 33 routes that adopt without
 * registering, and one of them supplying 17 of the 20 delivered clips.
 *
 * ── The two measured mechanisms ─────────────────────────────────────────────────────────────
 *
 * `adoptRouteForSource` classified by string shape and returned "primary" — "a beat filled by the
 * route that was supposed to fill it" — for everything it did not recognise. The unknown case was
 * the flattering one.
 *
 * `guaranteedAdoptSource("wikimedia")` returned the literal "wikimedia", the label the real
 * retrieval route uses. A last-resort Commons image and a retrieved, ranked, judged Wikimedia
 * asset were recorded as the same thing. That is `wikimedia eligible=0 adopted=2` exactly.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * The structural test below walks every `recordClipAdopt` call site in videoPipeline.ts, extracts
 * the source argument, and fails on any literal with no declared policy. A new adoption route
 * therefore cannot be added without saying what it is — which is the only thing that stops this
 * seam recurring for the sixteenth time.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  adoptionPolicyFor,
  censusAdoptionPolicies,
  declaredAdoptSources,
  formatAdoptionPolicyCensus,
  isDeclaredAdoptSource,
} from "./adoptionPolicy";
import { guaranteedAdoptSource } from "./videoPipeline";
import { buildBeatVisualStatuses, coverageOfAdoptEntry } from "./beatVisualStatus";
import { SUBJECT_FALLBACK_ROUTE } from "./beatSubjectFallback";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════ the vocabulary is complete ═══════════════ */

/** Every argument in position 6 of a `recordClipAdopt(...)` call, as written. */
function adoptSourceExpressions(): string[] {
  const out: string[] = [];
  for (const m of PIPE.matchAll(/recordClipAdopt\(/g)) {
    let depth = 1;
    let j = m.index! + m[0].length;
    const start = j;
    while (depth > 0 && j < PIPE.length) {
      const ch = PIPE[j];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    const args = PIPE.slice(start, j - 1);
    const parts: string[] = [];
    let d = 0;
    let cur = "";
    for (const ch of args) {
      if ("([{".includes(ch)) d++;
      if (")]}".includes(ch)) d--;
      if (ch === "," && d === 0) {
        parts.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    parts.push(cur.trim());
    if (parts.length >= 6) out.push(parts[5]!);
  }
  return out;
}

describe("every adoption route says what it is", () => {
  it("finds the call sites the audit counted", () => {
    expect(adoptSourceExpressions().length).toBeGreaterThanOrEqual(30);
  });

  /**
   * THE ANTI-SEAM TEST. A literal source with no policy is a route that would be classified by
   * the conservative default and never reasoned about — which is how the last fifteen instances
   * of this pattern got in.
   */
  it("declares a policy for every literal source in the pipeline", () => {
    const undeclared = adoptSourceExpressions()
      .map((e) => e.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim())
      .filter((e) => /^"[a-z_]+"$/.test(e))
      .map((e) => e.slice(1, -1))
      .filter((s) => !isDeclaredAdoptSource(s));
    expect([...new Set(undeclared)], "adoptionPolicy.ts has no entry for these").toEqual([]);
  });

  /** The two labels the pipeline builds at runtime rather than writing literally. */
  it("declares every label the runtime producers emit", () => {
    for (const tier of ["topical", "wikimedia", undefined] as const) {
      const label = guaranteedAdoptSource(tier as never);
      expect(isDeclaredAdoptSource(label), `guaranteedAdoptSource -> "${label}"`).toBe(true);
    }
    expect(isDeclaredAdoptSource(SUBJECT_FALLBACK_ROUTE)).toBe(true);
  });

  it("has no empty or duplicate declarations", () => {
    const all = declaredAdoptSources();
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((s) => s.trim().length > 0)).toBe(true);
  });
});

/* ═══════════════ the guaranteed ladder stops wearing the funnel's name ═══════════════ */

describe("a rescue does not report itself as retrieval", () => {
  /** The exact mechanism behind `wikimedia retrieved=400 eligible=0 adopted=2 finalVideo=1`. */
  it("labels the guaranteed ladder's Commons rung a rescue", () => {
    expect(guaranteedAdoptSource("wikimedia" as never)).toBe("rescue_wikimedia");
    expect(guaranteedAdoptSource("wikimedia" as never)).not.toBe("wikimedia");
  });

  it("and that rescue may not claim to be a verified visual", () => {
    const p = adoptionPolicyFor("rescue_wikimedia");
    expect(p.category).toBe("RESCUE_REAL");
    expect(p.countsAsRealFootage).toBe(true);
    expect(p.countsAsVerifiedVisual).toBe(false);
    expect(p.exceptionReason, "an exception without a reason is a loophole").toBeTruthy();
  });

  /** The real retrieval route keeps its own, stronger claim — the fix must not flatten both. */
  it("leaves the real Wikimedia route claiming what it always did", () => {
    const p = adoptionPolicyFor("wikimedia");
    expect(p.category).toBe("REAL_FUNNEL");
    expect(p.requiresEligibility).toBe(true);
    expect(p.requiresVision).toBe(true);
    expect(p.countsAsVerifiedVisual).toBe(true);
  });

  it("keeps the archive rung a rescue too", () => {
    expect(guaranteedAdoptSource("topical" as never)).toBe("rescue_archive");
    expect(adoptionPolicyFor("rescue_archive").category).toBe("RESCUE_REAL");
  });
});

/* ═══════════════ an unknown route is not the flattering one ═══════════════ */

describe("an undeclared route is conservative and visible", () => {
  it("claims nothing", () => {
    const p = adoptionPolicyFor("some_route_nobody_declared");
    expect(p.category).toBe("UNDECLARED");
    expect(p.countsAsRealFootage).toBe(false);
    expect(p.countsAsVerifiedVisual).toBe(false);
  });

  it("is named in the census rather than absorbed into a total", () => {
    const census = censusAdoptionPolicies(["archive", "mystery_route", "mystery_route"]);
    expect(census.byCategory.UNDECLARED).toBe(2);
    expect(census.undeclared.mystery_route).toBe(2);
    const lines = formatAdoptionPolicyCensus(census);
    expect(lines.join("\n")).toContain("UNDECLARED_ADOPT_SOURCE route=mystery_route count=2");
  });

  it("a clean render prints no undeclared line at all", () => {
    const lines = formatAdoptionPolicyCensus(censusAdoptionPolicies(["archive", "wikimedia"]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("undeclared=0");
  });
});

/* ═══════════════ the categories mean different things ═══════════════ */

describe("the census separates what the funnel conflated", () => {
  /** Render 568's adoption mix, as its own [BeatVisual] lines reported it. */
  it("splits render 568's mix into categories that mean different things", () => {
    const census = censusAdoptionPolicies([
      ...Array(10).fill("subject_fallback"),
      ...Array(4).fill("rescue_archive"),
      ...Array(2).fill("rescue_placeholder"),
      "archive",
    ]);
    expect(census.byCategory.FALLBACK_SUBJECT).toBe(10);
    expect(census.byCategory.RESCUE_REAL).toBe(4);
    expect(census.byCategory.PLACEHOLDER).toBe(2);
    expect(census.byCategory.REAL_FUNNEL).toBe(1);
    expect(formatAdoptionPolicyCensus(census)[0]).toContain("subjectFallback=10");
  });

  /** A placeholder is not real footage, however the montage counts it. */
  it("refuses to let a placeholder count as footage", () => {
    for (const s of ["fallback", "rescue_placeholder", "guaranteed"]) {
      const p = adoptionPolicyFor(s);
      expect(p.category, s).toBe("PLACEHOLDER");
      expect(p.countsAsRealFootage, s).toBe(false);
      expect(p.countsAsVerifiedVisual, s).toBe(false);
    }
  });

  /** A subject fallback is real, and is still not an answer to the beat's question. */
  it("keeps subject fallback real but unverified", () => {
    const p = adoptionPolicyFor("subject_fallback");
    expect(p.countsAsRealFootage).toBe(true);
    expect(p.countsAsVerifiedVisual).toBe(false);
    expect(p.requiresVision).toBe(true);
  });

  /** Every declared exception has to say why, or it is just a bypass with a nicer name. */
  it("every eligibility or vision exception carries a reason", () => {
    for (const s of declaredAdoptSources()) {
      const p = adoptionPolicyFor(s);
      if (!p.requiresEligibility || !p.requiresVision) {
        expect(p.exceptionReason, `${s} skips a check with no stated reason`).toBeTruthy();
      }
    }
  });

  /** Only funnel routes may claim a verified visual, and they must earn it. */
  it("only a funnel route can count as a beat's verified visual", () => {
    for (const s of declaredAdoptSources()) {
      const p = adoptionPolicyFor(s);
      if (p.countsAsVerifiedVisual) {
        expect(p.category, s).toBe("REAL_FUNNEL");
        expect(p.requiresEligibility, s).toBe(true);
        expect(p.requiresVision, s).toBe(true);
      }
    }
  });
});

/* ═══════════════ and the render reports it ═══════════════ */

describe("the census reaches the render log", () => {
  it("is emitted beside the unjudged-adoption report", () => {
    expect(PIPE).toContain("censusAdoptionPolicies(");
    const at = PIPE.indexOf("censusAdoptionPolicies(");
    expect(PIPE.slice(Math.max(0, at - 1400), at)).toContain("formatUnjudgedAdoptions(");
  });

  /** An undeclared route is a warning; the ordinary census is not. */
  it("warns only on the undeclared line", () => {
    const at = PIPE.indexOf("censusAdoptionPolicies(");
    const block = PIPE.slice(at, at + 700);
    expect(block).toContain('line.includes("UNDECLARED_ADOPT_SOURCE")');
    expect(block).toContain("console.warn");
    expect(block).toContain("console.log");
  });
});


/* ═══════════════ RONDE 91 — the policy now DECIDES coverage ═══════════════ */

/**
 * ── The third permissive default ────────────────────────────────────────────────────────────
 *
 * `coverageOfAdoptEntry` held a twelve-entry source->coverage map and returned `own_footage` for
 * everything else — the same shape as `adoptRouteForSource`'s `primary`. It has teeth that the
 * other two do not: `verifiedOwnVisual = own_footage && verified_fit` feeds
 * `beatVisuals.verifiedOwnVisual`, which is exactly what RONDE 89's NO_VERIFIED_OWN_VISUAL export
 * condition reads. An undeclared route could therefore become a beat's verified visual and help a
 * render past the delivery gate.
 */
describe("coverage is derived from the declared policy", () => {
  const cov = (source: string, basename = "clip.mp4") =>
    coverageOfAdoptEntry({ source, basename });

  it("real funnel and rescue media are own footage", () => {
    expect(cov("archive")).toBe("own_footage");
    expect(cov("wikimedia")).toBe("own_footage");
    expect(cov("rescue_wikimedia")).toBe("own_footage");
    expect(cov("rescue_archive")).toBe("own_footage");
  });

  it("keeps every distinction the old table drew", () => {
    expect(cov("subject_fallback")).toBe("subject_only");
    expect(cov("rescue_extend")).toBe("held_frame");
    expect(cov("fallback")).toBe("placeholder");
    expect(cov("rescue_placeholder")).toBe("placeholder");
    expect(cov("color_fallback")).toBe("placeholder");
    expect(cov("rescue_graphic")).toBe("graphic");
    expect(cov("graphic")).toBe("graphic");
    expect(cov("motion_graphic")).toBe("graphic");
    expect(cov("text_overlay")).toBe("graphic");
    expect(cov("ai")).toBe("generated");
    expect(cov("rescue_ai")).toBe("generated");
    expect(cov("kling")).toBe("generated");
  });

  /** THE FIX. An undeclared route can no longer claim the beat has a picture of its own. */
  it("an undeclared route is not own footage", () => {
    expect(cov("some_route_nobody_declared")).toBe("none");
  });

  /** And therefore cannot become a verified visual, even with a passing verdict. */
  it("an undeclared route cannot become a verified own visual", () => {
    const [status] = buildBeatVisualStatuses(
      [{ sceneIndex: 0, beatIndex: 0, beatText: "b", basename: "x.mp4", source: "mystery_route" }] as never,
      undefined
    );
    expect(status!.coverage).toBe("none");
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  /** A declared funnel route still can — the fix must not flatten every beat to unverified. */
  it("a funnel route still reaches own_footage", () => {
    const [status] = buildBeatVisualStatuses(
      [{ sceneIndex: 0, beatIndex: 0, beatText: "b", basename: "x.mp4", source: "archive" }] as never,
      undefined
    );
    expect(status!.coverage).toBe("own_footage");
  });

  /** The filename second opinion may only ever make the reading MORE conservative. */
  it("a guaranteed filename downgrades own footage and nothing else", () => {
    expect(cov("archive", "scene_1_slot103_guaranteed.mp4")).toBe("placeholder");
    expect(cov("subject_fallback", "scene_1_slot103_guaranteed.mp4")).toBe("subject_only");
    expect(cov("mystery_route", "scene_1_slot103_guaranteed.mp4")).toBe("none");
  });

  /** rescue_similar is a family the codebase already treats as a prefix. */
  it("covers the rescue_similar family without a row per version", () => {
    expect(adoptionPolicyFor("rescue_similar_v2").category).toBe("RESCUE_REAL");
    expect(cov("rescue_similar_v2")).toBe("own_footage");
  });

  /**
   * The labels that reach adoption through runtime expressions rather than literals. Three
   * existing tests caught these when they briefly became UNDECLARED — this pins them so the
   * suite says so directly rather than by side effect.
   */
  it("declares the provider labels the scene pool reports at runtime", () => {
    for (const s of ["loc", "nara", "nasa", "flickr", "gdelt", "mediaccc", "sepiasearch",
                     "youtube", "youtube_cc", "wikimedia_video", "own_archive",
                     "rescue_stock", "archive_similar"]) {
      expect(isDeclaredAdoptSource(s), `${s} has no declared policy`).toBe(true);
    }
  });
});
