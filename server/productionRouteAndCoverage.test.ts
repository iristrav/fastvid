/**
 * FINAL PRODUCTION VALIDATION §14 + §20 — a log that can be read forwards.
 *
 * Both sections come from the same production render and the same failure mode: the log was
 * truthful about what it measured and silent about what a reader actually needed.
 *
 *   §14  There was no route line at all. `[RenderJob] route=…` lives inside the
 *        `cinematicPlanningEnabled()` branch, so a deployment with the engine off says nothing,
 *        and the only way to learn which route ran was to notice that `[Graphics]`, `[Captions]`
 *        and `[EDL]` never appeared. Reading a log by what is missing from it is guesswork.
 *
 *   §20  `beats=29 adopted=2 placeholder=7 rejected=5 noCandidates=15` reads as a video with two
 *        pictures in it. It is not: `adopted` counts ONE event in the adopt path, while the rescue
 *        ladder, the subject fallback and extend-last-clip all put footage on screen without ever
 *        firing it. The funnel numbers were never a coverage measure.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { formatProductionRoute } from "./cinematicProduction";
import {
  createBeatOutcomeAudit,
  noteBeatAdopted,
  renderBeatFunnelReport,
  resolveBeatCoverage,
  coverageHasRealFootage,
  beatRecord,
} from "./beatOutcomeAudit";
import { createRejectionRegistry } from "./rejectionRegistry";

/* ═══════════════════════ §14 — the route line ═══════════════════════ */

const ROUTE_FLAGS = [
  "CINEMATIC_EDITING_ENGINE",
  "CINEMATIC_RENDER_PATH",
  "POOL_RANKING_V2",
  "ENABLE_SCENE_CANDIDATE_POOL",
  "ENABLE_YOUTUBE_SOURCING",
  "AI_DIRECTOR",
  "SEARCH_GATE_STRICT",
] as const;

describe("§14 — every render says which route it takes", () => {
  const saved = new Map<string, string | undefined>();
  const setFlag = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  /** RONDE 661 — with no render path there is no route: the line says so, and why. */
  it("names the one route, whatever the old switches say — they no longer exist", () => {
    /** Code audit P12: CINEMATIC_EDITING_ENGINE / CINEMATIC_RENDER_PATH were removed. */
    for (const v of [undefined, "false", "true"]) {
      setFlag("CINEMATIC_EDITING_ENGINE", v);
      setFlag("CINEMATIC_RENDER_PATH", v);
      const line = formatProductionRoute(42);
      expect(line).toContain("[ProductionRoute] video=42");
      expect(line).toContain("route=cinematic_timeline");
      expect(line).not.toContain("route=none");
      expect(line).not.toContain("legacy_compose");
    }
  });


  /**
   * The values must be READ from the real predicates, not restated from a copy. A line that says
   * `youtube=on` while sourcing is off is worse than no line at all.
   */
  it("follows the real flag state rather than a snapshot", () => {
    setFlag("ENABLE_YOUTUBE_SOURCING", "false");
    expect(formatProductionRoute(1)).toContain("ENABLE_YOUTUBE_SOURCING");
    setFlag("ENABLE_YOUTUBE_SOURCING", "true");
    expect(
      formatProductionRoute(1),
      "the flag is still reported as the blocker after it was switched on"
    ).not.toMatch(/missing:[^)]*ENABLE_YOUTUBE_SOURCING/);
  });

  /**
   * THE FLAG WAS NEVER THE WHOLE ANSWER.
   *
   * Render 562 made no live YouTube search at all — `[YouTubeUsage] used=0`, and not one search
   * in the log. YouTube needs three things: the flag, a key to SEARCH with, and a separate
   * service to DOWNLOAD with, because YouTube serves no media files directly. The old line
   * printed `youtube=on` for the flag alone, so a render with the flag set and no key looked
   * enabled and searched nothing.
   */
  it("names which requirement is missing, never a key's value", () => {
    setFlag("ENABLE_YOUTUBE_SOURCING", "true");
    setFlag("YOUTUBE_API_KEY", undefined);
    setFlag("RAPIDAPI_KEY", undefined);
    setFlag("YOUTUBE_CC_DL_SERVICE", undefined);
    const blocked = formatProductionRoute(1);
    expect(blocked, "a missing search key reads as enabled").toContain("youtube=BLOCKED");
    expect(blocked).toContain("YOUTUBE_API_KEY");
    expect(blocked).toContain("missing:YOUTUBE_API_KEY,YOUTUBE_CC_DL_SERVICE");

    /** VIDEO 619 — a RapidAPI key is no download route any more; the service is. */
    setFlag("YOUTUBE_API_KEY", "k");
    setFlag("RAPIDAPI_KEY", "k");
    expect(formatProductionRoute(1)).toContain("youtube=BLOCKED(missing:YOUTUBE_CC_DL_SERVICE)");
    setFlag("YOUTUBE_CC_DL_SERVICE", "k");
    const ready = formatProductionRoute(1);
    expect(ready).toContain("youtube=ready");
    expect(ready, "a key's VALUE reached the log").not.toContain("k ");
  });

  /** And it has to actually be called, unconditionally, or it is another channel carrying nothing. */
  it("the pipeline emits it in the render body, and there is no cinematic branch to hide it in", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf("formatProductionRoute");
    expect(at, "nothing in the pipeline emits the route line").toBeGreaterThan(-1);
    const inner = src.indexOf("async function _runVideoPipelineInner(");
    expect(src).not.toContain("cinematicPlanningEnabled(");
    expect(at, "the route line is not in the render body").toBeGreaterThan(inner);
  });
});

/* ═══════════════════════ §20 — coverage in the viewer's terms ═══════════════════════ */

function beat(over: Partial<{ adopted: number }>) {
  const audit = createBeatOutcomeAudit();
  const rec = beatRecord(audit, 0, 0);
  if (over.adopted) noteBeatAdopted(audit, 0, 0, "pexels", "clip.mp4");
  return rec;
}

describe("§20 — the things that can be on screen are told apart", () => {
  it("real footage adopted by the adopt path is REAL_ASSET", () => {
    expect(resolveBeatCoverage(beat({ adopted: 1 }))).toBe("REAL_ASSET");
  });

  it("a beat that reached no picture at all is NO_VALID_ASSET", () => {
    expect(resolveBeatCoverage(beat({}))).toBe("NO_VALID_ASSET");
  });
});

/* ═══════════════════════ render 562 — real footage AND a colour card ═══════════════════════ */

/**
 * `pushClip` APPENDS, so the guaranteed ladder's card does not replace what a beat already holds.
 * Six of render 562's sixteen beats therefore carried both, and the old ordering — fill tier
 * before `adopted` — reported every one of them as FALLBACK:
 *
 *     [BeatLedger] beat=s2b0 … eligible=2 adopted=2 coverage=FALLBACK origin=pexels
 *     [Retrieval]  s2b0 extendLastClip REFUSED — the same picture has already been held 3.5s …
 *     [VisualCoverage] s2b0: … fallback=PLACEHOLDER (all real/contextual/AI sourcing exhausted)
 *
 * The render's own funnel line said `adopted=10` while its coverage line said `REAL_ASSET=4`. Two
 * counters over one render disagreeing by more than half is the bug; a mixed category is the fix.
 */
describe("§20 — a beat holding both real footage and a colour card", () => {

  /** Both mixed and pure count as footage having reached the screen; nothing else does. */
  it("real footage is recognised in both categories and no others", () => {
    expect(coverageHasRealFootage("REAL_ASSET")).toBe(true);
    expect(coverageHasRealFootage("REAL_PLUS_FILLER")).toBe(true);
    for (const c of ["INTENTIONAL_TEXT", "FALLBACK", "NO_VALID_ASSET"] as const) {
      expect(coverageHasRealFootage(c), `${c} is counted as real footage`).toBe(false);
    }
  });
});

describe("§20 — the render report carries coverage alongside the funnel", () => {
  /** Two adopted beats and one with no picture — cards and the guaranteed ladder no longer fill beats. */
  function productionLikeAudit() {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 0, 0, "pexels", "a.mp4");
    noteBeatAdopted(audit, 0, 1, "wikimedia", "b.mp4");
    beatRecord(audit, 0, 2);
    return audit;
  }
  const planned = Array.from({ length: 3 }, (_, beatIndex) => ({ sceneIndex: 0, beatIndex }));

  it("rolls the categories up on a line of their own", () => {
    const lines = renderBeatFunnelReport(productionLikeAudit(), planned, createRejectionRegistry());
    const roll = lines.find((l) => l.includes("COVERAGE beats="));
    expect(roll, "no coverage roll-up in the report").toBeTruthy();
    expect(roll).toContain("REAL_ASSET=2");
    expect(roll).toContain("NO_VALID_ASSET=1");
  });

  /**
   * The two totals must stay SEPARATE lines. Merged, a reader takes the funnel's `adopted=2` for
   * coverage — which is exactly the misreading this section exists to end.
   */
  it("keeps the funnel roll-up and the coverage roll-up apart", () => {
    const lines = renderBeatFunnelReport(productionLikeAudit(), planned, createRejectionRegistry());
    const funnel = lines.find((l) => l.includes("TOTAL beats="))!;
    expect(funnel).toContain("adopted=2");
    expect(funnel, "the two roll-ups were merged into one line").not.toContain("REAL_ASSET");
  });

  /** Every beat lands in exactly one category, so the categories sum to the beat count. */
  it("categorises every beat exactly once", () => {
    const roll = renderBeatFunnelReport(productionLikeAudit(), planned, createRejectionRegistry())
      .find((l) => l.includes("COVERAGE beats="))!;
    const nums = [
      ...roll.matchAll(
        /\b(REAL_ASSET|REAL_PLUS_FILLER|INTENTIONAL_TEXT|FALLBACK|NO_VALID_ASSET)=(\d+)/g
      ),
    ];
    expect(nums.map((m) => m[1]), "a category is missing from the roll-up").toHaveLength(5);
    expect(nums.reduce((sum, m) => sum + Number(m[2]), 0)).toBe(3);
  });
});
