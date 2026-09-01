/**
 * RONDE 157 — Director 2.0: the shot vocabulary, the variety policy and attention moments.
 *
 * The rule this file exists to defend is §8's: relevance beats variety. It is easy to write a
 * variety policy that produces a beautifully varied sequence of shots of the wrong things, and the
 * tests that would catch that are the ones asserting what the policy REFUSES to do.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_SHOT_TYPES,
  ATTENTION_EFFECTS,
  MAX_RUN_BEFORE_VARIETY,
  SHOT_SCALE_ORDER,
  SHOT_SEMANTICS,
  applyShotVariety,
  classifyAttentionMoment,
  formatAttentionMoment,
  scaleDistance,
  suggestVariedShot,
  type AttentionMoment,
} from "./shotVocabulary";
import { planShotOrder } from "./aiDirector/shotOrderPlanner";
import { runAIDirector, toDirectorGuidance } from "./aiDirector";
import type { ShotType } from "./cinematicEditingEngine/types";
import type { Scene } from "./pipeline/types";
import type { VisualIntent } from "./visualMatchingV2/types";

/* ═══════════════════════ §7 — every shot MEANS something ═══════════════════════ */

describe("RONDE 157 §7 — the shot vocabulary", () => {
  it("includes every framing §7 asked for", () => {
    for (const t of [
      "extreme_close_up", "close_up", "medium", "medium_wide", "wide", "extreme_wide",
      "overhead", "aerial", "detail", "pov", "establishing",
    ] as ShotType[]) {
      expect(ALL_SHOT_TYPES, t).toContain(t);
    }
  });

  /** §7: "Niet alleen strings toevoegen." A type with no meaning is a label nobody can reason with. */
  it("gives every shot a meaning, a scale and a role", () => {
    for (const t of ALL_SHOT_TYPES) {
      const s = SHOT_SEMANTICS[t];
      expect(s.meaning.length, t).toBeGreaterThan(20);
      expect(SHOT_SCALE_ORDER, t).toContain(s.scale);
      expect(s.role.length, t).toBeGreaterThan(0);
    }
  });

  /**
   * These two are routinely confused and mean different things. Overhead looks DOWN at a surface;
   * aerial looks ACROSS a landscape. Their scales differ accordingly.
   */
  it("distinguishes overhead from aerial", () => {
    expect(SHOT_SEMANTICS.overhead.meaning.toLowerCase()).toContain("down");
    expect(SHOT_SEMANTICS.aerial.meaning.toLowerCase()).toContain("across");
    expect(SHOT_SEMANTICS.overhead.scale).not.toBe(SHOT_SEMANTICS.aerial.scale);
  });

  it("marks the shots that need footage a stock pool may not have", () => {
    expect(SHOT_SEMANTICS.aerial.needsSpecialFootage).toBe(true);
    expect(SHOT_SEMANTICS.pov.needsSpecialFootage).toBe(true);
    expect(SHOT_SEMANTICS.medium.needsSpecialFootage).toBe(false);
  });

  it("the scale ladder runs from widest to closest", () => {
    expect(scaleDistance("extreme_wide", "extreme_close_up")).toBe(SHOT_SCALE_ORDER.length - 1);
    expect(scaleDistance("medium", "medium")).toBe(0);
    expect(scaleDistance("wide", "medium_wide")).toBe(0);
  });
});

/* ═══════════════════════ §8 — variety, but never at relevance's expense ═══════════════════════ */

describe("RONDE 157 §8 — the variety policy", () => {
  /** The rule the whole policy hangs on. */
  it("only ever substitutes a shot with the SAME editorial role", () => {
    for (const t of ALL_SHOT_TYPES) {
      const varied = suggestVariedShot(t, []);
      if (!varied) continue;
      expect(SHOT_SEMANTICS[varied.shotType].role, t).toBe(SHOT_SEMANTICS[t].role);
    }
  });

  it("prefers the smallest change in framing that is still a change", () => {
    const varied = suggestVariedShot("wide", []);
    expect(varied).not.toBeNull();
    // A context shot stays a context shot, and moves as little as possible on the ladder.
    expect(scaleDistance("wide", varied!.shotType)).toBeLessThanOrEqual(1);
    expect(varied!.shotType).not.toBe("wide");
  });

  it("avoids a shot that needs footage the pool probably lacks", () => {
    const varied = suggestVariedShot("wide", []);
    expect(SHOT_SEMANTICS[varied!.shotType].needsSpecialFootage).toBe(false);
    // …unless the caller says its pool can supply one.
    const allowed = suggestVariedShot("wide", ["extreme_wide"], { avoidSpecialFootage: false });
    expect(allowed).not.toBeNull();
  });

  it("does not suggest something used in the last two beats", () => {
    const varied = suggestVariedShot("wide", ["extreme_wide", "establishing"]);
    if (varied) {
      expect(["extreme_wide", "establishing"]).not.toContain(varied.shotType);
    }
  });

  /**
   * §8 in its strongest form. A role with no alternative gets NO substitution — the run stands,
   * and the quality rules report it. Breaking a run with the wrong shot is worse than the run.
   */
  it("returns null rather than substituting a shot of the wrong thing", () => {
    // `graphic` is a role with exactly one member.
    expect(SHOT_SEMANTICS.overlay_shot.role).toBe("graphic");
    expect(suggestVariedShot("overlay_shot", [])).toBeNull();
  });

  it("leaves a short run alone", () => {
    const out = applyShotVariety(["wide", "wide"]);
    expect(out.every((o) => !o.changed)).toBe(true);
    expect(out.map((o) => o.shotType)).toEqual(["wide", "wide"]);
  });

  it("breaks a long run, and says why", () => {
    const out = applyShotVariety(["wide", "wide", "wide", "wide"]);
    const changed = out.filter((o) => o.changed);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[0]!.reason).toContain("same editorial role");
    // The run is genuinely gone.
    expect(out.slice(0, 3).map((o) => o.shotType)).not.toEqual(["wide", "wide", "wide"]);
  });

  it("is deterministic — §35 reaches into the Director too", () => {
    const a = applyShotVariety(["medium", "medium", "medium", "medium", "medium"]);
    const b = applyShotVariety(["medium", "medium", "medium", "medium", "medium"]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("the threshold agrees with the rule that REPORTS a run", async () => {
    const { MAX_CONSECUTIVE_SAME_SHOT } = await import("./directorQualityRules");
    // The policy that avoids a problem and the rule that reports it must mean the same thing.
    expect(MAX_RUN_BEFORE_VARIETY).toBe(MAX_CONSECUTIVE_SAME_SHOT);
  });

  it("an empty scene is handled without incident", () => {
    expect(applyShotVariety([])).toEqual([]);
  });
});

/* ═══════════════════════ the policy reaches the real planner ═══════════════════════ */

describe("RONDE 157 — variety reaches the Director's actual shot order", () => {
  it("a long scene no longer repeats one framing four times", () => {
    const order = planShotOrder("explain", "b_roll", 8);
    expect(order).toHaveLength(8);

    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < order.length; i++) {
      run = order[i]!.shotType === order[i - 1]!.shotType ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThanOrEqual(MAX_RUN_BEFORE_VARIETY + 1);
  });

  it("every shot in the order still carries a reason", () => {
    for (const item of planShotOrder("explain", "b_roll", 8)) {
      expect(item.reason.length).toBeGreaterThan(10);
    }
  });

  it("the new framings are describable by the planner", () => {
    // SHOT_REASONS is exhaustive over ShotType, so this would not compile if one were missing.
    const order = planShotOrder("establish", "b_roll", 4);
    expect(order.every((o) => typeof o.reason === "string" && o.reason.length > 0)).toBe(true);
  });

  it("the Director's guidance still carries the shot order to the engine", () => {
    const scene = (index: number): Scene => ({
      index,
      text: "Apple introduced the Vision Pro.",
      visualCue: "",
      pexelsQuery: "",
      aiImagePrompt: "",
      duration: 12,
    });
    const intent = (beatId: string): VisualIntent =>
      ({
        beatId, spokenText: "x", visualSubject: "Apple", visualAction: "", visualLocation: "",
        visualTime: "", historicalContext: "", emotion: "", visualDescription: "",
        primaryKeyword: "Apple", secondaryKeyword: "", negativeKeywords: [],
        secondaryVisualSubjects: [], objects: [], brands: [], companies: [], countries: [],
        events: [], people: [], intentHash: "h", cacheHit: false,
      }) as VisualIntent;

    const out = runAIDirector([
      { scene: scene(0), beatIntents: [intent("b0"), intent("b1"), intent("b2")], durationSec: 12 },
    ]);
    const guidance = toDirectorGuidance(out.decisions[0]!);
    expect(guidance.shotOrder!.length).toBeGreaterThan(0);
    for (const s of guidance.shotOrder!) {
      expect(ALL_SHOT_TYPES).toContain(s.shotType);
    }
  });
});

/* ═══════════════════════ §9 — attention moments ═══════════════════════ */

describe("RONDE 157 §9 — attention moments are first-class", () => {
  it("every moment says what it may influence, and why", () => {
    const moments: AttentionMoment[] = [
      "hook", "reveal", "impact", "emphasis", "turning_point",
      "statistic", "quote", "location", "climax",
    ];
    for (const m of moments) {
      const e = ATTENTION_EFFECTS[m];
      expect(e.why.length, m).toBeGreaterThan(20);
      if (e.preferShot) expect(ALL_SHOT_TYPES, m).toContain(e.preferShot);
    }
  });

  /**
   * §11: "De beslissing moet uit de inhoud volgen." Position alone is never enough — an opening
   * beat with nothing in it is not a hook.
   */
  it("does NOT call an empty opening beat a hook", () => {
    expect(
      classifyAttentionMoment({
        text: "In this video we will look at several things.",
        beatIndexInVideo: 0,
        beatStartSec: 0,
        videoDurationSec: 120,
      })
    ).toBeNull();
  });

  it("calls an opening beat with a real number a hook, and says why", () => {
    const found = classifyAttentionMoment({
      text: "Apple spent 3 billion dollars before anyone saw it.",
      beatIndexInVideo: 0,
      beatStartSec: 0,
      videoDurationSec: 120,
    });
    expect(found?.moment).toBe("hook");
    expect(found?.evidence).toContain("number");
  });

  it("the same sentence LATER in the video is a statistic, not a hook", () => {
    const found = classifyAttentionMoment({
      text: "Apple spent 3 billion dollars before anyone saw it.",
      beatIndexInVideo: 14,
      beatStartSec: 90,
      videoDurationSec: 240,
    });
    expect(found?.moment).toBe("statistic");
  });

  it("recognises a quotation", () => {
    const found = classifyAttentionMoment({
      text: 'Jobs said, "It just works, and that is the whole point."',
      beatIndexInVideo: 8,
      beatStartSec: 40,
      videoDurationSec: 240,
    });
    expect(found?.moment).toBe("quote");
  });

  it("recognises a turn in the narration", () => {
    const found = classifyAttentionMoment({
      text: "But then everything changed for the company.",
      beatIndexInVideo: 8,
      beatStartSec: 40,
      videoDurationSec: 240,
    });
    expect(found?.moment).toBe("turning_point");
  });

  it("uses the caller's location evidence rather than extracting its own", () => {
    const found = classifyAttentionMoment({
      text: "The team gathered at the campus.",
      beatIndexInVideo: 8,
      beatStartSec: 40,
      videoDurationSec: 240,
      hasLocation: true,
    });
    expect(found?.moment).toBe("location");
  });

  /** Most beats are not attention moments. A Director that marked every beat would mark none. */
  it("returns null for an ordinary beat", () => {
    expect(
      classifyAttentionMoment({
        text: "The team continued working through the following weeks.",
        beatIndexInVideo: 6,
        beatStartSec: 30,
        videoDurationSec: 240,
      })
    ).toBeNull();
  });

  it("returns null for empty text rather than guessing", () => {
    expect(
      classifyAttentionMoment({ text: "   ", beatIndexInVideo: 0, beatStartSec: 0, videoDurationSec: 60 })
    ).toBeNull();
  });

  it("is deterministic", () => {
    const args = {
      text: "Apple spent 3 billion dollars.",
      beatIndexInVideo: 0,
      beatStartSec: 0,
      videoDurationSec: 120,
    };
    expect(classifyAttentionMoment(args)).toEqual(classifyAttentionMoment(args));
  });

  /**
   * §9's last line: "alleen wanneer de benodigde payload bestaat. Geen nep-data genereren."
   * A statistic moment SUGGESTS a graphic; it does not create one.
   */
  it("suggests a graphic without providing any data for it", () => {
    expect(ATTENTION_EFFECTS.statistic.suggestsGraphic).toBe("statistic");
    // The table names a TYPE. It carries no values, so nothing here can fabricate a chart.
    expect(JSON.stringify(ATTENTION_EFFECTS.statistic)).not.toMatch(/\bvalues?\b/);
  });

  it("the log line names the moment and its evidence", () => {
    const found = classifyAttentionMoment({
      text: "Apple spent 3 billion dollars.",
      beatIndexInVideo: 0,
      beatStartSec: 0,
      videoDurationSec: 120,
    })!;
    const line = formatAttentionMoment("s0b0", found);
    expect(line).toContain("[Director]");
    expect(line).toContain("hook");
    expect(line).toContain("s0b0");
    expect(line).toContain(ATTENTION_EFFECTS.hook.why);
  });
});
