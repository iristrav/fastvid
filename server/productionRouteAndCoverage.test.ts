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
  noteBeatFillTier,
  noteBeatPlaceholder,
  renderBeatFunnelReport,
  resolveBeatCoverage,
  coverageHasRealFootage,
  beatRecord,
  type BeatFillTier,
} from "./beatOutcomeAudit";
import { createClipRejectAudit } from "./clipRejectAudit";

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

  it("names the legacy route, and the flag that chose it", () => {
    setFlag("CINEMATIC_EDITING_ENGINE", undefined);
    setFlag("CINEMATIC_RENDER_PATH", undefined);
    const line = formatProductionRoute(42);
    expect(line).toContain("[ProductionRoute] video=42");
    expect(line).toContain("route=legacy_compose");
    expect(line, "the line says legacy but not why").toContain("CINEMATIC_EDITING_ENGINE is not enabled");
  });

  /** Planning alone stores a timeline the editor can open — the delivered MP4 still comes from compose. */
  it("still says legacy when only planning is on, naming the OTHER flag", () => {
    setFlag("CINEMATIC_EDITING_ENGINE", "true");
    setFlag("CINEMATIC_RENDER_PATH", undefined);
    const line = formatProductionRoute(42);
    expect(line).toContain("route=legacy_compose");
    expect(line).toContain("CINEMATIC_RENDER_PATH is not enabled");
  });

  it("names the cinematic route when both switches are on", () => {
    setFlag("CINEMATIC_EDITING_ENGINE", "true");
    setFlag("CINEMATIC_RENDER_PATH", "true");
    const line = formatProductionRoute(42);
    expect(line).toContain("route=cinematic_timeline");
    expect(line, "a route that ran needs no excuse").not.toContain("reason=");
  });

  /** Every switch that changes what the render does is on the line, so one grep answers "how was this configured". */
  it("reports each flag that decides the route", () => {
    const line = formatProductionRoute(1);
    for (const flag of ROUTE_FLAGS) {
      const label = flag === "ENABLE_SCENE_CANDIDATE_POOL" ? "scenePool="
        : flag === "ENABLE_YOUTUBE_SOURCING" ? "youtube="
          : flag === "AI_DIRECTOR" ? "aiDirector="
            : flag === "SEARCH_GATE_STRICT" ? "searchGateStrict="
              : `${flag}=`;
      expect(line, `${flag} is not reported`).toContain(label);
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
    expect(blocked).toContain("RAPIDAPI_KEY|YOUTUBE_CC_DL_SERVICE");

    /** Either download route satisfies the third requirement. */
    setFlag("YOUTUBE_API_KEY", "k");
    setFlag("RAPIDAPI_KEY", "k");
    const ready = formatProductionRoute(1);
    expect(ready).toContain("youtube=ready");
    expect(ready, "a key's VALUE reached the log").not.toContain("k ");
  });

  /** And it has to actually be called, unconditionally, or it is another channel carrying nothing. */
  it("the pipeline emits it outside the cinematic branch", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = src.indexOf("formatProductionRoute");
    expect(at, "nothing in the pipeline emits the route line").toBeGreaterThan(-1);
    const inner = src.indexOf("async function _runVideoPipelineInner(");
    const planningBranch = src.indexOf("if (cinematicPlanningEnabled())");
    expect(at, "the route line is inside the cinematic branch — silent exactly when it is needed")
      .toBeLessThan(planningBranch);
    expect(at, "the route line is not in the render body").toBeGreaterThan(inner);
  });
});

/* ═══════════════════════ §20 — coverage in the viewer's terms ═══════════════════════ */

function beat(over: Partial<{ adopted: number; placeholder: boolean; fillTier: BeatFillTier }>) {
  const audit = createBeatOutcomeAudit();
  const rec = beatRecord(audit, 0, 0);
  if (over.adopted) noteBeatAdopted(audit, 0, 0, "pexels", "clip.mp4");
  if (over.placeholder) noteBeatPlaceholder(audit, 0, 0);
  if (over.fillTier) noteBeatFillTier(audit, 0, 0, over.fillTier);
  return rec;
}

describe("§20 — the things that can be on screen are told apart", () => {
  it("real footage adopted by the adopt path is REAL_ASSET", () => {
    expect(resolveBeatCoverage(beat({ adopted: 1 }))).toBe("REAL_ASSET");
  });

  /**
   * The heart of the 2-out-of-29 problem. These beats were counted as `placeholder` because every
   * search strategy was exhausted — and then the guaranteed ladder handed them REAL FOOTAGE from
   * the curated archive or Wikimedia. Calling that a placeholder is what made the video look empty.
   */
  it.each(["topical", "wikimedia"] as const)(
    "a beat the guaranteed ladder filled with %s footage is REAL_ASSET, not a placeholder",
    (tier) => {
      expect(resolveBeatCoverage(beat({ placeholder: true, fillTier: tier }))).toBe("REAL_ASSET");
    }
  );

  /** A card carrying the beat's own narration is a deliberate presentation, not a blank frame. */
  it("a text card is INTENTIONAL_TEXT", () => {
    expect(resolveBeatCoverage(beat({ placeholder: true, fillTier: "text_overlay" }))).toBe("INTENTIONAL_TEXT");
  });

  it("a drawn colour card is FALLBACK", () => {
    expect(resolveBeatCoverage(beat({ placeholder: true, fillTier: "color_fallback" }))).toBe("FALLBACK");
  });

  it("a beat that reached no picture at all is NO_VALID_ASSET", () => {
    expect(resolveBeatCoverage(beat({}))).toBe("NO_VALID_ASSET");
  });

  /** A card of unrecorded kind is still a card — never counted as nothing, never as real footage. */
  it("a placeholder with no tier recorded is FALLBACK", () => {
    expect(resolveBeatCoverage(beat({ placeholder: true }))).toBe("FALLBACK");
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
  it("is neither REAL_ASSET nor FALLBACK", () => {
    const rec = beat({ adopted: 1, placeholder: true, fillTier: "color_fallback" });
    expect(
      resolveBeatCoverage(rec),
      "an adopted clip is reported as if nothing chose the beat's picture"
    ).not.toBe("FALLBACK");
    expect(
      resolveBeatCoverage(rec),
      "a beat part of whose screen time is a drawn card is claimed as fully covered"
    ).not.toBe("REAL_ASSET");
    expect(resolveBeatCoverage(rec)).toBe("REAL_PLUS_FILLER");
  });

  /** The order matters, not just the categories: `adopted` alone must not be enough to reach it. */
  it("an adopted beat with no colour card stays REAL_ASSET", () => {
    expect(resolveBeatCoverage(beat({ adopted: 1, placeholder: true }))).toBe("REAL_ASSET");
    expect(resolveBeatCoverage(beat({ adopted: 1, fillTier: "topical" }))).toBe("REAL_ASSET");
  });

  /** And a colour card with nothing adopted is still a plain FALLBACK — no coverage was invented. */
  it("a colour card with no adoption stays FALLBACK", () => {
    expect(resolveBeatCoverage(beat({ placeholder: true, fillTier: "color_fallback" }))).toBe(
      "FALLBACK"
    );
  });

  /** Both mixed and pure count as footage having reached the screen; nothing else does. */
  it("real footage is recognised in both categories and no others", () => {
    expect(coverageHasRealFootage("REAL_ASSET")).toBe(true);
    expect(coverageHasRealFootage("REAL_PLUS_FILLER")).toBe(true);
    for (const c of ["INTENTIONAL_TEXT", "FALLBACK", "NO_VALID_ASSET"] as const) {
      expect(coverageHasRealFootage(c), `${c} is counted as real footage`).toBe(false);
    }
  });

  /**
   * The whole render, rebuilt from the ledger lines of video 562. The coverage totals must now
   * agree with the funnel's own `adopted` count — the disagreement that exposed the defect.
   */
  it("reproduces render 562's beats and agrees with its adoption count", () => {
    const audit = createBeatOutcomeAudit();
    /** [scene, beat, adopted, origin, colour card?] — read off the production [BeatLedger] lines. */
    const production = [
      [0, 0, 1, "archive", false], [0, 1, 1, "archive", false],
      [0, 2, 1, "archive", true], [0, 3, 1, "archive", true],
      [1, 0, 0, "", true], [1, 1, 0, "", true], [1, 2, 1, "internet_archive", true],
      [1, 3, 0, "", true], [1, 4, 0, "", false], [1, 5, 0, "", false], [1, 6, 0, "", false],
      [1, 7, 1, "wikimedia", false],
      [2, 0, 2, "pexels", true], [2, 1, 1, "wikimedia", true],
      [2, 2, 2, "internet_archive", true], [2, 3, 2, "pexels", false],
    ] as const;
    for (const [s, b, adopted, origin, card] of production) {
      for (let i = 0; i < adopted; i++) noteBeatAdopted(audit, s, b, origin, `s${s}b${b}.mp4`);
      if (card) {
        noteBeatPlaceholder(audit, s, b);
        noteBeatFillTier(audit, s, b, "color_fallback");
      }
    }
    const planned = production.map(([sceneIndex, beatIndex]) => ({ sceneIndex, beatIndex }));
    const lines = renderBeatFunnelReport(audit, planned, createClipRejectAudit());
    const roll = lines.find((l) => l.includes("COVERAGE beats="))!;

    expect(roll).toContain("beats=16");
    expect(roll).toContain("REAL_ASSET=4");
    expect(roll).toContain("REAL_PLUS_FILLER=6");
    expect(roll).toContain("FALLBACK=3");
    expect(roll).toContain("NO_VALID_ASSET=3");

    /**
     * The invariant the old ordering broke. Ten beats adopted something; ten beats must show
     * footage. It read REAL_ASSET=4 against adopted=10 in production.
     */
    const funnel = lines.find((l) => l.includes("TOTAL beats="))!;
    expect(funnel).toContain("adopted=10");
    expect(roll, "the coverage line disagrees with the funnel about how many beats got footage")
      .toContain("realFootage=10");
  });
});

describe("§20 — the render report carries coverage alongside the funnel", () => {
  /** The production shape: mostly rescue-filled beats, two adopted, one truly empty. */
  function productionLikeAudit() {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 0, 0, "pexels", "a.mp4");
    noteBeatAdopted(audit, 0, 1, "wikimedia", "b.mp4");
    for (const [b, tier] of [[2, "wikimedia"], [3, "topical"], [4, "text_overlay"], [5, "color_fallback"]] as const) {
      noteBeatPlaceholder(audit, 0, b);
      noteBeatFillTier(audit, 0, b, tier);
    }
    beatRecord(audit, 0, 6);
    return audit;
  }
  const planned = Array.from({ length: 7 }, (_, beatIndex) => ({ sceneIndex: 0, beatIndex }));

  it("reports every beat's coverage on its own line", () => {
    const lines = renderBeatFunnelReport(productionLikeAudit(), planned, createClipRejectAudit());
    /**
     * The COVERAGE line specifically. `[BeatLedger]` also carries `beat=`, so a filter on that
     * alone now matches two lines per beat — both of them correct, and the claim here is about
     * this one. Filtering by prefix keeps the assertion about what it was always about.
     */
    const perBeat = lines.filter((l) => l.startsWith("[VisualCoverageFinal] scene="));
    expect(perBeat).toHaveLength(7);
    for (const l of perBeat) expect(l, `no coverage on: ${l}`).toMatch(/coverage=[A-Z_]+/);
  });

  it("rolls the categories up on a line of their own", () => {
    const lines = renderBeatFunnelReport(productionLikeAudit(), planned, createClipRejectAudit());
    const roll = lines.find((l) => l.includes("COVERAGE beats="));
    expect(roll, "no coverage roll-up in the report").toBeTruthy();
    /** Four real assets: two adopted plus the two the ladder filled with real footage. */
    expect(roll).toContain("REAL_ASSET=4");
    expect(roll).toContain("INTENTIONAL_TEXT=1");
    expect(roll).toContain("FALLBACK=1");
    expect(roll).toContain("NO_VALID_ASSET=1");
  });

  /**
   * The two totals must stay SEPARATE lines. Merged, a reader takes the funnel's `adopted=2` for
   * coverage — which is exactly the misreading this section exists to end.
   */
  it("keeps the funnel roll-up and the coverage roll-up apart", () => {
    const lines = renderBeatFunnelReport(productionLikeAudit(), planned, createClipRejectAudit());
    const funnel = lines.find((l) => l.includes("TOTAL beats="))!;
    expect(funnel).toContain("adopted=2");
    expect(funnel, "the two roll-ups were merged into one line").not.toContain("REAL_ASSET");
  });

  /** Every beat lands in exactly one category, so the categories sum to the beat count. */
  it("categorises every beat exactly once", () => {
    const roll = renderBeatFunnelReport(productionLikeAudit(), planned, createClipRejectAudit())
      .find((l) => l.includes("COVERAGE beats="))!;
    const nums = [
      ...roll.matchAll(
        /\b(REAL_ASSET|REAL_PLUS_FILLER|INTENTIONAL_TEXT|FALLBACK|NO_VALID_ASSET)=(\d+)/g
      ),
    ];
    expect(nums.map((m) => m[1]), "a category is missing from the roll-up").toHaveLength(5);
    expect(nums.reduce((sum, m) => sum + Number(m[2]), 0)).toBe(7);
  });
});

describe("§20 — the pipeline actually records the tier", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * Without this the categories are a function nothing feeds: every beat would fall back to
   * `placeholder → FALLBACK` and the rescue ladder's real footage would still be miscounted.
   */
  it("every per-beat guaranteed fill records which rung answered", () => {
    /**
     * The three per-beat sites that call `generateGuaranteedBeatClip` with a tier out-parameter:
     * the rescue placeholder, the beat fill, and the emergency finish. The two remaining
     * `GuaranteedTierOut` uses are compose-level slots with no real beat index — recording those
     * against a beat would invent beats the render does not have.
     */
    const calls = [...SRC.matchAll(/noteBeatFillTier\(/g)].length;
    expect(calls, "a per-beat guaranteed fill site does not record its tier").toBe(3);
  });

  /** And it must be the REAL tier from the out-parameter, not a constant someone typed. */
  it("passes the tier the ladder reported", () => {
    const args = [...SRC.matchAll(/noteBeatFillTier\(([^)]*)\)/g)];
    expect(args).toHaveLength(3);
    for (const m of args) {
      expect(m[1], `a fill site invents its tier: ${m[1]}`).toMatch(/[Tt]ierOut\.tier/);
    }
  });
});
