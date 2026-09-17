/**
 * A PIPELINE DOES NOT SHRINK WITH ITS VIDEO.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 * No feature, sourcing route, quality gate, cinematic effect, graphic, animation, camera movement,
 * transition, audio feature or rendering behaviour may be disabled, downgraded or replaced solely
 * because the video is longer or shorter. Budgets, counts and processing time may scale with
 * duration. Capabilities may not.
 *
 * ── What was found ──────────────────────────────────────────────────────────────────────────
 *
 * `getPipelinePerfProfile` picks one of three literals by length, and three of their fields were
 * not budgets at all:
 *
 *                            1 min     8–10 min    10–20 min
 *     enableArchival         true      true        FALSE
 *     enableNasa             FALSE     true        true
 *     skipFairUseTransform   TRUE      false       TRUE
 *
 * A fifteen-minute video could not reach the Internet Archive at all. A one-minute video could not
 * reach NASA, whatever its subject. And the fair-use transform — a rights step — was skipped at one
 * minute and again from ten to twenty, but ran in between: not a pattern any budget could explain.
 * None of it follows from how long the video is; a beat about the Artemis launch needs NASA at one
 * minute exactly as much as at twenty.
 *
 * All three are now length-independent, at the stricter setting each time — archive and NASA ON,
 * the transform NOT skipped. A capability set that agreed by switching things OFF would satisfy
 * the letter of the rule and lose the thing it protects.
 *
 * ── What this test deliberately does NOT demand ─────────────────────────────────────────────
 *
 * Uniform budgets. A twenty-minute video has more beats, more scenes and more time to fill them,
 * and §3 asserts that the numbers still differ — so this file cannot be satisfied by flattening
 * every profile into one, which would be the other way to break the pipeline.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { getPipelinePerfProfile, type PipelinePerfProfile } from "./videoPipeline";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** Every length bucket the product offers, shortest to longest. */
const LENGTHS = ["1", "8-10", "10-15", "15-20"] as const;

/**
 * Both sourcing modes, because `getPipelinePerfProfile` has two exits.
 *
 * `curatedArchiveOnlyVisuals()` defaults to ON and takes a second branch that overrides part of
 * the profile. A test that only ran the default would leave the other branch — the one a render
 * with `CURATED_ARCHIVE_ONLY=false` takes — completely unchecked, and a length dependency could
 * live there unseen. Both are walked, and the assertions have to hold in each.
 */
const MODES = [
  { name: "curated-archive-only", env: undefined },
  { name: "all-sources", env: "false" },
] as const;

function inMode<T>(env: string | undefined, fn: () => T): T {
  const previous = process.env.CURATED_ARCHIVE_ONLY;
  if (env === undefined) delete process.env.CURATED_ARCHIVE_ONLY;
  else process.env.CURATED_ARCHIVE_ONLY = env;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CURATED_ARCHIVE_ONLY;
    else process.env.CURATED_ARCHIVE_ONLY = previous;
  }
}

/** Every (mode, length) pair the product can actually be rendered in. */
const profiles = (): Array<{ mode: string; length: string; profile: PipelinePerfProfile }> =>
  MODES.flatMap((m) =>
    LENGTHS.map((length) => ({
      mode: m.name,
      length,
      profile: inMode(m.env, () => getPipelinePerfProfile(length)),
    }))
  );

/** The lengths within ONE mode — for the checks that compare like with like. */
const profilesIn = (env: string | undefined): PipelinePerfProfile[] =>
  LENGTHS.map((length) => inMode(env, () => getPipelinePerfProfile(length)));

/**
 * Fields that say WHETHER, not how much. Every one of these must read the same at one minute and
 * at twenty.
 */
const CAPABILITY_FIELDS = [
  "enableArchival",
  "enableNasa",
  "skipFairUseTransform",
] as const satisfies readonly (keyof PipelinePerfProfile)[];

/**
 * Fields that say HOW MUCH. These MAY differ, and §3 asserts at least one of them does — otherwise
 * this file could be passed by making every video render like a one-minute one.
 */
const BUDGET_FIELDS = [
  "targetWallClockMin",
  "maxBeatsPerScene",
  "maxTopicQueries",
  "transformTimeoutMs",
  "pexelsDownloadRetries",
  "maxStockQueriesPerBeat",
  "beatClipTimeoutMs",
  "sceneVisualTimeoutMs",
] as const satisfies readonly (keyof PipelinePerfProfile)[];

/* ═══════════ 1 — a capability reads the same at every length ═══════════ */

describe("§1 — capabilities do not depend on duration", () => {
  for (const field of CAPABILITY_FIELDS) {
    it(`${field} is the same for a 1-minute video and a 20-minute one`, () => {
      for (const mode of MODES) {
        const seen = LENGTHS.map((length) => ({
          length,
          value: inMode(mode.env, () => getPipelinePerfProfile(length))[field],
        }));
        const distinct = new Set(seen.map((s) => String(s.value)));
        expect(
          [...distinct],
          `${field} differs by length in ${mode.name}: ` +
            seen.map((s) => `${s.length}=${s.value}`).join(" ")
        ).toHaveLength(1);
      }
    });
  }

  it("the Internet Archive is reachable at every length", () => {
    /** The middle column of the table above: a fifteen-minute video could not reach it at all. */
    for (const { mode, length, profile } of profiles()) {
      expect(profile.enableArchival, `archive is off for ${length} in ${mode}`).toBe(true);
    }
  });

  it("NASA is reachable at every length", () => {
    for (const { mode, length, profile } of profiles()) {
      expect(profile.enableNasa, `NASA is off for ${length} in ${mode}`).toBe(true);
    }
  });

  it("the fair-use transform is never skipped by length alone", () => {
    /**
     * A rights step, not a budget. `skipFairUseTransform` was true for everything under twenty
     * minutes, so the shorter the video the less of this ran — the exact shape the rule forbids.
     */
    for (const { mode, length, profile } of profiles()) {
      expect(
        profile.skipFairUseTransform,
        `the transform is skipped for ${length} in ${mode}`
      ).toBe(false);
    }
  });
});

/* ═══════════ 2 — one source of truth, so a fourth profile cannot diverge ═══════════ */

describe("§2 — the capability set is written once", () => {
  it("all three profiles spread the same constant", () => {
    expect(PIPELINE).toContain("const LENGTH_INDEPENDENT_CAPABILITIES = {");
    const fn = PIPELINE.indexOf("export function getPipelinePerfProfile");
    const body = PIPELINE.slice(fn, PIPELINE.indexOf("\n}\n", fn));
    const spreads = body.split("...LENGTH_INDEPENDENT_CAPABILITIES").length - 1;
    expect(spreads, "a length profile does not take the shared capabilities").toBe(3);
  });

  it("no profile re-states a capability as its own literal", () => {
    /**
     * A spread is only a guarantee while nothing overrides it afterwards. `{ ...CAPS,
     * enableNasa: false }` is valid TypeScript and puts the bug straight back.
     */
    const fn = PIPELINE.indexOf("export function getPipelinePerfProfile");
    const body = PIPELINE.slice(fn, PIPELINE.indexOf("\n}\n", fn));
    for (const field of CAPABILITY_FIELDS) {
      const literal = new RegExp(`\\n\\s+${field}:\\s*(true|false)\\s*,`);
      const override = literal.exec(body);
      expect(override?.[0] ?? null, `${field} is overridden per length again`).toBeNull();
    }
  });
});

/* ═══════════ 3 — budgets are still allowed to scale ═══════════ */

describe("§3 — proportional is not the same as absent", () => {
  it("a longer video still gets a bigger budget somewhere, in EVERY profile", () => {
    /**
     * All three profile literals, not two. `isShortVideoLength` is true only for "1", so "8-10"
     * takes the third literal and "10-15"/"15-20" the second — comparing only "1" against "15-20"
     * leaves the third one unchecked, and a mutation that flattened exactly that one survived the
     * first version of this test.
     */
    const short = getPipelinePerfProfile("1");
    for (const longer of ["8-10", "15-20"] as const) {
      const profile = getPipelinePerfProfile(longer);
      const grew = BUDGET_FIELDS.filter((f) => Number(profile[f]) > Number(short[f]));
      expect(
        grew,
        `${longer} has no budget bigger than a 1-minute video's — that profile has been ` +
          "flattened rather than corrected"
      ).not.toEqual([]);
    }
  });

  it("the wall-clock target scales with the video, for every longer bucket", () => {
    const short = getPipelinePerfProfile("1").targetWallClockMin;
    for (const longer of ["8-10", "10-15", "15-20"] as const) {
      expect(
        getPipelinePerfProfile(longer).targetWallClockMin,
        `${longer} gets no more wall clock than a 1-minute video`
      ).toBeGreaterThan(short);
    }
  });

  it("the AI clip ceiling is a count, and counts may differ", () => {
    /** Named explicitly so nobody later reads it as a capability and flattens it. */
    const values = profiles().map((p) => p.profile.maxAiClipsPerVideo);
    expect(values.every((v) => typeof v === "number")).toBe(true);
  });
});

/* ═══════════ 4 — what is NOT yet length-independent, named out loud ═══════════ */

describe("§4 — the remaining two, declared rather than hidden", () => {
  /**
   * `fastStockMode` and `scriptOnlyVisuals` still differ by length, and both are real violations
   * of the rule rather than budgets:
   *
   *   fastStockMode      on a short Railway job this REPLACES the beat-resolution route with
   *                      `resolveBeatClipTurbo` / `resolveBeatClipFastTurbo` — a reduced route,
   *                      not a smaller budget. It also skips the Openverse stills tier.
   *   scriptOnlyVisuals  false for short, true for longer, which changes what a beat may adopt.
   *
   * They are NOT fixed here, and the reason is not oversight. `fastStockMode` exists because of
   * measured Railway behaviour — OOM-killed ffmpeg processes and a 10-minute wall-clock target —
   * and switching it off without a production render to show the full route fits that budget would
   * be trading a known defect for an unmeasured one. Production is `Unauthorized`, so that render
   * cannot be run.
   *
   * This test exists so the boundary is explicit: these two are known, and a THIRD cannot be added
   * without failing here.
   */
  const KNOWN_LENGTH_DEPENDENT = ["fastStockMode", "scriptOnlyVisuals"] as const;

  it("no boolean OTHER than the two known ones differs by length", () => {
    /**
     * A subset check, not an equality one. `fastStockMode` is `IS_RAILWAY` on the short profile,
     * and `IS_RAILWAY` is derived from an environment variable — so on a machine where that key is
     * set the field is false everywhere and does not differ at all. Demanding that it DOES differ
     * would make this test pass or fail on where it runs rather than on what the code says.
     *
     * The direction that matters is the other one: nothing new may join the list.
     */
    for (const mode of MODES) {
      const one = inMode(mode.env, () => getPipelinePerfProfile("1"));
      const booleanFields = (Object.keys(one) as (keyof PipelinePerfProfile)[]).filter(
        (f) => typeof one[f] === "boolean"
      );
      const byLength = profilesIn(mode.env);
      const differing = booleanFields.filter(
        (f) => new Set(byLength.map((p) => String(p[f]))).size > 1
      );
      const unexpected = differing.filter(
        (f) => !(KNOWN_LENGTH_DEPENDENT as readonly string[]).includes(f)
      );
      expect(
        unexpected,
        `a new capability became a function of video length in ${mode.name}`
      ).toEqual([]);
    }
  });

  it("the two known ones are the only names on the list", () => {
    /** So the list cannot be widened to hide a new violation instead of fixing it. */
    expect([...KNOWN_LENGTH_DEPENDENT].sort()).toEqual(["fastStockMode", "scriptOnlyVisuals"]);
  });

  it("the two are documented where they are set, not only here", () => {
    expect(PIPELINE).toContain("A CAPABILITY IS NOT A FUNCTION OF LENGTH.");
  });
});
